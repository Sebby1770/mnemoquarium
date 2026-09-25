/* Boot and the front menu.
 *
 * The sea is still grown from words — that is the whole engine — but nobody
 * should have to think of any to play. The menu picks one, shows you what it
 * grew, and gets out of the way. Typing your own is down at the bottom for
 * anyone who wants it.
 *
 * Nothing heavy loads until you press Dive: the menu only needs the genetics,
 * and the genetics are a few kilobytes. */

import { RARITY, SITE, ZONES, zoneIndex } from "./config.js";
import { formatCredits, formatDepth } from "./util.js";
import { Ecology } from "./ecology.js";
import { clearProfile, listSeas, loadProfile, loadSea } from "./save.js";
import { watchMenuPad } from "./input.js";
import { dailyPhrase, dayKey } from "./daily.js";
import { shareOutcome, shareSea } from "./share.js";
import { pageview, track } from "./analytics.js";

/* Seas worth surfacing. Each grows a different roster, and the deeper bands
   are where the odd ones end up, so the list is chosen for words that read
   well as the name of something you would rather not meet. */
const SEAS = [
  "forgotten kiosk under neon rain",
  "the vending machine remembers my name",
  "library dust with electric teeth",
  "salt and static",
  "a lighthouse that stopped answering",
  "cold rooms full of borrowed light",
  "the tide comes back wearing my coat",
  "paper lanterns in a drowned arcade",
  "something fluent in the dark",
  "the last train hums underwater",
  "glass orchards and quiet machinery",
  "my grandmother's kitchen, flooded",
  "a chapel of kelp and copper wire",
  "the archive leaks at night",
  "moths the size of doors",
  "velvet rust and singing pipes",
  "a payphone ringing on the seabed",
  "clockwork gulls over black water",
  "the hotel keeps one room for the sea",
  "static bloom over a sunken orchard",
];

const $ = (id) => document.getElementById(id);

const els = {
  body: document.body,
  canvas: $("view"),
  panel: $("panel-start"),
  begin: $("start-begin"),
  cont: $("start-continue"),
  fresh: $("start-new"),
  reroll: $("start-reroll"),
  roster: $("start-roster"),
  advanced: $("start-advanced"),
  form: $("start-form"),
  phrase: $("start-phrase"),
  reset: $("start-reset"),
  summary: $("start-summary"),
  daily: $("start-daily"),
  share: $("start-share"),
  seas: $("start-seas"),
  seasList: $("start-seas-list"),
  supportWrap: $("start-support-wrap"),
  support: $("start-support"),
  communityWrap: $("start-community-wrap"),
  community: $("start-community"),
  note: $("start-note"),
  loading: $("loading"),
  loadingText: $("loading-text"),
  loadingBar: $("loading-bar"),
};

let booting = false;
let saved = null;          // the profile on disk, if any
let phrase = "";           // the sea the menu is currently showing
let armed = null;          // a button waiting for a second click to confirm

/* ------------------------------------------------------------ capability -- */

function webglSupported() {
  try {
    const probe = document.createElement("canvas");
    return !!(window.WebGL2RenderingContext && probe.getContext("webgl2"))
      || !!(window.WebGLRenderingContext && (probe.getContext("webgl") || probe.getContext("experimental-webgl")));
  } catch (err) {
    return false;
  }
}

function fail(headline, detail) {
  if (els.panel) els.panel.hidden = true;
  if (!els.loading) return;
  els.loading.hidden = false;
  els.loading.dataset.state = "error";
  if (els.loadingText) els.loadingText.textContent = headline;
  const bar = els.loadingBar && els.loadingBar.parentElement;
  if (bar) bar.remove();
  const p = document.createElement("p");
  p.className = "lede";
  p.textContent = detail;
  const inner = els.loading.querySelector(".panel-inner");
  if (inner) inner.appendChild(p);
}

/* ------------------------------------------------------------- the roster -- */

const hex = (n) => `#${(n >>> 0).toString(16).padStart(6, "0")}`;
const zoneName = (id) => (ZONES.find((z) => z.id === id) || ZONES[0]).name;

