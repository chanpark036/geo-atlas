import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location(
    'subway_headings', Path(__file__).with_name('import-subway-headings.py')
)
headings = importlib.util.module_from_spec(spec)
spec.loader.exec_module(headings)


class StationHeadingTests(unittest.TestCase):
    def test_departing_tangent_and_reverse_order(self):
        path = [[0, 0], [0.001, 0], [0.001, 0.001]]
        self.assertEqual(headings.station_bearing(path, [0.001, 0]), 0)
        self.assertEqual(headings.station_bearing(list(reversed(path)), [0.001, 0]), 270)
        self.assertEqual(headings.station_bearing(path, [0.001, 0.001]), 0)

    def test_small_coordinate_offset_and_distance_limit(self):
        path = [[0, 0], [0.001, 0]]
        self.assertEqual(headings.station_bearing(path, [0.0005, 0.00002]), 90)
        self.assertIsNone(headings.station_bearing(path, [0.0005, 0.001]))

    def test_repeated_vertices_and_ambiguous_loops(self):
        self.assertEqual(headings.station_bearing([[0, 0], [0, 0], [0.001, 0]], [0, 0]), 90)
        self.assertIsNone(headings.station_bearing([[0, 0], [0, 0]], [0, 0]))
        self.assertIsNone(headings.station_bearing([[0, 0], [1, 0], [0, 0], [0, 1]], [0, 0]))

    def test_circular_consensus_and_conflicting_variants(self):
        self.assertEqual(headings.consensus([359, 1]), 0)
        self.assertIsNone(headings.consensus([0, 90]))


if __name__ == '__main__':
    unittest.main()
