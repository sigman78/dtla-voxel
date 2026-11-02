"""OpenStreetMap for the AOI (+150 m margin) from public Overpass servers, as one Overpass-style JSON.

The box is split into a 3 x 3 grid of queries (one 5 x 5 km query is too heavy for the public servers at busy
times); elements are merged by (type, id). Geometry is clipped to the whole-AOI box (not the query tile), so ways crossing tile edges stay whole.
"""
import concurrent.futures as cf
import json
import sys
import time

import requests

from aoi import CACHE, bbox_lonlat

SERVERS = ["https://overpass-api.de/api/interpreter",
           "https://overpass.kumi.systems/api/interpreter",
           "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
           "https://overpass.private.coffee/api/interpreter"]
OUT = CACHE / "osm.json"
SPLIT = 3


def query(bb, full, rounds=6):
    # geometry clipped to the whole-AOI box: ways stay whole across query tiles, big boundary relations stay small
    f = ",".join(f"{x:.5f}" for x in full)
    q = f"[out:json][timeout:300][maxsize:536870912];nwr({bb[0]:.5f},{bb[1]:.5f},{bb[2]:.5f},{bb[3]:.5f});out body geom({f});"
    for rnd in range(rounds):
        for url in SERVERS:
            try:
                r = requests.post(url, data={"data": q}, timeout=400, headers={"User-Agent": "dtla-voxel/0.1"})
                if r.ok and r.text.lstrip().startswith("{"):
                    return r.json()["elements"]
                print(f"fail {url}: {r.status_code}", file=sys.stderr)
            except Exception as e:  # noqa: BLE001
                print(f"fail {url}: {e}", file=sys.stderr)
        time.sleep(10 * (rnd + 1))
    raise SystemExit("all Overpass servers failed")


def main():
    s, w, n, e = bbox_lonlat(150)
    parts = CACHE / "osm_parts"
    parts.mkdir(exist_ok=True)

    def tile(ij):
        i, j = ij
        f = parts / f"{i}_{j}.json"
        if not f.exists():
            bb = (s + (n - s) * i / SPLIT, w + (e - w) * j / SPLIT, s + (n - s) * (i + 1) / SPLIT, w + (e - w) * (j + 1) / SPLIT)
            try:
                els = query(bb, (s, w, n, e), rounds=2)
            except SystemExit:  # a dense corner: four smaller queries
                els = []
                for a in range(2):
                    for b in range(2):
                        sub = (bb[0] + (bb[2] - bb[0]) * a / 2, bb[1] + (bb[3] - bb[1]) * b / 2,
                               bb[0] + (bb[2] - bb[0]) * (a + 1) / 2, bb[1] + (bb[3] - bb[1]) * (b + 1) / 2)
                        els += query(sub, (s, w, n, e))
            f.write_text(json.dumps(els))
        print(f"tile {i},{j} done", flush=True)
        return json.loads(f.read_text())

    merged = {}
    with cf.ThreadPoolExecutor(2) as ex:
        for els in ex.map(tile, [(i, j) for i in range(SPLIT) for j in range(SPLIT)]):
            for el in els:
                merged[(el["type"], el["id"])] = el
    OUT.write_text(json.dumps({"bbox": [s, w, n, e], "elements": list(merged.values())}))
    print(f"OSM DONE {OUT} {OUT.stat().st_size / 1e6:.1f} MB, {len(merged)} elements", flush=True)


if __name__ == "__main__":
    main()
