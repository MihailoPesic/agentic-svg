'use strict';
const $ = (id) => document.getElementById(id);

const state = { imageDataUrl: null, quality: 'balanced', finalSvg: null, history: [], traceScore: null, busy: false };

const QHINTS = {
  draft: 'Draft — fastest, fewer shapes. ~1s.',
  balanced: 'Balanced — good fidelity, compact file. ~3s.',
  high: 'High — more shapes, tighter convergence. ~8s.',
  max: 'Max — exhaustive refinement. Slowest, best quality.',
};

// ---- input handling --------------------------------------------------------
const dz = $('dropzone'), fileInput = $('file');
fileInput.addEventListener('change', (e) => { if (e.target.files[0]) loadFile(e.target.files[0]); });

// dropzone highlight on local hover
['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('drag'); }));
['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('drag'); }));

// accept a drop anywhere on the page, not just the dropzone
['dragenter', 'dragover'].forEach((ev) => document.addEventListener(ev, (e) => {
  if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) { e.preventDefault(); dz.classList.add('drag'); }
}));
document.addEventListener('dragleave', (e) => { if (e.relatedTarget === null) dz.classList.remove('drag'); });
document.addEventListener('drop', (e) => {
  const f = e.dataTransfer && fileFromList(e.dataTransfer.files);
  if (f) { e.preventDefault(); dz.classList.remove('drag'); loadFile(f); }
});

// paste image from clipboard (Ctrl+V)
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
  if (!file || !file.type.startsWith('image/')) { $('phase').textContent = '⚠ Not an image file.'; return; }
  const reader = new FileReader();
  reader.onload = () => setImage(reader.result);
  reader.readAsDataURL(file);
}
function setImage(dataUrl) {
  state.imageDataUrl = dataUrl;
  $('origImg').src = dataUrl;
  $('compareImg').src = dataUrl;
  $('stage').hidden = false;
  $('run').disabled = false;
  $('actions').hidden = true;
  $('resHolder').innerHTML = '';
  $('resTag').textContent = 'idle';
  $('phase').textContent = 'Ready to vectorize.';
  $('progFill').style.width = '0%';
  $('stats').innerHTML = '';
  state.history = []; state.traceScore = null; state.finalSvg = null;
  setCompare(false);
  drawChart();
  $('origImg').onload = () => { const im = $('origImg'); $('origTag').textContent = `${im.naturalWidth}×${im.naturalHeight}`; };
}

document.querySelectorAll('.chip').forEach((c) => c.addEventListener('click', async () => {
  const url = c.dataset.sample;
  const blob = await (await fetch(url)).blob();
  loadFile(new File([blob], 'sample.png', { type: blob.type }));
}));

// ---- quality control -------------------------------------------------------
document.querySelectorAll('#quality button').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('#quality button').forEach((x) => x.classList.remove('active'));
  b.classList.add('active');
  state.quality = b.dataset.q;
  $('qhint').textContent = QHINTS[state.quality];
}));

