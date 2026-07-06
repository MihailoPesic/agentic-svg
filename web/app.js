'use strict';
const $ = (id) => document.getElementById(id);

const state = { imageDataUrl: null, quality: 'balanced', finalSvg: null, traceDssim: null, busy: false };

const QHINTS = {
  draft: 'fastest, fewer shapes, ~1s',
  balanced: 'good fidelity, compact file, ~3s',
  high: 'more shapes, tighter convergence, ~8s',
  max: 'exhaustive refinement, slowest, best quality',
};

// ---- input -----------------------------------------------------------------
const drop = $('drop'), fileInput = $('file');
fileInput.addEventListener('change', (e) => { if (e.target.files[0]) loadFile(e.target.files[0]); });

['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('drag'); }));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('drag'); }));

['dragenter', 'dragover'].forEach((ev) => document.addEventListener(ev, (e) => {
  if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) { e.preventDefault(); drop.classList.add('drag'); }
}));
document.addEventListener('dragleave', (e) => { if (e.relatedTarget === null) drop.classList.remove('drag'); });
document.addEventListener('drop', (e) => {
  const f = e.dataTransfer && fileFromList(e.dataTransfer.files);
  if (f) { e.preventDefault(); drop.classList.remove('drag'); loadFile(f); }
});

document.addEventListener('paste', (e) => {
  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  for (const it of items) {
    if (it.kind === 'file' && it.type.startsWith('image/')) {
      const f = it.getAsFile();
      if (f) { e.preventDefault(); loadFile(f); return; }
    }
  }
});

function fileFromList(list) {
  if (!list) return null;
  for (const f of list) if (f.type.startsWith('image/')) return f;
  return null;
}

function loadFile(file) {
  if (!file || !file.type.startsWith('image/')) { setPhase('not an image file', true); return; }
  const reader = new FileReader();
  reader.onload = () => setImage(reader.result);
  reader.readAsDataURL(file);
}

function setImage(dataUrl) {
  state.imageDataUrl = dataUrl;
  state.finalSvg = null; state.traceDssim = null;
  const im = $('origImg');
  im.src = dataUrl; im.hidden = false;
  $('origEmpty').hidden = true;
  $('cmpImg').src = dataUrl;
  $('resHolder').innerHTML = '';
  $('resEmpty').hidden = false;
  $('resMeta').textContent = 'idle'; $('resMeta').classList.remove('live');
  $('run').disabled = false;
  $('acts').hidden = true;
  $('progFill').style.width = '0%';
  $('stats').innerHTML = '';
  setPhase('ready');
  setCompare(false);
  im.onload = () => { $('origMeta').textContent = `${im.naturalWidth}×${im.naturalHeight}`; };
}

document.querySelectorAll('.chip').forEach((c) => c.addEventListener('click', async () => {
  const url = c.dataset.sample;
  try {
    const blob = await (await fetch(url)).blob();
    loadFile(new File([blob], 'sample.png', { type: blob.type }));
  } catch (e) { setPhase('could not load sample', true); }
}));

// ---- quality ---------------------------------------------------------------
document.querySelectorAll('#quality button').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('#quality button').forEach((x) => x.classList.remove('on'));
  b.classList.add('on');
  state.quality = b.dataset.q;
  $('qhint').textContent = QHINTS[state.quality];
}));

// ---- run -------------------------------------------------------------------
$('run').addEventListener('click', run);
async function run() {
  if (!state.imageDataUrl || state.busy) return;
  state.busy = true;
  $('run').disabled = true;
  $('acts').hidden = true;
  setCompare(false);
  state.traceDssim = null;
  $('resEmpty').hidden = true;
  $('resMeta').textContent = 'starting'; $('resMeta').classList.add('live');
  $('stats').innerHTML = '';
  $('progFill').style.width = '3%';
  setPhase('uploading');

  let jobId;
  try {
    const r = await fetch('/api/convert', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: state.imageDataUrl, quality: state.quality }),
    });
    if (!r.ok) throw new Error(await r.text());
    ({ jobId } = await r.json());
  } catch (e) { fail('upload failed: ' + e.message); return; }

  const es = new EventSource('/api/progress/' + jobId);

  es.addEventListener('queued', (e) => {
    let pos = '';
    try { pos = ' #' + JSON.parse(e.data).position; } catch (_) {}
    setPhase(`waiting for a slot${pos}`);
  });

  es.addEventListener('analysis', (e) => {
    const { analysis, plan } = JSON.parse(e.data);
    const sal = plan && plan.saliency ? ' · saliency on' : '';
    const slow = analysis.type === 'photo' ? ' · photographic image, takes longer' : '';
    setPhase(`${analysis.type} · ${analysis.colors} colors · edges ${analysis.edgeDensity}${sal}${slow} · tracing base`);
    const im = $('origImg');
    $('origMeta').textContent = `${im.naturalWidth}×${im.naturalHeight} · ${analysis.type}`;
  });

  es.addEventListener('trace', (e) => {
    const { svg, rmse } = JSON.parse(e.data);
    showSvg(svg);
    $('resMeta').textContent = 'base trace';
    setPhase(`base trace done, rmse ${rmse.toFixed(4)} · refining`);
  });

  es.addEventListener('refine', (e) => {
    const d = JSON.parse(e.data);
    if (d.svg) showSvg(d.svg);
    $('resMeta').textContent = `+${d.added} shapes`;
    $('progFill').style.width = Math.min(100, (d.i / d.budget) * 100) + '%';
    setPhase(`refine ${d.i}/${d.budget} · kept ${d.added} · rmse ${d.score.toFixed(4)}`);
  });

  es.addEventListener('done', (e) => {
    const res = JSON.parse(e.data);
    es.close(); state.busy = false; $('run').disabled = false;
    state.finalSvg = res.svg;
    showSvg(res.svg);
    $('resMeta').textContent = 'done'; $('resMeta').classList.remove('live');
    $('progFill').style.width = '100%';
    setPhase('converged');
    renderStats(res);
    $('acts').hidden = false;
  });

  es.addEventListener('error', (e) => {
    let msg = 'stream error';
    try { msg = JSON.parse(e.data).message; } catch (_) {}
    es.close(); fail(msg);
  });
}

