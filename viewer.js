import * as THREE from './vendor/three.module.js';
import { GLTFLoader } from './vendor/GLTFLoader.js';
import { OrbitControls } from './vendor/OrbitControls.js';
import { RoomEnvironment } from './vendor/RoomEnvironment.js';
import { QUAD_VARIANTS, PART_MODELS } from './model-variants.js';
import { MODEL_PREVIEWS } from './assets/models/model-previews.js?v=20261006-models3';
import { readAsset, withDeadline } from './asset-loader.js?v=20261006-models3';

// Saved Tripo outputs from READY and additional website demonstrations.
// Models are pre-generated; the website makes no Tripo API requests.
const ASSETS = {
  knight: { label: 'Knight', modes: ['texture', 'quads', 'rig', 'parts'], yaw: -Math.PI / 2 },
  dragon: { label: 'Dragon', modes: ['texture', 'quads', 'rig'], yaw: -Math.PI / 2 },
  tavern: { label: 'Tavern', modes: ['texture', 'quads', 'parts'], yaw: 0 },
  chest: { label: 'Treasure chest', modes: ['texture'], yaw: 0 },
};
const MODES = { texture: 'Textured model', quads: 'Native polygon topology', rig: 'Animated skeleton', parts: 'AI segmentation' };
const BASE = new URL('./assets/models/', import.meta.url);
const COLORS = { paper: 0xf3eee3, blue: 0x214ce5, pink: 0xec4f9e, yellow: 0xf5d829 };
const noop = () => {};

/** Parse polygon boundaries before triangulation, so the displayed quad wire
 * does not include artificial diagonal edges introduced by WebGL rendering. */
function parsePolygonOBJ(text) {
  const vertices = [], faces = [], edges = new Set(), indices = [], lines = [];
  for (const line of text.split(/\r?\n/)) {
    const bits = line.trim().split(/\s+/);
    // These OBJ files were exported from Tripo's FBX output (Z-up), while
    // embedded GLB assets use Y-up: [x, y, z] -> [x, z, -y]. This is the same
    // conversion used by the original movie's tools/asset_mesh.py.
    if (bits[0] === 'v') vertices.push([Number(bits[1]), Number(bits[3]), -Number(bits[2])]);
    if (bits[0] === 'f') {
      const face = bits.slice(1).map(b => {
        const value = Number(b.split('/')[0]);
        return value < 0 ? vertices.length + value : value - 1;
      });
      if (face.length < 3 || face.some(i => !vertices[i])) throw new Error('Invalid polygon data.');
      faces.push(face);
    }
  }
  for (const face of faces) {
    for (let i = 1; i < face.length - 1; i++) indices.push(face[0], face[i], face[i + 1]);
    for (let i = 0; i < face.length; i++) {
      const a = face[i], b = face[(i + 1) % face.length], key = a < b ? `${a}:${b}` : `${b}:${a}`;
      if (!edges.has(key)) { edges.add(key); lines.push(...vertices[a], ...vertices[b]); }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices.flat(), 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const lineGeometry = new THREE.BufferGeometry();
  lineGeometry.setAttribute('position', new THREE.Float32BufferAttribute(lines, 3));
  const root = new THREE.Group();
  root.add(new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
    color: COLORS.paper, roughness: 0.9, metalness: 0, side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
  })));
  root.add(new THREE.LineSegments(lineGeometry, new THREE.LineBasicMaterial({ color: COLORS.blue })));
  return { root, stats: { faces: faces.length, quads: faces.filter(f => f.length === 4).length,
    vertices: vertices.length, triangles: indices.length / 3 } };
}

