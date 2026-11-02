"""Convert the attributed Disney Concert Hall mesh into true 3D shell voxels.

The 60 MB source remains in the external cache. Only the small, registered voxel
derivative and its reproducible transform/provenance are kept in the repository.
No downward height fill or invented parametric sails are used.
"""
import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
import trimesh

from aoi import CACHE, ROOT

ASSETS = ROOT / "scripts" / "assets"
SOURCE = CACHE / "disney-model" / "65cfd28f2904457e9b5c4e8cd1c37fc0.glb"
SOURCE_MD5 = "3fb599653948ce5cc920da8f4e090641"

# Scene is glTF Y-up. Registration uses the original Rhino Z-up coordinates.
NATIVE_FROM_SCENE = np.array([[1, 0, 0, 0], [0, 0, -1, 0],
                              [0, 1, 0, 0], [0, 0, 0, 1]], float)
KEPT = {"Acero_inoxidable_satinado", "Vidrio_azul_claro",
        "Losa_2_reflectante", "Abedul_pulido"}


def registered_parts(source, native_to_grid):
    """Yield (mesh, class) with graph transforms baked and native materials kept."""
    scene = trimesh.load_scene(source, process=False)
    for node in scene.graph.nodes_geometry:
        transform, key = scene.graph[node]
        original = scene.geometry[key]
        name = getattr(original.visual.material, "name", "")
        if name not in KEPT:
            continue
        mesh = original.copy()
        mesh.apply_transform(NATIVE_FROM_SCENE @ transform)
        # The generic slab material also covers the outer roof in this academic
        # model. Documented exterior roofing is steel; low plinth stays opaque.
        if name == "Losa_2_reflectante":
            for low, kind in ((True, 3), (False, 1)):
                selected = (mesh.triangles_center[:, 2] <= 6) == low
                if selected.any():
                    part = mesh.submesh([selected], append=True)
                    part.apply_transform(native_to_grid)
                    yield part, kind
        else:
            mesh.apply_transform(native_to_grid)
            yield mesh, 2 if name == "Vidrio_azul_claro" else 3 if name == "Abedul_pulido" else 1


def shell_voxels(parts):
    """Mark intersected 1 m cells only; retain overhangs, gaps and hollow interiors.

    trimesh subdivision voxelization places centres on integer coordinates. Shift
    by half a cell first so the exported indices denote normal grid cell corners.
    At collisions opaque interiors < steel shell < deliberately modeled glazing.
    """
    occupied = {}
    priority = {3: 0, 1: 1, 2: 2}
    for mesh, kind in sorted(parts, key=lambda part: priority[part[1]]):
        mesh = mesh.copy()
        mesh.apply_translation([-0.5, -0.5, -0.5])
        grid = mesh.voxelized(pitch=1.0, method="subdivide")
        indices = np.rint(grid.points).astype(np.int32)
        for index in indices:
            occupied[tuple(map(int, index))] = kind
    if not occupied:
        raise ValueError("Disney source produced no shell voxels")
    world = np.array(sorted(occupied), np.int32)
    classes = np.array([occupied[tuple(p)] for p in world], np.uint16)
    origin = world.min(axis=0)
    local = world-origin
    if local.max() >= 65536:
        raise ValueError("Model bounds cannot fit the derived uint16 asset")
    return np.column_stack([local.astype(np.uint16), classes]), origin


def validate_transform(matrix):
    """Require a finite uniform physical transform, without reflection or squash."""
    matrix = np.asarray(matrix, float)
    if matrix.shape != (4, 4) or not np.isfinite(matrix).all() \
            or not np.allclose(matrix[3], [0, 0, 0, 1]):
        raise ValueError("Invalid model registration matrix")
    scales = np.linalg.svd(matrix[:3, :3], compute_uv=False)
    if np.linalg.det(matrix[:3, :3]) <= 0 or not np.allclose(scales, scales[0]):
        raise ValueError("Registration must preserve 3D chirality and uniform scale")
    return matrix


def build(source, metadata_path, output):
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    content = source.read_bytes()
    if hashlib.md5(content).hexdigest() != SOURCE_MD5:
        raise ValueError("Source checksum differs from the reviewed licensed model")
    matrix = validate_transform(metadata["nativeToGrid"])
    voxels, origin = shell_voxels(list(registered_parts(source, matrix)))
    output.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(output, voxels=voxels, origin=origin.astype(np.int32))
    metadata.update(origin=origin.tolist(), shape=(voxels[:, :3].max(0)+1).tolist(),
                    count=len(voxels), classCounts={str(k): int((voxels[:, 3] == k).sum()) for k in (1, 2, 3)},
                    sourceSHA256=hashlib.sha256(content).hexdigest(),
                    derivedSHA256=hashlib.sha256(output.read_bytes()).hexdigest())
    metadata_path.write_text(json.dumps(metadata, indent=2, ensure_ascii=False)+"\n", encoding="utf-8")
    print(json.dumps({k: metadata[k] for k in ("origin", "shape", "count", "classCounts")}), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=SOURCE)
    parser.add_argument("--metadata", type=Path, default=ASSETS / "disney-shell.json")
    parser.add_argument("--output", type=Path, default=ASSETS / "disney-shell.npz")
    args = parser.parse_args()
    build(args.source, args.metadata, args.output)


if __name__ == "__main__":
    main()