// ---- run -------------------------------------------------------------------
$('run').addEventListener('click', run);
async function run() {
  if (!state.imageDataUrl || state.busy) return;
  state.busy = true;
  $('run').disabled = true; $('actions').hidden = true;
  setCompare(false);
  state.history = []; state.traceScore = null;
  $('resTag').textContent = 'starting…'; $('phase').textContent = 'Uploading…';
  $('progFill').style.width = '2%'; $('stats').innerHTML = '';

  let jobId;
  try {
    const r = await fetch('/api/convert', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: state.imageDataUrl, quality: state.quality }),
    });
    if (!r.ok) throw new Error(await r.text());
    ({ jobId } = await r.json());
  } catch (e) { fail('Upload failed: ' + e.message); return; }

  const es = new EventSource('/api/progress/' + jobId);
  es.addEventListener('analysis', (e) => {
    const { analysis, plan } = JSON.parse(e.data);
    const sal = plan && plan.saliency ? ' · focusing detail on subject (saliency)' : '';
    $('phase').textContent = `Detected: ${analysis.type} · ${analysis.colors} colors · edge density ${analysis.edgeDensity}${sal}. Tracing base…`;
    $('origTag').textContent = `${$('origImg').naturalWidth}×${$('origImg').naturalHeight} · ${analysis.type}`;
  });
  es.addEventListener('trace', (e) => {
    const { svg, rmse } = JSON.parse(e.data);
    state.traceScore = rmse;
    showSvg(svg);
    $('resTag').textContent = 'base trace';
    $('phase').textContent = `Base trace done (RMSE ${rmse.toFixed(4)}). Refining where the error is…`;
    drawChart();
  });
  es.addEventListener('refine', (e) => {
    const d = JSON.parse(e.data);
    state.history.push({ i: d.i, score: d.score });
    if (d.svg) showSvg(d.svg);
    $('resTag').textContent = `refining · ${d.added} shapes`;
    $('progFill').style.width = Math.min(100, (d.i / d.budget) * 100) + '%';
    $('phase').textContent = `Refining — shape ${d.i}/${d.budget}, kept ${d.added}, RMSE ${d.score.toFixed(4)}`;
    drawChart();
  });
  es.addEventListener('done', (e) => {
    const res = JSON.parse(e.data);
    es.close(); state.busy = false; $('run').disabled = false;
    state.finalSvg = res.svg;
    showSvg(res.svg);
    $('resTag').textContent = 'done'; $('progFill').style.width = '100%';
    $('phase').textContent = 'Converged.';
    renderStats(res);
    $('actions').hidden = false;
    drawChart();
  });
  es.addEventListener('error', (e) => {
    let msg = 'stream error';
    try { msg = JSON.parse(e.data).message; } catch {}
    es.close(); fail(msg);
  });
}
function fail(msg) { state.busy = false; $('run').disabled = false; $('phase').textContent = '⚠ ' + msg; $('resTag').textContent = 'error'; }

function showSvg(svg) { $('resHolder').innerHTML = svg; }

function renderStats(res) {
  const m = res.metrics;
  const tD = m.trace ? m.trace.dssim : null;
  const fD = m.finalDssim;
  const improve = tD ? ((1 - fD / tD) * 100) : 0;
  const kb = (m.finalBytes / 1024).toFixed(1);
  const cards = [
    ['Detected', `${res.analysis.type}`, `${res.analysis.colors} colors`],
    ['Trace DSSIM', tD != null ? tD.toFixed(4) : '—', 'one-shot baseline'],
    ['Converged DSSIM', fD.toFixed(4), tD ? `<span class="delta">▼ ${improve.toFixed(0)}% better</span>` : ''],
    ['Shapes', `${m.shapesTotal}`, 'trace + corrections'],
    ['File size', `${kb}<small> KB</small>`, `raw ${(m.rawBytes / 1024).toFixed(1)} KB`],
  ];
  $('stats').innerHTML = cards.map(([k, v, s]) => `<div class="stat"><div class="k">${k}</div><div class="v">${v} <small>${s || ''}</small></div></div>`).join('');
  const win = tD && fD < tD ? `Converged ${(tD / fD).toFixed(1)}× closer than the one-shot trace.` : '';
  $('winline').textContent = win;
}

// ---- error convergence chart ----------------------------------------------
function drawChart() {
  const cv = $('chart'), ctx = cv.getContext('2d');
  const W = cv.width, H = cv.height, pad = 8;
  ctx.clearRect(0, 0, W, H);
  const pts = state.history;
  const all = [];
  if (state.traceScore != null) all.push(state.traceScore);
  for (const p of pts) all.push(p.score);
  if (all.length === 0) { ctx.fillStyle = '#6b7090'; ctx.font = '12px sans-serif'; ctx.fillText('error curve appears here', 14, H / 2); return; }
  const maxV = Math.max(...all) * 1.05, minV = 0;
  const n = pts.length;
  const x = (i) => pad + (i / Math.max(1, n - 1)) * (W - pad * 2);
  const y = (v) => H - pad - ((v - minV) / (maxV - minV || 1)) * (H - pad * 2);

  // trace baseline
  if (state.traceScore != null) {
    ctx.strokeStyle = '#8a8fa6'; ctx.setLineDash([5, 4]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(pad, y(state.traceScore)); ctx.lineTo(W - pad, y(state.traceScore)); ctx.stroke();
    ctx.setLineDash([]);
  }
  // converging curve
  if (n > 1) {
    const grad = ctx.createLinearGradient(0, 0, W, 0);
    grad.addColorStop(0, '#ff7a59'); grad.addColorStop(1, '#63d2ff');
    ctx.strokeStyle = grad; ctx.lineWidth = 2; ctx.beginPath();
    pts.forEach((p, i) => { const px = x(i), py = y(p.score); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); });
    ctx.stroke();
    // area
    ctx.lineTo(x(n - 1), H - pad); ctx.lineTo(x(0), H - pad); ctx.closePath();
    ctx.fillStyle = 'rgba(255,122,89,.08)'; ctx.fill();
    // last point
    const last = pts[n - 1];
    ctx.fillStyle = '#63d2ff'; ctx.beginPath(); ctx.arc(x(n - 1), y(last.score), 3, 0, 7); ctx.fill();
  }
}

