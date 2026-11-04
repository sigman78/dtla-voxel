# Compact voxel rendering and bounded adaptive streaming

Status: implemented and reviewed; correctness and performance validation complete.

Scope: items 1–3 in the research summary: remove unused/duplicated data, demand-driven mixed LOD, and 16-byte quad rendering. Source: [research](../voxel-performance-proposal.html). Existing vegetation/data edits are outside this feature.

## November 4 follow-up: measurements and chosen direction

The current direction is to reuse coarser existing tiles for shadow LOD and tighten
per-pass frustum culling. Offline shadow-only assets remain a deferred experiment;
there is no new mesh asset format or build pipeline enabled.

The offline experiment is reproducible with `node tools/bench-mesh-merging.mjs`
from `web/`. Its [raw measurements](../measurements/mesh-merging-sample.json) are
stored in the repository rather than only in ignored local artifacts. The samples
are the two largest gzip files in each of levels 1, 1f and 2, not a representative
whole-scene benchmark. Counts below are quads (each draws two triangles).

| Tile | Existing | Ignore baked AO | Shadow-only merge |
|---|---:|---:|---:|
| 1/15_5 | 21,557 | 15,392 | 9,426 |
| 1/20_6 | 31,313 | 23,004 | 14,058 |
| 1f/22_8 | 32,083 | 25,231 | 18,138 |
| 1f/17_7 | 26,120 | 20,141 | 14,599 |
| 2/7_2 | 29,990 | 24,087 | 15,165 |
| 2/15_0 | 32,041 | 25,482 | 15,036 |

Ignoring AO in the greedy-merge key reduced sampled geometry by 20–29%, with a
visible shading tradeoff. Ignoring all shading attributes for a shadow-only mesh
reduced it by 43–56%. Canonical oriented surface coverage matched exactly for all
six samples. This is not a measured FPS gain: a dedicated shadow mesh would add
asset/buffer ownership and build work. Ordinary mesh concatenation reduces draw
calls, not triangle counts; prebuilding the existing meshes only moves CPU work
offline. Neither is sufficient evidence to replace the current compact format.

Earlier local desktop measurements (GTX 1080 Ti, Chrome, 1600×1000, DPR 1) compared
the civic view with forced shadow redraws: visible-detail casters submitted 713
draw calls and 14.57 million triangles per full frame; a 2 m shadow cap submitted
377 calls and 9.44 million triangles. Main-pass GPU time was approximately 13.8 ms
and 9.0 ms respectively in separate runs. These are descriptive desktop samples,
not M1/tablet results or controlled estimates of the shadow pass alone.

Camera stabilization was also invalidating shadows on every matrix change. The
fit now retains padded world-space coverage until the requested region escapes
or a substantial zoom warrants a smaller fit. Sun/caster changes remain immediate.
Forced-redraw image comparisons pass for small pans, orbit, zoom, sunlight and resize.

### More aggressive existing LOD and tighter culling

The default shadow cap is now 4 m. Near-camera nodes still refine below that cap,
with 192 m entry / 256 m exit hysteresis; no separate mesh assets are generated.
`?shadowlod=1|2|4|8` provides comparisons. Tile meshes and their shadow proxies use
the worker's emitted-face bounding boxes instead of loose spheres. Bounds are
transformed by each object's world matrix, and each render pass tests its own
frustum. A caster outside the viewing camera remains eligible in the light frustum.

The [paired capture](../measurements/shadow-culling-comparison.json) holds visible
geometry fixed in one browser session, at 1600×1000, DPR 1 on the same GTX 1080 Ti.
Shadow redraws are forced in each measured frame. Each sample lasts 3.5 seconds;
2 m/sphere and 4 m/box were repeated at the end to check drift. Counts include all
frame passes; GPU time below is the main render pass including shadows.

| Shadow cap / culling | Draw calls | Triangles | Main GPU pass |
|---|---:|---:|---:|
| 2 m / sphere | 378 | 9,446,430 | 8.44 ms (two-sample mean) |
| 4 m / sphere | 326 | 7,341,054 | 7.22 ms |
| 4 m / box | 292 | 6,564,148 | 6.71 ms (two-sample mean) |
| 8 m / box | 276 | 5,529,964 | 6.11 ms |

Choose 4 m as the default: about 31% fewer triangles, 23% fewer draw calls and 20%
less main-pass GPU time than 2 m/sphere in this view. Box culling alone reduced
triangles about 11% at 4 m. The 8 m option is available for experiments, but that
exported level omits thin-detail geometry and has coarser silhouettes. These are
local desktop results, not promises of equivalent mobile gains. Coarser shadow
shapes are a quality tradeoff; tight box culling is conservative and must preserve
the image relative to sphere culling at the same LOD.

