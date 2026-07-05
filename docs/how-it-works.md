# How agentic-svg works

A technical walkthrough of the conversion pipeline, the algorithms behind each
stage, and the design decisions that matter.

## The core idea

Every ordinary vectorizer (VTracer, Potrace, Illustrator's Image Trace) is a
single pass: quantize colors, trace each region's boundary, emit paths, stop. It
never looks at its own output. That's why it flattens a gradient into bands and
shatters a photo into thousands of shapes.

agentic-svg closes the loop:

```
trace a base  ->  render it to pixels  ->  measure where it's wrong
      ^                                              |
      |                                              v
      +---------  add a shape there if it helps  <---+
                  (repeat until it stops improving)
```

This is the strategy behind the research vectorizers (LIVE, DiffVG) without
their differentiable CUDA rasterizer. Instead of gradient descent on path
control points, the refinement is greedy hill-climbing over geometric
primitives (the `primitive`/Geometrize family). It's plain Node, no GPU.

## Pipeline overview

`convertImage(input, { quality })` in `src/core/pipeline.js` runs five stages:

1. **classify** — what kind of image is this?
2. **plan** — turn the class + quality dial into concrete engine settings.
3. **converge** — build a base, then refine it against a measured error map.
4. **finalize** — SVGO cleanup.
5. **report** — honest metrics (real element count, file size, DSSIM).

Everything below lives under `src/core/`.

## 1. Classify (`classify.js`)

`analyze()` decodes the image at 128px and computes three cheap signals:

- **color count** — distinct colors quantized to 4 bits/channel (4096 buckets).
- **edge density** — fraction of pixels whose luma gradient exceeds a threshold.
- **smoothness** — `1 - mean(gradient)`, how much flat/smooth area there is.

It routes to one of four types:

- `text` — edge density in a **band** `[0.15, 0.42)` with `<= 200` colors. The
  band is the key trick: genuine UI/screenshot text has lots of thin high-
  contrast strokes (so density is high) but bold-outlined art (stickers, comics)
  sits *below* the band and pure noise sits *above* it. This keeps bold art out
  of the expensive text path.
- `flat` — very few colors, low edge density (logos, icons).
- `illustration` — moderate colors and edges.
- `photo` — everything else (high color count / high edge density).

## 2. Plan (`classify.js` `planConversion`)

The **quality dial** (`draft` / `balanced` / `high` / `max`) maps to compute
budget and stop targets:

| quality | workRes | traceRes | shape budget | target DSSIM |
| --- | --- | --- | --- | --- |
| draft | 256 | 700 | 60 | 0.02 |
| balanced | 320 | 1000 | 160 | 0.006 |
| high | 384 | 1400 | 320 | 0.003 |
| max | 448 | 2000 | 600 | 0.0015 |

`workRes` is the resolution the refinement loop runs at (everything scales with
pixel count, so this is the main speed lever). `traceRes` is separate and
usually higher, so the base trace keeps crisp edges while the loop stays cheap.

The type then overrides specifics:

- **text** — trace preset with high color precision + low speckle, and
  **upsample ~2x before tracing** (`traceEnlarge`). VTracer's curve fitting
  needs enough pixels per glyph; at native size small text smears, at 2x it
  stays legible. Refinement is kept minimal (it only smears glyphs).
- **photo** — `poster` trace preset (polygon mode, fine color layers) and soft
  **rotated-ellipse** refinement at low alpha over fine cells, which dissolves
  banding instead of stamping flat polygon slabs.
- **flat / illustration** — opaque `any`-shape refinement.

## 3. Converge (`converge.js`) — the loop

### Working canvas and coordinate spaces

The image is loaded at `workRes`. The trace is done at `traceRes` (which can be
larger), so the **base lives in trace-space** and the **refinement lives in
work-space**. A single number, `refineScale = traceW / workW`, bridges them: the
refinement `<g>` in the output SVG carries `transform="scale(refineScale)"`.
This is how a cheap low-res refinement composites correctly over a crisp
high-res trace.

### Base selection (best of four)

The base is whichever of these wins, in order — each only replaces the current
base if it measurably beats it:

1. **VTracer trace** (`trace.js`, `@neplex/vectorizer`) — the default skeleton:
   clean, layered, semantic.
2. **Whole-image gradient** (`gradient.js`) — if one fitted linear/radial
   gradient beats the trace RMSE by 15%, use it. A smooth gradient becomes a
   few hundred bytes with zero banding (the radial-gradient test case ships at
   0.8 KB). The fit is non-parametric: project pixels onto an axis (linear) or
   distance-from-center (radial), bin them, take each bin's mean color; the
   center is found by searching luma-extreme centroids + a grid.
3. **Per-region gradient** (`regiongradient.js`) — segment the image
   (quantize -> connected components -> merge tiny ones) and fit a gradient per
   region, for images that are several smooth regions (a sky + ground). Gated by
   a `fragmented` flag so noise (which shatters into hundreds of confetti
   regions) falls back to the trace.
4. **Gradient overlay** (`gradoverlay.js`) — *additive*. Finds the large smooth
   *blobs* (a shaded sphere, a sun, a face) via a smoothness mask + blob/ellipse
   fit, and overlays one native `<radialGradient>` per blob on top of whatever
   base was chosen. This is what kills "concentric ring" banding on an object
   embedded in a textured scene, where a whole-image or per-region fit can't
   help. Applied only if it improves the rendered base; the blob's own
   silhouette is the fill path, so features (eyes, sparkles) show through.

The chosen base is rendered to pixels — that raster is the **seed canvas** the
refiner starts from and measures against.

### When to refine (and when not to)

Two gates stop refinement from making things worse:

- **Clean-base gate** — if the base already matches the image closely
  (DSSIM < 0.013), skip refinement entirely. On clean art the trace is already
  good and primitive refinement only stamps faceted polygons over crisp edges
  while shaving imperceptible RMSE. This is a direct consequence of the
  RMSE-vs-perception gap: lower pixel error can look worse.
- **Overlay-region mask** — where the gradient overlay painted a smooth blob,
  the refiner's importance weight is set to zero there, so it can't re-facet the
  sphere it just smoothed. (The overlay's coverage is rendered to a mask to find
  those pixels.)

### The refinement step (`optimizer.js` `Model.refineStep`)

One step:

1. Build a **per-block error map** over the current canvas vs the target,
   optionally multiplied by an **importance map** (saliency: region
   distinctiveness + a center prior, from `saliency.js`).
2. Pick a high-error cell by error-weighted random choice over the top-K (so it
   spreads across hot regions instead of hammering one).
3. Expand that cell into a search region. Generate candidate shapes seeded
   inside it; **hill-climb** each (mutate one parameter, keep the mutation if it
   lowers the error, repeat until it stalls).
4. Keep the best candidate only if it lowers whole-image error past a small
   epsilon.

Shapes are Triangle / Ellipse / RotatedEllipse / RotatedRectangle
(`shapes.js`). Each can rasterize itself to scanlines, mutate by a small
gaussian perturbation, and emit an SVG element.

Two caps keep shapes sane:

- **Area cap** — a shape can't cover more than a few neighbouring cells (and
  never more than ~6% of the image). Stops big translucent blobs.
