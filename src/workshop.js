/* A real-time fitted-boat preview, with a single selected component at a time. */
import * as THREE from "three";
import { UPGRADES } from "./config.js";
import { upgradeCost } from "./progression.js";
import { buildSubModel, fittedParts } from "./submodel.js";

const MOUNTS = {
  hull: "Armour plates along the flanks",
  pressure: "External pressure-frame rings",
  thrust: "Stern screw, shroud and thruster pods",
  cargo: "Paired specimen pods below the hull",
  battery: "Deck-mounted cell racks",
  lights: "Bow floodlight housings",
  sonar: "Sensor dome below the bow",
  capture: "Capture emitter around the bow",
  harpoon: "Forward deck gun",
  torpedo: "Paired bow launch tubes",
  net: "Aft net drum",
  repair: "Repair drone on the sail",
  reactor: "Core behind the sail",
  scrubber: "Viewport wiper arms",
  lattice: "Charged mesh over the pressure hull",
};
export class Workshop {
  constructor(game) {
    this.game = game;
    this.selected = "pressure";
    this.angle = 0.7;
    this.root = document.getElementById("shipyard");
    this.root.innerHTML =
      '<div class="ship-view"><canvas aria-label="Rotatable 3D preview of your fitted submarine"></canvas><div class="ship-rotate"><button type="button" data-spin="-1" aria-label="Rotate submarine left">↶</button><span>YOUR BOAT · DRAG TO ROTATE</span><button type="button" data-spin="1" aria-label="Rotate submarine right">↷</button></div><p class="ship-fitted"></p></div><div class="ship-controls"><p class="eyebrow">Component workshop</p><h3>Make it your boat.</h3><p class="hint">Choose a component to see where it fits. Every installation changes the model and your boat’s capabilities.</p><div class="component-picks"></div><div class="component-detail" aria-live="polite"></div><button class="primary component-buy" type="button"></button><button class="component-board" type="button">Walk inside your submarine</button></div>';
    const picks = this.root.querySelector(".component-picks");
    for (const up of UPGRADES) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = up.name;
      b.dataset.component = up.id;
      picks.appendChild(b);
    }
    this.click = (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      if (b.dataset.component) {
        this.selected = b.dataset.component;
        this.refresh();
      }
      if (b.dataset.spin) this.angle += Number(b.dataset.spin) * 0.45;
      if (b.classList.contains("component-buy")) {
        game.buyUpgrade(this.selected);
        this.refresh();
      }
      if (b.classList.contains("component-board")) game.enterCabin();
    };
    this.root.addEventListener("click", this.click);
    this.canvas = this.root.querySelector("canvas");
    this.down = (e) => {
      this.drag = e.clientX;
      this.canvas.setPointerCapture(e.pointerId);
    };
    this.move = (e) => {
      if (this.drag == null) return;
      this.angle += (e.clientX - this.drag) * 0.012;
      this.drag = e.clientX;
    };
    this.up = () => {
      this.drag = null;
    };
    this.canvas.addEventListener("pointerdown", this.down);
    this.canvas.addEventListener("pointermove", this.move);
    this.canvas.addEventListener("pointerup", this.up);
    this.canvas.addEventListener("pointercancel", this.up);
    this.off = game.bus.on("economy:upgrade", () => this.refresh());
  }
  init() {
    if (this.renderer) return;
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      alpha: true,
    });
    this.renderer.setPixelRatio(Math.min(1.5, devicePixelRatio));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.scene = new THREE.Scene();
    this.scene.add(new THREE.HemisphereLight(0xc5e7ff, 0x314552, 3));
    const light = new THREE.DirectionalLight(0xffedcf, 3);
    light.position.set(4, 7, 5);
    this.scene.add(light);
    this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
    this.camera.position.set(0, 4, 15);
    this.camera.lookAt(0, 0.5, 0);
    this.refresh();
  }
  refresh() {
    const up = UPGRADES.find((u) => u.id === this.selected),
      p = this.game.profile,
      level = p.upgrades[up.id] || 0,
      cost = upgradeCost(p.upgrades, up.id);
    for (const b of this.root.querySelectorAll("[data-component]")) {
      b.setAttribute(
        "aria-pressed",
        String(b.dataset.component === this.selected),
      );
      b.dataset.fitted = String((p.upgrades[b.dataset.component] || 0) > 0);
    }
    const detail = this.root.querySelector(".component-detail");
    detail.replaceChildren();
    for (const [tag, text] of [
      ["h3", up.name],
      ["p", MOUNTS[up.id]],
      ["p", up.blurb],
      [
        "strong",
        cost == null
          ? `Fully fitted · mark ${level}`
          : `Mark ${level} → ${level + 1} · ${up.values[level]} → ${up.values[level + 1]}`,
      ],
    ]) {
      const n = document.createElement(tag);
      n.textContent = text;
      detail.appendChild(n);
    }
    const buy = this.root.querySelector(".component-buy");
    buy.disabled = cost == null || p.credits < cost || !this.game.sub.docked;
    buy.textContent =
      cost == null
        ? "Fully installed"
        : !this.game.sub.docked
          ? "Return to the Hull to install"
          : p.credits < cost
            ? `${cost} cr · need ${cost - p.credits} more`
            : `Install component · ${cost} cr`;
    this.root.querySelector(".ship-fitted").textContent = fittedParts(
      p.upgrades,
    ).join(" · ");
    const key = JSON.stringify(p.upgrades);
    if (this.scene && key !== this.key) {
      this.key = key;
      if (this.model) {
        this.scene.remove(this.model.group);
        this.model.group.traverse((o) => o.geometry?.dispose());
        this.model.materials.forEach((m) => m.dispose());
      }
      this.model = buildSubModel(p.upgrades);
      this.model.materials.forEach((m) => {
        m.metalness = Math.min(m.metalness, 0.3);
        m.emissiveIntensity = Math.min(m.emissiveIntensity, 0.6);
      });
      this.scene.add(this.model.group);
    }
  }
  update() {
    if (this.game.mode !== "station" || this.game.hud.activeTab !== "shipyard")
      return;
    if (this.failed) return;
    try { this.init(); } catch (error) {
      this.failed = true;
      this.canvas.hidden = true;
      const note = document.createElement("p");
      note.className = "ship-fitted";
      note.textContent = "3D preview unavailable on this device. You can still select and install components.";
      this.canvas.after(note);
      return;
    }
    const w = this.canvas.clientWidth,
      h = this.canvas.clientHeight;
    if (!w || !h) return;
    if (w !== this.width || h !== this.height) {
      this.width = w;
      this.height = h;
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }
    this.model.group.rotation.y = this.angle;
    this.renderer.render(this.scene, this.camera);
  }
  dispose() {
    this.off();
    this.root.removeEventListener("click", this.click);
    for (const [n, f] of [
      ["pointerdown", this.down],
      ["pointermove", this.move],
      ["pointerup", this.up],
      ["pointercancel", this.up],
    ])
      this.canvas.removeEventListener(n, f);
    if (this.model) {
      this.model.group.traverse((o) => o.geometry?.dispose());
      this.model.materials.forEach((m) => m.dispose());
    }
    this.renderer?.dispose();
    this.root.replaceChildren();
  }
}
