import { createReadyViewer } from './viewer.js';
const $ = id => document.getElementById(id);
const assetButtons = [...document.querySelectorAll('[data-asset]')];
const modeButtons = [...document.querySelectorAll('[data-mode]')];
const copy = {
  knight: {title:'The knight.',description:'Explore the original knight assets and three polygon budgets remeshed from the same source model for this website.',input:'Four views of one character. One consistent 3D model.'},
  dragon: {title:'The dragon.',description:'A hand-drawn creature becomes a textured 3D dragon, with a native quad mesh and a 24-joint walking rig.',input:'One dragon sketch becomes a textured, rigged creature.'},
  tavern: {title:'The tavern.',description:'Four original polygon targets, plus a segmented version prepared for this website. Explore the topology and separate the parts.',input:'One environment reference, explored at four polygon targets.'},
  chest: {title:'The treasure.',description:'A text prompt becomes a textured prop — one of the fantasy-world assets generated for READY.',input:'A text-to-model asset with its original PBR materials.'}
};
const modeLabels={texture:'TEXTURED MODEL',quads:'NATIVE TOPOLOGY',rig:'RIG + MOTION',parts:'SEPARATE PARTS'};
const notes={texture:'Original PBR materials, viewed with neutral studio lighting.',quads:'Blue lines follow the source polygon boundaries. Triangulation diagonals are hidden.',rig:'Pink markers show actual skeleton joints. Motion comes from a Tripo animation output.',parts:''};
let viewer, assetData, lastState={asset:'knight',mode:'texture'}, renderedStats, toastTimer, loadingTimer;
function toast(message){$('toast').textContent=message;$('toast').classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').classList.remove('show'),2800)}
function setInputs(asset){
  const container=$('input-images');container.replaceChildren();
  const data=assetData?.assets?.find(a=>a.id===asset);
  for(const input of data?.inputs||[]){const img=document.createElement('img');img.src=typeof input==='string'?input:(input.path||input.src);img.alt=typeof input==='string'?`${asset} input reference`:(input.label||input.alt||`${asset} input reference`);img.loading='lazy';container.append(img)}
  if(asset==='chest'){const text=document.createElement('span');text.className='text-prompt';text.textContent='Text → 3D · Fantasy treasure chest';container.append(text)}
  $('input-caption').textContent=copy[asset].input;
}
function onModeChange(state){
  lastState=state;
  assetButtons.forEach(b=>{const active=b.dataset.asset===state.asset;b.classList.toggle('selected',active);b.setAttribute('aria-pressed',String(active));b.disabled=state.loading});
  modeButtons.forEach(b=>{const active=b.dataset.mode===state.mode;b.classList.toggle('selected',active);b.setAttribute('aria-pressed',String(active));b.disabled=state.loading||!state.availableModes.includes(b.dataset.mode)});
  $('asset-title').textContent=copy[state.asset].title;$('asset-description').textContent=copy[state.asset].description;
  const partsLabel=state.partsCount===undefined?'Parts':`${state.partsCount} parts`;
  $('parts-mode-label').textContent=partsLabel;
  const modelMode=state.mode==='parts'&&state.partsCount!==undefined?`${state.partsCount} SEPARATE PARTS`:modeLabels[state.mode];
  $('model-label').textContent=`${state.asset.toUpperCase()} / ${modelMode}`;
  $('mode-note').textContent=notes[state.mode];$('mode-note').hidden=!notes[state.mode];
  const resetLabel=state.mode==='parts'?'Reset view and parts':'Reset view';
  $('reset-view').title=resetLabel;$('reset-view').setAttribute('aria-label',resetLabel);
  $('animation-control').hidden=state.mode!=='rig';$('explode-control').hidden=state.mode!=='parts';
  const levels=state.availableQuadLevels;
  $('level-control').hidden=state.mode!=='quads'||levels.length<2;
  $('quad-level').disabled=state.loading;$('explode').disabled=state.loading;
  const levelSignature=JSON.stringify(levels);
  if($('quad-level').dataset.options!==levelSignature){
    $('quad-level').replaceChildren(...levels.map(level=>new Option(level.label,level.id)));
    $('quad-level').dataset.options=levelSignature;
  }
  $('play-animation').textContent=state.playing?'Ⅱ Pause motion':'▶ Play motion';$('play-animation').setAttribute('aria-pressed',String(state.playing));
  $('explode').value=Math.round(state.explode*100);$('explode-value').value=`${Math.round(state.explode*100)}%`;
  $('quad-level').value=state.quadLevel||'';setInputs(state.asset);
}
function onStats(stats){
  renderedStats=stats;
  const facts=stats.mode==='quads'?[[stats.quads,'Quad faces'],[stats.faces,'Total faces']]:stats.mode==='rig'?[[stats.joints,'Skeleton joints'],['LIVE','Tripo motion']]:stats.mode==='parts'?[[stats.parts,'Separate meshes'],['AI','Segmentation']]:[[Math.round(stats.triangles),'Triangles'],['PBR','Materials']];
  $('model-stats').replaceChildren(...facts.map(([value,label])=>{const d=document.createElement('div');d.className='stat';const s=document.createElement('strong');s.textContent=typeof value==='number'?value.toLocaleString():value;const l=document.createElement('span');l.textContent=label;d.append(s,l);return d}));
}
function onStatus({type,message}){
  clearTimeout(loadingTimer);
  const status=$('viewer-status'), loading=type==='loading';
  $('model-canvas').setAttribute('aria-busy',String(loading));
  $('model-stats').setAttribute('aria-busy',String(loading));
  status.textContent='';status.className='viewer-status ready';
  if(loading){
    // Keep the figures belonging to the model still on screen during a topology swap.
    if(renderedStats?.asset!==lastState.asset||renderedStats?.mode!==lastState.mode)$('model-stats').replaceChildren();
    const loadingText=lastState.mode==='quads'?'Updating mesh…':'Loading model…';
    // Cached and quick loads finish without flashing a status message.
    loadingTimer=setTimeout(()=>{status.textContent=loadingText;status.className='viewer-status loading'},250);
  }else if(type==='error'||type==='unsupported'){
    status.textContent=message;status.className=`viewer-status ${type}`;
  }
}
async function change(action){try{await action()}catch(e){console.error(e);toast('This asset could not load. Please try again.')}}
async function init(){
  try{const response=await fetch('data/assets.json');if(response.ok)assetData=await response.json()}catch(e){console.warn('Asset captions unavailable',e)}
  setInputs('knight');
  try{viewer=await createReadyViewer({canvas:$('model-canvas'),onStatus,onStats,onModeChange})}catch(e){console.error(e);return}
  assetButtons.forEach(b=>b.addEventListener('click',()=>change(()=>viewer.selectAsset(b.dataset.asset))));
  modeButtons.forEach(b=>b.addEventListener('click',()=>change(()=>viewer.setMode(b.dataset.mode))));
  $('play-animation').addEventListener('click',()=>viewer.setPlaying(!viewer.getState().playing));
  $('explode').addEventListener('input',e=>viewer.setExplode(Number(e.target.value)/100));
  $('quad-level').addEventListener('change',e=>change(()=>viewer.setQuadLevel(e.target.value)));
  $('reset-view').addEventListener('click',()=>{
    const resetParts=viewer.getState().mode==='parts';
    viewer.resetView();
    if(resetParts)viewer.setExplode(0);
    toast(resetParts?'View and parts reset':'View reset');
  });
  $('save-frame').addEventListener('click',()=>{const a=document.createElement('a');a.href=viewer.capture();a.download=`READY_${lastState.asset}_${lastState.mode}.png`;a.click();toast('Model image saved')});
}
init();
function focusLab(active){$('lab').classList.toggle('is-focused',active);document.body.classList.toggle('lab-open',active);$('focus-lab').textContent=active?'Exit expanded view ×':'Expand asset lab ↗';$('focus-lab').setAttribute('aria-pressed',String(active))}
$('focus-lab').addEventListener('click',()=>focusLab(!$('lab').classList.contains('is-focused')));
document.querySelectorAll('.topbar a').forEach(a=>a.addEventListener('click',()=>focusLab(false)));
// Let the film play while visible, but do not leave its soundtrack running under the asset lab.
const film=$('film-player');new IntersectionObserver(entries=>{if(!entries[0].isIntersecting&&!film.paused)film.pause()},{threshold:0}).observe(film);
