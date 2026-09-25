/* Everything that is not a keyboard and a mouse: gamepads and thumbs.
 *
 * Both write into the same two places the keyboard and mouse already use —
 * `sub.analog` for thrust (added to the keys, never replacing them) and
 * `sub.lookDX/lookDY` for look, in mouse pixels, so the sensitivity slider and
 * invert-Y apply to a stick and a thumb exactly as they do to a mouse. Actions
 * go through the sub's own methods (fire, setBeam, ping, setLights,
 * cycleWeapon), so there is only ever one rule for what a button does.
 *
 * Menus are driven by pressing the panel's own primary button. The pad can
 * dive, resume, undock and revive; buying things is still a pointer's job. */

import { clamp } from "./util.js";
import { edges, shapeAxis, shapeStick, thumbVector } from "./stick.js";

/* Standard-mapping button indices. */
const B = {
  a: 0, b: 1, x: 2, y: 3, lb: 4, rb: 5, lt: 6, rt: 7,
  back: 8, start: 9, ls: 10, rs: 11, up: 12, down: 13, left: 14, right: 15,
};

const PAD_LOOK_PX = 1050;        // mouse pixels per second at full deflection
const TOUCH_LOOK_SCALE = 1.7;    // a thumb covers less ground than a mouse
const TOUCH_RADIUS = 56;         // joystick throw, CSS pixels
const TRIGGER_ON = 0.35;

/* Which panel button a pad's "confirm" presses, per mode. */
const CONFIRM = {
  paused: ["btn-resume"],
  station: ["btn-undock"],
  dead: ["btn-revive"],
};

function pressed(button) {
  if (!button) return false;
  return typeof button === "object" ? button.pressed || button.value > TRIGGER_ON : button > TRIGGER_ON;
}

function firstPad() {
  if (typeof navigator === "undefined" || typeof navigator.getGamepads !== "function") return null;
  let pads;
  try {
    pads = navigator.getGamepads();
  } catch (err) {
    return null;
  }
  for (const pad of pads || []) if (pad && pad.connected !== false) return pad;
  return null;
}

function clickVisible(ids) {
  for (const id of ids) {
    const node = document.getElementById(id);
    if (node && !node.hidden && !node.disabled && node.offsetParent !== null) {
      node.click();
      return true;
    }
  }
  return false;
}

/* The start screen exists before the game does, so it gets its own tiny
   poller: A or Start dives (or continues), and it stops once the game is up. */
