# DTLA in voxels

**Live: https://sigman78.github.io/dtla-voxel/**

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

## License

Code: MIT (`LICENSE`). Generated data in `web/public/data` derives from OpenStreetMap (ODbL, © OpenStreetMap contributors)
and from USGS and USDA public-domain data.
