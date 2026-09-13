from __future__ import annotations

import html
import json
import math

from .model import Species, World, ranked_species
from .snapshot import detailed_snapshot

FISH_KINDS = ("tetra", "guppy", "angel", "betta", "catfish", "eel")


def fish_kind(sp: Species) -> str:
    """Match the browser tank: bottom-dwellers, angels, tetras, else seed."""
    if sp.appetite >= 3 and sp.curiosity <= 2:
        return "catfish"
    if sp.stubbornness >= 6:
        return "angel"
    if sp.curiosity >= 6 and sp.appetite <= 2:
        return "tetra"
    return FISH_KINDS[sp.seed % len(FISH_KINDS)]


def _sand_y(x: float, width: float, seed: int, base: float) -> float:
    n = (x / max(width, 1.0)) * math.pi * 2
    rise = 18 + 10 * math.sin(n * 1.2 + seed) + 6 * math.sin(n * 2.7 + seed * 0.3)
    return base - rise


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
    genealogy = world.genealogy()
    lines.extend(
        [
            "",
            "## Genealogy",
            "",
            f"Deepest generation: `{genealogy['max_generation']}`",
            f"Mean generation: `{genealogy['mean_generation']}`",
            f"Carrying an inherited mutation: `{genealogy['mutant_population']}`",
            "",
            "| Species | Pop | Max gen | Founders alive | Mutants | Trait variants |",
            "| --- | ---: | ---: | ---: | ---: | ---: |",
        ]
    )
    for entry in genealogy["species"]:
        lines.append(
            f"| {entry['name']} | {entry['population']} | {entry['max_generation']} | "
            f"{entry['founders_alive']} | {entry['mutants']} | {entry['trait_variants']} |"
        )
    if world.events:
        lines.extend(["", "## Last Events", ""])
        lines.extend(f"- {event}" for event in world.events)
    lines.append("")
    return "\n".join(lines)


