import unittest

import numpy as np
from rasterio.features import rasterize
from scipy import ndimage
from shapely.geometry import LineString, Point

from road_markings import apply_crosswalk_paint, build_crosswalk_mask, finalize_crosswalk_paint, junction_interiors


def road(oid, coordinates, width=10, **tags):
    return (oid, {"highway": "primary", **tags}, LineString(coordinates), width)


def road_mask(roads, shape=(64, 64)):
    return rasterize([(r[2].buffer(r[3]/2, cap_style="flat"), 1) for r in roads], out_shape=shape)


class RoadMarkingTests(unittest.TestCase):
    def test_crosswalk_bars_follow_traffic_for_orthogonal_and_oblique_roads(self):
        for direction in ((1, 0), (2**-.5, 2**-.5)):
            with self.subTest(direction=direction):
                traffic = np.array(direction)
                walk = np.array([-traffic[1], traffic[0]])
                centre = np.array([30, 30])
                roads = [road(1, [centre-traffic*25, centre+traffic*25])]
                crossing = LineString([centre-walk*6, centre+walk*6])
                mask, diagnostic = build_crosswalk_mask([(10, {"footway": "crossing", "crossing": "marked"}, crossing)], [], roads, road_mask(roads))
                self.assertEqual(diagnostic["explicit"], 1)
                labels, count = ndimage.label(mask)
                self.assertGreaterEqual(count, 2)
                for component in range(1, count+1):
                    rr, cc = np.nonzero(labels == component)
                    self.assertGreaterEqual(len(rr), 3)
                    points = np.column_stack((cc+.5, rr+.5))
                    self.assertGreater(np.ptp(points @ traffic), np.ptp(points @ walk))

    def test_unmarked_grade_separated_and_ambiguous_nodes_stay_unpainted(self):
        roads = [road(1, [(3, 30), (60, 30)]), road(2, [(30, 3), (30, 60)])]
        for tags in ({"crossing": "unmarked", "crossing:markings": "zebra"},
                     {"crossing:markings": "no", "crossing": "traffic_signals"},
                     {"crossing": "traffic_signals"}, {"crossing:markings": "surface"},
                     {"crossing": "marked", "bridge": "yes"},
                     {"crossing": "marked", "tunnel": "yes"},
                     {"crossing": "marked", "layer": "-1"},
                     {"crossing": "marked"}):  # two intersecting road directions are ambiguous
            with self.subTest(tags=tags):
                mask, _ = build_crosswalk_mask([], [(10, {"highway": "crossing", **tags}, Point(30, 30))], roads, road_mask(roads))
                self.assertFalse(mask.any())

    def test_marked_node_fallback_is_bounded_and_explicit_way_takes_precedence(self):
        roads = [road(1, [(2, 20), (60, 20)], width=8), road(2, [(2, 35), (60, 35)], width=8)]
        node = (11, {"highway": "crossing", "crossing": "marked"}, Point(25, 20))
        mask, diagnostic = build_crosswalk_mask([], [node], roads, road_mask(roads))
        self.assertEqual(diagnostic["nodeFallback"], 1)
        self.assertTrue(mask[16:24].any())
        self.assertFalse(mask[30:].any())  # no leak into the adjacent road
        crossing = (12, {"footway": "crossing", "crossing": "marked"}, LineString([(25, 15), (25, 25)]))
        _, diagnostic = build_crosswalk_mask([crossing], [node], roads, road_mask(roads))
        self.assertEqual(diagnostic["explicit"], 1)
        self.assertEqual(diagnostic["nodeFallback"], 0)

    def test_closed_or_bent_crossing_path_does_not_create_diagonal_paint(self):
        roads = [road(1, [(2, 30), (60, 30)])]
        for coordinates in ([(20, 20), (40, 20), (40, 40), (20, 20)],
                            [(20, 23), (30, 30), (20, 37)]):
            crossing = (12, {"footway": "crossing", "crossing": "marked"}, LineString(coordinates))
            mask, _ = build_crosswalk_mask([crossing], [], roads, road_mask(roads))
            self.assertFalse(mask.any())

    def test_late_paint_preserves_centerlines_and_discards_isolated_fragments(self):
        colors = np.ones((8, 8), np.uint16)
        colors[3, :] = 2  # yellow center line
        mask = np.zeros_like(colors, bool)
        mask[1:6, 2:5] = True
        mask[7, 7] = True
        apply_crosswalk_paint(colors, mask, [1], 3)
        self.assertTrue((colors[3] == 2).all())
        self.assertEqual(colors[7, 7], 1)
        self.assertTrue((colors[4:6, 2:5] == 3).all())

    def test_explicit_lines_style_has_two_walking_direction_borders(self):
        roads = [road(1, [(2, 30), (60, 30)], width=12)]
        crossing = (12, {"footway": "crossing", "crossing:markings": "lines"}, LineString([(30, 23), (30, 37)]))
        mask, diagnostic = build_crosswalk_mask([crossing], [], roads, road_mask(roads))
        self.assertEqual(diagnostic["explicit"], 1)
        self.assertFalse(mask[:, 29:31].any())  # no interior bars across the walking strip
        labels, count = ndimage.label(mask)
        self.assertEqual(count, 2)
        for label in (1, 2):
            rr, cc = np.nonzero(labels == label)
            self.assertGreater(np.ptp(rr), np.ptp(cc))

    def test_explicit_negative_way_overrides_positive_node(self):
        roads = [road(1, [(2, 30), (60, 30)])]
        crossing = (12, {"footway": "crossing", "crossing": "unmarked"}, LineString([(30, 24), (30, 36)]))
        node = (13, {"highway": "crossing", "crossing": "marked"}, Point(30, 30))
        mask, diagnostic = build_crosswalk_mask([crossing], [node], roads, road_mask(roads))
        self.assertFalse(mask.any())
        self.assertEqual(diagnostic["nodeFallback"], 0)

    def test_explicit_cycleway_does_not_become_pedestrian_node_zebra(self):
        roads = [road(1, [(2, 30), (60, 30)])]
        crossing = (12, {"highway": "cycleway", "cycleway": "crossing", "crossing": "marked"}, LineString([(30, 24), (30, 36)]))
        node = (13, {"highway": "crossing", "crossing": "marked"}, Point(30, 30))
        mask, diagnostic = build_crosswalk_mask([crossing], [node], roads, road_mask(roads))
        self.assertFalse(mask.any())
        self.assertEqual(diagnostic["nodeFallback"], 0)

    def test_finalizer_retains_underlay_and_existing_model_palette_prefix(self):
        from palette import pal
        colors = np.ones((8, 8), np.uint16)
        mask = np.zeros_like(colors, bool)
        mask[2:5, 2:5] = True
        layers = dict(gcol=colors, crosswalkMask=mask, crosswalkUnderlay=colors.copy(),
                      roadPaletteIds=[1], roadMarkingDiagnostics={})
        prefix = list(pal.entries)  # includes materials allocated by the model preparation step
        finalize_crosswalk_paint(layers)
        self.assertEqual(pal.entries[:len(prefix)], prefix)
        self.assertTrue((layers["crosswalkUnderlay"] == 1).all())
        self.assertEqual(layers["roadMarkingDiagnostics"]["paintedCells"], 9)
        self.assertTrue((colors[mask] == layers["crosswalkPalette"]).all())
        finalize_crosswalk_paint(layers)
        np.testing.assert_array_equal(layers["crosswalkMask"], mask)

    def test_four_way_and_t_junctions_remove_yellow_inside_but_keep_approaches(self):
        through = road(1, [(3, 30), (30, 30), (60, 30)], width=10)
        for arm in (road(2, [(30, 3), (30, 30), (30, 60)], width=12),
                    road(2, [(30, 3), (30, 30)], width=12)):
            with self.subTest(arm=arm):
                interior = junction_interiors([through, arm])
                self.assertTrue(interior.covers(Point(30, 30)))
                self.assertTrue(interior.covers(Point(30, 33)))  # full through-road even at T
                yellow = through[2].buffer(.5).difference(interior)
                self.assertFalse(yellow.covers(Point(30, 30)))
                self.assertTrue(yellow.covers(Point(15, 30)))

    def test_collinear_joins_and_non_surface_roads_are_not_junctions(self):
        through = road(1, [(3, 30), (30, 30)])
        self.assertTrue(junction_interiors([through, road(2, [(30, 30), (60, 30)])]).is_empty)
        for tags in ({"bridge": "yes"}, {"tunnel": "yes"}, {"layer": "1"}, {"highway": "service"}):
            self.assertTrue(junction_interiors([through, road(2, [(30, 3), (30, 60)], **tags)]).is_empty)
        # Geometric crossings without shared vertices are not connected road junctions.
        self.assertTrue(junction_interiors([road(1, [(3, 30), (60, 30)]), road(2, [(30, 3), (30, 60)])]).is_empty)


if __name__ == "__main__":
    unittest.main()
