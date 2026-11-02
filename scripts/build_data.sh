#!/bin/sh
# Full data pipeline: downloads (cached in $DTLA_CACHE, default C:\data\dtla-voxel-cache) -> rasters -> voxels -> web/public/data
# Disk: ~1.4 GB LiDAR + ~0.25 GB NAIP + ~0.2 GB OSM + ~0.8 GB intermediates in the cache; ~12 MB of tiles in the project.
set -e
cd "$(dirname "$0")/.."
export PYTHONPATH=scripts
uv run python scripts/fetch_lidar.py   # USGS 3DEP 2023 LA County point cloud (EPT), full density, ~1.4 GB
uv run python scripts/fetch_dem.py     # USGS 1 m bare-earth DEM, read window only
uv run python scripts/fetch_naip.py    # NAIP 2022 RGB+NIR, read windows only
uv run python scripts/fetch_osm.py     # OpenStreetMap via Overpass (3 x 3 tiles, cached)
uv run python scripts/prep_lidar.py    # points -> 0.5 m / 1 m rasters on the rotated grid
uv run python scripts/voxelize.py      # layers -> voxels -> tiles, terrain.bin, meta.json (~6 min, ~4 GB RAM)
