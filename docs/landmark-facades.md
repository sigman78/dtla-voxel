# Landmark facade overrides

Landmark treatments select specific OSM buildings after ordinary building fusion.
The measured footprint and LiDAR roof profile remain the basis of the model;
procedural surface detail makes selected buildings easier to recognize at closer
views. These treatments are stylized approximations, not architectural surveys.

## Identities and bounds

`scripts/landmark_overrides.py` defines `LandmarkSpec` and the City Hall entry.
`scripts/landmark_catalog.py` supplies the other entries through
`additional_specs(LandmarkSpec)`, avoiding a circular import. Material IDs append
to the existing contract in `scripts/palette.py` and `web/src/voxelMaterial.ts`.

Areas and centroids below were measured using `scripts/osm.py` against
`C:\data\dtla-voxel-cache\osm.json`. Coordinates are export-grid metres:
`x = column`, `z = row`. Search radii bound the footprint centroid, not every
vertex of the building.

| Key | OSM identity | Material ID | Cached area, m² | Anchor (x, row) | Radius, m | Allowed area, m² |
| --- | --- | --- | ---: | --- | ---: | --- |
| `city_hall` | relation 6333145 | 23 | see City Hall registry | (2869.8, 1400.4) | 100 | 5000–15000 |
| `broad` | way 427532197 | 24 | 3466.1 | (2499.59, 775.57) | 35 | 2800–4300 |
| `disney` | relation 6333150 | 25 | 11202.4 | (2618.48, 759.75) | 45 | 9000–13500 |
| `union_station` | relation 1483140 | 26 | 16245.3 | (3469.77, 1753.15) | 45 | 14000–18500 |
| `us_bank` | way 23973401 | 27 | 2305.7 | (1986.20, 722.42) | 30 | 1800–2900 |
| `wilshire` | way 496246723 | 28 | 8196.8 | (1570.40, 342.60) | 40 | 6800–9800 |

Selection first uses both element type and ID. If that identity is absent, an
exact, case-insensitive name from the entry's fallback list can select one nearby
building with a plausible area. An invalid exact match fails closed. Ambiguous
fallbacks, non-buildings, roof-only structures and construction are excluded.

Union Station's selected relation is tagged `building=train_station`,
`historic=yes`, and `start_date=1939-05`: the historic terminal footprint. Its
bounds are approximately (3344.6, 1650.6)–(3574.8, 1841.8). Transit stop nodes,
rail platforms and their `building=roof` canopies, the east parking garage,
nearby offices and the wider railway site are outside this treatment.

Landmark labels use the same selected typed identities through their
`landmark_key`, so an unrelated same-name stop cannot move a building label.
Their roof anchor uses the maximum height inside the rasterized footprint mask,
not the maximum of the surrounding bounding rectangle; a neighbouring taller
building cannot raise the label.

## Surface treatment and evidence

The renderer uses a frame from each footprint's oriented rectangle and one
median terrain datum for that building. Window rhythm therefore follows the
building rather than resetting at each terrain sample. Palette IDs are separate
from material IDs. Late allocation of landmark colours keeps generic palette
allocation stable; `landmarkStyles` in `meta.json` supplies the local frames.
Union Station and both tower entries preserve the ordinary roof colours and
materials, including any sampled tile colour at Union Station. The Broad and
Disney Hall explicitly apply their concrete and steel colours/materials to roofs
as well as walls, while preserving planted terrace cells such as Disney Hall's
garden. This does not change roof heights.

