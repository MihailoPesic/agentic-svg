// Server smoke test: worker-thread conversions must run concurrently,
// static serving must stay responsive under load, and a client disconnect
// must kill its worker. Plain node, no deps:
//   node scripts/test-server.js

import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '..');
const PORT = 5199;
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
const ok = (cond, label) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${label}`);
  if (!cond) failures++;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function get(path) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    http.get(BASE + path, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body, ms: Date.now() - t0 }));
    }).on('error', reject);
  });
}

function post(path, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = http.request(BASE + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

/**
 * Open an SSE progress stream. Calls onEvent(name, data, stream) per event.
 * Resolves when the stream ends. stream.destroy() aborts it client-side.
 */
function openStream(jobId, onEvent) {
  return new Promise((resolve, reject) => {
    const req = http.get(`${BASE}/api/progress/${jobId}`, (res) => {
      let buf = '';
      res.on('data', (chunk) => {
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const raw = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const ev = { name: 'message', data: null };
          for (const line of raw.split('\n')) {
            if (line.startsWith('event: ')) ev.name = line.slice(7);
            else if (line.startsWith('data: ')) { try { ev.data = JSON.parse(line.slice(6)); } catch {} }
          }
          onEvent(ev.name, ev.data, req);
        }
      });
      res.on('end', resolve);
      res.on('aborted', resolve);
      res.on('error', resolve); // client-side destroy surfaces here; not a failure
    });
    req.on('error', () => resolve()); // destroyed mid-flight
  });
}

async function waitForServer(timeoutMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { const r = await get('/'); if (r.status === 200) return; } catch {}
    await sleep(200);
  }
  throw new Error('server did not come up');
}

async function startJob(image, quality) {
  const r = await post('/api/convert', { image, quality });
  if (r.status !== 200) throw new Error(`convert start failed: ${r.status} ${r.body}`);
  return JSON.parse(r.body).jobId;
}

async function main() {
  const png = await readFile(join(ROOT, 'fixtures', 'scene.png'));
  const image = `data:image/png;base64,${png.toString('base64')}`;

  const server = spawn(process.execPath, [join(ROOT, 'src', 'server', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), AGENTIC_OPEN: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (c) => process.stderr.write(`[server] ${c}`));
  let serverExited = false;
  server.on('exit', () => { serverExited = true; });

  try {
    await waitForServer();
    console.log('server up');

    // --- 1. Two conversions at once: both must finish, and overlap in time.
    const [jobA, jobB] = await Promise.all([startJob(image, 'balanced'), startJob(image, 'balanced')]);
    const track = () => ({ first: 0, done: 0, error: null, events: new Set() });
    const A = track(); const B = track();
    let sawBothActive = false;
    const watch = (state) => (name, data) => {
      state.events.add(name);
      if (!state.first && name !== 'open') state.first = Date.now();
      if (name === 'done') state.done = Date.now();
      if (name === 'error') state.error = data;
    };
    const streams = Promise.all([openStream(jobA, watch(A)), openStream(jobB, watch(B))]);

    // While both run: workers should both be active, and static GET must stay fast.
    let staticMs = null;
    for (let i = 0; i < 200 && !(A.done && B.done); i++) {
      const stats = JSON.parse((await get('/api/stats')).body);
      if (stats.active >= 2) sawBothActive = true;
      if (sawBothActive && staticMs === null) staticMs = (await get('/')).ms;
      await sleep(250);
    }
    await streams;

    ok(A.done > 0 && !A.error, `job A completed with done (events: ${[...A.events].join(',')})`);
    ok(B.done > 0 && !B.error, `job B completed with done (events: ${[...B.events].join(',')})`);
    ok(sawBothActive, 'both workers active simultaneously (stats.active >= 2)');
    const overlap = Math.min(A.done, B.done) - Math.max(A.first, B.first);
    ok(overlap > 0, `streams overlapped in time (${overlap}ms)`);
    ok(staticMs !== null && staticMs < 500, `static GET / during conversions: ${staticMs}ms (< 500ms)`);

    // --- 2. Disconnect mid-conversion must terminate the worker.
    // 'max' quality runs long, so a fast active->0 can only mean terminate().
    const jobC = await startJob(image, 'max');
    let destroyed = 0;
    let sawDoneC = false;
    const cStream = openStream(jobC, (name, data, req) => {
      if (name === 'done') sawDoneC = true;
      // Bail as soon as real work is underway (first trace/refine event).
      if (!destroyed && (name === 'trace' || name === 'refine')) {
        destroyed = Date.now();
        req.destroy();
      }
    });
    await cStream;
    ok(destroyed > 0, 'disconnected mid-conversion (after trace started)');
    ok(!sawDoneC, 'aborted job never reached done');
    let cleared = 0;
    while (Date.now() - destroyed < 5000) {
      const stats = JSON.parse((await get('/api/stats')).body);
      if (stats.active === 0) { cleared = Date.now() - destroyed; break; }
      await sleep(100);
    }
    ok(cleared > 0 && cleared < 5000, `worker terminated after client disconnect (active=0 after ${cleared}ms)`);

    // Server itself must still be healthy after all that.
    ok((await get('/')).status === 200, 'server still serving after disconnect test');
  } finally {
    server.kill();
    await sleep(1500);
    if (!serverExited) { server.kill('SIGKILL'); await sleep(500); }
    ok(serverExited || server.killed, 'server process terminated (no orphan)');
  }

  console.log(failures === 0 ? '\nall server tests passed' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
