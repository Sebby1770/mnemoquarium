/* Counting, politely.
 *
 * To know whether the first ten minutes work you need a few numbers: how many
 * people dive, how many dock, how deep they get, whether they share. This
 * sends those as GoatCounter events — no cookies, no personal data — and does
 * nothing at all unless SITE.goatcounter is set, the visitor has not asked
 * not to be tracked, and the page is not running on a developer's machine.
 *
 * Phrases are never sent: a sea might be somebody's own name. */

import { SITE } from "./config.js";

const DEPTH_MARKS = [90, 240, 520, 980];

/* Whether to send anything at all. Pure. */
export function shouldTrack({ endpoint, dnt, host }) {
  if (!endpoint) return false;
  if (dnt === "1" || dnt === "yes" || dnt === true) return false;
  const h = String(host || "");
  if (!h || h === "localhost" || h.startsWith("127.") || h.endsWith(".local") || h === "[::1]") return false;
  return true;
}

/* The GET that GoatCounter's own script would send for one event. Pure. */
export function eventUrl(endpoint, name, title) {
  const u = new URL(endpoint);
  u.searchParams.set("p", name);
  u.searchParams.set("t", title || name);
  u.searchParams.set("e", "true");
  u.searchParams.set("rnd", Math.random().toString(36).slice(2, 10));
  return u.toString();
}

function enabled() {
  if (typeof window === "undefined") return false;
  const nav = window.navigator || {};
  return shouldTrack({
    endpoint: SITE.goatcounter,
    dnt: nav.doNotTrack || window.doNotTrack || nav.msDoNotTrack,
    host: window.location && window.location.hostname,
  });
}

function send(url) {
  try {
    if (navigator.sendBeacon && navigator.sendBeacon(url)) return;
  } catch (err) {
    void err;
  }
  try {
    const img = new Image();
    img.src = url;
  } catch (err) {
    void err;
  }
}

/* One event, e.g. "dive", "dock", "depth-240". */
export function track(name, title) {
  if (!enabled()) return;
  send(eventUrl(SITE.goatcounter, name, title));
}

/* A page view, sent once on load. */
export function pageview() {
  if (!enabled()) return;
  const u = new URL(SITE.goatcounter);
  u.searchParams.set("p", window.location.pathname || "/");
  u.searchParams.set("t", document.title || "");
  if (document.referrer) u.searchParams.set("r", document.referrer);
  u.searchParams.set("rnd", Math.random().toString(36).slice(2, 10));
  send(u.toString());
}

/* Listen to the game for the handful of moments worth counting. */
export function attachAnalytics(game) {
  if (!game || !game.bus) return () => {};
  const passed = new Set();
  const offs = [
    game.bus.on("station:dock", () => track("dock")),
    game.bus.on("station:undock", () => track("undock")),
    game.bus.on("sub:destroyed", () => track("death")),
    game.bus.on("economy:upgrade", (e) => track(`upgrade-${(e && e.id) || "?"}`)),
    game.bus.on("landmark:found", () => track("landmark")),
    game.bus.on("sub:zone", () => {
      const depth = game.sub ? game.sub.depth : 0;
      for (const mark of DEPTH_MARKS) {
        if (depth >= mark && !passed.has(mark)) {
          passed.add(mark);
          track(`depth-${mark}`);
        }
      }
    }),
  ];
  track("dive");
  return () => { for (const off of offs) off(); };
}
