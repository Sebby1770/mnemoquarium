/* Today's sea: one phrase for everybody, grown from the date.
 *
 * Same day, same words, same sea — so "did you find the Widow in today's?"
 * is a question with an answer. The day turns over at midnight UTC so the
 * whole world shares it. Pure, so it can be tested without a browser. */

const FIRST = [
  "drowned", "borrowed", "electric", "quiet", "rusted", "velvet", "paper",
  "glass", "salt", "hollow", "sunken", "patient", "humming", "brass",
  "forgotten", "copper", "neon", "pale", "singing", "sleeping", "lantern",
  "winter", "broken", "gentle",
];
const THINGS = [
  "kiosk", "lighthouse", "arcade", "orchard", "choir", "radio", "archive",
  "harbour", "telephone", "chapel", "piano", "library", "engine", "carousel",
  "hotel", "greenhouse", "museum", "signal", "clock", "garden", "violin",
  "ferry", "cinema", "observatory",
];
const JOIN = ["under", "beneath", "with", "after", "of", "in"];
const SECOND = [
  "rain", "static", "moonlight", "weather", "snow", "tides", "smoke", "bells",
  "wires", "lanterns", "thunder", "silence", "fog", "embers", "questions",
  "birds",
];
const THIRD = [
  "neon", "cold", "slow", "green", "black", "honest", "late", "silver",
  "falling", "distant", "old", "warm",
];

function fnv(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/* A small LCG so each pick is its own draw from the day's seed. */
function picker(seed) {
  let s = seed || 1;
  return (list) => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    // The high bits: an LCG's low bits repeat on a short cycle.
    return list[Math.floor((s / 4294967296) * list.length)];
  };
}

/* "2026-09-25" for the UTC day a Date falls in. */
export function dayKey(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  return d.toISOString().slice(0, 10);
}

export function dailyPhrase(date = new Date()) {
  const pick = picker(fnv(`mnemoquarium-daily-${dayKey(date)}`) ^ 0x9e3779b9);
  const a = pick(FIRST);
  const thing = pick(THINGS);
  const join = pick(JOIN);
  let b = pick(THIRD);
  if (b === a) b = pick(THIRD);
  const second = pick(SECOND);
  return `${a} ${thing} ${join} ${b} ${second}`;
}
