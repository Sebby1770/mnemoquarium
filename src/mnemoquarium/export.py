from __future__ import annotations

import html
import json

from .display import dominant_organism, organisms_by_cell
from .model import World, ranked_species
from .snapshot import detailed_snapshot


def json_document(world: World) -> str:
    return json.dumps(detailed_snapshot(world), indent=2, sort_keys=True) + "\n"


def field_report(world: World) -> str:
    snapshot = world.snapshot()
    lines = [
        "# Mnemoquarium Field Report",
        "",
        f"Phrase: `{world.phrase}`",
        f"Tick: `{world.tick_count}`",
        f"Fossil hash: `{snapshot['fossil_hash']}`",
        f"Population: `{len(world.organisms)}`",
        f"Nutrient total: `{snapshot['nutrient_total']}`",
        "",
        "## Species",
        "",
        "| Glyph | Species | Source | Pop | Traits |",
        "| --- | --- | --- | ---: | --- |",
    ]
    for sp, count in ranked_species(world):
        traits = (
            f"eat {sp.appetite}, curious {sp.curiosity}, "
            f"stubborn {sp.stubbornness}, split {sp.split_threshold}, "
            f"life {sp.lifespan}"
        )
        lines.append(
            f"| `{sp.glyph}` | {sp.name} | `{sp.source_word}` | {count} | {traits} |"
        )
    if world.events:
        lines.extend(["", "## Last Events", ""])
        lines.extend(f"- {event}" for event in world.events)
    lines.append("")
    return "\n".join(lines)


def svg_document(world: World, *, cell: int = 12) -> str:
    margin = 18
    legend_height = 108 + len(world.species) * 18
    width = world.width * cell + margin * 2
    grid_height = world.height * cell
    height = grid_height + legend_height + margin * 2
    title = html.escape("Mnemoquarium specimen")
    phrase = html.escape(world.phrase)
    fossil = html.escape(world.fossil_hash())

    parts = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        (
            f'<svg xmlns="http://www.w3.org/2000/svg" '
            f'width="{width}" height="{height}" viewBox="0 0 {width} {height}">'
        ),
        "<defs>",
        "<style>",
        "text { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }",
        ".small { font-size: 12px; fill: #d8e3ef; }",
        ".label { font-size: 11px; fill: #93a4b8; }",
        "</style>",
        "</defs>",
        '<rect width="100%" height="100%" fill="#071014"/>',
        f'<text x="{margin}" y="25" class="small">{title}</text>',
        f'<text x="{margin}" y="44" class="label">phrase: {phrase}</text>',
        f'<text x="{margin}" y="62" class="label">tick: {world.tick_count} / fossil: {fossil}</text>',
    ]

    ox = margin
    oy = margin + 60
    parts.append(
        f'<rect x="{ox - 1}" y="{oy - 1}" width="{world.width * cell + 2}" '
        f'height="{grid_height + 2}" fill="#0d1b20" stroke="#24404a"/>'
    )
    for y, row in enumerate(world.nutrients):
        for x, value in enumerate(row):
            light = 8 + value * 6
            opacity = 0.25 + value * 0.055
            parts.append(
                f'<rect x="{ox + x * cell}" y="{oy + y * cell}" '
                f'width="{cell}" height="{cell}" fill="hsl(185 42% {light}%)" '
                f'opacity="{opacity:.2f}"/>'
            )

    for (x, y), occupants in organisms_by_cell(world).items():
        organism = dominant_organism(occupants)
        sp = world.species[organism.species_index]
        energy = organism.energy
        radius = max(3, min(cell * 0.48, 2 + energy * 0.18))
        cx = ox + x * cell + cell / 2
        cy = oy + y * cell + cell / 2
        glyph = html.escape(sp.glyph)
        parts.append(
            f'<circle cx="{cx:.1f}" cy="{cy:.1f}" r="{radius:.1f}" '
            f'fill="hsl({sp.hue} 78% 56%)" opacity="0.88"/>'
        )
        parts.append(
            f'<text x="{cx:.1f}" y="{cy + 3:.1f}" text-anchor="middle" '
            f'font-size="{max(8, cell - 2)}" fill="#071014">{glyph}</text>'
        )
        if len(occupants) > 1:
            parts.append(
                f'<text x="{cx + cell * 0.28:.1f}" y="{cy - cell * 0.22:.1f}" '
                f'font-size="8" fill="#d8e3ef">{len(occupants)}</text>'
            )

    legend_y = oy + grid_height + 28
    parts.append(f'<text x="{margin}" y="{legend_y}" class="small">species ledger</text>')
    for index, (sp, count) in enumerate(ranked_species(world), start=1):
        y = legend_y + index * 18
        glyph = html.escape(sp.glyph)
        name = html.escape(sp.name)
        source = html.escape(sp.source_word)
        parts.append(
            f'<circle cx="{margin + 6}" cy="{y - 4}" r="5" '
            f'fill="hsl({sp.hue} 78% 56%)"/>'
        )
        parts.append(
            f'<text x="{margin + 18}" y="{y}" class="label">'
            f'{glyph} {name} from "{source}" - pop {count}, '
            f'eat {sp.appetite}, curious {sp.curiosity}, split {sp.split_threshold}'
            "</text>"
        )

    parts.append("</svg>")
    return "\n".join(parts) + "\n"


