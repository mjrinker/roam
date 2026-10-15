import unittest

import conftest_path  # noqa: F401
from resources.lib import timeline

PARTS = [
    {"startSeconds": 0, "durationSeconds": 100},
    {"startSeconds": 100, "durationSeconds": 50},
]
SLICE = [{"startSeconds": 0, "durationSeconds": 40, "inFileOffsetSeconds": 60, "inFileEndSeconds": 100}]


class Timeline(unittest.TestCase):
    def test_finds_the_part_and_the_place_in_its_file(self):
        self.assertEqual(timeline.locate_part(PARTS, 30)[0::2], (0, 30))
        self.assertEqual(timeline.locate_part(PARTS, 100)[0::2], (1, 0))
        self.assertEqual(timeline.locate_part(PARTS, 120)[0::2], (1, 20))

    def test_clamps_before_the_start_and_after_the_end(self):
        self.assertEqual(timeline.locate_part(PARTS, -5)[0::2], (0, 0))
        self.assertEqual(timeline.locate_part(PARTS, 999)[0::2], (1, 50))

    def test_a_slice_of_a_shared_file_starts_inside_the_file(self):
        i, seg, local = timeline.locate_part(SLICE, 10)
        self.assertEqual((i, local), (0, 70))
        self.assertEqual(timeline.global_time(seg, 70), 10)

    def test_global_time_adds_the_parts_before(self):
        self.assertEqual(timeline.global_time(PARTS[1], 20), 120)

    def test_scenes_have_edges(self):
        skips = [{"startSeconds": 10, "endSeconds": 20, "action": "skip"}]
        self.assertIsNone(timeline.scene_at(skips, 9.9))
        self.assertIsNotNone(timeline.scene_at(skips, 10))
        self.assertIsNotNone(timeline.scene_at(skips, 19.9))
        self.assertIsNone(timeline.scene_at(skips, 20))
        self.assertIsNone(timeline.scene_at(None, 5))

    def test_the_skip_button_is_offered_while_a_part_plays_and_named_by_kind(self):
        segs = [{"kind": "intro", "startSeconds": 60, "endSeconds": 90}, {"kind": "outro", "startSeconds": 2500, "endSeconds": 2600}]
        self.assertIsNone(timeline.skip_button_at(segs, 30))
        self.assertEqual(timeline.skip_button_at(segs, 75), {"label": "Skip intro", "to": 90, "kind": "intro"})
        self.assertEqual(timeline.skip_button_at(segs, 2550)["label"], "Skip credits")
        self.assertIsNone(timeline.skip_button_at(segs, 89.5))  # the last second isn't worth a button

    def test_what_counts_as_watched(self):
        self.assertTrue(timeline.is_finished(5400 - 60, 5400))
        self.assertTrue(timeline.is_finished(5200, 5400))
        self.assertFalse(timeline.is_finished(1000, 5400))
        self.assertFalse(timeline.is_finished(10, 0))


if __name__ == "__main__":
    unittest.main()
