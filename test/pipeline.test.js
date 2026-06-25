// End-to-end pipeline tests: run the real convertImage() on each fixture at
// 'draft' quality and assert the result is a valid SVG that re-renders and
// stays perceptually close to the source. Run with: node --test test/pipeline.test.js
//
// Thresholds are deliberately loose. Draft quality + a downsampled DSSIM probe
// has run-to-run variance (tracer/optimizer use randomness), so each ceiling is
// several times the observed worst case — these guard against gross regressions
// (blank/garbage output, classifier mis-routing), not fidelity tuning.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { Resvg } from '@resvg/resvg-js';
import { convertImage } from '../src/core/pipeline.js';
import { analyze } from '../src/core/classify.js';
import { loadImage } from '../src/core/image.js';
import { renderSvgToRgba } from '../src/core/render.js';
import { dssim } from '../src/core/metrics.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixturesDir = join(root, 'fixtures');

// Probe resolution for the DSSIM check. Matches draft workRes so we compare the
// SVG against the same scale the converger optimized at (not the full-res PNG).
const PROBE_RES = 256;

// One row per fixture: which generator script can produce it if missing, the
// classifier type we expect it to route to, and a generous DSSIM ceiling.
const CASES = [
  { name: 'logo',     gen: 'gen-fixtures.js', types: ['illustration', 'flat'], maxDssim: 0.05 },
  { name: 'scene',    gen: 'gen-fixtures.js', types: ['illustration', 'photo'], maxDssim: 0.06 },
  { name: 'gradient', gen: 'gen-fixtures.js', types: ['illustration', 'flat'], maxDssim: 0.05 },
  { name: 'orb',      gen: 'gen-orb.js',      types: ['photo', 'illustration'], maxDssim: 0.06 },
  { name: 'ui',       gen: 'gen-ui.js',       types: ['text'], maxDssim: 0.06 },
];

function ensureFixture(name, genScript) {
  const path = join(fixturesDir, `${name}.png`);
  if (existsSync(path)) return path;
  execFileSync(process.execPath, [join(root, 'scripts', genScript)], { stdio: 'ignore' });
  if (!existsSync(path)) throw new Error(`fixture ${name}.png missing and ${genScript} did not produce it`);
  return path;
}

for (const { name, gen, types, maxDssim } of CASES) {
  test(`pipeline: ${name} converts to a faithful SVG (draft)`, async () => {
    const path = ensureFixture(name, gen);

    const t0 = Date.now();
    const result = await convertImage(path, { quality: 'draft' });
    const elapsed = Date.now() - t0;
    const svg = result.svg;

    // (a) non-empty SVG string
    assert.equal(typeof svg, 'string');
    assert.ok(svg.length > 0, 'svg must be non-empty');
    assert.ok(svg.trimStart().startsWith('<svg'), `svg must start with <svg, got: ${svg.slice(0, 40)}`);
    assert.match(svg, /<\/svg>\s*$/, 'svg must be closed');

    // (b) re-renders via resvg without throwing
    assert.doesNotThrow(() => {
      const r = new Resvg(svg, { fitTo: { mode: 'width', value: PROBE_RES }, font: { loadSystemFonts: false } });
      const img = r.render();
      assert.ok(img.width > 0 && img.height > 0, 'rendered raster must have positive dimensions');
    }, 'rendered SVG must be parseable by resvg');

    // (c) rendered DSSIM vs source is below a generous, per-type ceiling
    const src = await loadImage(path, { maxSize: PROBE_RES });
    const rendered = renderSvgToRgba(svg, src.width, src.height);
    const d = dssim(src.data, rendered.data, src.width, src.height);
    assert.ok(
      Number.isFinite(d) && d >= 0,
      `dssim must be a non-negative number, got ${d}`,
    );
    assert.ok(d <= maxDssim, `${name}: dssim ${d.toFixed(4)} exceeds ceiling ${maxDssim}`);

    // (d) classify returns a sane type, and the pipeline reports the same one
    const analysis = await analyze(path);
    assert.ok(
      ['flat', 'illustration', 'photo', 'text'].includes(analysis.type),
      `unexpected classifier type: ${analysis.type}`,
    );
    assert.ok(
      types.includes(analysis.type),
      `${name}: expected one of [${types.join(', ')}], got ${analysis.type}`,
    );
    assert.equal(result.analysis.type, analysis.type, 'pipeline analysis should match a fresh analyze()');
    assert.ok(analysis.colors > 0, 'color count should be positive');

    // result metadata sanity
    assert.equal(result.plan.quality, 'draft');
    assert.ok(result.metrics.finalBytes > 0);

    console.log(`  ${name}: type=${analysis.type} dssim=${d.toFixed(4)} bytes=${svg.length} ${elapsed}ms`);
  });
}
