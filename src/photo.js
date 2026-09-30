/* Photo mode (P).
 *
 * Every picture of this game that leaves somebody's screen is the best
 * advertising it will ever get, so taking one should be easy and the picture
 * should carry its own invitation: the phrase that grew the sea, and where to
 * grow your own.
 *
 * In the water, photo mode holds the sea still (game.frame runs on a zero
 * step while it is frozen) and puts the instruments and the cockpit away; you
 * can still look around. Aboard the Hull it just hides the HUD. Enter, a
 * click, the pad's right trigger or the on-screen button takes the shot:
 * one full-resolution frame, captioned, then a preview to save or share. */

import { HOTKEYS, SITE, zoneForDepth } from "./config.js";
import { formatDepth } from "./util.js";
import { seaLink, shareOutcome, shareSea } from "./share.js";
import { track } from "./analytics.js";

const MAX_WIDTH = 2560;

/* The caption's three lines. Pure. */
export function captionFor({ phrase, depth, zone, aboard }) {
  const where = aboard ? "aboard the Hull" : `${formatDepth(depth || 0)} · ${zone || "the sea"}`;
  let host = "";
  try {
    const u = new URL(SITE.play);
    host = `${u.host}${u.pathname}`.replace(/\/$/, "");
  } catch (err) {
    host = "";
  }
  return {
    title: phrase ? `“${phrase}”` : "Mnemoquarium",
    detail: `MNEMOQUARIUM · THE DEEP · ${where}`,
    invite: host ? `grow your own sea → ${host}` : "grow your own sea",
  };
}

function slug(text) {
  return String(text || "sea").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "sea";
}

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

export class PhotoMode {
  constructor(game) {
    this.game = game;
    this.active = false;
    this.previewing = false;
    this.lastBlob = null;
    this.lastUrl = "";
    this._buildDom();
    this._bind();
  }

  /* The sea is held while the camera is out in it. */
  frozen() {
    return this.active && this.game.mode === "dive";
  }

  /* ---------------------------------------------------------------- DOM -- */

  _buildDom() {
    const bar = el("div", "photo-bar");
    bar.id = "photo-bar";
    bar.hidden = true;
    bar.append(el("span", "photo-title", "photo mode"));
    bar.append(el("span", "photo-help", "look around · Enter or click to take · P to leave"));
    this.takeBtn = el("button", "photo-btn primary", "Take photo");
    this.takeBtn.type = "button";
    this.leaveBtn = el("button", "photo-btn", "Leave");
    this.leaveBtn.type = "button";
    bar.append(this.takeBtn, this.leaveBtn);
    document.body.appendChild(bar);
    this.bar = bar;

    const panel = el("div", "panel screen photo-panel");
    panel.id = "panel-photo";
    panel.hidden = true;
    const inner = el("div", "panel-inner photo-inner");
    inner.append(el("p", "eyebrow", "photo"));
    this.previewImg = el("img", "photo-preview");
    this.previewImg.alt = "Your photo of the sea";
    inner.append(this.previewImg);
    const row = el("div", "photo-actions");
    this.saveLink = el("a", "photo-btn primary", "Save image");
    this.shareBtn = el("button", "photo-btn", "Share");
    this.shareBtn.type = "button";
    this.copyBtn = el("button", "photo-btn", "Copy link to this sea");
    this.copyBtn.type = "button";
    this.againBtn = el("button", "photo-btn", "Take another");
    this.againBtn.type = "button";
    this.doneBtn = el("button", "photo-btn", "Done");
    this.doneBtn.type = "button";
    row.append(this.saveLink, this.shareBtn, this.copyBtn, this.againBtn, this.doneBtn);
    inner.append(row);
    this.note = el("p", "hint photo-note", "");
    inner.append(this.note);
    panel.append(inner);
    document.body.appendChild(panel);
    this.panel = panel;

    // A way in from the pause panel, for anyone without a P key.
    const pauseActions = document.querySelector("#panel-pause .start-actions");
    if (pauseActions) {
      this.pauseBtn = el("button", null, "Photo mode");
      this.pauseBtn.type = "button";
      pauseActions.appendChild(this.pauseBtn);
    }
  }

  _bind() {
    const game = this.game;
    const on = (node, type, fn, opts) => {
      if (!node) return;
      node.addEventListener(type, fn, opts);
      this.offs.push(() => node.removeEventListener(type, fn, opts));
    };
    this.offs = [];

    on(window, "keydown", (e) => {
      const t = e.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      if (e.repeat || e.metaKey || e.ctrlKey) return;
      if (this.previewing) {
        if (e.code === "Escape") this.closePreview(false);
        return;
      }
      if (HOTKEYS.photo.includes(e.code)) {
        e.preventDefault();
        this.toggle();
      } else if (this.active && (e.code === "Enter" || e.code === "NumpadEnter")) {
        e.preventDefault();
        this.capture();
      }
    });

    /* In photo mode a click is a shutter, never a harpoon. Registered in the
       capture phase so it runs before the boat's own mousedown. */
    on(game.canvas, "mousedown", (e) => {
      if (!this.active || this.previewing) return;
      e.stopImmediatePropagation();
      e.preventDefault();
      const locked = document.pointerLockElement === game.canvas;
      if (!locked && game.mode === "dive" && !game.sub.touchLook) {
        game.sub.requestLook();
        return;
      }
      if (e.button === 0) this.capture();
    }, true);

    on(this.takeBtn, "click", (e) => { e.preventDefault(); this.capture(); });
    on(this.leaveBtn, "click", (e) => { e.preventDefault(); this.exit(); });
    on(this.pauseBtn, "click", (e) => {
      e.preventDefault();
      game.setMode("dive");
      this.enter();
    });
    on(this.shareBtn, "click", (e) => { e.preventDefault(); this.share(true); });
    on(this.copyBtn, "click", (e) => { e.preventDefault(); this.share(false); });
    on(this.againBtn, "click", (e) => { e.preventDefault(); this.closePreview(true); });
    on(this.doneBtn, "click", (e) => { e.preventDefault(); this.closePreview(false); });

    this.offBus = game.bus.on("mode", (e) => {
      if (this.active && e && e.mode !== "dive" && e.mode !== "base") this.exit();
    });
  }

