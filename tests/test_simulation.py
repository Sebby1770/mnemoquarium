import io
import json
import unittest
from unittest.mock import patch

from mnemoquarium.cli import main
from mnemoquarium.export import field_report, json_document, svg_document
from mnemoquarium.model import World, make_species, words_from_phrase
from mnemoquarium.render import render_ansi
from mnemoquarium.snapshot import HistoryRecorder, detailed_snapshot, load_snapshot


class MnemoquariumTests(unittest.TestCase):
    def test_phrase_tokenization_keeps_unique_words(self):
        self.assertEqual(
            words_from_phrase("Echo echo, STATIC! static? 1770"),
            ["echo", "static", "1770"],
        )

    def test_species_are_deterministic_and_capped(self):
        phrase = "one two three four five six seven eight nine"
        first = make_species(phrase, max_species=4)
        second = make_species(phrase, max_species=4)
        self.assertEqual([sp.as_dict() for sp in first], [sp.as_dict() for sp in second])
        self.assertEqual(len(first), 4)

    def test_species_glyphs_are_unique(self):
        phrase = "alpha beta gamma delta epsilon zeta eta theta iota kappa"
        species = make_species(phrase, max_species=10)
        glyphs = [sp.glyph for sp in species]
        self.assertEqual(len(glyphs), len(set(glyphs)))

    def test_world_is_deterministic(self):
        phrase = "the vending machine remembers my name"
        first = World.from_phrase(phrase, width=24, height=12, population=12).run(32)
        second = World.from_phrase(phrase, width=24, height=12, population=12).run(32)
        self.assertEqual(first.fossil_hash(), second.fossil_hash())
        self.assertEqual(render_ansi(first, color=False), render_ansi(second, color=False))

    def test_exports_include_core_snapshot_data(self):
        world = World.from_phrase("library dust with electric teeth", width=20, height=10).run(5)
        snapshot = json.loads(json_document(world))
        self.assertEqual(snapshot["fossil_hash"], world.fossil_hash())
        self.assertIn("Mnemoquarium specimen", svg_document(world))
        self.assertIn("Field Report", field_report(world))

    def test_small_worlds_are_rejected(self):
        with self.assertRaises(ValueError):
            World.from_phrase("tiny", width=4, height=4)

    def test_step_increments_tick(self):
        world = World.from_phrase("tick test", width=16, height=10, population=8)
        self.assertEqual(world.tick_count, 0)
        world.step()
        self.assertEqual(world.tick_count, 1)

    def test_weather_events_fire_on_schedule(self):
        world = World.from_phrase("weather", width=20, height=12, population=10)
        world.run(11)
        self.assertTrue(any("static bloom" in event for event in world.events))

    def test_extinction_triggers_rescue(self):
        world = World.from_phrase("rescue", width=16, height=10, population=4)
        world.organisms.clear()
        world.step()
        self.assertGreater(len(world.organisms), 0)
        self.assertTrue(any("reseeded" in event for event in world.events))

    def test_cli_rejects_invalid_dimensions(self):
        result = main(["test", "--width", "4", "--height", "4"])
        self.assertEqual(result, 2)

    def test_cli_rejects_negative_steps(self):
        result = main(["test", "--steps", "-1"])
        self.assertEqual(result, 2)

    def test_cli_uses_default_phrase(self):
        buffer = io.StringIO()
        with patch("sys.stdout", buffer):
            result = main(["--steps", "0", "--width", "16", "--height", "10"])
        self.assertEqual(result, 0)
        self.assertIn("tick=0", buffer.getvalue())

    def test_snapshot_round_trip_preserves_state(self):
        world = World.from_phrase("replay me softly", width=20, height=12, population=10).run(12)
        restored = load_snapshot(detailed_snapshot(world))
        self.assertEqual(world.fossil_hash(), restored.fossil_hash())
        self.assertEqual(render_ansi(world, color=False), render_ansi(restored, color=False))

    def test_history_recorder_tracks_population(self):
        world = World.from_phrase("history check", width=18, height=10, population=8)
        history = HistoryRecorder(interval=2)
        history.maybe_record(world)
        for _ in range(6):
            world.step()
            history.maybe_record(world)
        self.assertGreaterEqual(len(history.entries), 3)
        self.assertIn("tick", history.entries[0])
        self.assertIn("species_populations", history.entries[-1])

    def test_overcrowded_cells_show_counts(self):
        world = World.from_phrase("crowd", width=16, height=10, population=1)
        world.organisms = [
            world.organisms[0],
            World.from_phrase("crowd", width=16, height=10, population=1).organisms[0],
        ]
        world.organisms[0].x = world.organisms[1].x = 3
        world.organisms[0].y = world.organisms[1].y = 4
        world.organisms[1].energy = world.organisms[0].energy - 1
        rendered = render_ansi(world, color=False)
        self.assertIn("2", rendered)


if __name__ == "__main__":
    unittest.main()