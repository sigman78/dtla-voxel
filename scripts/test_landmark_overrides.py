"""Run with: python -m unittest discover -s scripts -p 'test_*.py'."""
from dataclasses import replace
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np
from shapely.geometry import box

from landmark_overrides import LandmarkSpec, apply_landmark_overrides, refine_city_hall, select_features
from palette import C


class LandmarkOverrideTests(unittest.TestCase):
    def setUp(self):
        self.spec = LandmarkSpec("test", (("relation", 12),), 23, "#ded6c8",
                                 (5, 5), 3, 4, 30, ("Landmark",))
        self.feature = (12, "relation", {"building": "civic", "name": "Landmark"}, box(3, 3, 7, 7))

    def test_exact_type_and_id_win(self):
        wrong_type = (12, "way", {"building": "yes"}, box(3, 3, 7, 7))
        same_name = (99, "way", self.feature[2], box(3, 3, 7, 7))
        self.assertEqual(select_features([wrong_type], self.spec), [])
        self.assertEqual(select_features([same_name, self.feature], self.spec), [self.feature])

    def test_fallback_is_named_bounded_and_unambiguous(self):
        near = (99, "way", self.feature[2], box(3, 3, 7, 7))
        far = (100, "way", self.feature[2], box(30, 30, 34, 34))
        site = (101, "way", {"name": "Landmark"}, box(3, 3, 7, 7))
        self.assertEqual(select_features([near, far, site], self.spec), [near])
        self.assertEqual(select_features([near, (102, *near[1:])], self.spec), [])
        self.assertEqual(select_features([far, site], self.spec), [])
        # A malformed exact ID fails closed even if a valid named neighbour exists.
        broken = (12, "relation", self.feature[2], box(30, 30, 34, 34))
        self.assertEqual(select_features([broken, near], self.spec), [])

    def test_updates_are_local_and_masked_with_stable_height(self):
        shape = (12, 12)
        mask = np.ones(shape, bool)
        mask[4, 4] = False
        ground = np.full(shape, 13, np.int32)
        ground[3, 3] = 100  # robust datum ignores this terrain outlier
        top = np.full(shape, 50, np.int32)
        wall = np.ones(shape, np.uint16)
        roof = wall.copy()
        # Even a refiner that edits every local cell cannot edit unsupported cells.
        spec = replace(self.spec, geometry_refiner=lambda t, m: t + 1, crown_base=40)
        result = apply_landmark_overrides([self.feature], mask, ground, top, wall, roof, (spec,))
        expected = np.zeros(shape, bool)
        expected[3:7, 3:7] = True
        expected[4, 4] = False
        np.testing.assert_array_equal(top == 51, expected)
        np.testing.assert_array_equal(wall != 1, expected)
        np.testing.assert_array_equal(roof, np.ones(shape, np.uint16))
        self.assertEqual(result["styles"][0]["origin"], [5, 13, 5])
        self.assertEqual(result["styles"][0]["crownBase"], 40)

    def test_explicit_roof_override_preserves_planted_terrace(self):
        shape = (12, 12)
        roof = np.full(shape, C["roof_default"], np.uint16)
        roof[4, 4] = C["garden_roof"]
        spec = replace(self.spec, roof_colour="#ded6c8")
        apply_landmark_overrides([self.feature], np.ones(shape, bool),
                                 np.full(shape, 13), np.full(shape, 50),
                                 np.ones(shape, np.uint16), roof, (spec,))
        self.assertEqual(roof[4, 4], C["garden_roof"])
        self.assertNotEqual(roof[3, 3], C["roof_default"])
        self.assertEqual(roof[0, 0], C["roof_default"])

    def test_curved_roof_restores_interior_without_changing_classification(self):
        shape = (16, 16)
        feature = (12, "relation", self.feature[2], box(2, 2, 14, 14))
        spec = replace(self.spec, anchor=(8, 8), max_area=200, preserve_roof_profile=True)
        mask = np.ones(shape, bool)
        top = np.full(shape, 50, np.int32)
        roof = np.full(shape, C["roof_default"], np.uint16)
        roof[7, 7] = C["garden_roof"]
        raw = np.full(shape, 53.2)
        result = apply_landmark_overrides([feature], mask, np.full(shape, 13), top,
                                         np.ones(shape, np.uint16), roof, (spec,), measured_top=raw)
        self.assertEqual(top[5, 5], 53)
        self.assertEqual(top[2, 2], 50)  # cleaned footprint boundary
        self.assertEqual(top[7, 7], 50)  # planted terrace
        self.assertEqual(top[0, 0], 50)  # outside footprint
        self.assertTrue(mask.all())  # classification/vegetation inputs untouched
        self.assertGreater(result['diagnostics'][0]['roofCellsChanged'], 0)

    def test_city_hall_refiner_preserves_steps_apex_and_footprint(self):
        top = np.full((13, 13), 60, np.int32)
        top[:, 8:] = 90
        top[2, 2] = 61  # isolated 1 m noise on a supported flat roof
        top[6, 6] = 135  # observed pinnacle must survive
        top[4, 4] = 75  # substantial roof geometry must survive
        mask = np.ones(top.shape, bool)
        result = refine_city_hall(top.copy(), mask)
        self.assertEqual(result[2, 2], 60)
        self.assertEqual(result[6, 6], 135)
        self.assertEqual(result[4, 4], 75)
        self.assertTrue((result[:, 8:] == 90).all())
        self.assertEqual(np.count_nonzero(result != top), 1)

    def test_label_uses_selected_identity_and_excludes_neighbouring_tower(self):
        import voxelize

        geom = box(3, 3, 7, 7).difference(box(5, 5, 7, 7))
        ground = np.full((12, 12), 13, np.int32)
        top = np.full((12, 12), 10, np.int32)
        top[6, 6] = 150  # within bounding rectangle, outside selected footprint
        layers = dict(osm=SimpleNamespace(areas=[(12, "relation", {}, geom)], nodes=[]),
                      topi=top, bmask=np.ones(top.shape, bool),
                      landmarkDiagnostics=[dict(key="test", status="applied", identities=[["relation", 12]])])
        landmark = dict(name="Unmatched name", lat=0, lon=0, landmark_key="test")
        with patch.object(voxelize, "LANDMARKS", [landmark]), \
                patch.object(voxelize, "D", 12), patch.object(voxelize, "W", 12), \
                patch.object(voxelize, "lonlat_to_uv", return_value=(voxelize.U_MIN+5, voxelize.V_MAX-5)):
            labels = voxelize.make_labels(layers, ground)
        self.assertEqual(labels[0]["z"], 29)
        self.assertGreater(labels[0]["R"], 1)
        self.assertNotIn("landmark_key", labels[0])


if __name__ == "__main__":
    unittest.main()
