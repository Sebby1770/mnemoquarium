import io
import json
import unittest
from unittest.mock import patch

from mnemoquarium.cli import main
from mnemoquarium.compare import compare_worlds
from mnemoquarium.export import (
    FISH_KINDS,
    field_report,
    fish_kind,
    html_document,
    json_document,
    svg_document,
)
from mnemoquarium.model import World, make_species, words_from_phrase
from mnemoquarium.render import render_ansi, sparkline
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

    def test_drought_fires_on_schedule(self):
        world = World.from_phrase("dry season", width=20, height=12, population=10)
        world.run(41)
        self.assertTrue(any("drought" in event for event in world.events))

    def test_census_tracks_population_and_counters(self):
        world = World.from_phrase("census booth", width=20, height=12, population=12).run(20)
        report = world.census()
        self.assertEqual(report["tick"], 20)
        self.assertEqual(report["population"], len(world.organisms))
        self.assertIn("mutations", report)
        self.assertIn("predations", report)
        self.assertIsInstance(report["species"], list)
        self.assertIn(report["season"], ("spring", "summer", "autumn", "winter"))

    def test_explicit_seed_changes_the_world(self):
        phrase = "same words different weather"
        a = World.from_phrase(phrase, width=16, height=10, population=8, seed=1).run(8)
        b = World.from_phrase(phrase, width=16, height=10, population=8, seed=2).run(8)
        self.assertNotEqual(a.fossil_hash(), b.fossil_hash())

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

    def test_html_export_embeds_specimen(self):
        world = World.from_phrase("html export test", width=18, height=10).run(4)
        document = html_document(world)
        self.assertIn("<!doctype html>", document)
        self.assertIn("reactbits.dev", document)
        self.assertIn(world.phrase, document)

    def test_compare_reports_differences(self):
        left = World.from_phrase("alpha tank", width=16, height=10, population=6).run(8)
        right = World.from_phrase("beta tank", width=16, height=10, population=6).run(8)
        report = compare_worlds(left, right)
        self.assertIn("alpha tank", report)
        self.assertIn("beta tank", report)
        self.assertIn("fossil", report)

    def test_sparkline_renders_blocks(self):
        self.assertEqual(len(sparkline([1, 2, 3, 9])), 4)

    def test_svg_is_side_view_tank(self):
        world = World.from_phrase("library dust with electric teeth", width=20, height=10).run(8)
        svg = svg_document(world)
        self.assertIn("Mnemoquarium specimen", svg)
        self.assertIn("tank-sand", svg)
        self.assertIn("tank-glass", svg)
        self.assertIn("fish-body", svg)
        self.assertIn("url(#water)", svg)
        self.assertEqual(svg, svg_document(world))

    def test_fish_kind_is_stable_and_known(self):
        species = make_species("neon rain static bloom", max_species=6)
        for sp in species:
            kind = fish_kind(sp)
            self.assertIn(kind, FISH_KINDS)
            self.assertEqual(kind, fish_kind(sp))

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




class HeredityTests(unittest.TestCase):
    def test_traits_are_deterministic_and_bounded(self):
        from mnemoquarium.model import genome_traits

        for genome in (0, 1, 0xFF, 0xA5A5, 123456789, 2**63 - 1):
            traits = genome_traits(genome)
            self.assertEqual(traits, genome_traits(genome))
            self.assertIn(traits.appetite, (-1, 0, 1))
            self.assertIn(traits.curiosity, (-1, 0, 1))
            self.assertIsInstance(traits.thrift, bool)
            self.assertTrue(-21 <= traits.hue_shift <= 21)

    def test_point_mutation_flips_exactly_one_expressed_bit(self):
        from mnemoquarium.model import EXPRESSED_MASK, point_mutation

        for genome in (0, 0xFFFF, 0x1234_5678, 987654321):
            mutated = point_mutation(genome)
            diff = genome ^ mutated
            self.assertEqual(bin(diff).count("1"), 1)
            self.assertEqual(diff & ~EXPRESSED_MASK, 0)

    def test_children_inherit_expressed_bits(self):
        from mnemoquarium.model import EXPRESSED_MASK, inherit_genome

        child = inherit_genome(0xABCD_EF00, 0x1234_5642)
        self.assertEqual(child & EXPRESSED_MASK, 0x42)
        self.assertEqual(child & ~EXPRESSED_MASK, 0xABCD_EF00)

    def test_offspring_carry_generation_and_parent_links(self):
        world = World.from_phrase("heredity test", width=24, height=12, population=16).run(60)
        children = [org for org in world.organisms if org.generation > 0]
        self.assertTrue(children, "a 60-tick run should produce offspring")
        for child in children:
            self.assertGreater(child.born, 0)
            self.assertNotEqual(child.parent, 0)
        chain = world.lineage_of(children[0].genome)
        self.assertEqual(chain[0].genome, children[0].genome)
        for older, younger in zip(chain[1:], chain[:-1]):
            self.assertEqual(younger.parent, older.genome)
            self.assertEqual(older.generation + 1, younger.generation)

    def test_genealogy_summary_matches_population(self):
        world = World.from_phrase("family tree", width=24, height=12, population=12).run(40)
        genealogy = world.genealogy()
        self.assertEqual(genealogy["population"], len(world.organisms))
        self.assertEqual(sum(entry["population"] for entry in genealogy["species"]), len(world.organisms))
        self.assertGreaterEqual(genealogy["max_generation"], max(o.generation for o in world.organisms))
        census = world.census()
        self.assertEqual(census["max_generation"], genealogy["max_generation"])
        self.assertIn("mutants", census["species"][0])

    def test_snapshot_round_trip_keeps_heredity(self):
        from mnemoquarium.snapshot import detailed_snapshot, load_snapshot

        world = World.from_phrase("archive", width=20, height=10, population=10).run(30)
        restored = load_snapshot(json.loads(json.dumps(detailed_snapshot(world))))
        self.assertEqual(world.fossil_hash(), restored.fossil_hash())
        self.assertEqual(world.mutations, restored.mutations)
        self.assertEqual(world.predations, restored.predations)
        self.assertEqual(world.extinctions, restored.extinctions)
        self.assertEqual(
            sorted(o.generation for o in world.organisms),
            sorted(o.generation for o in restored.organisms),
        )
        restored.step()
        world.step()
        self.assertEqual(world.fossil_hash(), restored.fossil_hash())

    def test_lineage_document_lists_every_organism(self):
        from mnemoquarium.snapshot import lineage_document

        world = World.from_phrase("lineage doc", width=20, height=10, population=8).run(25)
        payload = json.loads(lineage_document(world))
        self.assertEqual(len(payload["organisms"]), len(world.organisms))
        self.assertIn("genealogy", payload)
        self.assertTrue(all("traits" in org for org in payload["organisms"]))

    def test_history_csv_includes_generation_columns(self):
        from mnemoquarium.snapshot import HistoryRecorder

        world = World.from_phrase("csv", width=16, height=8, population=6)
        recorder = HistoryRecorder(interval=1)
        recorder.maybe_record(world)
        world.step()
        recorder.maybe_record(world)
        header, first, *_ = recorder.to_csv().splitlines()
        self.assertTrue(header.endswith("max_generation,mutant_population"))
        self.assertEqual(len(first.split(",")), 6)

    def test_field_report_has_genealogy_section(self):
        from mnemoquarium.export import field_report

        world = World.from_phrase("report", width=16, height=8, population=6).run(12)
        self.assertIn("## Genealogy", field_report(world))


if __name__ == "__main__":
    unittest.main()
