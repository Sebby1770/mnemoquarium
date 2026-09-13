/* Boot. Nothing heavy loads until the player commits to a phrase: the start
   screen only needs the genetics, and the genetics are a few kilobytes. */

import { RARITY, ZONES, zoneIndex } from "./config.js";
import { formatCredits } from "./util.js";
import { Ecology } from "./ecology.js";
import { clearProfile, loadProfile } from "./save.js";

const $ = (id) => document.getElementById(id);

const els = {
  body: document.body,
  canvas: $("view"),
  panel: $("panel-start"),
  form: $("start-form"),
  phrase: $("start-phrase"),
  begin: $("start-begin"),
  cont: $("start-continue"),
  reset: $("start-reset"),
  roster: $("start-roster"),
  loading: $("loading"),
  loadingText: $("loading-text"),
  loadingBar: $("loading-bar"),
};

let booting = false;
let rosterTimer = 0;

/* ------------------------------------------------------------ capability -- */

function webglSupported() {
  try {
    const probe = document.createElement("canvas");
    return !!(
      window.WebGL2RenderingContext && probe.getContext("webgl2")
    ) || !!(
      window.WebGLRenderingContext &&
      (probe.getContext("webgl") || probe.getContext("experimental-webgl"))
    );
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
  const link = document.createElement("p");
  link.className = "tiny";
  link.innerHTML = '<a href="../index.html">The 2D tank runs anywhere &rarr;</a>';
  const inner = els.loading.querySelector(".panel-inner");
  if (inner) {
    inner.appendChild(p);
    inner.appendChild(link);
  }
}

/* --------------------------------------------------------- roster preview -- */

/* The same card markup the HUD uses, so one stylesheet covers both and the
   start screen can show you the sea before it exists. */
function drawRoster(phrase) {
  if (!els.roster) return;
  let species;
  try {
    species = new Ecology(phrase).roster();
  } catch (err) {
    els.roster.replaceChildren();
    return;
  }
  const frag = document.createDocumentFragment();
  const zoneName = (id) => (ZONES.find((z) => z.id === id) || ZONES[0]).name;

  for (const entry of species.slice().sort((a, b) => zoneIndex(a.zoneId) - zoneIndex(b.zoneId))) {
    const card = document.createElement("article");
    card.className = "roster-card";
    card.dataset.rarity = entry.rarity;
    card.style.setProperty("--swatch", `#${(entry.colorHex >>> 0).toString(16).padStart(6, "0")}`);

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
    word.textContent = `from "${entry.word}"`;
    names.appendChild(word);
    top.appendChild(names);
    card.appendChild(top);

    const meta = document.createElement("div");
    meta.className = "roster-meta";
    const zone = document.createElement("span");
    zone.className = "roster-zone";
    zone.textContent = zoneName(entry.zoneId);
    meta.appendChild(zone);
    const rarity = document.createElement("span");
    rarity.className = "roster-rarity";
    rarity.textContent = (RARITY[entry.rarity] || RARITY.common).label;
    meta.appendChild(rarity);
    const money = document.createElement("span");
    money.className = "money";
    money.textContent = `${formatCredits(entry.baseValue)} cr`;
    meta.appendChild(money);
    card.appendChild(meta);

    frag.appendChild(card);
  }
  els.roster.replaceChildren(frag);
}

function scheduleRoster() {
  window.clearTimeout(rosterTimer);
  rosterTimer = window.setTimeout(() => drawRoster(els.phrase.value), 220);
}

/* ------------------------------------------------------------------ boot -- */

async function boot(phrase, profile) {
  if (booting) return;
  booting = true;

  if (els.panel) els.panel.hidden = true;
  if (els.loading) {
    els.loading.hidden = false;
    if (els.loadingText) els.loadingText.textContent = "Growing the sea…";
    if (els.loadingBar) els.loadingBar.style.width = "18%";
  }

  try {
    // three.js is 650 KB; it is not fetched until somebody actually dives.
    const { Game } = await import("./game.js");
    if (els.loadingBar) els.loadingBar.style.width = "62%";

    // One paint between the fetch and the build, so the bar is not a lie.
    await new Promise((resolve) => requestAnimationFrame(() => resolve()));

    const game = new Game(els.canvas, { phrase, profile });
    window.__deep = game;
    if (els.loadingBar) els.loadingBar.style.width = "100%";
    game.start();

    window.setTimeout(() => {
      if (els.loading) els.loading.hidden = true;
    }, 180);
  } catch (err) {
    console.error(err);
    booting = false;
    fail(
      "The sea would not flood.",
      `${(err && err.message) || err}. Reload to try again, or take the shallow route.`,
    );
  }
}

/* ------------------------------------------------------------------ wire -- */

function init() {
  if (!els.canvas || !els.form) return;

  if (!webglSupported()) {
    fail(
      "This one needs WebGL.",
      "Your browser will not give the page a 3D context, so there is nothing to look through.",
    );
    return;
  }

  const params = new URLSearchParams(window.location.search);
  const urlPhrase = params.get("phrase");
  if (urlPhrase) els.phrase.value = urlPhrase;

  const saved = loadProfile();
  if (saved && saved.phrase && els.cont) {
    els.cont.hidden = false;
    const credits = formatCredits(saved.credits || 0);
    els.cont.textContent = `Continue "${saved.phrase}" · ${credits} cr`;
    els.cont.addEventListener("click", () => {
      els.phrase.value = saved.phrase;
      boot(saved.phrase, saved);
    });
  }

  els.form.addEventListener("submit", (e) => {
    e.preventDefault();
    const phrase = (els.phrase.value || "").trim();
    // Diving back into the phrase you saved keeps the logbook that goes with it.
    const carry = saved && saved.phrase === phrase ? saved : null;
    boot(phrase, carry);
  });

  els.phrase.addEventListener("input", scheduleRoster);

  if (els.reset) {
    els.reset.addEventListener("click", () => {
      clearProfile();
      if (els.cont) els.cont.hidden = true;
      els.reset.textContent = "save erased";
      els.reset.disabled = true;
    });
  }

  drawRoster(els.phrase.value);
  els.body.dataset.mode = "start";
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
