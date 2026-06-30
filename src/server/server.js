// agentic-svg server: static web app + streaming convert API (SSE).
// Zero-framework (Node http) to keep the dependency surface small.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, normalize } from 'node:path';
import { randomUUID } from 'node:crypto';
import { exec } from 'node:child_process';
import { convertImage } from '../core/pipeline.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const WEB = join(__dir, '..', '..', 'web');
const PORT = process.env.PORT || 5173;
const MAX_BODY = 25 * 1024 * 1024; // 25MB upload cap

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json',
  '.png': 'image/png', '.ico': 'image/x-icon',
};

/** Pending jobs: jobId -> { input:Buffer, quality, started:false } */
const jobs = new Map();

const readBody = (req) => new Promise((resolve, reject) => {
  let size = 0;
  const chunks = [];
  req.on('data', (c) => {
    size += c.length;
    if (size > MAX_BODY) { reject(new Error('payload too large')); req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', () => resolve(Buffer.concat(chunks)));
  req.on('error', reject);
});

async function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const safe = normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
  const file = join(WEB, safe);
  if (!file.startsWith(WEB)) { res.writeHead(403); return res.end('forbidden'); }
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404); res.end('not found');
  }
}

const MAX_PENDING = 16; // cap queued jobs so abandoned uploads can't pile up

function reapJobs() {
  const now = Date.now();
  for (const [id, j] of jobs) if (now - j.created > 5 * 60 * 1000) jobs.delete(id);
}

async function handleConvertStart(req, res) {
  try {
    const body = await readBody(req);
    let parsed;
    try { parsed = JSON.parse(body.toString('utf8')); } catch { res.writeHead(400); return res.end('invalid json'); }
    const { image, quality = 'balanced', saliency } = parsed || {};
    if (typeof image !== 'string' || !image) { res.writeHead(400); return res.end('missing image'); }
    const b64 = image.includes(',') ? image.split(',')[1] : image;
    if (b64.length > (MAX_BODY / 3) * 4) { res.writeHead(413); return res.end('image too large'); }
    const buf = Buffer.from(b64, 'base64');
    if (buf.length === 0) { res.writeHead(400); return res.end('empty image'); }
    reapJobs();
    if (jobs.size >= MAX_PENDING) { res.writeHead(429); return res.end('server busy, retry shortly'); }
    const jobId = randomUUID();
    jobs.set(jobId, { input: buf, quality, saliency, started: false, created: Date.now() });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jobId }));
  } catch (e) {
    res.writeHead(400); res.end(String(e.message || e));
  }
}

async function handleProgress(req, res, jobId) {
  const job = jobs.get(jobId);
  if (!job || job.started) { res.writeHead(404); return res.end('no such job'); }
  job.started = true;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const send = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };
  send('open', { jobId });

  let lastPreview = 0;
  try {
    const result = await convertImage(job.input, {
      quality: job.quality,
      optimize: true,
      overrides: typeof job.saliency === 'boolean' ? { saliency: job.saliency } : {},
      onProgress: (p) => {
        if (p.phase === 'analysis') {
          send('analysis', { analysis: p.analysis, plan: p.plan });
        } else if (p.phase === 'trace') {
          send('trace', { svg: p.svg, rmse: p.rmse, dssim: p.dssim });
        } else if (p.phase === 'refine') {
          const ev = { i: p.i, budget: p.budget, added: p.added, score: p.score };
          // Cap previews to ~8 over the whole run regardless of budget — injecting
          // a large SVG too often can stall the browser renderer.
          const stride = Math.max(20, Math.floor(p.budget / 8));
          if (p.i - lastPreview >= stride && p.model) { ev.svg = p.model.toSVG(); lastPreview = p.i; }
          send('refine', ev);
        }
      },
    });
    send('done', {
      svg: result.svg,
      analysis: result.analysis,
      plan: result.plan,
      metrics: result.metrics,
      history: result.history,
    });
  } catch (e) {
    send('error', { message: String(e.message || e) });
  } finally {
    jobs.delete(jobId);
    res.end();
  }
}

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  if (req.method === 'POST' && url === '/api/convert') return handleConvertStart(req, res);
  if (req.method === 'GET' && url.startsWith('/api/progress/')) {
    return handleProgress(req, res, url.slice('/api/progress/'.length));
  }
  if (req.method === 'GET') return serveStatic(req, res);
  res.writeHead(405); res.end('method not allowed');
});

// Reap abandoned jobs even when no new requests arrive.
setInterval(reapJobs, 60 * 1000).unref();

const URL = `http://localhost:${PORT}`;

// Open the default browser when launched as an app (AGENTIC_OPEN=1); a dev
// `npm run server` leaves it off so restarts don't spawn tabs.
function openBrowser() {
  if (process.env.AGENTIC_OPEN !== '1') return;
  const cmd = process.platform === 'win32' ? `start "" "${URL}"`
    : process.platform === 'darwin' ? `open "${URL}"`
      : `xdg-open "${URL}"`;
  exec(cmd, () => {});
}

// If the port is taken, an instance is probably already up — just open it.
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.log(`agentic-svg is already running at ${URL}`);
    openBrowser();
    process.exit(0);
  }
  throw e;
});

server.listen(PORT, () => {
  console.log(`agentic-svg running  ->  ${URL}`);
  openBrowser();
});