export function watchMenuPad(isDone) {
  if (typeof requestAnimationFrame !== "function") return;
  let prev = [];
  const tick = () => {
    if (isDone()) return;
    const pad = firstPad();
    if (pad) {
      const now = pad.buttons.map(pressed);
      const { down } = edges(prev, now);
      prev = now;
      if (down.includes(B.a) || down.includes(B.start)) clickVisible(["start-continue", "start-begin"]);
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

export class InputDevices {
  constructor(game) {
    this.game = game;
    this.padButtons = [];
    this.padActive = false;
    this.padName = "";

    // Touch state.
    this.touchOn = false;
    this.stickId = null;
    this.stickOrigin = { x: 0, y: 0 };
    this.stickVec = { x: 0, y: 0, boost: false };
    this.lookId = null;
    this.lookLast = { x: 0, y: 0 };
    this.held = { fire: false, beam: false, rise: false, dive: false, dock: false };
    this.dockPointer = null;

    this.onPadConnect = (e) => {
      const name = (e.gamepad && e.gamepad.id) || "a controller";
      this.game.toast(`${name.split("(")[0].trim() || "controller"} connected`);
    };
    window.addEventListener("gamepadconnected", this.onPadConnect);

    /* Touch appears on the first touch, not on a guess from the user agent:
       a laptop with a touchscreen still mostly gets flown with a mouse. */
    this.onFirstTouch = (e) => {
      if (e.pointerType === "touch") {
        this.enableTouch();
      } else if (e.pointerType === "mouse" && this.touchOn && this.touchRoot
        && this.touchRoot.contains(e.target)) {
        /* A touchscreen laptop: the mouse is back. Put the thumbs away so the
           click reaches the canvas and can lock the pointer again. */
        this.setTouchActive(false);
        const sub = this.game.sub;
        if (sub) sub.requestLook();
      }
    };
    window.addEventListener("pointerdown", this.onFirstTouch, true);
    if (typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches) this.enableTouch();
  }

  /* ------------------------------------------------------------- per frame -- */

  /* Who the sticks are steering: the boat, or you on foot inside the Hull.
     Both expose the same `analog` and `lookDX/lookDY`. */
  pilot() {
    const game = this.game;
    return game.mode === "base" && game.base ? game.base : game.sub;
  }

  update(dt) {
    const sub = this.game.sub;
    if (!sub) return;
    for (const p of [sub, this.game.base]) {
      if (!p) continue;
      const z = p.analog;
      z.forward = 0; z.strafe = 0; z.vert = 0; z.boost = false; z.dock = false;
    }
    const a = this.pilot().analog;

    this.pollPad(dt, a, sub);
    if (this.touchOn) this.applyTouch(a, sub);

    a.forward = clamp(a.forward, -1, 1);
    a.strafe = clamp(a.strafe, -1, 1);
    a.vert = clamp(a.vert, -1, 1);
  }

  pollPad(dt, a, sub) {
    const pad = firstPad();
    if (!pad) {
      if (this.padActive) this.releasePad(sub);
      return;
    }
    const now = pad.buttons.map(pressed);
    const { down, up } = edges(this.padButtons, now);
    this.padButtons = now;
    const axes = pad.axes || [];
    const moved = axes.some((v) => Math.abs(v) > 0.3);
    if (!this.padActive && (down.length || moved)) {
      this.padActive = true;
      document.body.dataset.input = "pad";
    }
    if (!this.padActive) return;

    const game = this.game;
    const mode = game.mode;

    // On foot: the same sticks walk and look, and A (or X) uses what you face.
    if (mode === "base" && game.base) {
      const [wx, wy] = shapeStick(axes[0], axes[1]);
      a.forward += -wy;
      a.strafe += wx;
      const [vx, vy] = shapeStick(axes[2], axes[3], 0.14, 1.8);
      game.base.lookDX += vx * PAD_LOOK_PX * dt;
      game.base.lookDY += vy * PAD_LOOK_PX * dt;
      if (now[B.ls]) a.boost = true;
      if (down.includes(B.a) || down.includes(B.x)) game.base.interact();
      return;
    }

    if (mode !== "dive") {
      if (this.padFiring) this.releasePad(sub);
      if (mode === "chart" && (down.includes(B.b) || down.includes(B.back) || down.includes(B.start))) {
        game.chart.close();
      } else if (mode === "paused" && (down.includes(B.b) || down.includes(B.start))) {
        game.setMode("dive");
      } else if ((down.includes(B.a) || down.includes(B.start)) && CONFIRM[mode]) {
        clickVisible(CONFIRM[mode]);
      }
      return;
    }

    // Photo mode: the right stick click toggles it; A or the trigger shoots.
    if (down.includes(B.rs) && game.photo) game.photo.toggle();
    if (game.photo && game.photo.active) {
      const [px, py] = shapeStick(axes[2], axes[3], 0.14, 1.8);
      sub.lookDX += px * PAD_LOOK_PX * dt;
      sub.lookDY += py * PAD_LOOK_PX * dt;
      if (down.includes(B.a) || down.includes(B.rt)) game.photo.capture();
      if (down.includes(B.b)) game.photo.exit();
      return;
    }

    // Flight.
    const [mx, my] = shapeStick(axes[0], axes[1]);
    a.forward += -my;
    a.strafe += mx;
    const [lx, ly] = shapeStick(axes[2], axes[3], 0.14, 1.8);
    sub.lookDX += lx * PAD_LOOK_PX * dt;
    sub.lookDY += ly * PAD_LOOK_PX * dt;
    if (now[B.a]) a.vert += 1;
    if (now[B.b]) a.vert -= 1;
    if (now[B.ls]) a.boost = true;
    if (now[B.up]) a.dock = true;

    // The right trigger holds the trigger; the left holds the beam.
    const rt = pad.buttons[B.rt];
    const lt = pad.buttons[B.lt];
    const fire = pressed(rt);
    const beam = pressed(lt) || shapeAxis(lt && lt.value) > 0.3;
    // Written only on a change, so a held mouse button is not cancelled by an
    // idle pad sitting on the desk.
    if (fire !== !!this.padFiring) {
      this.padFiring = fire;
      if (fire) sub.fire();
      sub.firing = fire || this.held.fire;
    }
    if (beam !== !!this.padBeam) {
      this.padBeam = beam;
      sub.setBeam(beam || this.held.beam);
    }

    for (const i of down) {
      if (i === B.x) sub.ping();
      else if (i === B.y) sub.setLights(!sub.lightsOn);
      else if (i === B.lb) sub.cycleWeapon(-1);
      else if (i === B.rb) sub.cycleWeapon(1);
      else if (i === B.back || i === B.left) game.chart.show();
      else if (i === B.start) game.setMode("paused");
      else if (i === B.down) game.hud.setCargoOpen(true);
    }
    if (up.includes(B.down)) game.hud.setCargoOpen(false);
  }

  releasePad(sub) {
    this.padFiring = false;
    if (this.padBeam) {
      this.padBeam = false;
      if (!this.held.beam) sub.setBeam(false);
    }
    if (!this.held.fire) sub.firing = false;
  }

  /* ----------------------------------------------------------------- touch -- */

  enableTouch() {
    if (!this.touchRoot) {
      this.buildTouch();
      const hint = document.getElementById("hint-dock");
      if (hint) hint.textContent = "Hold DOCK to moor at the Hull";
    }
    this.setTouchActive(true);
  }

  setTouchActive(on) {
    if (on === this.touchOn) return;
    this.touchOn = on;
    if (this.touchRoot) this.touchRoot.hidden = !on;
    document.body.dataset.input = on ? "touch" : "mouse";
    const sub = this.game.sub;
    if (!sub) return;
    sub.touchLook = on;
    if (on) sub.releaseLook();
    else this.clearTouch();
  }

  buildTouch() {
    const root = el("div", "touch-controls");
    root.id = "touch-controls";

    this.lookZone = el("div", "touch-look");
    this.stickZone = el("div", "touch-stick-zone");
    this.stickBase = el("div", "touch-stick");
    this.stickKnob = el("div", "touch-knob");
    this.stickBase.append(this.stickKnob);
    this.stickZone.append(this.stickBase);

    const actions = el("div", "touch-actions");
    const hold = (name, label, cls) => {
      const b = el("button", `touch-btn ${cls || ""}`.trim(), label);
      b.type = "button";
      b.dataset.hold = name;
      return b;
    };
    const tap = (name, label, cls) => {
      const b = el("button", `touch-btn touch-small ${cls || ""}`.trim(), label);
      b.type = "button";
      b.dataset.tap = name;
      return b;
    };
    actions.append(
      hold("beam", "BEAM", "touch-beam"),
      hold("fire", "FIRE", "touch-fire"),
      hold("rise", "▲", "touch-rise"),
      hold("dive", "▼", "touch-dive"),
    );
    /* Four buttons, not seven: the weapon rack, the hold gauge and the dock
       prompt are already on the glass, so a thumb presses those instead. */
    const bar = el("div", "touch-bar");
    bar.append(
      tap("pause", "❚❚"),
      tap("chart", "CHART"),
      tap("sonar", "SONAR"),
      tap("lights", "LAMPS"),
      tap("photo", "PHOTO"),
    );

    root.append(this.lookZone, this.stickZone, actions, bar);
    document.body.appendChild(root);
    this.touchRoot = root;

    const opts = { passive: false };
    this.onTouchDown = (e) => this.touchDown(e);
    this.onTouchMove = (e) => this.touchMove(e);
    this.onTouchUp = (e) => this.touchUp(e);
    root.addEventListener("pointerdown", this.onTouchDown, opts);
    window.addEventListener("pointermove", this.onTouchMove, opts);
    window.addEventListener("pointerup", this.onTouchUp, opts);
    window.addEventListener("pointercancel", this.onTouchUp, opts);
    // Long-press menus and double-tap zoom have no business over a viewport.
    this.onCtx = (e) => e.preventDefault();
    root.addEventListener("contextmenu", this.onCtx);

    // The parts of the HUD a thumb can press (see styles.css, data-input).
    this.hudRoot = document.getElementById("hud");
    this.onHudDown = (e) => this.hudDown(e);
    if (this.hudRoot) this.hudRoot.addEventListener("pointerdown", this.onHudDown, opts);

    // The hold drawer opens over the gauge that opened it, so it closes itself.
    this.cargoPanel = document.getElementById("panel-cargo");
    this.onCargoDown = (e) => {
      if (!this.touchOn) return;
      e.preventDefault();
      this.game.hud.setCargoOpen(false);
    };
    if (this.cargoPanel) {
      this.cargoPanel.addEventListener("pointerdown", this.onCargoDown, opts);
      const hint = this.cargoPanel.querySelector(".hint");
      if (hint) hint.textContent = "Tap to close. Cargo sells at the Hull.";
    }
  }

  hudDown(e) {
    if (!this.touchOn || this.game.mode !== "dive") return;
    const t = e.target;
    const game = this.game;
    const weapon = t.closest && t.closest(".weapon");
    if (weapon && weapon.parentNode) {
      e.preventDefault();
      game.sub.selectWeapon([...weapon.parentNode.children].indexOf(weapon));
      return;
    }
    if (t.closest && t.closest("#gauge-cargo")) {
      e.preventDefault();
      game.hud.setCargoOpen(!game.hud.cargoOpen);
      return;
    }
    const dock = t.closest && t.closest("#hint-dock");
    if (dock) {
      e.preventDefault();
      this.dockPointer = e.pointerId;
      this.held.dock = true;
      dock.classList.add("on");
    }
  }

  touchDown(e) {
    const mode = this.game.mode;
    if (mode !== "dive" && mode !== "base") return;
    const target = e.target;
    e.preventDefault();
    const sub = this.game.sub;

    if (target.dataset && target.dataset.hold) {
      this.setHeld(target.dataset.hold, true, target);
      target.setPointerCapture(e.pointerId);
      target.dataset.pointer = String(e.pointerId);
      return;
    }
    if (target.dataset && target.dataset.tap) {
      this.tapAction(target.dataset.tap, sub);
      target.classList.add("on");
      setTimeout(() => target.classList.remove("on"), 140);
      return;
    }
    if (target === this.stickZone && this.stickId === null) {
      this.stickId = e.pointerId;
      this.stickOrigin.x = e.clientX;
      this.stickOrigin.y = e.clientY;
      const rect = this.stickZone.getBoundingClientRect();
      this.stickBase.style.left = `${e.clientX - rect.left}px`;
      this.stickBase.style.top = `${e.clientY - rect.top}px`;
      this.stickBase.classList.add("on");
      this.stickKnob.style.transform = "translate(-50%, -50%)";
      return;
    }
    if (target === this.lookZone && this.lookId === null) {
      this.lookId = e.pointerId;
      this.lookLast.x = e.clientX;
      this.lookLast.y = e.clientY;
    }
  }

  touchMove(e) {
    if (e.pointerId === this.stickId) {
      e.preventDefault();
      const dx = e.clientX - this.stickOrigin.x;
      const dy = e.clientY - this.stickOrigin.y;
      const v = thumbVector(dx, dy, TOUCH_RADIUS);
      this.stickVec.x = v.x;
      this.stickVec.y = v.y;
      this.stickVec.boost = v.boost;
      const len = Math.hypot(dx, dy) || 1;
      const k = Math.min(len, TOUCH_RADIUS) / len;
      this.stickKnob.style.transform = `translate(calc(-50% + ${dx * k}px), calc(-50% + ${dy * k}px))`;
      this.stickBase.classList.toggle("boost", v.boost);
    } else if (e.pointerId === this.lookId) {
      e.preventDefault();
      const pilot = this.pilot();
      pilot.lookDX += (e.clientX - this.lookLast.x) * TOUCH_LOOK_SCALE;
      pilot.lookDY += (e.clientY - this.lookLast.y) * TOUCH_LOOK_SCALE;
      this.lookLast.x = e.clientX;
      this.lookLast.y = e.clientY;
    }
  }

  touchUp(e) {
    if (e.pointerId === this.stickId) {
      this.stickId = null;
      this.stickVec.x = 0;
      this.stickVec.y = 0;
      this.stickVec.boost = false;
      this.stickBase.classList.remove("on", "boost");
    } else if (e.pointerId === this.lookId) {
      this.lookId = null;
    }
    if (e.pointerId === this.dockPointer) {
      this.dockPointer = null;
      this.held.dock = false;
      const dock = document.getElementById("hint-dock");
      if (dock) dock.classList.remove("on");
    }
    if (!this.touchRoot) return;
    for (const b of this.touchRoot.querySelectorAll("[data-hold]")) {
      if (b.dataset.pointer === String(e.pointerId)) {
        delete b.dataset.pointer;
        this.setHeld(b.dataset.hold, false, b);
      }
    }
  }

  setHeld(name, on, node) {
    this.held[name] = on;
    if (node) node.classList.toggle("on", on);
    const sub = this.game.sub;
    if (name === "fire") {
      if (on) sub.fire();
      sub.firing = on || !!this.padFiring;
    } else if (name === "beam") {
      sub.setBeam(on || !!this.padBeam);
    }
  }

  tapAction(name, sub) {
    const game = this.game;
    if (name === "sonar") sub.ping();
    else if (name === "lights") sub.setLights(!sub.lightsOn);
    else if (name === "chart") game.chart.show();
    else if (name === "pause") game.setMode("paused");
    else if (name === "photo" && game.photo) game.photo.toggle();
  }

  applyTouch(a) {
    const mode = this.game.mode;
    if (mode === "base") {
      a.forward += -this.stickVec.y;
      a.strafe += this.stickVec.x;
      if (this.stickVec.boost) a.boost = true;
      return;
    }
    if (mode !== "dive") {
      this.clearTouch();
      return;
    }
    a.forward += -this.stickVec.y;
    a.strafe += this.stickVec.x;
    if (this.stickVec.boost) a.boost = true;
    if (this.held.rise) a.vert += 1;
    if (this.held.dive) a.vert -= 1;
    if (this.held.dock) a.dock = true;
  }

  /* A panel opened under a held thumb: let go of everything. */
  clearTouch() {
    if (this.stickId === null && this.lookId === null && !Object.values(this.held).some(Boolean)) return;
    this.stickId = null;
    this.lookId = null;
    this.dockPointer = null;
    this.stickVec.x = 0;
    this.stickVec.y = 0;
    this.stickVec.boost = false;
    if (this.stickBase) this.stickBase.classList.remove("on", "boost");
    for (const name of Object.keys(this.held)) this.held[name] = false;
    if (this.touchRoot) {
      for (const b of this.touchRoot.querySelectorAll("[data-hold]")) {
        b.classList.remove("on");
        delete b.dataset.pointer;
      }
    }
  }

  /* ------------------------------------------------------------- teardown -- */

  dispose() {
    window.removeEventListener("gamepadconnected", this.onPadConnect);
    window.removeEventListener("pointerdown", this.onFirstTouch, true);
    if (this.touchRoot) {
      this.touchRoot.removeEventListener("pointerdown", this.onTouchDown);
      this.touchRoot.removeEventListener("contextmenu", this.onCtx);
      window.removeEventListener("pointermove", this.onTouchMove);
      window.removeEventListener("pointerup", this.onTouchUp);
      window.removeEventListener("pointercancel", this.onTouchUp);
      this.touchRoot.remove();
      this.touchRoot = null;
    }
    if (this.hudRoot) this.hudRoot.removeEventListener("pointerdown", this.onHudDown);
    if (this.cargoPanel) this.cargoPanel.removeEventListener("pointerdown", this.onCargoDown);
    delete document.body.dataset.input;
  }
}
