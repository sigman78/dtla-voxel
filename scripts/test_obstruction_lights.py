import gzip
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

import numpy as np
from shapely.geometry import Point, box

from obstruction_lights import generate_lights, read_surfaces, roof_markers, spire_start


class ObstructionLightTests(unittest.TestCase):
    def test_markers_touch_existing_high_roof_and_tip(self):
        top = np.full((30, 30), 30, np.int32)
        mask = np.zeros(top.shape, bool)
        mask[3:27, 3:27] = True
        top[mask] = 240
        top[14:16, 14:16] = 300
        markers, threshold = roof_markers(top, mask, 100, 200)
        self.assertEqual(threshold, 240)
        self.assertEqual(len(markers), 5)
        self.assertEqual(sum(kind == "beacon" for _, kind in markers), 1)
        for (x, y, z), kind in markers:
            r, c = int(z)-200, int(x)-100
            self.assertTrue(mask[r, c])
            self.assertEqual(y, top[r, c])
            self.assertGreater(y, 0)
            self.assertEqual(y, 300 if kind == "beacon" else 240)

    def test_sail_is_not_misclassified_as_a_spire(self):
        top = np.full((30, 30), 240)
        top[4:26, 12:17] = 275  # broad architectural sail, not a slender isolated tip
        self.assertIsNone(spire_start(top, np.ones(top.shape, bool)))

    def test_no_vegetation_or_neighbour_roof_selection(self):
        top = np.full((40, 40), 20, np.uint16)
        material = np.full(top.shape, 12, np.uint8)
        ground = np.full(top.shape, 20, np.uint8)
        top[2:26, 2:26] = 240
        top[10, 10] = 360
        material[10, 10] = 3  # tall foliage must never receive a marker
        top[2:26, 27:38] = 350  # unrelated neighbouring roof
        area = (1, "way", {"building": "office", "name": "Test tower"}, box(2, 2, 26, 26))
        meta = dict(W=40, D=40)
        lights, diagnostics, _ = generate_lights(meta, [area], (top, material, ground))
        self.assertEqual(len(lights), 4)
        for light in lights:
            x, y, z = light["position"]
            self.assertTrue(area[3].contains(Point(x, z)))
            self.assertEqual(y, 240)
            self.assertNotEqual((int(x), int(z)), (10, 10))
        self.assertEqual(diagnostics[0]["maxHeight"], 220)

    def test_low_podium_with_borrowed_tower_samples_is_excluded(self):
        top = np.full((30, 30), 240)
        material = np.full(top.shape, 12)
        ground = np.full(top.shape, 20)
        area = (1, "way", {"building": "yes", "building:levels": "2"}, box(2, 2, 26, 26))
        result = generate_lights(dict(W=30, D=30), [area], (top, material, ground))
        self.assertEqual(result[0], [])

    def test_reads_top_exposed_run_and_skips_tile_apron(self):
        # Two by two tile core with one-cell apron; every column has ground and roof.
        counts = np.full(16, 2, dtype="<u2")
        terrain = np.full(16, 12, dtype="u1")
        runs = np.tile(np.array([[0, 12, 1], [12, 228, 2]], dtype="<u2"), (16, 1))
        # core cell (0,0) gets a different top run to verify indexing.
        runs[11] = [12, 288, 3]
        raw = counts.tobytes()+terrain.tobytes()+runs.tobytes()
        with TemporaryDirectory() as directory:
            path = Path(directory)/"tiles"/"1"
            path.mkdir(parents=True)
            (path/"0_0.bin").write_bytes(gzip.compress(raw))
            top, mats, ground = read_surfaces(
                dict(W=2, D=2, tiles=dict(N=2), palette=[[0,0,0,0],[0,0,0,10],
                                                       [0,0,0,12],[0,0,0,3]]), directory)
        np.testing.assert_array_equal(top, [[300, 240], [240, 240]])
        self.assertEqual(mats[0, 0], 3)
        self.assertTrue((ground == 12).all())


if __name__ == "__main__":
    unittest.main()
