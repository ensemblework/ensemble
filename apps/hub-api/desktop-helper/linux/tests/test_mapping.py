import unittest

from desktop_helper import mapping


class FitTests(unittest.TestCase):
    def test_downscales_the_long_edge_and_keeps_the_aspect(self):
        self.assertEqual(mapping.fit(2560, 1440), (1568, 882))
        self.assertEqual(mapping.fit(1440, 2560), (882, 1568))

    def test_never_upscales(self):
        self.assertEqual(mapping.fit(800, 600), (800, 600))

    def test_rejects_empty_images(self):
        with self.assertRaises(ValueError):
            mapping.fit(0, 10)


class RegionTests(unittest.TestCase):
    def test_a_logical_region_covers_the_right_frame_pixels_at_125_percent(self):
        # 2560x1440 pixels shown as a 2048x1152 logical monitor.
        self.assertEqual(mapping.logical_to_native((100, 50, 200, 100), (2048, 1152), (2560, 1440)), (125, 62, 250, 126))

    def test_regions_stay_inside_the_stream(self):
        self.assertEqual(mapping.clamp_region((-20, 1430, 5000, 50), 2560, 1440), (0.0, 1430.0, 2560.0, 10.0))
        left, top, width, height = mapping.logical_to_native((2550, 1430, 50, 50), (2560, 1440), (2560, 1440))
        self.assertLessEqual(left + width, 2560)
        self.assertLessEqual(top + height, 1440)

    def test_rejects_infinite_values(self):
        with self.assertRaises(ValueError):
            mapping.clamp_region((float("inf"), 0, 1, 1), 100, 100)


class PointTests(unittest.TestCase):
    def test_points_are_clamped_inside_the_stream(self):
        self.assertEqual(mapping.clamp_point(-5, 20, 1920, 1080), (0.0, 20.0, True))
        self.assertEqual(mapping.clamp_point(5000, 5000, 1920, 1080), (1919.5, 1079.5, True))
        self.assertEqual(mapping.clamp_point(10, 10, 1920, 1080), (10.0, 10.0, False))

    def test_image_points_map_to_pixel_centres_of_the_region(self):
        # A 1568x882 image of a 2560x1440 logical screen.
        x, y = mapping.image_to_logical(0, 0, (1568, 882), (0, 0, 2560, 1440))
        self.assertAlmostEqual(x, 0.816, places=2)
        x, y = mapping.image_to_logical(1567, 881, (1568, 882), (0, 0, 2560, 1440))
        self.assertAlmostEqual(x, 2559.18, places=1)
        self.assertAlmostEqual(y, 1439.18, places=1)
        # A zoom of the region (1000, 500, 400, 300) shown at its own size.
        self.assertEqual(mapping.image_to_logical(10, 20, (400, 300), (1000, 500, 400, 300)), (1010.5, 520.5))

    def test_pointer_positions_are_frame_pixels_of_the_stream(self):
        # Mutter takes absolute pointer positions in the stream's frame pixels, which a scaled monitor makes larger than its logical ones.
        for scale, logical, expected in ((1, (2560, 1440), (100.0, 50.0)), (1.25, (2048, 1152), (125.0, 62.5)), (2, (1280, 720), (200.0, 100.0))):
            with self.subTest(scale=scale):
                self.assertEqual(mapping.logical_to_stream(100, 50, logical, (2560, 1440)), expected)
        x, y = mapping.logical_to_stream(2047.5, 1151.5, (2048, 1152), (2560, 1440))
        self.assertLess(x, 2560)
        self.assertLess(y, 1440)
        self.assertEqual(mapping.logical_to_stream(-5, -5, (2048, 1152), (2560, 1440)), (0.0, 0.0))

    def test_drag_paths_include_both_ends(self):
        points = mapping.path((0, 0), (100, 50), 4)
        self.assertEqual(points[0], (0, 0))
        self.assertEqual(points[-1], (100, 50))
        self.assertEqual(len(points), 5)


if __name__ == "__main__":
    unittest.main()