- **Extent cap** — a shape's bounding-box span is bounded too. A thin sliver
  triangle has tiny area but can stretch across the whole image; the area cap
  alone misses it, so both are needed.

### Fast, exact scoring

Re-rendering and re-scoring the whole image per candidate would be far too slow.
Instead:

- A shape rasterizes to **scanlines** (`{y, x1, x2}` runs).
- `computeColor` finds the optimal flat fill for compositing that shape (with
  alpha) over the current canvas to best match the target, analytically, over
  just the covered pixels.
- `differencePartial` computes the would-be new RMSE by adjusting only the
  covered pixels' contribution — `O(shape area)`, not `O(image)`.
- The working canvas is **Float32**, not Uint8. Integer rounding would drift the
  incremental score over hundreds of shapes and corrupt the greedy decisions;
  floats keep `differencePartial` exact. Pixels are quantized only at output.

### Stopping

The loop ends on the first of: shape budget hit, a **plateau** (the last N
shapes barely moved the score), a **target DSSIM** reached, or a stall (too many
rejected candidates in a row).

### Two post-loop guards

- **Prune pass** — replay the kept shapes from the base with a stricter
  acceptance bar, dropping the marginal ones that only show up as background
  residue or stray smears (and shrink the file). Reverted if it raises RMSE more
  than 12% (some images genuinely need every shape).
- **Revert guard** — if the final result is perceptually worse than the base
  (DSSIM), throw away the whole refinement layer and ship the clean base.
  Converged is never worse than the base.

### Gaussian-splat shading (the smooth-shading representation)

SVG has no gradient meshes, so continuous 2D shading is unrepresentable with
flat fills — quantize-and-trace turns a shaded sphere into concentric rings no
matter how many layers you spend. The way out: an anisotropic 2D Gaussian is
exactly an `<ellipse>` filled with a radial gradient whose stops sample the
Gaussian falloff. `splat.js` fits them greedily:

- A splat has center, two scales, rotation, peak opacity and a color. Its
  per-pixel alpha is `A·exp(-d²/2)` (Mahalanobis d), cut at 2.5σ.
- The optimal color over the current canvas has a closed form
  (`c = Σ a(t − cur(1−a)) / Σ a²` per channel), and the error delta is computed
  over just the footprint — so the greedy add-one, hill-climb-it loop from the
  primitive refiner carries over unchanged.
- The internal alpha profile is *defined as* the piecewise-linear interpolation
  of the emitted gradient stops, so the optimizer scores exactly what resvg and
  browsers render (verified < 0.011 RMSE on random splat stacks).
- Placement is confined to smooth regions by weighting the error map with an
  inverse-local-variance mask; texture and edges stay with the primitive
  refiner. Gradient defs are deduped by quantized (color, opacity), so a few
  hundred splats share a few dozen defs.

Because a coarse base helps splats (a fine trace averages shading correctly and
leaves zero-mean residual no smooth splat can improve), shading-heavy images
get **two complete runs** — the normal flat-fill pipeline and a
coarse-skeleton+splats pipeline — and whichever *finished* render scores closer
wins. Base-stage scores mispredict the final, so the pick happens at the end.

