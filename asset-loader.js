// Requests have both a stalled-transfer deadline and an overall deadline.
// Abort the transport itself so a retry never joins an old, hung Three request.
export async function readAsset(url, { signal, onProgress = () => {}, priority = 'high' } = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  let stalled;
  const timeout = () => controller.abort(new Error('The asset request timed out. Please retry.'));
  const touch = () => { clearTimeout(stalled); stalled = setTimeout(timeout, 30000); };
  const totalTimer = setTimeout(timeout, 90000);
  touch();
  try {
    const response = await fetch(url, { signal: controller.signal, priority });
    if (!response.ok) throw new Error(`Model request failed (${response.status}).`);
    const total = Number(response.headers.get('Content-Length')) || 0;
    if (!response.body?.getReader) return await response.arrayBuffer();
    const reader = response.body.getReader(), chunks = [];
    let loaded = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value); loaded += value.byteLength; touch();
      onProgress({ loaded, total, percent: total ? Math.min(100, loaded / total * 100) : undefined });
    }
    const result = new Uint8Array(loaded);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
    return result.buffer;
  } finally {
    clearTimeout(stalled); clearTimeout(totalTimer);
    signal?.removeEventListener('abort', abort);
  }
}

// Parsing/image decoding cannot be cancelled, but their late results can be disposed.
export function withDeadline(promise, signal, onLate = () => {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, result) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); fn(result);
    };
    const abort = () => finish(reject, signal.reason || new DOMException('Aborted', 'AbortError'));
    const timer = setTimeout(() => finish(reject, new Error('Model decoding timed out. Please retry.')), 30000);
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    promise.then(value => { if (settled) onLate(value); else finish(resolve, value); }, error => finish(reject, error));
  });
}
