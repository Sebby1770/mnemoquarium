#!/usr/bin/env node
/* Screenshots for the press kit, the itch.io page and link previews.
 *
 *   node scripts/press-shots.mjs            # writes web/press/*.jpg
 *
 * Needs Playwright (npm i -g playwright, or a local install). It serves web/
 * itself, drives the real game into a handful of staged scenes, hides the HUD
 * the way photo mode does, and saves 1280x720 JPEGs, plus og.jpg (1200x630,
 * the card social sites show for a shared link) and itch-cover.jpg (630x500).
 *
 * Run it on a machine with a real GPU for the best-looking results; without
 * one Chromium falls back to software rendering, which is slow but works. */

import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import { extname, join, normalize, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "web");
const out = join(root, "press");

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch (err) {
    const global = execSync("npm root -g").toString().trim();
    return createRequire(join(global, "noop.js"))("playwright");
  }
}

const TYPES = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
  ".svg": "image/svg+xml", ".json": "application/json", ".webmanifest": "application/manifest+json",
  ".png": "image/png", ".jpg": "image/jpeg",
};

function serve() {
  const server = createServer(async (req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^([/\\])+/, "");
    const file = join(root, path || "index.html");
    if (!file.startsWith(root)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const body = await readFile(file.endsWith("/") ? join(file, "index.html") : file);
      res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream" }).end(body);
    } catch (err) {
      res.writeHead(404).end();
    }
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

const PHRASE = "forgotten kiosk under neon rain";
const W = 1280;
const H = 720;

/* Each scene sets the game up, then waits for it to render. */
const SCENES = [
  { name: "station", setup: `
      const s = g.sub, st = g.world.stationPosition;
      s.position.set(st.x + 20, st.y - 3, st.z + 60); s.velocity.set(0, 0, 0);
      s.yaw = Math.atan2(20, 60); s.pitch = -0.07;` },
  { name: "reef", setup: `
      const s = g.sub; s.position.y = -30; s.yaw = 0; s.pitch = 0.22; s.velocity.set(0, 0, 0);
      const T = g.ambient.kinds.find((k) => k.id === "turtle");
      const t = T.animals[0]; t.alive = true; t.scale = 1.4; t.retarget = 99; t.turn = 0;
      t.position.set(s.position.x - 1.5, s.position.y + 1.2, s.position.z - 6); t.heading = 2.4;
      const J = g.ambient.kinds.find((k) => k.id === "jelly");
      J.animals.slice(0, 5).forEach((j, i) => { j.alive = true; j.scale = 0.9 + i * 0.15; j.position.set(s.position.x + 3 + i * 1.6, s.position.y + 2 + (i % 3), s.position.z - 9 - i * 2); });` },
  { name: "widow", setup: `
      g.profile.upgrades.pressure = 5; g.profile.upgrades.lights = 3; g.recomputeStats();
      const s = g.sub; const p = g.__deepSpot(130); s.position.set(p[0], -130, p[1]); s.pitch = -0.1; s.yaw = 0;
      const c = g.creatures.spawn("inkwidow", s.position.clone().add({ x: 0.5, y: -0.8, z: -7 }));
      c.stun = 999; c.state = "hunt"; c.aggro = true;
      // Side on, so the arms stream out behind it — and held there, or it
      // turns to face the camera.
      c.object.lookAt(s.position.x + 12, s.position.y - 0.8, s.position.z - 7);
      const move = g.creatures._move;
      g.creatures._move = function (cr, dt) { if (cr !== c) move.call(this, cr, dt); };` },
  { name: "deep", setup: `
      g.profile.upgrades.pressure = 5; g.profile.upgrades.lights = 3; g.recomputeStats();
      const s = g.sub; const p = g.__deepSpot(700); s.position.set(p[0], -700, p[1]); s.pitch = -0.08; s.yaw = 0;
      for (let i = 0; i < 5; i += 1) {
        const c = g.creatures.spawn("choir", s.position.clone().add({ x: (i - 2) * 3.2, y: (i % 2) * 2 - 1, z: -14 - i * 2 }));
        c.stun = 999;
      }` },
  { name: "hangar", dock: true, upgrades: { hull: 3, pressure: 2, thrust: 3, cargo: 3, battery: 2, lights: 2, sonar: 2, torpedo: 2, net: 1, repair: 1, reactor: 1, scrubber: 1 }, setup: `
      const b = g.base; b.pos.x = 8.8; b.pos.z = 6.8; b.yaw = Math.atan2(8.8, 6.8); b.pitch = -0.2;` },
  { name: "tank", dock: true, setup: `
      g.profile.stats.discovered = g.ecology.species.map((sp) => sp.index); g.base.tankKey = "?"; g.base._refreshTank();
      const b = g.base; b.pos.x = 0; b.pos.z = -15.1; b.yaw = 0; b.pitch = -0.12;` },
];

async function main() {
  await mkdir(out, { recursive: true });
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}/`;
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch({ args: ["--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  page.on("pageerror", (e) => console.error("page error:", e.message));

  for (const scene of SCENES) {
    await page.goto(`${base}?phrase=${encodeURIComponent(PHRASE)}`);
    await page.waitForFunction(() => document.getElementById("start-begin") || document.getElementById("start-continue"));
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await page.waitForTimeout(1500);
    await page.click("#start-begin");
    await page.waitForFunction(() => window.__deep && window.__deep.mode === "dive", null, { timeout: 60000 });
    await page.evaluate(({ dock, upgrades }) => {
      const g = window.__deep;
      g.__deepSpot = (depth) => {
        for (let r = 300; r < 4000; r += 150) {
          for (let a = 0; a < 6.28; a += 0.3) {
            const x = Math.cos(a) * r;
            const z = Math.sin(a) * r;
            if (-g.world.heightAt(x, z) > depth + 40) return [x, z];
          }
        }
        return [0, 0];
      };
      for (const c of g.creatures.all) { c.alive = false; c.object.visible = false; }
      g.creatures.spawnTimer = 1e9;
      if (upgrades) Object.assign(g.profile.upgrades, upgrades);
      if (dock) { g.sub.dock(); g.bus.emit("station:dock", {}); }
    }, { dock: !!scene.dock, upgrades: scene.upgrades || null });
    await page.waitForTimeout(800);
    await page.evaluate(`(() => { const g = window.__deep; ${scene.setup} })()`);
    // Photo-mode look without the freeze: HUD and cockpit away, sea still moving.
    await page.evaluate(() => {
      document.body.dataset.photo = "1";
      const s = window.__deep.sub;
      if (s.cockpit) s.cockpit.visible = false;
    });
    await page.waitForTimeout(4000);
    const file = join(out, `${scene.name}.jpg`);
    await page.screenshot({ path: file, type: "jpeg", quality: 84 });
    console.log("wrote", file);
  }

  // Cards: a shot behind the title, at the sizes the sites want.
  const station = (await readFile(join(out, "station.jpg"))).toString("base64");
  const card = (w, h, file) => `
    <html><body style="margin:0;width:${w}px;height:${h}px;overflow:hidden;font-family:system-ui,sans-serif">
      <div style="position:absolute;inset:0;background:url(data:image/jpeg;base64,${station}) center/cover"></div>
      <div style="position:absolute;inset:0;background:linear-gradient(180deg,rgba(3,6,12,.1) 30%,rgba(3,6,12,.88) 100%)"></div>
      <div style="position:absolute;left:${Math.round(w * 0.05)}px;right:${Math.round(w * 0.05)}px;bottom:${Math.round(h * 0.08)}px;color:#eaf6fb">
        <div style="font:600 ${Math.round(h * 0.03)}px ui-monospace,Menlo,monospace;letter-spacing:.3em;color:#7ee0d0">MNEMOQUARIUM</div>
        <div style="font:700 ${Math.round(h * 0.11)}px system-ui,sans-serif;line-height:1.05;margin:.1em 0 .2em">The Deep</div>
        <div style="font:${Math.round(h * 0.045)}px Georgia,serif;color:#cfe3ee">Type any words. Dive the sea they grow.</div>
        <div style="font:${Math.round(h * 0.03)}px ui-monospace,Menlo,monospace;color:#ffc46b;margin-top:.6em">free in your browser</div>
      </div>
    </body></html>`;
  for (const [w, h, name] of [[1200, 630, "og.jpg"], [630, 500, "itch-cover.jpg"]]) {
    const p = await browser.newPage({ viewport: { width: w, height: h } });
    await p.setContent(card(w, h, name));
    await p.waitForTimeout(300);
    await p.screenshot({ path: join(out, name), type: "jpeg", quality: 86 });
    console.log("wrote", join(out, name));
    await p.close();
  }

  await browser.close();
  server.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