Validation passed: production build; unit tests for boundary inclusion, transformed
bounds, proxy cloning and independent camera/light frusta; browser checks for
coverage, navigation, sun changes and WebGL context restoration. The same-LOD
box/sphere image comparison stayed within the existing tight raster tolerance
(mean channel difference 0.116/255; 0.044% of channels differed by more than 8/255).
That scene also drew 37 off-camera shadow proxies, verifying that camera culling
does not remove shadow contributors. Nine cached/forced-shadow scenarios passed.

Reproduce from `web/` with Vite on port 5177:

```powershell
$env:VARIANTS = 'shadow-2-sphere,shadow-4-sphere,shadow-4-box,shadow-8-box,shadow-4-box,shadow-2-sphere'
node tools/profile-streaming.mjs ../artifacts/profiling/shadow-culling-comparison.json
node tools/test-tile-culling.mjs
node tools/check-shadow-lod.mjs
```

## Intended behavior

The default viewer keeps a complete coarse city and refines useful regions using projected voxel size, with bounded requests and residency. Nearby foliage arrives with its base tile. Queries retain merged occupancy intervals instead of palette runs. Four vertices are reconstructed from one tile-local quad record in every geometry pass. Explicit `?lod=1|2|4|8` remains the fixed-detail diagnostic path.

## Implementation sequence

1. Extract pure tile decoding, query compaction and quad codec helpers. Decode aligned source ranges as views, copy only retained compact products. Preserve emitted corner order and AO. Validate against the original mesher and World query behavior.
2. Emit 16-byte quad records directly in the worker, omitting the unused scale. Use instanced unit quads, local mesh origins, conservative worker-computed bounds and matching standard/depth/distance shader decoding. Keep a diagnostic expanded format for visual/performance comparisons. No large shared dynamic index buffer.
3. Add job identities, fetch cancellation, bounded worker concurrency, retry state, obsolete-reply rejection, byte accounting and eviction. Share occupancy-only base data with foliage; foliage needs solid occupancy, not palette. Bound upload admission per frame.
4. Add pure adaptive selection over the existing 8/4/2/1 grid. Use conservative content bounds, screen-space thresholds and hysteresis; prioritize visible/nearby regions and offscreen shadow dependencies. Cap refinement by a leaf/estimated-byte budget. Retain root fallback and ancestors until complete descendant coverage is ready. Query fallback remains available after fine-tile eviction.
5. Integrate progressive foliage, readiness, labels, shadow invalidation and fixed-LOD override. Avoid settled selection work. Validate failures, stale replies, movement, eviction and context restoration.
6. Measure fixed-detail packing separately from adaptive selection. Record memory, GPU/CPU time and limitations; reassess next priorities.

## Review decisions before implementation

- Accept compact quads only with identical decoded corners, palette, ground, normals and AO. The renderer must decode in shadows as well as color; N8AO uses scene depth, so its geometry passes need the same positions.
- Use existing closed tile border faces. They prevent open sides at independently replaced LOD boundaries; coarse silhouettes can still step and require visual review. Do not remove border faces in this feature.
- Refine sibling coverage atomically. Never interpret network failure as an empty tile. A failed descendant leaves its parent visible.
- Retain coarse root query coverage, with fine query tiles around navigation. Occupancy merging preserves solid/top semantics at a fixed level; coarse queries remain an approximation, as already true under the fixed coarse override.
- Do not globally hide tiles merely because they are outside the camera frustum. Select conservative shadow dependencies and let each render pass apply its own frustum.
- Use one job per worker to bound synchronous mesh work; cancel fetches and reject stale jobs by identity. Cancel messages cannot interrupt synchronous meshing.
- Track unique bytes, separate desired/active/pinned sets, and dispose inactive geometry. Instanced unit indices are tiny and owned per geometry, avoiding the existing large shared-index disposal hazard.
- Keep packed attributes available for context restoration initially. Their 3× smaller payload plus bounded residency is preferable to an unimplemented null-array recovery path. Reassess CPU duplicates after validation.
- No GPU occlusion queries, offline mesh assets, new codec dependency, or quality reductions to postprocessing in this feature.

## Validation gates

- Pure checks: source decode views; occupancy equivalence over exported columns; packed quad round trip against baseline emitted vertices, all six orientations and AO diagonals; selector coverage, bounded refinement and hysteresis.
- Browser: TypeScript/build; no shader/WebGL errors; packed versus expanded fixed-camera screenshots including forced shadows, night and AO; cached shadow correctness; adaptive load, fast turns, fallback coverage, bounded queues/residency, retries, context restoration.
- Repeated profiles: fixed 1 m/4 m packed versus expanded, adaptive overview and Civic Center, stationary and motion. Keep raw artifacts, hardware/settings and actual limitations in this file.
- Re-evaluate based on measured results. Do not claim lower vertex storage implies lower frame time.