## 4. Output and finalize

`Model.toSVG` emits:

```
<svg viewBox="0 0 traceW traceH" width="origW" height="origH">
  <clipPath id="frame"><rect .../></clipPath>
  <g clip-path="url(#frame)">          <!-- everything clipped to the image -->
    <rect fill="avg colour"/>          <!-- background -->
    <g id="base">...trace / gradient...</g>
    <g id="refine" transform="scale(refineScale)">...primitives...</g>
  </g>
</svg>
```

The **clip** matters: a `viewBox` is only a coordinate map, not a clip. A shape
may legitimately overhang an edge (only its in-bounds part is scored), but
without the clip that overhang renders into the letterbox margins when a wide
image sits in a tall viewport. Wrapping all content in a clip to the image
rectangle makes out-of-frame geometry structurally impossible.

`finalizeSvg` then runs SVGO (preset-default, 2-decimal precision, ids kept so
the base/refine/clip structure survives) to strip the slack.

## 5. Metrics (`metrics.js`)

- **RMSE** — drives the inner loop (cheap, exact, incremental).
- **DSSIM** — `(1 - MSSIM) / 2` via `ssim.js` (bezkrovny variant), used for the
  gates, the revert guard, and reporting. It's the perceptual check that catches
  cases where RMSE and "how it looks" disagree.
- **error map** — per-block summed squared error, optionally importance-weighted,
  that tells the refiner where to spend shapes.

A note on DSSIM: it's good but not perfect — it under-credits smooth-gradient
restoration, so a visual win (banding removed) can show a flat or slightly worse
DSSIM. The pipeline gates on it conservatively and leans on RMSE + direct visual
checks where they diverge.

## Server and web app

`src/server/server.js` is a zero-framework Node HTTP server: it serves the
static front end and exposes a streaming convert API. `POST /api/convert`
returns a job id; `GET /api/progress/:id` is a Server-Sent-Events stream that
emits `analysis`, `trace`, `refine` (with throttled live-preview SVGs), and
`done` events, so the browser watches the error curve drop and the SVG build up
in real time. It validates input size, caps concurrent jobs, and reaps
abandoned ones.

`web/` is vanilla HTML/CSS/JS — no build step, no framework, no external
requests. Drag-drop / paste / file input, the quality dial, a live preview, a
before/after compare slider, an error-convergence chart, and download/copy.

## Performance

- The loop runs at `workRes` (256-448px); a typical convert is ~1-9s depending
  on quality and shape count.
- `differencePartial` (covered-pixels-only scoring) is the main reason it's
  tractable.
- `src/core/pool.js` is a `worker_threads` pool that can parallelize candidate
  evaluation across cores. It's provided as a module; wiring it into the hot
  path is the obvious next speed step (the server currently runs one conversion
  at a time).

## Where it's strong and where it isn't

Strong: logos and flat art (clean trace), smooth gradients (fitted as native
gradients, sub-kilobyte), gradient *objects* like a shaded sphere or sun
(overlay), UI screenshots (legible text via 2x-trace), and anything one-shot
tracers flatten or shatter.

Honest limits:

- **Dense photographic shading** — a busy photo with continuous gradients
  *everywhere* is the hard frontier. The overlay catches discrete blobs; it
  doesn't yet reconstruct continuous shading across a whole scene (that's
  gradient-mesh / diffusion-curve territory, which SVG can't even represent
  natively without a custom renderer).
- **Lumpy primitives** — VTracer traces curves as polylines, so a circle can be
  slightly wavy at high zoom; true primitive/Bezier fitting (detecting a real
  circle/ellipse) would close that, and is a larger build.
- Very small text (below ~9px in the source) can still smear — there's a floor
  to what curve fitting can recover.

## File map

| file | role |
| --- | --- |
| `src/core/image.js` | decode / resize / fill RGBA buffers (sharp) |
| `src/core/raster.js` | scanline fill, optimal color, RMSE (full + partial), compositing |
| `src/core/shapes.js` | triangle / ellipse / rotated rect, region-seeded sampling |
| `src/core/metrics.js` | RMSE, DSSIM, per-block error map |
| `src/core/render.js` | SVG -> RGBA via resvg |
| `src/core/trace.js` | VTracer presets (flat / text / poster) |
| `src/core/gradient.js` | whole-image linear/radial gradient fit |
| `src/core/regiongradient.js` | per-region gradient fit |
| `src/core/gradoverlay.js` | gradient overlay on smooth blobs |
| `src/core/saliency.js` | importance map (region distinctiveness + center bias) |
| `src/core/optimizer.js` | the Model: seed, hill-climb, error-targeted refinement, prune, SVG out |
| `src/core/converge.js` | the loop: base selection, gates, refine, guards |
| `src/core/classify.js` | router + quality presets |
| `src/core/pipeline.js` | `convertImage()` + SVGO finalize |
| `src/core/pool.js` | worker-thread pool (optional parallelism) |
| `src/server/server.js` | static host + streaming convert API |
| `web/` | front end |