| Landmark | Implemented surface cue | Primary reference and remaining approximation |
| --- | --- | --- |
| City Hall | Pale masonry, punched openings and piers; openings stop below the crown | The [Library of Congress HABS report](https://tile.loc.gov/storage-services/master/pnp/habshaer/ca/ca1200/ca1261/data/ca1261data.pdf) documents cream terra cotta, and the [LA Conservancy building record](https://www.laconservancy.org/learn/historic-places/los-angeles-city-hall/) supplies architectural context. Existing measured tower, setbacks and pyramid remain authoritative. A narrowly supported one-cell plateau-noise refiner preserves steep transitions and the observed apex. |
| The Broad | Ivory concrete with staggered elongated hexagonal dark recesses | The museum's [Veil tour stop](https://www.thebroad.org/tour-stops/veil) describes 2,500 GFRC panels and the deep light-filtering envelope. The shader suggests depth through shading; it does not cut real holes or reconstruct the lifted corners. |
| Walt Disney Concert Hall | Continuous silver metal with restrained panel seams and metallic response | [LA Phil's venue description](https://www.laphil.com/about-us/our-venues/about-walt-disney-concert-hall) documents Gehry's stainless-steel exterior. Measured voxel massing approximates the curved sails; the treatment does not add smooth curved shells. |
| Union Station | Warm cream stucco and tall arched openings | The station's [official history](https://unionstationla.com/history/) identifies the Spanish Colonial, Mission Revival and Art Deco blend. Its [Historic Guide](https://unionstationla.com/wp-content/uploads/2024/12/union-station-historic-guide-english.pdf) identifies the historic main terminal and clock tower. Arches are surface patterns, not reconstructed arcades or clock faces. |
| U.S. Bank Tower | Restrained pale cladding and regular inset glazing | The architect's [project description](https://www.pcf-p.com/projects/us-bank-tower-formerly-library-tower/) explains the overlapping circular and orthogonal geometry and full-height setbacks. Its images show the crown. The material preserves sampled setbacks; no new circular crown geometry or accurate crown lighting is claimed. |
| Wilshire Grand | Blue-grey curtain wall, fine mullions and floor spandrels | [AC Martin's project page](https://www.acmartin.com/portfolio/wilshire-grand-center) describes floor-to-ceiling glass and the Half Dome reference. The [California Geological Survey SMIP18 proceedings](https://www.conservation.ca.gov/cgs/documents/program-smi/seminar/SMIP18_proceedings.pdf), printed p. 117, document the rooftop sail and attached spire. The surface treatment does not reconstruct either feature. |

All dimensions, spacing, colours, roughness and emission settings in these
procedural patterns are artistic choices. They do not assert measured window
positions, cladding dimensions or current lighting schedules. The Broad's recesses
and Disney Hall's metal have no random office-window emission.

## Extending and validating

1. Inspect a candidate with `osm.OSM`; verify it is the actual building polygon
   rather than a similarly named transit or site feature. Record the typed ID,
   grid centroid and area.
2. Add a bounded entry to `additional_specs`. Use a short fallback name list and
   tight area/radius checks. Keep `geometry_refiner=None` unless a measured-data
   defect justifies a local change.
3. Append a material constant in both Python and TypeScript and implement its
   surface branch. Keep existing IDs stable. The current shader has six landmark
   uniform slots and a material range ending at `WILSHIRE`: extend the frame and
   crown uniform arrays, CPU allocation/validation and shader range together when
   adding an ID beyond these six materials. Merely adding a catalog entry and
   constant does not extend that renderer contract. Any refiner must return a same-shape
   array with finite heights of at least two cells inside the supplied mask; the
   override engine writes only those cells.
4. Check exact selection, renamed/missing identities, distant same-name buildings
   and roof-only false matches. Check that unrelated buildings and roof heights
   remain unchanged. Inspect both day and night, near and distant views.

Lightweight cached identity inspection from PowerShell at the repository root:

```powershell
@'
import sys
sys.path.insert(0, "scripts")
from osm import OSM
from landmark_catalog import additional_specs
from landmark_overrides import LandmarkSpec, select_features
areas = OSM().areas
for spec in additional_specs(LandmarkSpec):
    found = select_features(areas, spec)
    assert len(found) == 1, spec.key
    print(spec.key, [(a[1], a[0], round(a[3].area, 1)) for a in found])
'@ | .venv/Scripts/python.exe -
```

Run `npm run check` and `npm run build` in `web` for the viewer. Regenerating
landmark material assignments requires the normal exporter,
`.venv/Scripts/python.exe scripts/voxelize.py`, using existing prepared cache
rasters. This is a full export and is unnecessary for identity inspection. A
shader-only edit needs a viewer rebuild, whereas Python assignment changes need
new tiles, palette and metadata together. The `--labels` option only refreshes
labels/views and cannot update landmark tile materials.

For repeatable screenshots, start the viewer with `npm run dev` in `web`, then
run this in another PowerShell terminal from `web`:

```powershell
node tools/landmark-shots.mjs C:/data/dtla-voxel-cache/shots/before 1 10.5,15.8,19.5
$env:REFERENCE = 'C:/data/dtla-voxel-cache/shots/before/manifest.json'
node tools/landmark-shots.mjs C:/data/dtla-voxel-cache/shots/after 1 10.5,15.8,19.5
Remove-Item Env:REFERENCE
```

Capture the baseline before changing the export/viewer, then capture the changed
version with the same LOD and times. `REFERENCE` is optional; it reuses the saved
camera positions and targets even when label anchors or metadata change. Each
output directory includes six-landmark images and a `manifest.json` recording
cameras, times, LOD, renderer memory counts and browser errors. Set `URL` for a
different running viewer or `CHROME` for an explicit browser executable. Store
these artifacts in the external cache to avoid filling the repository drive.

The initial catalog validation selected exactly one cached footprint for each
of its five entries. At that first pass none of those entries modified roof heights;
the later Disney DSM correction is described below. Small features
missed by the one-metre sampling remain missing; material detail alone cannot
recover a spire, a real perforated veil, a rounded crown or an arcade interior.

## First-pass verification (2026-11-02)

- Six Python regression tests pass, covering typed identity selection, bounded
  fallback, localized edits, planted-roof preservation, City Hall plateau cleanup,
  and label height isolation from neighboring buildings.
- Production TypeScript/Vite build passes. All 2,261 generated gzip tiles were
  decoded and checked for valid run lengths and palette indices.
- The original 281 palette entries, terrain and all foliage tiles remain unchanged.
  Changes affect 19 tiles at 1 m, 11 at 2 m, seven at 4 m and four at 8 m, all within
  the selected landmark footprints plus tile aprons.
- City Hall changes seven height samples by one metre; the other five landmarks
  preserve their heights. The Broad and Union Station have corrected label anchors.
- Captured all six buildings at 10:30, 15:48 and 19:30 on November 2, with no browser
  errors, plus a 390 × 844 viewport at 4 m detail. This is a desktop-browser viewport
  check, not a real-device performance measurement.

Review artifacts are in `C:\data\dtla-voxel-cache\shots\landmarks-before` and
`landmarks-after`; the latter's manifest records all 18 desktop captures.

## Follow-up corrections and representation limits

The first-pass results above describe the initial export, before the following
Disney geometry and night-lighting corrections. They are retained as historical
validation, not as assertions that the follow-up export leaves Disney heights
unchanged.

Disney Hall's existing footprint is a single OSM multipolygon; the few nearby
building parts do not describe its curved sails. The previous generic building
processing treated this low building like a flat roof: it cleaned steep wall-edge
samples, snapped heights near the footprint median and applied a 3 × 3 median
filter. These steps can erase real gradients and narrow changes in a curved roof.
The follow-up correction uses the raw measured `nd_max` DSM heights in the
interior of the exact bounded hall footprint and exempts that interior from
flat-roof snapping and median filtering. A two-metre boundary keeps the ordinary
cleanup to avoid projecting facade-return artifacts beyond the building edge.
It restores those heights after vegetation classification, so a local roof edit
does not renumber tree groups and change foliage styling elsewhere. Planted
terraces retain their existing heights. It does not introduce guessed sail surfaces.

This preserves more of the measured top profile, but it cannot recover Disney
Hall's full shape. The DSM records only the highest sample at each horizontal
position, and the exporter fills the column beneath it. Overlapping shells,
undercuts, overhangs and open spaces beneath sails therefore remain filled or
missing. The facade contractor's [project record](https://www.permasteelisagroup.com/historic-project/walt-disney-concert-hall/)
documents the complex curved steel skin, and the structural engineer's
[project record](https://www.johnmartin.com/project/walt-disney-concert-hall/)
documents the three-dimensional supporting structure. A faithful reconstruction
needs a separately registered exterior shell mesh, with the corresponding filled
voxel regions removed, or shell voxelization and building fill supporting multiple
occupied intervals per column. The existing tile format already supports multiple
runs; the limitation lies in the current single-heightfield building fill, not
in that file format. Increasing metallic shine or inventing a smooth height
function cannot supply those missing surfaces.

The Broad now receives a continuous, soft nighttime wash over its veil, rather
than random lit-window cells. [Tillotson Design Associates' project description](https://www.tillotsondesign.com/museums/the-broad)
explains the gradient from shielded in-grade LED fixtures, including highlights
and shadows across the veil cells. The shader suggests that continuous wash;
it does not model individual fixtures or a measured photometric distribution.
Disney Hall's steel remains free of random office-window emission.

Wilshire Grand exports `spireBase` from its sampled thin-column height profile.
The shader uses this threshold to keep ordinary curtain-wall windows off the
spire, instead of extending a facade grid to its tip. The threshold follows the
exported model; it does not reconstruct the actual sail or spire cross-section.

## Rooftop obstruction-light approximation

The final metadata contains 73 lights across 18 measured towers at least 180 m
tall, including the eight tallest: Wilshire Grand, U.S. Bank Tower, Aon Center,
Two California Plaza, Gas Company Tower, Bank of America Plaza, 777 Tower and
Wells Fargo Center's north tower. Marker positions follow their exported rooftop
geometry. They are model-derived positions, not an as-built fixture survey;
actual fixture counts and mounting positions have not been established.

The full exporter calls `scripts/obstruction_lights.py` automatically after the
tiles and palette are final. To refresh lighting metadata and Wilshire's measured
`spireBase` from existing exported tiles without rebuilding them, run
`.venv/Scripts/python.exe scripts/obstruction_lights.py` from the repository root.
This updates `web/public/data/meta.json` and prints per-building diagnostics.

The renderer draws steady red rooftop markers and red tip beacons pulsing
30 times per minute. They appear only at night and after the relevant tiles have
loaded. Depth testing hides lights behind buildings, and the renderer adjusts
their elevation for coarse roof sampling. These are small emissive markers with
halos, not scene lights that illuminate nearby surfaces. The general reference is
[FAA AC 70/7460-1N, issued August 11, 2026](https://www.faa.gov/regulations_policies/advisory_circulars/index.cfm/go/document.current/documentnumber/70_7460-1);
the visualization does not claim an approved lighting layout or compliance.

Architectural crown illumination is a separate feature. The Wilshire Grand's
[lighting installer](https://standardvision.com/wilshire-grand-tower) documents
integrated facade lighting and a crown marquee. A [PBS SoCal interview with the
U.S. Bank crown-light operator](https://www.pbssocal.org/shows/socal-connected/clip/behind-the-towering-light-show)
describes twelve crown light wells. Neither source establishes aviation-red
fixture locations, and neither system should be represented as a red obstruction
beacon. Corporate lettering and blue glass at other tower crowns likewise do not
establish obstruction-light positions.

Follow-up validation: 12 Python regression tests and the production build pass.
The final export restores 1,426 Disney roof samples; only its six 1 m tiles,
four 2 m tiles, two 4 m tiles and one 8 m tile differ from the first facade pass.
All foliage, terrain and palette entries remain byte-identical. All 73 marker
anchors were checked against supporting roofs at every exported detail level.
Twelve final day/night browser captures report no errors and verify that markers
are hidden during daylight and enabled at night after their tiles load. A close
spire capture and a phone-sized 4 m night view were also inspected. Artifacts:
`C:\data\dtla-voxel-cache\shots\landmark-corrections-final` and
`C:\data\dtla-voxel-cache\shots\landmark-night-corrections`.