## Results

### Review outcomes

The implementation preserves the existing data export. No offline mesh assets or new runtime dependency were introduced. It uses:

- Eight Uint16 fields per quad (16 bytes), emitted directly by the mesher. There is no expanded intermediate vertex array in the normal worker path. `?geometry=expanded` remains an A/B diagnostic.
- Uint32 query offsets, Uint8 ground and two Uint16 values per contiguous occupied interval. Palette and counts are no longer retained for queries. Foliage receives a copy of occupancy intervals only.
- A full coarse-root fallback, 2 px refinement / 1.5 px coarsening thresholds, a 384-leaf cap and 128 MiB estimated leaf budget. A 192 MiB resident-pressure target coarsens selection when necessary. These account for geometry/query payloads, not whole-process/GPU memory; active fallback and an individual large result can exceed a target transiently. Explicit fixed LOD bypasses adaptive residency limits for diagnostics.
- Small touch screens retain the former 4 m minimum detail (or the nearest available finer level), with a 192-leaf / 64 MiB selection budget and 96 MiB resident-pressure target. Desktop defaults are not applied indiscriminately to phones. This preserves the existing device policy; mobile GPU performance still needs physical-device testing.
- Up to four workers with one job each, fetch cancellation, generation IDs, stale-reply rejection, exponential retry delays capped at 30 seconds, a 4 MiB pending-output backpressure threshold and approximately 2 MiB output admission per frame (at least one tile makes progress).
- Hidden replacement attribute uploads using a zero-index staging render. Complete sibling coverage replaces its parent atomically; failed children retain fallback. Inactive tiles receive a two-second grace period before eviction unless memory pressure requires earlier removal.
- Conservative camera and projected shadow-footprint selection, plus fine-data preference within 192 m of the camera. Each render pass retains its own normal frustum test. Roots stay resident for queries. Cached coarse query data cannot mask a finer tile at a later query point.
- Retained compact arrays and context-loss cleanup, allowing geometry to upload again after restoration. Generated environment and shadow resources are rebuilt. CPU copies are intentionally retained for recovery; they are not counted as a second GPU allocation in payload tables.

Review rejected a blanket AABB-culling replacement: research did not establish a net timing gain. Per-tile tight export bounds, certified error bounds, adjacency-constrained LOD seams, a persistent mesh cache and GPU occlusion remain outside this implementation. Existing closed tile sides preserve closed coverage; different resolutions can still change silhouettes and surface steps.

### Correctness evidence

- `node tools/test-voxel.mjs`: all 1,304 base files, 21,307,069 compact intervals, 344,010 sampled quads, 20,000 ground/top/solid query points and 100 raycasts passed. Eight predefined views passed selector partition and budget checks. Differential references use repository revision `c043114ea9a266e383f61f7ae45611ca365e3919`, which must exist in local Git history.
- Browser validation (local generated report): fixed-1 m packed/expanded images matched exactly at day and night, both raw scene and postprocessed, with forced shadows. Navigation, injected HTTP failure/retry, rapid changes, cancellation, eviction and context restoration passed without page/WebGL errors.
- 438 transition coverage samples found no uncovered or overlapping base-tile regions. Peak retained geometry/query/pending payload was 170.7 MiB during that 1200 × 800 route. The route exercised 1,287 evictions and nine cancelled/stale jobs; counts can vary with timing.
- Shadow checks (local generated report): no missed invalidation across 223 base and 222 foliage loading batches. Settled frames submitted no shadow draws; pan, zoom, orbit, hour/date, night and resize matched forced redraws within the existing tolerance.
- The context-loss test exposed invalid disposal of old GPU handles after restoration; cleanup now occurs while the context is lost. Eviction after restoration is also checked.
- `npm run build` passed. Production smoke checks (local generated report) passed for desktop and an emulated 390 × 844 touch screen at DPR 2: desktop Civic selected all four levels; touch selected only 4/8 m. This validates policy and bundle integration, not physical mobile-GPU speed.

### Performance and re-evaluation

Repeated measurements used Chromium 156, GTX 1080 Ti / ANGLE D3D11, i7-9700K, 1600 × 1000, DPR 1, November 2 at 13:00, the existing postprocessing and cached shadows. Values below average two six-second sample means. The earlier baseline uses the same vegetation export. These are sequential local experiments, not randomized multi-device results.