def html_document(world: World) -> str:
    phrase = html.escape(world.phrase)
    fossil = html.escape(world.fossil_hash())
    svg = svg_document(world)
    if svg.startswith("<?xml"):
        svg = svg.split("\n", 1)[1]
    species_rows = []
    for sp, count in ranked_species(world):
        species_rows.append(
            "<tr>"
            f"<td>{html.escape(sp.glyph)}</td>"
            f"<td>{html.escape(sp.name)}</td>"
            f"<td>{html.escape(sp.source_word)}</td>"
            f"<td>{count}</td>"
            f"<td>{sp.appetite}</td>"
            f"<td>{sp.curiosity}</td>"
            f"<td>{sp.split_threshold}</td>"
            "</tr>"
        )

    return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Mnemoquarium — {phrase}</title>
  <style>
    :root {{
      color-scheme: dark;
      --ink: #071014;
      --panel: rgba(10, 24, 30, 0.82);
      --line: rgba(147, 164, 184, 0.22);
      --text: #d8e3ef;
      --muted: #93a4b8;
      --cyan: #4de7ff;
      --coral: #ff6a53;
      --gold: #ffd166;
    }}
    * {{ box-sizing: border-box; }}
    body {{
      margin: 0;
      font-family: Inter, ui-sans-serif, system-ui, sans-serif;
      color: var(--text);
      background: var(--ink);
      min-height: 100vh;
    }}
    .aurora {{
      position: fixed;
      inset: 0;
      pointer-events: none;
      overflow: hidden;
      z-index: 0;
    }}
    .aurora span {{
      position: absolute;
      width: 50vmax;
      height: 50vmax;
      border-radius: 50%;
      filter: blur(80px);
      opacity: 0.45;
      animation: drift 16s ease-in-out infinite;
    }}
    .aurora .a {{ top: -10%; left: -8%; background: radial-gradient(circle, rgba(77,231,255,.5), transparent 70%); }}
    .aurora .b {{ right: -12%; bottom: -18%; background: radial-gradient(circle, rgba(255,106,83,.4), transparent 72%); animation-delay: -5s; }}
    .aurora .c {{ top: 40%; left: 35%; background: radial-gradient(circle, rgba(255,209,102,.35), transparent 74%); animation-delay: -9s; }}
    @keyframes drift {{
      0%, 100% {{ transform: translate3d(0,0,0) scale(1); }}
      50% {{ transform: translate3d(3%, -2%, 0) scale(1.05); }}
    }}
    main {{
      position: relative;
      z-index: 1;
      max-width: 1100px;
      margin: 0 auto;
      padding: 32px 20px 48px;
    }}
    h1 {{
      margin: 0 0 8px;
      font-size: clamp(1.6rem, 4vw, 2.4rem);
      background: linear-gradient(92deg, var(--cyan), var(--gold), var(--coral));
      -webkit-background-clip: text;
      background-clip: text;
      color: transparent;
    }}
    .meta, .events {{
      color: var(--muted);
      font-size: 0.95rem;
      line-height: 1.5;
    }}
    .card {{
      margin-top: 24px;
      padding: 18px;
      border: 1px solid var(--line);
      border-radius: 14px;
      background: var(--panel);
      backdrop-filter: blur(14px);
      box-shadow: 0 24px 60px rgba(0,0,0,.35);
    }}
    .specimen svg {{ width: 100%; height: auto; display: block; }}
    table {{
      width: 100%;
      border-collapse: collapse;
      font-size: 0.9rem;
    }}
    th, td {{
      padding: 10px 8px;
      border-bottom: 1px solid rgba(255,255,255,.08);
      text-align: left;
    }}
    th {{ color: var(--muted); font-size: 0.75rem; text-transform: uppercase; letter-spacing: .04em; }}
  </style>
</head>
<body>
  <div class="aurora" aria-hidden="true"><span class="a"></span><span class="b"></span><span class="c"></span></div>
  <main>
    <h1>Mnemoquarium specimen</h1>
    <p class="meta">phrase: <strong>{phrase}</strong><br />
    tick: {world.tick_count} · population: {len(world.organisms)} · fossil: <code>{fossil}</code></p>
    <section class="card specimen">{svg}</section>
    <section class="card">
      <h2>Species ledger</h2>
      <table>
        <thead><tr><th>Glyph</th><th>Species</th><th>Source</th><th>Pop</th><th>Eat</th><th>Curious</th><th>Split</th></tr></thead>
        <tbody>{''.join(species_rows)}</tbody>
      </table>
    </section>
    {"<section class='card events'><h2>Last events</h2><ul>" + ''.join(f"<li>{html.escape(event)}</li>" for event in world.events) + "</ul></section>" if world.events else ""}
    <p class="meta">UI inspired by <a href="https://reactbits.dev" style="color:var(--cyan)">React Bits</a> aurora + gradient patterns.</p>
  </main>
</body>
</html>
"""