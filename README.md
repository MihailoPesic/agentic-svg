# agentic-svg

Raster to SVG converter that refines its output in a loop instead of tracing once and stopping — and represents smooth shading with 2D Gaussian splats emitted as plain SVG.

Normal vectorizers (VTracer, Potrace, Illustrator's Image Trace) do a single pass. They're great on flat logos and useless on anything with a gradient, soft shading, or a photo — the output either flattens smooth areas into solid blobs or shatters them into thousands of shapes. agentic-svg traces a base, renders it back to pixels, measures where it's wrong, and spends extra shapes only on those spots. Repeat until it stops improving.

It's the same idea as the research vectorizers (LIVE, DiffVG) but without the differentiable CUDA renderer — greedy hill-climbing does the refinement, so it's plain Node and runs on any machine.

Two things here that I haven't seen shipped elsewhere:

1. **The converge loop itself.** Every open-source tracer is fire-and-forget; this one measures its own output and fixes the worst parts until a perceptual target is hit.
2. **Gaussian-splat shading in pure SVG.** SVG has no gradient meshes, so continuous 2D shading is the thing no vectorizer can represent — flat fills posterize it into rings and bands. But an anisotropic 2D Gaussian is exactly an `<ellipse>` filled with a radial gradient. For shading-heavy images the pipeline greedily fits a few hundred soft Gaussian splats (closed-form optimal color per splat, hill-climbed position/scale/rotation/opacity) over a coarse color skeleton, and the result is glossy, band-free shading in a file that opens in any browser or editor. Same representation as the GaussianImage line of research, minus the GPU, plus a standards-compliant output.

![comparison](web/hero.png)

Left to right: original, one-shot trace, agentic-svg. The middle column is what a normal vectorizer produces; the gradient collapses to a flat fill and the shaded sphere loses its shading.

## Results

Measured by rendering the output SVG back to pixels and comparing to the source (DSSIM, lower is closer):

| image | one-shot trace | agentic-svg | notes |
| --- | --- | --- | --- |
| flat logo | 0.0036 | 0.0025 | clean trace plus a few corrections, 5 KB |
| gradient scene | 0.0357 | 0.0040 | gradient sky recovered |
| radial gradient | 0.066 | 0.0057 | fitted as a real `<radialGradient>`, 0.8 KB |
| photo subject | 0.019 | 0.0068 | shading recovered |
| UI screenshot | unreadable | 0.016 | text stays legible (see below) |

## How it works

```
input
  -> classify (flat / illustration / photo / text)
  -> base: VTracer trace OR a fitted SVG gradient, whichever has lower error
  -> render base to pixels (resvg), build an error map
  -> loop: pick the highest-error region, search a primitive there,
           keep it only if it lowers the error  (shapes capped to the region)
  -> stop on plateau or quality target
  -> if refinement made it perceptually worse than the base, drop it
  -> svgo cleanup
```

A few things worth calling out:

- **Base is whichever is better.** For smooth images a single fitted gradient beats a trace (no banding, a few hundred bytes), so it's used as the seed; otherwise the trace is.
- **Text and screenshots** are traced at ~2x the source resolution. VTracer's curve fitting needs enough pixels per glyph; at native size small text turns to mush, at 2x it stays readable.
- **Shape size is capped** to the local region during refinement. Without that, a shape seeded in a small area can grow to cover the whole image and leave a big translucent smear.
- **Importance weighting** (optional, on for non-flat images) biases refinement toward distinct/central subjects so the foreground stays sharp while a busy background is left approximate.
- **Safety guard:** the refinement objective is RMSE, but on already-clean bases shaving RMSE can add structure that hurts perceptual quality. If the final result scores worse than the base, the refinement layer is thrown away.
- **Gaussian splats for shading.** Shading-heavy images (detected by a smooth-gradient share signal) get two full runs — the flat-fill pipeline and a splat pipeline (coarse color skeleton + greedy Gaussian splat fit confined to smooth regions) — and the better final render wins. Each splat's optimal color has a closed form; the internal alpha profile is defined as the piecewise interpolation of the emitted gradient stops, so what the optimizer scores is exactly what the SVG renders (verified to < 0.011 RMSE against resvg). Gradient defs are deduped by quantized color+opacity, so hundreds of splats share a few dozen defs.

## Benchmark

`node scripts/benchmark.js` scores every contender by rendering its SVG at the source resolution and computing DSSIM against the original — same metric, same renderer, no favorites. Baselines are per-image best-of: VTracer gets both its flat and photo presets, imagetracerjs gets default and high-quality settings, and the better result counts. Table lands in `out/benchmark.md`.

Latest run (13 test images, mean DSSIM, lower is better): agentic-svg high **0.0078** vs 0.0178 for best-of-VTracer and 0.0163 for best-of-imagetracerjs — less than half the error of either, best result on 11 of 13 images. Part of that comes from candidate sets: at high quality some image classes get 2-3 complete runs with different presets in parallel worker threads, and the best finished render wins (with a byte tiebreak so a heavier run must earn its size). Honest losses: imagetracerjs still wins the UI screenshot and fine map-line detail, our outputs cost more bytes than the smaller baseline on most images, and high quality trades wall-clock for the candidate runs (~10s mean on this suite). Full table with per-image numbers and the losses spelled out: `out/benchmark.md` after a run.

## Running it

**Easiest (Windows):** run **`make-shortcut.cmd`** once to put an **agentic-svg**
icon on your desktop, then double-click that icon whenever you want it. It starts
the local app silently (no console window) and opens it in your browser; click it
again any time to re-open the tab. `stop-agentic-svg.cmd` stops it.

Under the hood the desktop icon runs `launch-hidden.vbs` (silent). For a visible
window with logs, or for the very first run, double-click `agentic-svg.cmd`
instead — it installs dependencies the first time.

Otherwise:

```bash
npm install

# web app: drop an image, watch it converge, download the SVG
npm run server          # http://localhost:5173

# CLI
node src/cli.js input.png out.svg --quality high   # draft | balanced | high | max

# tests
npm test
```

## Layout

| path | what |
| --- | --- |
| `src/core/image.js` | decode / resize / fill RGBA buffers |
| `src/core/raster.js` | scanline fill, optimal color, RMSE, compositing |
| `src/core/shapes.js` | triangle / ellipse / rotated rect, region-seeded sampling |
| `src/core/metrics.js` | RMSE, DSSIM, per-block error map |
| `src/core/render.js` | SVG to RGBA via resvg |
| `src/core/trace.js` | VTracer presets |
| `src/core/gradient.js` | fit and emit linear/radial gradients |
| `src/core/regiongradient.js` | per-region gradient fitting |
| `src/core/gradoverlay.js` | gradient overlays on smooth blobs |
| `src/core/splat.js` | Gaussian splat fitting (smooth shading as SVG) |
| `src/core/pathfit.js` | snap traced polylines to true circles/ellipses |
| `src/core/textregions.js` | detect text regions, re-trace and patch them |
| `src/core/tonematch.js` | correct global contrast drift in emitted colors |
| `src/core/sizegov.js` | byte budgets and the coarseness ladder |
| `src/core/saliency.js` | importance map (region distinctiveness + center bias) |
| `src/core/optimizer.js` | the model: seed, hill-climb, error-targeted refinement |
| `src/core/converge.js` | the loop |
| `src/core/dualrun.js` | flat vs splat passes in parallel worker threads |
| `src/core/classify.js` | router (with a 512px text probe) + quality presets |
| `src/core/pipeline.js` | `convertImage()`: dual-run, text patches, tone match, svgo |
| `src/server/server.js` | static host + streaming convert API |
| `web/` | front end |

## Limits

- Photographic content costs bytes: smooth shading and texture are inherently expensive to vectorize. A byte governor caps the pathological cases per quality tier (`max` is uncapped), and capped photos pay a measured fidelity premium for it.
- Very small text below roughly 9px in the source can still smear; there's a limit to what curve fitting can recover. Text regions inside photos are detected and re-traced at high resolution, but lit signs with strong glow remain hit-and-miss.
- Photo conversions at high quality take tens of seconds — two full pipelines run (in parallel threads) plus text patching and tone matching, and that compute is the price of the fidelity.

## License

MIT