| View / mode | Frame mean / p95 ms | Scene GPU ms | Composer CPU ms | Geometry MiB | Query MiB |
|---|---:|---:|---:|---:|---:|
| Overview, original fixed 1 m | 22.48 / 24.15 | 21.19 | 7.91 | 621.10 | 354.42 |
| Overview, adaptive packed | 6.06 / 6.20 | 3.90 | 0.79 | 28.90 | 12.22 |
| Civic, original fixed 1 m | 6.24 / 7.45 | 4.81 | 3.29 | 621.10 | 354.42 |
| Civic, adaptive packed | 6.81 / 10.15 | 5.60 | 1.80 | 110.31 | 51.55 |
| Overview, new fixed 1 m packed | 27.67 / 29.60 | 26.62 | 9.48 | 206.14 | 137.70 |
| Overview, new fixed 1 m expanded | 19.40 / 20.95 | 18.37 | 8.86 | 740.95 | 137.70 |

Geometry/query columns describe unique logical buffers, including currently hidden cached geometry, not measured GPU residency or whole-process RAM. Compact attributes remain on the CPU for recovery and also consume GPU storage after upload; textures, render targets, worker scratch, JS objects and driver allocations are additional. Expanded diagnostic geometry owns its indices per tile rather than using the old shared buffer, hence its larger geometry total despite dropping the unused attribute byte. CPU and GPU times overlap and must not be added.

The overview improves approximately **73% in frame time** and **82% in scene GPU time**. Its retained logical payload falls about **96%**, from 975.5 MiB to 41.1 MiB. The close Civic view is approximately **9% slower in mean frame time**, while payload falls about **83%**. Both coarse rendering quality and resident content change under adaptive selection; this is not a lossless quality comparison. Packed versus expanded at the same fixed detail is the lossless comparison.

Slow auto-orbit averaged 6.76 ms (p95 7.50 ms) in the adaptive overview and 13.20 ms (p95 15.45 ms) in Civic Center. These motion samples include shadow redraws and evolving selection; they are descriptive paths, not exact paired trajectories against the old renderer. The approximately 6.06 ms presentation floor limits stationary comparisons. Local adaptive full-view readiness was 4.1 s / 9.6 s for overview/Civic, versus the earlier fixed 1 m observations of 25.9 s / 22.2 s; these are single load observations with no WAN throttling.

Evidence: original fixed baseline (local generated report), adaptive (local generated report), fixed packed, integer decode (local generated report), fixed expanded (local generated report), integer shader image validation (local generated report).

**Decision:** keep adaptive compact rendering as the default for its large overview/residency benefit, retaining `?lod=1&geometry=expanded` for exact-detail speed comparisons. The 16-byte quad format is a confirmed storage win, but its four-vertex instanced draw path is **not a throughput win on this GPU**. At fixed 1 m it is about 43% slower in frame time than the new expanded diagnostic. Replacing float field extraction with integer bit operations preserved identical pixels but did not materially change that result. The close-view regression is explicit, not hidden by the overview average.

**Revised next priorities:**

1. Compare 8-byte indexed vertices or texture-based vertex pulling with the current tiny quad instances, especially at close detail. This targets the measured packing/rendering tradeoff before adding another visibility pass. The cause of the GPU difference has not been isolated to a single instruction or hardware bottleneck.
2. Export tight content bounds and inspect shadow-footprint over-selection. Current height bounds use the whole map height; they are conservative but can refine unnecessary offscreen casters. Improve selection quality/budget stability and validate on an integrated/mobile GPU.
3. Pilot precomputed coarse compact meshes only if startup measurements justify their greater network size. Fine runtime work is already avoided outside the desired set.
4. Keep GPU occlusion deferred. The wide-view geometry problem has largely been removed; close-view geometry throughput and moving shadows are now more useful targets. Re-measure candidate subtree occlusion after the first two changes.

### Reproduce

From `web/`, with Vite running at `http://localhost:5173/`:

```powershell
npm run check
node tools/test-voxel.mjs
node tools/check-voxel.mjs
$env:URL='http://localhost:5173/'
node tools/check-shadows.mjs ../artifacts/profiling/voxel-shadow-check.json
$env:VIEWS='default,civic'
$env:ROUNDS='2'
$env:VARIANTS='baseline,moving'
$env:LOD='0' # adaptive; 1/2/4/8 force a full fixed-detail city
$env:GEOMETRY='packed' # or expanded
node tools/profile.mjs ../artifacts/profiling/implemented-adaptive.json
npm run build
# Start Vite preview on localhost:5176, then:
node tools/check-mobile.mjs
```

Limitations: validated on desktop Chromium/ANGLE/D3D11 only. No Safari/Firefox/mobile GPU or WAN benchmark is claimed. SSE is a projected voxel-size heuristic, not a measured maximum geometric deviation. Coarse fallback queries are approximations until fine data arrives; interval compaction itself preserves the original query semantics at each fixed level. Fine LOD selection is bounded and can be quality-limited by the budget. Ground/bridge boundaries, thin details and landmark silhouettes still warrant device-specific visual review.