export async function createReadyViewer({ canvas, onStatus = noop, onStats = noop, onModeChange = noop }) {
  if (!canvas) throw new Error('A canvas is required for the asset viewer.');
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, preserveDrawingBuffer: true });
  } catch (error) {
    onStatus({ type: 'unsupported', message: '3D preview needs WebGL. Please try a current browser with hardware acceleration enabled.' });
    throw error;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(COLORS.paper);
  const camera = new THREE.PerspectiveCamera(36, 1, 0.01, 100);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.enablePan = false;
  controls.minDistance = 2;
  controls.maxDistance = 12;
  controls.maxPolarAngle = Math.PI * 0.92;
  controls.target.set(0, 0.15, 0);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x81796f, 2));
  const key = new THREE.DirectionalLight(0xffffff, 2.6); key.position.set(3, 5, 4); scene.add(key);
  const fill = new THREE.DirectionalLight(0xe9efff, 1.5); fill.position.set(-4, 2, 1); scene.add(fill);
  const rim = new THREE.DirectionalLight(0xffffff, 1.6); rim.position.set(1, 2, -3); scene.add(rim);
  const room = new RoomEnvironment();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const environment = pmrem.fromScene(room, 0.04);
  scene.environment = environment.texture;
  room.dispose(); pmrem.dispose();

  const loader = new GLTFLoader(), cache = new Map(), partCounts = new Map();
  const quadLevels = Object.fromEntries(Object.entries(QUAD_VARIANTS).map(([asset, config]) => [asset, config.defaultLevel]));
  let state = { asset: 'knight', mode: 'texture', playing: true, explode: 0, loading: false };
  let current = null, disposed = false, loadSerial = 0, frame = 0, previousTime = 0;
  let visible = true, activeRequest;
  function getState() {
    return { ...state, availableModes: [...ASSETS[state.asset].modes],
      hasModel: Boolean(current && current.asset === state.asset && current.mode === state.mode && current.file === fileFor(state.asset, state.mode)),
      quadLevel: quadLevels[state.asset],
      availableQuadLevels: (QUAD_VARIANTS[state.asset]?.levels || []).map(level => ({ ...level })),
      partsCount: partCounts.get(state.asset) };
  }
  function notify() { onModeChange(getState()); }
  function resetView() {
    controls.target.set(0, 0.12, 0);
    // A wider view gives separated pieces room at full separation.
    if (state.mode === 'parts') camera.position.set(3.75, 2.3, 6.5);
    else camera.position.set(2.75, 1.67, 4.73);
    controls.update();
  }
  resetView();
  const sizeObserver = new ResizeObserver(() => resize());
  function resize() {
    const box = canvas.getBoundingClientRect();
    const w = Math.max(1, box.width), h = Math.max(1, box.height);
    renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
  }
  sizeObserver.observe(canvas); resize();
  const visibilityObserver = new IntersectionObserver(entries => { visible = entries[0]?.isIntersecting ?? true; });
  visibilityObserver.observe(canvas);

  function fileFor(asset, mode) {
    if (mode === 'texture') return `${asset}_tex.glb`;
    if (mode === 'quads') {
      const config = QUAD_VARIANTS[asset];
      return config ? config.levels.find(level => level.id === quadLevels[asset]).file : `${asset}_quad.obj`;
    }
    if (mode === 'rig') return asset === 'knight' ? 'knight_d04.glb' : 'dragon_walk.glb';
    return PART_MODELS[asset].file;
  }
  function disposeObject(root) {
    const textures = new Set(), materials = new Set(), images = new Set();
    root?.traverse(node => {
      node.geometry?.dispose();
      for (const material of node.material ? (Array.isArray(node.material) ? node.material : [node.material]) : []) materials.add(material);
    });
    for (const material of materials) {
      for (const value of Object.values(material)) if (value?.isTexture) textures.add(value);
      material.dispose();
    }
    for (const texture of textures) { images.add(texture.image); texture.dispose(); }
    for (const image of images) image?.close?.();
  }
  async function load(asset, mode, file, signal, onProgress) {
    if (cache.has(file)) return cache.get(file);
      let root, stats, clips = [], texturesByImage = new Map();
      const preview = MODEL_PREVIEWS[file];
      const gzip = Boolean(preview?.compressed && typeof DecompressionStream === 'function');
      const bytes = await readAsset(new URL(gzip ? preview.compressed : preview?.preview || file, BASE), { signal, onProgress, gzip });
      signal.throwIfAborted();
      if (file.endsWith('.obj')) {
        ({ root, stats } = parsePolygonOBJ(new TextDecoder().decode(bytes)));
      } else {
        const gltf = await withDeadline(loader.parseAsync(bytes, BASE.href), signal, result => disposeObject(result.scene));
        root = gltf.scene; clips = gltf.animations;
        let triangles = 0, vertices = 0, meshes = 0;
        const bones = new Set();
        root.traverse(object => {
          if (!object.isMesh) return;
          meshes++; const geometry = object.geometry;
          triangles += (geometry.index?.count ?? geometry.attributes.position.count) / 3;
          vertices += geometry.attributes.position.count;
          if (object.isSkinnedMesh) object.skeleton.bones.forEach(bone => bones.add(bone));
          const materials = Array.isArray(object.material) ? object.material : [object.material];
          for (const material of materials) {
            if (material.map) material.map.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
            for (const texture of Object.values(material).filter(value => value?.isTexture)) {
              const textureIndex = gltf.parser?.associations.get(texture)?.textures;
              const imageIndex = gltf.parser?.json.textures?.[textureIndex]?.source;
              if (imageIndex === undefined) continue;
              if (!texturesByImage.has(imageIndex)) texturesByImage.set(imageIndex, new Set());
              texturesByImage.get(imageIndex).add(texture);
            }
          }
          if (mode === 'rig') {
            object.material = new THREE.MeshStandardMaterial({ color: COLORS.blue,
              transparent: true, opacity: 0.19, roughness: 1, metalness: 0,
              depthWrite: false, side: THREE.DoubleSide });
          }
        });
        stats = { triangles, vertices, joints: bones.size, parts: mode === 'parts' ? meshes : undefined };
        if (mode === 'parts') partCounts.set(asset, meshes);
      }
      // +X-facing character outputs are turned to +Z, matching the movie pipeline.
      const orientation = new THREE.Group(); orientation.rotation.y = ASSETS[asset].yaw; orientation.add(root);
      orientation.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(orientation), center = box.getCenter(new THREE.Vector3());
      const extent = box.getSize(new THREE.Vector3()), scale = 2.65 / Math.max(extent.x, extent.y, extent.z);
      const container = new THREE.Group(); container.add(orientation);
      orientation.position.sub(center); container.scale.setScalar(scale);
      const bundle = { root, container, stats, file, asset, mode, orientation, mixer: null, bones: [], markers: null, helper: null, pieces: [],
        texturesByImage, previewTextures: new Map(texturesByImage), detailReplacements: new Map(),
        detailImages: (preview?.images || []).filter(image => !image.previewIsFullResolution && texturesByImage.has(image.index)), detailDone: new Set() };
      if (mode === 'rig') {
        const boneSet = new Set(); root.traverse(object => {
          if (object.isSkinnedMesh) object.skeleton.bones.forEach(b => boneSet.add(b));
        });
        bundle.bones = [...boneSet];
        bundle.helper = new THREE.SkeletonHelper(root);
        bundle.helper.material.depthTest = false; bundle.helper.material.depthWrite = false;
        bundle.helper.material.color.setHex(0xd51978);
        bundle.helper.material.toneMapped = false;
        bundle.helper.material.vertexColors = false;
        bundle.helper.renderOrder = 8;
        bundle.markers = new THREE.InstancedMesh(new THREE.SphereGeometry(0.022, 10, 8),
          new THREE.MeshBasicMaterial({ color: 0xd51978, depthTest: false, toneMapped: false }), bundle.bones.length);
        bundle.markers.renderOrder = 9; bundle.markers.frustumCulled = false;
        if (clips.length) {
          bundle.mixer = new THREE.AnimationMixer(root);
          bundle.mixer.clipAction(clips[0]).play();
          bundle.mixer.update(0);
          stats.animation = clips[0].name; stats.animationDuration = clips[0].duration;
        }
      }
      if (mode === 'parts') {
        container.updateMatrixWorld(true);
        const wholeCenter = new THREE.Box3().setFromObject(root).getCenter(new THREE.Vector3());
        root.traverse(object => {
          if (!object.isMesh) return;
          const pieceCenter = new THREE.Box3().setFromObject(object).getCenter(new THREE.Vector3());
          const direction = pieceCenter.clone().sub(wholeCenter).normalize();
          // Convert the world-space separation into this part's parent coordinates.
          const a = object.parent.worldToLocal(pieceCenter.clone());
          const b = object.parent.worldToLocal(pieceCenter.clone().add(direction.multiplyScalar(0.72)));
          bundle.pieces.push({ object, base: object.position.clone(), direction: b.sub(a) });
        });
      }
      if (signal.aborted) { disposeObject(container); signal.throwIfAborted(); }
      // Cache only completed models. Cancelled and failed requests are always retryable.
      cache.set(file, bundle);
      return bundle;
  }
  function replaceTextures(bundle, replacements) {
    bundle.root.traverse(object => {
      for (const material of object.material ? (Array.isArray(object.material) ? object.material : [object.material]) : []) {
        for (const key of Object.keys(material)) if (replacements.has(material[key])) material[key] = replacements.get(material[key]);
      }
    });
  }
  function releaseDetails(bundle) {
    // Keep previews for instant switching; only the displayed model retains 4K maps.
    const reverse = new Map([...bundle.detailReplacements].map(([preview, hd]) => [hd, preview]));
    replaceTextures(bundle, reverse);
    const images = new Set();
    for (const texture of reverse.keys()) { images.add(texture.image); texture.dispose(); }
    for (const image of images) image?.close?.();
    bundle.texturesByImage = new Map(bundle.previewTextures);
    bundle.detailReplacements.clear(); bundle.detailDone.clear();
  }
  async function upgradeDetails(bundle, signal, serial) {
    const pending = bundle.detailImages.filter(image => !bundle.detailDone.has(image.index));
    if (!pending.length) return;
    onStatus({ type: 'detail', message: 'Model ready · refining textures…' });
    try {
      for (const image of pending) {
        const bytes = await readAsset(new URL(image.file, BASE), { signal, priority: 'low' });
        signal.throwIfAborted();
        const bitmap = await withDeadline(createImageBitmap(new Blob([bytes], { type: image.mimeType }),
          { premultiplyAlpha: 'none', colorSpaceConversion: 'none' }), signal, bitmap => bitmap.close());
        if (signal.aborted || disposed || serial !== loadSerial) { bitmap.close(); return; }
        // An uploaded Texture cannot change dimensions: replace it with a new GPU texture.
        const replacements = new Map(), source = new THREE.Source(bitmap);
        for (const texture of bundle.texturesByImage.get(image.index)) {
          const next = texture.clone(); next.source = source; next.needsUpdate = true;
          replacements.set(texture, next); bundle.detailReplacements.set(texture, next);
        }
        replaceTextures(bundle, replacements);
        bundle.texturesByImage.set(image.index, new Set(replacements.values()));
        for (const texture of replacements.keys()) texture.dispose();
        bundle.detailDone.add(image.index);
      }
      if (serial === loadSerial && !signal.aborted) onStatus({ type: 'ready' });
    } catch (error) {
      if (signal.aborted || disposed || serial !== loadSerial) return;
      onStatus({ type: 'detail-error', message: 'Model ready. High-resolution textures will retry when you select this model again.' });
      console.warn('[READY textures]', error);
    }
  }
  function attach(bundle) {
    if (current) { scene.remove(current.container); if (current.helper) scene.remove(current.helper); if (current.markers) scene.remove(current.markers); }
    current = bundle; scene.add(bundle.container);
    if (bundle.helper) scene.add(bundle.helper);
    if (bundle.markers) scene.add(bundle.markers);
    setExplode(state.explode);
  }
  async function refresh() {
    const serial = ++loadSerial, asset = state.asset, mode = state.mode, file = fileFor(asset, mode);
    activeRequest?.abort();
    activeRequest = new AbortController();
    const signal = activeRequest.signal;
    if (current && current.file !== file) releaseDetails(current);
    // Keep the previous model only when comparing budgets of the same asset.
    if (current && (current.asset !== asset || current.mode !== mode)) {
      scene.remove(current.container); if (current.helper) scene.remove(current.helper); if (current.markers) scene.remove(current.markers);
      current = null;
    }
    state.loading = true; notify();
    const message = mode === 'quads' ? 'Updating mesh…' : `Loading ${ASSETS[asset].label.toLowerCase()}…`;
    onStatus({ type: 'loading', message });
    try {
      const bundle = await load(asset, mode, file, signal, progress => {
        if (serial === loadSerial && !signal.aborted) onStatus({ type: 'loading', message, ...progress });
      });
      if (disposed || serial !== loadSerial) return getState();
      attach(bundle); state.loading = false;
      onStats({ asset, label: ASSETS[asset].label, mode, ...bundle.stats,
        quadLevel: mode === 'quads' ? quadLevels[asset] : undefined });
      const guidance = mode === 'rig' ? `${bundle.stats.joints} actual joints · ${bundle.stats.animation} animation`
        : mode === 'parts' ? `${bundle.stats.parts} actual Tripo mesh parts · drag the separation slider`
        : mode === 'quads' ? 'Original polygon edges · triangulation diagonals hidden'
        : 'Original Tripo model and embedded material textures';
      onStatus({ type: 'ready', message: guidance }); notify();
      void upgradeDetails(bundle, signal, serial);
    } catch (error) {
      if (disposed || serial !== loadSerial) return getState();
      // A failed topology swap keeps both the displayed model and its selected budget.
      const previousLevel=mode==='quads'&&current?.asset===asset&&current?.mode===mode
        ? QUAD_VARIANTS[asset]?.levels.find(level=>level.file===current.file) : null;
      if(previousLevel)quadLevels[asset]=previousLevel.id;
      state.loading = false; notify();
      onStatus({ type: 'error', message: previousLevel
        ? 'This version could not load. The previous mesh is still shown. Please try again.'
        : 'This model could not be loaded. Please retry the asset or refresh the page.' });
      console.error('[READY viewer]', error);
    }
    return getState();
  }
  function selectAsset(id) {
    if (!ASSETS[id]) return Promise.resolve(getState());
    state.asset = id;
    if (!ASSETS[id].modes.includes(state.mode)) state.mode = 'texture';
    state.explode = 0;
    resetView(); return refresh();
  }
  function setMode(mode) {
    if (!ASSETS[state.asset].modes.includes(mode)) {
      onStatus({ type: 'unsupported', message: `${MODES[mode] ?? mode} is not available for this asset. Choose one of the enabled views.` });
      return Promise.resolve(getState());
    }
    const wasParts = state.mode === 'parts';
    state.mode = mode;
    if (wasParts || mode === 'parts') resetView();
    return refresh();
  }
  function setPlaying(value) { state.playing = Boolean(value); notify(); }
  function setExplode(value) {
    state.explode = THREE.MathUtils.clamp(Number(value) || 0, 0, 1);
    if (current?.asset === state.asset && current?.mode === state.mode) for (const piece of current.pieces) piece.object.position.copy(piece.base).addScaledVector(piece.direction, state.explode);
    notify();
  }
  function setQuadLevel(level) {
    const config = QUAD_VARIANTS[state.asset];
    if (!config?.levels.some(option => option.id === level)) return Promise.resolve(getState());
    quadLevels[state.asset] = level;
    // Keep camera position, target and zoom while the same model's topology changes.
    if (state.mode === 'quads') return refresh();
    notify(); return Promise.resolve(getState());
  }
  const markerMatrix = new THREE.Matrix4(), markerPosition = new THREE.Vector3();
  function tick(time) {
    if (disposed) return;
    frame = requestAnimationFrame(tick);
    const delta = previousTime ? Math.min((time - previousTime) / 1000, 0.06) : 0;
    previousTime = time;
    if (!visible || document.hidden) return;
    if (current?.mixer && state.playing && !state.loading) current.mixer.update(delta);
    controls.update();
    if (current?.markers) {
      current.container.updateMatrixWorld(true);
      current.bones.forEach((bone, index) => {
        bone.getWorldPosition(markerPosition); markerMatrix.makeTranslation(markerPosition.x, markerPosition.y, markerPosition.z);
        current.markers.setMatrixAt(index, markerMatrix);
      });
      current.markers.instanceMatrix.needsUpdate = true;
    }
    renderer.render(scene, camera);
  }
  frame = requestAnimationFrame(tick);
  function capture() { renderer.render(scene, camera); return canvas.toDataURL('image/png'); }
  function dispose() {
    disposed = true; loadSerial++; cancelAnimationFrame(frame); sizeObserver.disconnect(); visibilityObserver.disconnect(); controls.dispose();
    activeRequest?.abort();
    cache.forEach(bundle => {
        releaseDetails(bundle);
        bundle.mixer?.stopAllAction();
        for (const object of [bundle.container, bundle.helper, bundle.markers].filter(Boolean)) disposeObject(object);
    });
    cache.clear();
    environment.dispose(); renderer.dispose();
  }
  return { start: refresh, selectAsset, setMode, setPlaying, setExplode, setQuadLevel, resetView, capture, getState, dispose };
}