// ---- actions ---------------------------------------------------------------
$('download').addEventListener('click', () => {
  if (!state.finalSvg) return;
  const blob = new Blob([state.finalSvg], { type: 'image/svg+xml' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = 'svgforge.svg'; a.click();
  URL.revokeObjectURL(a.href);
});
$('copy').addEventListener('click', async () => {
  if (!state.finalSvg) return;
  await navigator.clipboard.writeText(state.finalSvg);
  $('copy').textContent = 'Copied ✓'; setTimeout(() => ($('copy').textContent = 'Copy SVG'), 1200);
});
// ---- before / after compare slider ----------------------------------------
let comparing = false, comparePos = 50;
const compare = $('compare'), compareBefore = $('compareBefore'), compareHandle = $('compareHandle');

function applyComparePos(pct) {
  comparePos = Math.max(0, Math.min(100, pct));
  // original is revealed on the left of the handle
  compareBefore.style.clipPath = `inset(0 ${100 - comparePos}% 0 0)`;
  compareHandle.style.left = comparePos + '%';
  compareHandle.setAttribute('aria-valuenow', Math.round(comparePos));
}
function setCompare(on) {
  comparing = on;
  compareBefore.hidden = !on;
  compareHandle.hidden = !on;
  compare.classList.toggle('active', on);
  const btn = $('toggleView');
  btn.textContent = on ? 'Hide compare ⇄' : 'Compare ⇄';
  btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  if (on) applyComparePos(comparePos);
}
$('toggleView').addEventListener('click', () => { if (state.finalSvg) setCompare(!comparing); });

function posFromEvent(clientX) {
  const r = compare.getBoundingClientRect();
  if (!r.width) return comparePos;
  return ((clientX - r.left) / r.width) * 100;
}
let dragging = false;
function startDrag(e) {
  if (!comparing) return;
  dragging = true;
  compareHandle.setPointerCapture && e.pointerId != null && compareHandle.setPointerCapture(e.pointerId);
  applyComparePos(posFromEvent(e.clientX));
  e.preventDefault();
}
function moveDrag(e) { if (dragging) applyComparePos(posFromEvent(e.clientX)); }
function endDrag() { dragging = false; }
compareHandle.addEventListener('pointerdown', startDrag);
// allow grabbing anywhere on the comparison area
compare.addEventListener('pointerdown', (e) => { if (comparing && e.target !== compareHandle && !compareHandle.contains(e.target)) startDrag(e); });
window.addEventListener('pointermove', moveDrag);
window.addEventListener('pointerup', endDrag);
compareHandle.addEventListener('keydown', (e) => {
  if (!comparing) return;
  if (e.key === 'ArrowLeft') { applyComparePos(comparePos - 4); e.preventDefault(); }
  else if (e.key === 'ArrowRight') { applyComparePos(comparePos + 4); e.preventDefault(); }
  else if (e.key === 'Home') { applyComparePos(0); e.preventDefault(); }
  else if (e.key === 'End') { applyComparePos(100); e.preventDefault(); }
});

// ---- health ----------------------------------------------------------------
fetch('/api/convert', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  .then((r) => { $('status').classList.add('ok'); $('statusText').textContent = 'engine ready'; })
  .catch(() => { $('statusText').textContent = 'offline'; });

drawChart();
