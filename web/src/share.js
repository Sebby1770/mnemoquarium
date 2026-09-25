/* Links to a sea, and handing them to whoever the player wants to show.
 *
 * A sea is its phrase: the same words always grow the same water, so a link
 * with ?phrase= is the whole of "come and see this". Sharing prefers the
 * system share sheet (phones), then the clipboard, then a prompt the player
 * can copy from — and says which one happened. */

import { SITE } from "./config.js";

/* The link for a phrase, on a base page. Pure. */
export function seaLink(phrase, base = SITE.play) {
  const url = new URL(base || "https://example.invalid/");
  url.search = "";
  url.hash = "";
  const p = String(phrase || "").trim();
  if (p) url.searchParams.set("phrase", p);
  return url.toString();
}

/* The words that go with it. Pure. */
export function shareText(phrase, detail) {
  const p = String(phrase || "").trim();
  const lead = p ? `I dived a sea grown from "${p}"` : "I dived a sea grown from words";
  return detail ? `${lead} — ${detail}. Same words, same sea:` : `${lead}. Same words, same sea:`;
}

/* Share a sea. Resolves to "shared" | "copied" | "shown" | "cancelled". */
export async function shareSea(phrase, detail, files) {
  const url = seaLink(phrase);
  const text = shareText(phrase, detail);
  const nav = typeof navigator !== "undefined" ? navigator : null;
  if (nav && typeof nav.share === "function") {
    const data = { title: "Mnemoquarium: The Deep", text, url };
    if (files && files.length && typeof nav.canShare === "function" && nav.canShare({ files })) data.files = files;
    try {
      await nav.share(data);
      return "shared";
    } catch (err) {
      if (err && err.name === "AbortError") return "cancelled";
      // Fall through to the clipboard.
    }
  }
  if (nav && nav.clipboard && typeof nav.clipboard.writeText === "function") {
    try {
      await nav.clipboard.writeText(`${text} ${url}`);
      return "copied";
    } catch (err) {
      void err;
    }
  }
  if (typeof window !== "undefined" && typeof window.prompt === "function") {
    window.prompt("Copy the link to this sea:", url);
    return "shown";
  }
  return "cancelled";
}

export function shareOutcome(result) {
  if (result === "copied") return "link copied — paste it anywhere";
  if (result === "shared") return "sent";
  return "";
}