function fail(msg) {
  state.busy = false; $('run').disabled = false;
  setPhase(msg, true);
  $('resMeta').textContent = 'error'; $('resMeta').classList.remove('live');
}

function setPhase(text, err) {
  const el = $('phase');
  el.textContent = text;
  el.classList.toggle('err', !!err);
}

function showSvg(svg) {
  $('resEmpty').hidden = true;
  $('resHolder').innerHTML = svg;
}

function renderStats(res) {
  const m = res.metrics;
  const tD = m.trace ? m.trace.dssim : null;
  const fD = m.finalDssim;
  state.traceDssim = tD;
  const kb = (m.finalBytes / 1024).toFixed(1);
  const raw = (m.rawBytes / 1024).toFixed(1);
  const method = m.pickedCandidate && m.pickedCandidate !== m.base ? `${m.base} (${m.pickedCandidate})` : (m.base || '—');
  const patched = state.finalSvg && /textpatches/.test(state.finalSvg) ? ' +text patches' : '';
  const parts = [
    `type <b>${res.analysis.type}</b>`,
    `method <b>${method}${patched}</b>`,
    `trace dssim <b>${tD != null ? tD.toFixed(4) : '—'}</b>`,
    `final dssim <b>${fD.toFixed(4)}</b>`,
    `elements <b>${m.elements ?? m.shapesTotal}</b>`,
    `size <b>${kb} kb</b> (raw ${raw})`,
  ];
  if (tD && fD < tD) parts.push(`<span class="good">${(tD / fD).toFixed(1)}× closer than trace</span>`);
  $('stats').innerHTML = parts.join('');
}

// ---- actions ---------------------------------------------------------------
$('download').addEventListener('click', () => {
  if (!state.finalSvg) return;
  const blob = new Blob([state.finalSvg], { type: 'image/svg+xml' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = 'raster2svg.svg'; a.click();
  URL.revokeObjectURL(a.href);
});

$('copy').addEventListener('click', async () => {
  if (!state.finalSvg) return;
  try {
    await navigator.clipboard.writeText(state.finalSvg);
    const b = $('copy'); b.textContent = 'copied'; setTimeout(() => (b.textContent = 'copy'), 1200);
  } catch (_) { setPhase('clipboard blocked', true); }
});

// ---- before/after compare --------------------------------------------------
let comparing = false, comparePos = 50, dragging = false;
const cmp = $('cmp'), cmpBefore = $('cmpBefore'), cmpHandle = $('cmpHandle');

function applyComparePos(pct) {
  comparePos = Math.max(0, Math.min(100, pct));
  cmpBefore.style.clipPath = `inset(0 ${100 - comparePos}% 0 0)`;
  cmpHandle.style.left = comparePos + '%';
  cmpHandle.setAttribute('aria-valuenow', Math.round(comparePos));
}
function setCompare(on) {
  comparing = on;
  cmpBefore.hidden = !on;
  cmpHandle.hidden = !on;
  cmp.classList.toggle('active', on);
  const btn = $('compareBtn');
  btn.textContent = on ? 'hide compare' : 'compare';
  btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  if (on) applyComparePos(comparePos);
}
$('compareBtn').addEventListener('click', () => { if (state.finalSvg) setCompare(!comparing); });

function posFromEvent(clientX) {
  const r = cmp.getBoundingClientRect();
  if (!r.width) return comparePos;
  return ((clientX - r.left) / r.width) * 100;
}
function startDrag(e) {
  if (!comparing) return;
  dragging = true;
  if (cmpHandle.setPointerCapture && e.pointerId != null) cmpHandle.setPointerCapture(e.pointerId);
  applyComparePos(posFromEvent(e.clientX));
  e.preventDefault();
}
cmpHandle.addEventListener('pointerdown', startDrag);
cmp.addEventListener('pointerdown', (e) => { if (comparing && e.target !== cmpHandle && !cmpHandle.contains(e.target)) startDrag(e); });
window.addEventListener('pointermove', (e) => { if (dragging) applyComparePos(posFromEvent(e.clientX)); });
window.addEventListener('pointerup', () => { dragging = false; });
cmpHandle.addEventListener('keydown', (e) => {
  if (!comparing) return;
  if (e.key === 'ArrowLeft') { applyComparePos(comparePos - 4); e.preventDefault(); }
  else if (e.key === 'ArrowRight') { applyComparePos(comparePos + 4); e.preventDefault(); }
  else if (e.key === 'Home') { applyComparePos(0); e.preventDefault(); }
  else if (e.key === 'End') { applyComparePos(100); e.preventDefault(); }
});

// ---- health ----------------------------------------------------------------
fetch('/api/convert', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  .then(() => { $('dot').classList.add('ok'); $('healthText').textContent = 'engine ready'; })
  .catch(() => { $('dot').classList.add('off'); $('healthText').textContent = 'offline'; });