def svg_document(world: World, *, cell: int = 12) -> str:
    """Side-view aquarium specimen: glass, water, sand, coral, fish."""
    _ = cell  # kept for callers; the tank is a fixed widescreen view
    width = 960
    tank_h = 420
    legend_height = 92 + len(world.species) * 18
    height = tank_h + legend_height + 36
    title = html.escape("Mnemoquarium specimen")
    phrase = html.escape(world.phrase)
    fossil = html.escape(world.fossil_hash())
    ox, oy, tw, th = 24.0, 72.0, 912.0, 330.0
    sand_base = oy + th - 8
    water_top = oy + 16

    parts = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        (
            f'<svg xmlns="http://www.w3.org/2000/svg" '
            f'width="{width}" height="{height}" viewBox="0 0 {width} {height}">'
        ),
        "<defs>",
        "<style>",
        "text { font-family: ui-sans-serif, system-ui, sans-serif; }",
        ".small { font-size: 13px; fill: #e8dfd2; }",
        ".label { font-size: 11px; fill: #9a8c78; }",
        "</style>",
        '<linearGradient id="water" x1="0" y1="0" x2="0" y2="1">',
        '<stop offset="0" stop-color="#6eb7c8"/>',
        '<stop offset="0.45" stop-color="#1a5c6e"/>',
        '<stop offset="1" stop-color="#0b2430"/>',
        "</linearGradient>",
        '<linearGradient id="sandg" x1="0" y1="0" x2="0" y2="1">',
        '<stop offset="0" stop-color="#d2b48c"/>',
        '<stop offset="1" stop-color="#8a6a3b"/>',
        "</linearGradient>",
        "</defs>",
        '<rect class="room" width="100%" height="100%" fill="#120c08"/>',
        f'<text x="24" y="28" class="small">{title}</text>',
        f'<text x="24" y="48" class="label">phrase: {phrase} · tick {world.tick_count} · {world.season()} · fossil {fossil}</text>',
        f'<rect class="tank-glass" x="{ox - 6:.1f}" y="{oy - 18:.1f}" width="{tw + 12:.1f}" '
        f'height="{th + 26:.1f}" rx="8" fill="#1b120c" stroke="#5a3b24"/>',
        f'<rect x="{ox:.1f}" y="{oy:.1f}" width="{tw:.1f}" height="{th:.1f}" fill="url(#water)"/>',
    ]

    # God rays
    for i in range(5):
        x = ox + 40 + i * (tw / 5)
        parts.append(
            f'<polygon points="{x:.1f},{water_top:.1f} {x + 18:.1f},{sand_base:.1f} '
            f'{x + 70:.1f},{sand_base:.1f} {x + 22:.1f},{water_top:.1f}" '
            f'fill="rgba(180,230,255,0.07)"/>'
        )

    # Far kelp
    for i in range(8):
        kx = ox + 30 + ((world.seed * (i + 3)) % int(tw - 60))
        h = 70 + (world.seed + i * 17) % 90
        parts.append(
            f'<path d="M{kx:.1f},{sand_base:.1f} C{kx + 12:.1f},{sand_base - h * 0.4:.1f} '
            f'{kx - 14:.1f},{sand_base - h * 0.7:.1f} {kx + 4:.1f},{sand_base - h:.1f}" '
            f'stroke="hsl(120 35% 22%)" stroke-width="4" fill="none" stroke-linecap="round"/>'
        )

    sand_pts = [f"{ox:.1f},{sand_base + 6:.1f}"]
    for i in range(33):
        px = ox + (i / 32) * tw
        py = _sand_y(px, tw, world.seed, sand_base)
        sand_pts.append(f"{px:.1f},{py:.1f}")
    sand_pts.append(f"{ox + tw:.1f},{sand_base + 6:.1f}")
    parts.append(
        f'<path class="tank-sand" d="M{" L".join(sand_pts)} Z" fill="url(#sandg)"/>'
    )

    # Coral / rocks from seed
    rng_state = world.seed & 0xFFFFFFFF
    for i in range(7):
        rng_state = (rng_state * 1664525 + 1013904223) & 0xFFFFFFFF
        cx = ox + 50 + (rng_state % int(tw - 100))
        rng_state = (rng_state * 1664525 + 1013904223) & 0xFFFFFFFF
        kind = ("branch", "brain", "anemone", "rock")[rng_state % 4]
        hue = 20 + (rng_state % 80)
        sy = _sand_y(cx, tw, world.seed, sand_base)
        if kind == "brain":
            parts.append(
                f'<ellipse cx="{cx:.1f}" cy="{sy - 10:.1f}" rx="16" ry="11" '
                f'fill="hsl({hue} 50% 46%)"/>'
            )
        elif kind == "rock":
            parts.append(
                f'<path d="M{cx - 18:.1f},{sy:.1f} Q{cx - 10:.1f},{sy - 20:.1f} {cx:.1f},{sy - 16:.1f} '
                f'Q{cx + 16:.1f},{sy - 22:.1f} {cx + 20:.1f},{sy:.1f} Z" fill="hsl(220 8% 28%)"/>'
            )
        elif kind == "anemone":
            parts.append(
                f'<ellipse cx="{cx:.1f}" cy="{sy - 4:.1f}" rx="7" ry="4" fill="hsl({hue} 40% 28%)"/>'
            )
            for t in range(7):
                ang = -3.0 + t * 0.4
                tx = cx + math.cos(ang) * 14
                ty = sy - 28
                parts.append(
                    f'<path d="M{cx:.1f},{sy - 6:.1f} Q{cx + math.cos(ang) * 8:.1f},{sy - 20:.1f} '
                    f'{tx:.1f},{ty:.1f}" stroke="hsl({hue + t * 4} 70% 58%)" fill="none" stroke-width="1.6"/>'
                )
        else:
            parts.append(
                f'<path d="M{cx:.1f},{sy:.1f} L{cx:.1f},{sy - 28:.1f} M{cx:.1f},{sy - 16:.1f} '
                f'L{cx - 12:.1f},{sy - 30:.1f} M{cx:.1f},{sy - 16:.1f} L{cx + 11:.1f},{sy - 32:.1f}" '
                f'stroke="hsl({hue} 55% 44%)" stroke-width="4" stroke-linecap="round" fill="none"/>'
            )

    # Bubbles from an aerator
    ax = ox + 40 + (world.seed % 80)
    for i in range(8):
        by = sand_base - 20 - i * 28
        parts.append(
            f'<circle cx="{ax + (i % 3) * 3:.1f}" cy="{by:.1f}" r="{1.5 + (i % 3) * 0.6:.1f}" '
            f'fill="rgba(200,230,255,0.2)" stroke="rgba(255,255,255,0.45)"/>'
        )

    def map_org(org) -> tuple[float, float, str]:
        sp = world.species[org.species_index]
        kind = fish_kind(sp)
        nx = (org.x + 0.5) / world.width
        ny = (org.y + 0.5) / world.height
        px = ox + nx * tw
        py = water_top + 18 + ny * (th - 70)
        if kind == "catfish":
            py = sand_base - 14 - (org.genome % 9)
        elif kind == "eel":
            py = water_top + (th * 0.62) + ny * 30
        return px, py, kind

    for org in sorted(world.organisms, key=lambda o: o.y):
        sp = world.species[org.species_index]
        px, py, kind = map_org(org)
        length = 16 + org.energy * 0.35 + (sp.lifespan % 8)
        height = length * (1.1 if kind == "angel" else 0.16 if kind == "eel" else 0.36)
        facing = 1 if (org.genome >> 3) % 2 == 0 else -1
        hue = sp.hue
        # Teardrop body as an ellipse plus a tail polygon
        parts.append(f'<g class="fish-body" transform="translate({px:.1f} {py:.1f}) scale({facing} 1)">')
        parts.append(
            f'<ellipse cx="0" cy="0" rx="{length * 0.42:.1f}" ry="{height * 0.55:.1f}" '
            f'fill="hsl({hue} 78% 52%)"/>'
        )
        parts.append(
            f'<polygon points="{-length * 0.4:.1f},0 {-length * 0.75:.1f},{-height * 0.55:.1f} '
            f'{-length * 0.55:.1f},0 {-length * 0.75:.1f},{height * 0.55:.1f}" '
            f'fill="hsl({(hue + 12) % 360} 65% 48%)"/>'
        )
        if kind == "angel":
            parts.append(
                f'<polygon points="0,{-height * 0.2:.1f} {-length * 0.1:.1f},{-height * 1.3:.1f} '
                f'{-length * 0.25:.1f},0" fill="hsl({hue} 60% 46%)"/>'
            )
        parts.append(
            f'<circle cx="{length * 0.22:.1f}" cy="{-height * 0.08:.1f}" r="{max(1.4, height * 0.14):.1f}" fill="#f4f1e6"/>'
        )
        parts.append(
            f'<circle cx="{length * 0.26:.1f}" cy="{-height * 0.08:.1f}" r="{max(0.7, height * 0.07):.1f}" fill="#121418"/>'
        )
        parts.append("</g>")

    # Glass highlight + waterline
    parts.append(
        f'<rect x="{ox:.1f}" y="{oy:.1f}" width="22" height="{th:.1f}" fill="rgba(255,255,255,0.12)"/>'
    )
    parts.append(
        f'<rect x="{ox:.1f}" y="{water_top:.1f}" width="{tw:.1f}" height="3" fill="rgba(255,255,255,0.28)"/>'
    )
    parts.append(
        f'<rect x="{ox:.1f}" y="{oy:.1f}" width="{tw:.1f}" height="{th:.1f}" fill="none" '
        f'stroke="rgba(180,210,230,0.4)" stroke-width="3"/>'
    )

    # Tick-driven night wash (48 ticks ≈ one tank day). Winter stays a little darker.
    cycle = (world.tick_count % 48) / 48.0
    night = 0.5 + 0.5 * math.cos(cycle * math.pi * 2)
    if world.season() == "winter":
        night = min(1.0, night + 0.12)
    if night > 0.32:
        alpha = 0.10 + 0.22 * night
        parts.append(
            f'<rect class="moonlit-tint" x="{ox:.1f}" y="{oy:.1f}" width="{tw:.1f}" '
            f'height="{th:.1f}" fill="rgba(18,36,90,{alpha:.2f})"/>'
        )
    if night > 0.55:
        parts.append(
            f'<circle class="moon" cx="{ox + tw - 36:.1f}" cy="{oy - 10:.1f}" r="7" fill="#e8e4d4"/>'
        )

    legend_y = oy + th + 36
    parts.append(f'<text x="24" y="{legend_y}" class="small">species ledger</text>')
    for index, (sp, count) in enumerate(ranked_species(world), start=1):
        y = legend_y + index * 18
        glyph = html.escape(sp.glyph)
        name = html.escape(sp.name)
        source = html.escape(sp.source_word)
        kind = fish_kind(sp)
        parts.append(
            f'<circle cx="30" cy="{y - 4}" r="5" fill="hsl({sp.hue} 78% 56%)"/>'
        )
        parts.append(
            f'<text x="42" y="{y}" class="label">'
            f'{glyph} {name} ({kind}) from "{source}" — pop {count}, '
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