function card(entry) {
  const el = document.createElement("article");
  el.className = "roster-card";
  el.dataset.rarity = entry.rarity;
  el.style.setProperty("--swatch", hex(entry.colorHex));

  const top = document.createElement("div");
  top.className = "roster-top";
  const swatch = document.createElement("span");
  swatch.className = "roster-swatch";
  swatch.textContent = entry.glyph || "●";
  top.appendChild(swatch);
  const names = document.createElement("div");
  names.className = "roster-names";
  const strong = document.createElement("strong");
  strong.textContent = entry.name;
  names.appendChild(strong);
  const word = document.createElement("span");
  word.className = "roster-word";
  word.textContent = zoneName(entry.zoneId);
  names.appendChild(word);
  top.appendChild(names);
  el.appendChild(top);

  const meta = document.createElement("div");
  meta.className = "roster-meta";
  const rarity = document.createElement("span");
  rarity.className = "roster-rarity";
  rarity.textContent = (RARITY[entry.rarity] || RARITY.common).label;
  meta.appendChild(rarity);
  const money = document.createElement("span");
  money.className = "money";
  money.textContent = `${formatCredits(entry.baseValue)} cr`;
  meta.appendChild(money);
  el.appendChild(meta);
  return el;
}

/* Show a sea without committing to it. */
function showSea(next) {
  phrase = next;
  if (els.phrase) els.phrase.value = next;
  if (!els.roster) return;
  let roster;
  try {
    roster = new Ecology(next).roster();
  } catch (err) {
    els.roster.replaceChildren();
    return;
  }
  const frag = document.createDocumentFragment();
  for (const entry of roster.slice().sort((a, b) => zoneIndex(a.zoneId) - zoneIndex(b.zoneId))) {
    frag.appendChild(card(entry));
  }
  els.roster.replaceChildren(frag);

  // One line that says what this sea is, so the cards are detail rather than
  // homework.
  if (els.summary) {
    const bands = roster.map((e) => zoneIndex(e.zoneId));
    const top = ZONES[Math.min(...bands)];
    const bottom = ZONES[Math.max(...bands)];
    const best = roster.reduce((a, b) => (b.baseValue > a.baseValue ? b : a), roster[0]);
    const today = next === dailyPhrase() ? `today's sea (${dayKey()}) · ` : "";
    els.summary.textContent = `${today}${roster.length} species · ${top.name} down to ${bottom.name} · best ${formatCredits(best.baseValue)} cr`;
  }
}

/* Look at a sea, and at your run on it if you have one. Every sea keeps its
   own save, so looking never costs anything. */
function selectSea(next) {
  showSea(next);
  saved = loadSea(next);
  renderMenu();
}

function anotherSea() {
  const pool = SEAS.filter((s) => s !== phrase);
  selectSea(pool[Math.floor(Math.random() * pool.length)] || SEAS[0]);
}

function say(text) {
  if (els.note) els.note.textContent = text || "";
}

/* --------------------------------------------------------------- the menu -- */

/* A save is worth protecting: there is one slot, so a new sea overwrites it.
   Rather than a dialog, the button asks once and means it the second time. */
function arm(button, question, run) {
  if (armed && armed.button !== button) restore(armed);
  if (armed && armed.button === button) {
    const go = armed.run;
    restore(armed);
    go();
    return;
  }
  armed = { button, label: button.textContent, run, timer: 0 };
  button.textContent = question;
  button.dataset.armed = "1";
  armed.timer = window.setTimeout(() => restore(armed), 6000);
}

function restore(state) {
  if (!state) return;
  window.clearTimeout(state.timer);
  state.button.textContent = state.label;
  delete state.button.dataset.armed;
  if (armed === state) armed = null;
}

function renderMenu() {
  const has = !!(saved && saved.phrase === phrase);
  if (has) {
    // Continuing is the default when there is something to continue.
    els.cont.hidden = false;
    const deepest = (saved.stats && saved.stats.deepest) || 0;
    els.cont.textContent = deepest
      ? `Continue · ${formatCredits(saved.credits || 0)} cr · ${formatDepth(deepest)} deep`
      : `Continue · ${formatCredits(saved.credits || 0)} cr`;
    els.cont.classList.add("primary");
    els.begin.hidden = true;
  } else {
    els.cont.hidden = true;
    els.begin.hidden = false;
  }
  // Nothing here is destructive any more, so there is no "start a new sea".
  els.fresh.hidden = true;
  renderSeas();
}

