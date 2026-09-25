# Launch kit

Everything needed to put Mnemoquarium: The Deep in front of people. The code
side is done; the steps below need your accounts.

| file | what it is |
| --- | --- |
| [`itch-page.md`](itch-page.md) | copy, tags and settings for the itch.io page |
| [`press-kit.md`](press-kit.md) | fact sheet and description for press, streamers and portals |
| [`launch-posts.md`](launch-posts.md) | drafts for Reddit, Hacker News, the first devlog, short videos, and streamer outreach |
| `../web/press/*.jpg` | screenshots (1280×720), the link-preview card `og.jpg` (1200×630), and the itch cover `itch-cover.jpg` (630×500) |
| `../scripts/press-shots.mjs` | regenerates every image above from the live game — run it on a machine with a real GPU for sharper shots |
| `../scripts/package_itch.py` | builds `dist/mnemoquarium-web-<version>.zip` for the itch.io upload |

## This week — your part

1. **itch.io page.** Create a project, kind *HTML*, upload the zip from
   `python3 scripts/package_itch.py` (or run the *Package for itch.io*
   workflow in the Actions tab and download its artifact). Tick *This file will
   be played in the browser*. Paste the copy from `itch-page.md`. Set pricing
   to *No payments* at first, or pay-what-you-want with $0 minimum.
2. **Support link.** Once the itch page (or a Ko-fi) exists, put its URL in
   `SITE.support` in `web/src/config.js`. A *support the game* link appears on
   the menu; nothing shows while it is empty.
3. **Community.** Make a Discord (or anything with an invite link) and put the
   invite in `SITE.community`. A *join the crew* link appears.
4. **Analytics.** Sign up at goatcounter.com (free for small sites, no
   cookies), pick a code, and set `SITE.goatcounter` to
   `https://<code>.goatcounter.com/count`. The game then counts dives, docks,
   depth reached, deaths, upgrades, photos and shares — never the phrases.
   It honours Do Not Track and sends nothing from localhost.
5. **Post.** Use `launch-posts.md`. One channel a day, not all at once, so
   you can answer comments.

## What to watch

- **How many players reach the kelp band (90 m)** — the first real goal.
- **How many dock at least once** — whether the loop is understood.
- **Photos and shares per dive** — whether the game spreads itself.

If people dive but do not dock, the first ten minutes need clearer goals
before anything else gets built.