  /* ------------------------------------------------------------ modes -- */

  toggle() {
    if (this.active) this.exit();
    else this.enter();
  }

  enter() {
    const game = this.game;
    if (this.active || (game.mode !== "dive" && game.mode !== "base")) return;
    this.active = true;
    document.body.dataset.photo = "1";
    this.bar.hidden = false;
    if (game.sub && game.sub.cockpit) game.sub.cockpit.visible = false;
    if (game.sub) game.sub.firing = false;
    if (game.audio) game.audio.sfx("click");
  }

  exit() {
    const game = this.game;
    if (!this.active) return;
    this.active = false;
    this.previewing = false;
    delete document.body.dataset.photo;
    this.bar.hidden = true;
    this.panel.hidden = true;
    if (game.sub && game.sub.cockpit) game.sub.cockpit.visible = true;
  }

  /* ---------------------------------------------------------- the shot -- */

  capture() {
    const game = this.game;
    if (!this.active || this.previewing) return;
    game.requestCapture((source) => this._compose(source));
    if (game.audio) game.audio.sfx("sonar");
  }

  _compose(source) {
    const game = this.game;
    const sw = source.width;
    const sh = source.height;
    const scale = Math.min(1, MAX_WIDTH / sw);
    const w = Math.round(sw * scale);
    const h = Math.round(sh * scale);
    const out = document.createElement("canvas");
    out.width = w;
    out.height = h;
    const g = out.getContext("2d");
    g.drawImage(source, 0, 0, w, h);

    const aboard = game.mode === "base";
    const depth = game.sub ? game.sub.depth : 0;
    const cap = captionFor({ phrase: game.phrase, depth, zone: zoneForDepth(depth).name, aboard });
    const band = Math.round(h * 0.16);
    const grad = g.createLinearGradient(0, h - band, 0, h);
    grad.addColorStop(0, "rgba(3,6,12,0)");
    grad.addColorStop(1, "rgba(3,6,12,0.82)");
    g.fillStyle = grad;
    g.fillRect(0, h - band, w, band);
    const pad = Math.round(h * 0.035);
    const big = Math.max(14, Math.round(h * 0.042));
    const small = Math.max(10, Math.round(h * 0.02));
    g.textBaseline = "alphabetic";
    g.fillStyle = "#eaf6fb";
    g.font = `600 ${big}px Georgia, "Times New Roman", serif`;
    g.fillText(cap.title, pad, h - pad - small * 1.6, w * 0.62);
    g.fillStyle = "rgba(207,227,238,0.78)";
    g.font = `${small}px ui-monospace, Menlo, Consolas, monospace`;
    g.fillText(cap.detail, pad, h - pad, w * 0.62);
    g.textAlign = "right";
    g.fillStyle = "#ffc46b";
    g.fillText(cap.invite, w - pad, h - pad, w * 0.36);
    g.textAlign = "left";

    out.toBlob((blob) => {
      if (!blob) return;
      this.lastBlob = blob;
      if (this.lastUrl) URL.revokeObjectURL(this.lastUrl);
      this.lastUrl = URL.createObjectURL(blob);
      this._openPreview();
    }, "image/png");
    track("photo");
  }

  _openPreview() {
    const game = this.game;
    this.previewing = true;
    // Let go of the mouse on purpose, so the boat does not take it as Esc.
    if (game.sub) game.sub.releaseLook();
    this.previewImg.src = this.lastUrl;
    this.saveLink.href = this.lastUrl;
    this.saveLink.download = `mnemoquarium-${slug(game.phrase)}.png`;
    this.note.textContent = "";
    this.bar.hidden = true;
    this.panel.hidden = false;
  }

  closePreview(again) {
    this.previewing = false;
    this.panel.hidden = true;
    if (again) this.bar.hidden = false;
    else this.exit();
  }

  async share(withImage) {
    const game = this.game;
    let files = null;
    if (withImage && this.lastBlob && typeof File === "function") {
      files = [new File([this.lastBlob], `mnemoquarium-${slug(game.phrase)}.png`, { type: "image/png" })];
    }
    const depth = game.sub ? Math.round(game.sub.depth) : 0;
    const result = await shareSea(game.phrase, depth > 5 ? `${depth} m down` : "", files);
    this.note.textContent = shareOutcome(result) || (result === "shown" ? seaLink(game.phrase) : "");
    if (result !== "cancelled") track(withImage ? "share-photo" : "share-link");
  }

  dispose() {
    for (const off of this.offs) off();
    if (this.offBus) this.offBus();
    if (this.lastUrl) URL.revokeObjectURL(this.lastUrl);
    this.bar.remove();
    this.panel.remove();
    if (this.pauseBtn) this.pauseBtn.remove();
    delete document.body.dataset.photo;
  }
}
