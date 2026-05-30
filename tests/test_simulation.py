import json
import unittest

from mnemoquarium.export import field_report, json_document, svg_document
from mnemoquarium.model import World, make_species, words_from_phrase
from mnemoquarium.render import render_ansi


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


if __name__ == "__main__":
    unittest.main()
