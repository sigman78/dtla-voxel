"""Download the USGS 3DEP 2023 LA County LiDAR (CA_LosAngeles_1_B23) for the diorama, at full density.

The survey is published as Entwine Point Tiles (an octree of LAZ files) in a public S3 bucket, so we fetch
only the octree nodes that touch our rotated rectangle. Every depth is needed: EPT spreads the points of a
region across all levels. Files are cached in CACHE/lidar/ept and the download resumes where it stopped.
"""
import concurrent.futures as cf
import json
import sys
import time

import requests
from pyproj import Transformer
from shapely.geometry import Polygon, box

from aoi import CACHE, corners_uv, uv_to_utm

BASE = "https://s3-us-west-2.amazonaws.com/usgs-lidar-public/CA_LosAngeles_1_B23/"
OUT = CACHE / "lidar" / "ept"
MARGIN = 40.0

session = requests.Session()
session.mount("https://", requests.adapters.HTTPAdapter(pool_maxsize=32, max_retries=5))


def get(url, **kw):
    for attempt in range(6):
        try:
            r = session.get(url, timeout=120, **kw)
            r.raise_for_status()
            return r
        except Exception as e:  # noqa: BLE001 - transient network trouble, retry
            if attempt == 5:
                raise
            print(f"retry {url}: {e}", file=sys.stderr)
            time.sleep(2 ** attempt)


def aoi_polygon_3857():
    to3857 = Transformer.from_crs(32611, 3857, always_xy=True)
    return Polygon([to3857.transform(*uv_to_utm(u, v)) for u, v in corners_uv(MARGIN)])


def node_box(bounds, key):
    d, x, y, z = map(int, key.split("-"))
    w = (bounds[3] - bounds[0]) / 2 ** d
    return box(bounds[0] + x * w, bounds[1] + y * w, bounds[0] + (x + 1) * w, bounds[1] + (y + 1) * w)


def walk(ept, aoi):
    """Return {key: point_count} for every non-empty node touching the AOI."""
    bounds = ept["bounds"]
    hier = get(BASE + "ept-hierarchy/0-0-0-0.json").json()
    found, frontier = {}, ["0-0-0-0"]
    with cf.ThreadPoolExecutor(16) as ex:
        while frontier:
            pages = [k for k in frontier if hier.get(k) == -1]
            for k, page in zip(pages, ex.map(lambda k: get(BASE + f"ept-hierarchy/{k}.json").json(), pages)):
                hier.update(page)
            nxt = []
            for k in frontier:
                if hier.get(k, 0) <= 0 or not node_box(bounds, k).intersects(aoi):
                    continue
                found[k] = hier[k]
                d, x, y, z = map(int, k.split("-"))
                nxt += [f"{d+1}-{2*x+i}-{2*y+j}-{2*z+l}" for i in (0, 1) for j in (0, 1) for l in (0, 1)
                        if f"{d+1}-{2*x+i}-{2*y+j}-{2*z+l}" in hier]
            frontier = nxt
    return found


def download(key):
    dst = OUT / f"{key}.laz"
    if dst.exists():
        return 0
    data = get(BASE + f"ept-data/{key}.laz").content
    tmp = dst.with_suffix(".part")
    tmp.write_bytes(data)
    tmp.replace(dst)
    return len(data)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    ept = get(BASE + "ept.json").json()
    (OUT.parent / "ept.json").write_text(json.dumps(ept))
    nodes_file = OUT.parent / "nodes.json"
    if nodes_file.exists():
        nodes = json.loads(nodes_file.read_text())
    else:
        nodes = walk(ept, aoi_polygon_3857())
        nodes_file.write_text(json.dumps(nodes))
    total_pts = sum(nodes.values())
    print(f"{len(nodes)} nodes, {total_pts:,} points", flush=True)
    done, nbytes, t0 = 0, 0, time.time()
    with cf.ThreadPoolExecutor(24) as ex:
        for n in ex.map(download, sorted(nodes)):
            done += 1
            nbytes += n
            if done % 500 == 0 or done == len(nodes):
                print(f"{done}/{len(nodes)} nodes, {nbytes/1e9:.2f} GB this run, {time.time()-t0:.0f}s", flush=True)
    print("LIDAR DONE", flush=True)


if __name__ == "__main__":
    main()