/* The seas you have been to, newest first, one click to go back. */
function renderSeas() {
  if (!els.seas || !els.seasList) return;
  const seas = listSeas().filter((e) => e.phrase);
  els.seas.hidden = seas.length === 0;
  const summary = els.seas.querySelector("summary");
  if (summary) summary.textContent = `Your seas (${seas.length})`;
  const frag = document.createDocumentFragment();
  for (const entry of seas) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "sea-row";
    if (entry.phrase === phrase) b.dataset.current = "1";
    const name = document.createElement("strong");
    name.textContent = entry.phrase;
    const meta = document.createElement("span");
    meta.textContent = `${formatCredits(entry.credits)} cr${entry.deepest ? ` · ${formatDepth(entry.deepest)} deep` : ""}`;
    b.append(name, meta);
    b.addEventListener("click", () => selectSea(entry.phrase));
    frag.appendChild(b);
  }
  els.seasList.replaceChildren(frag);
}

/* ------------------------------------------------------------------ boot -- */

async function boot(seaPhrase, profile) {
  if (booting) return;
  booting = true;

  if (els.panel) els.panel.hidden = true;
  if (els.loading) {
    els.loading.hidden = false;
    if (els.loadingText) els.loadingText.textContent = "Flooding the tanks…";
    if (els.loadingBar) els.loadingBar.style.width = "18%";
  }

  try {
    // three.js is 650 KB; it is not fetched until somebody actually dives.
    const { Game } = await import("./game.js");
    if (els.loadingBar) els.loadingBar.style.width = "62%";
    /* One paint between the fetch and the build, so the bar is not a lie —
       but a tab that is not on screen never paints, and waiting on a frame
       that will not come leaves the game stuck on "flooding the tanks" until
       somebody looks at it. Take whichever arrives first. */
    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      requestAnimationFrame(finish);
      setTimeout(finish, 150);
    });

    const game = new Game(els.canvas, { phrase: seaPhrase, profile });
    window.__deep = game;
    if (els.loadingBar) els.loadingBar.style.width = "100%";
    game.start();

    window.setTimeout(() => {
      if (els.loading) els.loading.hidden = true;
    }, 180);
  } catch (err) {
    console.error(err);
    booting = false;
    fail("The sea would not flood.", `${(err && err.message) || err}. Reload and try again.`);
  }
}

/* ------------------------------------------------------------------ wire -- */

function init() {
  if (!els.canvas || !els.begin) return;

  if (!webglSupported()) {
    fail(
      "This one needs WebGL.",
      "Your browser will not give the page a 3D context, so there is nothing to look through.",
    );
    return;
  }

  pageview();

  /* Which sea to show first: a shared link, then ?daily, then the last sea
     you played, then one at random. A link never touches another sea's run. */
  const params = new URLSearchParams(window.location.search);
  const urlPhrase = (params.get("phrase") || "").trim();
  const last = loadProfile();
  const first = urlPhrase
    || (params.has("daily") ? dailyPhrase() : "")
    || (last && last.phrase)
    || SEAS[Math.floor(Math.random() * SEAS.length)];
  selectSea(first);

  // Links that only exist once somebody has filled them in (config.SITE).
  if (SITE.support && els.support) {
    els.support.href = SITE.support;
    els.supportWrap.hidden = false;
  }
  if (SITE.community && els.community) {
    els.community.href = SITE.community;
    els.communityWrap.hidden = false;
  }

  // A controller can dive from the menu; the game takes the pad over once it exists.
  watchMenuPad(() => !!window.__deep);

  els.begin.addEventListener("click", () => boot(phrase, null));
  els.cont.addEventListener("click", () => boot(phrase, saved));
  els.reroll.addEventListener("click", anotherSea);

  if (els.daily) {
    els.daily.addEventListener("click", () => {
      selectSea(dailyPhrase());
      say("everyone gets the same sea today. it changes at midnight UTC.");
      track("daily");
    });
  }

  if (els.share) {
    els.share.addEventListener("click", async () => {
      const result = await shareSea(phrase);
      say(shareOutcome(result));
      if (result !== "cancelled") track("share-menu");
    });
  }

  els.form.addEventListener("submit", (e) => {
    e.preventDefault();
    const typed = (els.phrase.value || "").trim();
    if (!typed) return;
    selectSea(typed);
    boot(typed, saved);
  });

  els.reset.addEventListener("click", () => {
    if (!saved) {
      say("nothing saved on this sea yet.");
      return;
    }
    arm(els.reset, "erase it?", () => {
      clearProfile(phrase);
      saved = null;
      say("that sea's save is gone. your other seas are untouched.");
      renderMenu();
    });
  });

  els.body.dataset.mode = "start";
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
