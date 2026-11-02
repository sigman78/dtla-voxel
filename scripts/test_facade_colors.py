import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

import numpy as np
from shapely.geometry import box

from facade_colors import FacadeColor, apply_facade_colors, load_roster
from palette import M_CITY_HALL, M_GLASS, M_ROOF, M_WALL, C, pal


class FacadeColorTests(unittest.TestCase):
    def setUp(self):
        self.feature = (12, "relation", {"building": "yes", "name": "Same Name"}, box(2, 2, 6, 6))
        self.entry = FacadeColor("test", ("relation", 12), (4, 4), 2, 10, 20,
                                 "#827261", M_WALL)
        self.mask = np.ones((8, 8), bool)
        self.wall = np.full((8, 8), pal("#9c5b31", M_GLASS), np.uint16)
        self.roof = np.full((8, 8), pal("#d0d0d0", M_ROOF), np.uint16)

    def test_exact_namespace_and_geometry_guards_fail_closed(self):
        for feature in ((12, "way", self.feature[2], self.feature[3]),
                        (13, "relation", self.feature[2], self.feature[3]),
                        (12, "relation", self.feature[2], box(20, 20, 24, 24)),
                        (12, "relation", self.feature[2], box(3, 3, 4, 4))):
            with self.subTest(feature=feature):
                before = self.wall.copy()
                diagnostic = apply_facade_colors([feature], self.mask, self.wall, self.roof, [self.entry])
                np.testing.assert_array_equal(self.wall, before)
                self.assertNotEqual(diagnostic[0]["status"], "applied")

    def test_only_building_cells_inside_identity_change_and_roofs_stay(self):
        self.mask[3, 3] = False
        wall, roof = self.wall.copy(), self.roof.copy()
        apply_facade_colors([self.feature], self.mask, self.wall, self.roof, [self.entry])
        expected = np.zeros((8, 8), bool)
        expected[2:6, 2:6] = True
        expected[3, 3] = False
        np.testing.assert_array_equal(self.wall != wall, expected)
        np.testing.assert_array_equal(self.roof, roof)
        self.assertEqual(pal.entries[int(self.wall[2, 2])][3], M_WALL)

    def test_special_pattern_and_planted_roof_survive_explicit_colour(self):
        self.wall[:] = pal("#e0d6ca", M_CITY_HALL)
        self.roof[:] = pal("#e0d6ca", M_CITY_HALL)
        self.roof[3, 3] = C["garden_roof"]
        entry = FacadeColor("test", ("relation", 12), (4, 4), 2, 10, 20,
                            "#d2c8b9", M_GLASS, "#ded5c8")
        apply_facade_colors([self.feature], self.mask, self.wall, self.roof, [entry])
        self.assertEqual(pal.entries[int(self.wall[2, 2])][3], M_CITY_HALL)
        self.assertEqual(self.wall[2, 2], pal("#d2c8b9", M_CITY_HALL))
        self.assertEqual(self.roof[2, 2], pal("#ded5c8", M_CITY_HALL))
        self.assertEqual(self.roof[3, 3], C["garden_roof"])
        self.assertEqual(self.roof[0, 0], pal("#e0d6ca", M_CITY_HALL))

    def test_roster_ignores_pending_but_rejects_invalid_verified(self):
        verified = dict(key="test", status="verified", identity=dict(type="relation", id=12),
                        anchor=[4, 4], maxDistance=2, minArea=10, maxArea=20,
                        color="#827261", material="wall", sources=["https://example.com/evidence"])
        with TemporaryDirectory() as folder:
            path = Path(folder) / "roster.json"
            self.assertEqual(load_roster(path), [])
            path.write_text(json.dumps(dict(version=1, entries=[dict(status="pending"), verified])))
            self.assertEqual(load_roster(path), [self.entry])
            for broken in ({**verified, "sources": []}, {**verified, "color": "orange"},
                           {**verified, "identity": dict(type="node", id=12)},
                           {**verified, "maxDistance": float("nan")}):
                path.write_text(json.dumps(dict(version=1, entries=[broken])))
                with self.assertRaises(ValueError):
                    load_roster(path)


if __name__ == "__main__":
    unittest.main()
