# DTLA in voxels

**Live: https://sigman78.github.io/dtla-voxel/**

[![City Hall and Grand Park, Civic Center](docs/img/hero-civic.jpg)](https://sigman78.github.io/dtla-voxel/?view=civic&hour=10.5)

| | |
|---|---|
| [![Bunker Hill at golden hour](docs/img/bunker-hill.jpg)](https://sigman78.github.io/dtla-voxel/?view=bunkerhill&hour=15.8) | [![The skyline at sunset, from the east](docs/img/skyline-sunset.jpg)](https://sigman78.github.io/dtla-voxel/?cam=4052,647,2285,2007,196,744&hour=16.4) |
| Bunker Hill at golden hour | The skyline at sunset, from the east |
| [![Broadway and Pershing Square](docs/img/broadway.jpg)](https://sigman78.github.io/dtla-voxel/?view=historic&hour=13) | [![Bunker Hill at night](docs/img/night.jpg)](https://sigman78.github.io/dtla-voxel/?view=bunkerhill&hour=19.5) |
| Broadway and Pershing Square | Bunker Hill at night |

Click a picture to open that view in the live viewer.

A 4.2 × 3.6 km diorama of downtown Los Angeles at 1 m voxels, with a southern-California palette:
sun-bleached stucco, Beaux-Arts terracotta, teal glass towers, cool white roofs, palms, jacarandas, golden dry
grass, and an amber haze at golden hour. The grid is rotated 52° so it lines up with the DTLA street grid, which
keeps walls from staircasing. The map runs from the Convention Center to Chinatown, and from the Harbor Freeway
to the east bank of the LA River (Bunker Hill, Civic Center, the Historic Core, Little Tokyo, the Arts District,
the 6th Street Viaduct).

The approach and the viewer follow [warsaw-vibe-voxel](https://github.com/stared/warsaw-vibe-voxel) by Piotr Migdał
(MIT, see `LICENSE-warsaw-vibe-voxel`).

```sh
cd web && npm install && npm run dev     # http://localhost:5173
```

URL parameters: `view=` (default, bunkerhill, civic, littletokyo, viaduct, lalive, historic), `hour=19.5`,
`date=MM-DD`, `tilt=0`, `ui=0`, `lod=1|2|4|8`, `cam=x,y,z,tx,ty,tz`.

## Data and pipeline (scripts/)

| Source | Used for |
|---|---|
| **USGS 3DEP LiDAR, CA_LosAngeles_1_B23 (2023)**: public EPT point cloud, full density, 242 M points | Roof heights and shapes, tree canopies, freeway decks (bridge class), the viaduct's arches |
| **USGS 3DEP 1 m DEM** (same survey) | Bare ground under buildings and freeways |
| **USDA NAIP 2022** (0.6 m, RGB + near infrared) | Roof colours, vegetation (NDVI), lawn vs dry grass, the river's low-flow channel |
| **OpenStreetMap** (Overpass, fetched at build time) | 20 k building footprints, colours and materials, roads and lane markings, crosswalks, rail, parks, the river, landmarks |

This LiDAR survey only classifies ground and bridges, so the other classes are inferred:
- **Buildings** are OSM footprints, with their heights and roof shapes taken from the LiDAR.
- **Trees** are above-ground LiDAR where NDVI is green or the beam passed through (multiple returns).
  - Glass-facade echoes are filtered out.
- **Palms** are small isolated crowns on tall bare trunks.
  - They get a voxel trunk, a skirt of dead fronds and a star of fronds.
- **Street lamps** are placed every 36 m along road kerbs (OSM maps almost none in DTLA).

Downloads are cached outside the project, in `C:\data\dtla-voxel-cache` (override with `DTLA_CACHE`), because
D: is nearly full. The cache takes about 2.5 GB; the web data in `web/public/data` takes about 19 MB.

```sh
sh scripts/build_data.sh   # downloads (cached), then rasterise + voxelise: ~7 min, ~4 GB RAM
```

| Script | Step |
|---|---|
| `aoi.py` | Map extent and the rotated grid frame |
| `fetch_lidar.py`, `fetch_dem.py`, `fetch_naip.py`, `fetch_osm.py` | Downloads, reading only the area needed |
| `prep_lidar.py` | Point cloud to 0.5 m / 1 m rasters |
| `layers.py` | 2D fusion: ground, buildings, roofs, vegetation, palms, decks |
| `voxelize.py` | 3D fill in 128-row bands, so the full volume is never in memory; writes tiles, `terrain.bin` and `meta.json` |
| `palette.py` | The SoCal palette and material ids |
| `landmarks.py` | Labels, with facts |
| `tiles.py` | Tile format, unchanged from warsaw-vibe-voxel |

## Known limits

- **Wall colours** come from OSM where tagged, otherwise from a palette picked by building type and height.
  Windows are procedural, not real.
- **Glass towers lean in NAIP**, so their roofs use a default grey instead of the photo colour.
- **Some rail-yard light masts** still read as small trees.
- **The 6th Street Viaduct's arches** are drawn as their top 3 m only, so they float slightly. Its cables aren't drawn.
- **The LA River** is built from the OSM centreline and the terrain, because the riverbank outline is cut open at
  the map edge. The channel is the flat bed plus its walls; the water is a ~14 m low-flow strip widened by NAIP wet
  pixels, not a measured water line.
- **Buildings finished after the 2023 flight** use their OSM height where it's tagged.

## Roadmap

Ideas, roughly in order. None of these are started yet.

**Life on the streets**
- [ ] **Traffic**: cars on the street grid and the 110 / 101 / 10 freeways, with headlight and taillight streams after dark.
- [ ] **Metro**: trains on the A/E lines and the Union Station approach tracks, and buses on the main avenues.
- [ ] **People** on Broadway, in Grand Park and at LA Live on event nights.

**Windows and facades**
- [ ] **Realistic windows**: floor height and window rhythm from `building:levels` and building type, so curtain-wall towers, punched-window lofts and warehouses each look different.
- [ ] **Lit windows by use**: offices empty out after 7 pm, residential lofts fill up, hotels stay half lit (from OSM building use and POIs).
- [ ] **Shop fronts and signs**: ground-floor retail bands along Broadway, Spring and 7th, plus the historic theatre marquees.
- [ ] **Rooftop helipads**: the red "H" pads on 1970s–2000s towers (required by the LA fire code until 2014).

**Landmark facades**, hand-tuned beyond what 1 m LiDAR shows:
- [ ] City Hall's stepped tower and pyramid top.
- [ ] Disney Hall's curved steel sails, with their glare at golden hour.
- [ ] The Broad's honeycomb veil.
- [ ] Union Station's mission tower and tile roofs.
- [ ] The crowns of Wilshire Grand and U.S. Bank Tower.
- [ ] Angels Flight's two orange cars.
- [ ] The Bradbury Building and Grand Central Market signage.
- [ ] **Sixth Street Viaduct**: full arches down to the deck, and the suspension cables.

**Light and weather**
- [ ] **Marine layer**: a "May Gray / June Gloom" low-cloud mode.
- [ ] **Smoggy-gold haze** in summer, and clear blue days after rain.
- [ ] **Seasons**: jacarandas in bloom in May, and green lawns in winter against dry summer gold.
- [ ] **Glass reflections**: towers mirroring the sky and each other.
- [ ] **Water**: a moving surface in the LA River's low-flow channel.
- [ ] **Palms swaying** in Santa Ana winds.
- [ ] **Backdrop**: the San Gabriel Mountains and the Hollywood Hills as distant silhouettes, from the DEM.

**Coverage and data**
- [ ] **A bigger map**: Echo Park and Dodger Stadium, Boyle Heights across the river, and Exposition Park.
- [ ] **Better tree and pole sorting**: a classifier on LiDAR return shape plus NAIP, so rail-yard masts stop reading as trees.
- [ ] **Fresher data**: re-fetch OSM, and pick up newer NAIP and LiDAR when they're published.

**Viewer**
- [ ] **Tile retries**: retry a tile after a failed fetch (right now a CDN hiccup leaves a hole until reload).
- [ ] **Guided tour**: a flight between the landmarks that shows their facts.
- [ ] **Phone performance**: lighter shadows and a lower level of detail on small screens.

## License

Code: MIT (`LICENSE`). Generated data in `web/public/data` derives from OpenStreetMap (ODbL, © OpenStreetMap contributors)
and from USGS and USDA public-domain data.
