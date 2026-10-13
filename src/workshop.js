/* A real-time fitted-boat preview, with a single selected component at a time. */
import * as THREE from "three";
import { UPGRADES } from "./config.js";
import { upgradeCost } from "./progression.js";
import { buildSubModel, fittedParts } from "./submodel.js";

const MOUNTS = {
  hull: "Conformal armour wrapped around the flanks",
  pressure: "External pressure-frame rings",
  thrust: "Stern screw, shroud and thruster pods",
  cargo: "Paired specimen pods below the hull",
  battery: "Sealed battery banks blended into the shoulders",
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
const CATEGORIES = {
  Structure: ["pressure", "hull", "cargo", "thrust"],
  Exploration: ["lights", "sonar", "capture", "net"],
  Weapons: ["harpoon", "torpedo", "lattice"],
  Systems: ["battery", "repair", "reactor", "scrubber"],
};
const UNITS = { hull: "HP", pressure: "m rated", thrust: "m/s²", cargo: "slots", battery: "charge", lights: "m reach", sonar: "m range", capture: "m reach", harpoon: "damage", torpedo: "rounds", net: "fish", repair: "HP/s", reactor: "charge/s", scrubber: "% ink", lattice: "damage" };
export class Workshop {
  constructor(game) {
    this.game = game;
    this.selected = "pressure";
    this.angle = 1.05;
    this.category = "Structure";
    this.preview = true;
    this.root = document.getElementById("shipyard");
    this.root.innerHTML = `
      <div class="ship-view"><div class="preview-heading"><span class="eyebrow">MN / EXPLORER CLASS</span><span class="preview-state"></span></div><canvas aria-label="Rotatable 3D preview of your submarine"></canvas><div class="ship-rotate"><button type="button" data-spin="-1" aria-label="Rotate submarine left">↶</button><span>DRAG TO INSPECT</span><button type="button" data-spin="1" aria-label="Rotate submarine right">↷</button></div><button type="button" class="preview-toggle" aria-pressed="true">Preview next mark</button><p class="ship-fitted"></p></div>
      <div class="ship-controls"><div class="component-categories" aria-label="Component categories"></div><div class="component-picks"></div><div class="component-detail" aria-live="polite"></div><button class="primary component-buy" type="button"></button><p class="purchase-note" role="status"></p><button class="component-board" type="button">Inspect the cabin →</button></div>`;
    for (const name of Object.keys(CATEGORIES)) {
      const b = document.createElement("button"); b.type = "button"; b.dataset.category = name; b.textContent = name;
      this.root.querySelector(".component-categories").appendChild(b);
    }
    const picks = this.root.querySelector(".component-picks");
    for (const up of UPGRADES) {
      const b = document.createElement("button");
      b.type = "button";
      b.innerHTML = `<span class="component-icon">${up.icon}</span><span><strong>${up.name}</strong><small></small></span><span class="component-price"></span>`;
      b.dataset.component = up.id;
      picks.appendChild(b);
    }
    this.click = (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      if (b.dataset.category) {
        this.category = b.dataset.category; this.selected = CATEGORIES[this.category][0]; this.refresh();
      }
      if (b.classList.contains("preview-toggle")) { this.preview = !this.preview; this.refresh(); }
      if (b.dataset.component) {
        this.selected = b.dataset.component;
        this.refresh();
      }
      if (b.dataset.spin) this.angle += Number(b.dataset.spin) * 0.45;
      if (b.classList.contains("component-buy")) {
        const result = game.buyUpgrade(this.selected);
        this.refresh();
        this.root.querySelector(".purchase-note").textContent = result.ok ? `Installed mark ${result.level}. Your boat is ready.` : result.reason;
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
    this.scene.add(new THREE.HemisphereLight(0xc5e7ff, 0x314552, 2.2));
    const rim = new THREE.DirectionalLight(0x58c9ff, 2.4); rim.position.set(-5, 2, -4); this.scene.add(rim);
    const light = new THREE.DirectionalLight(0xffedcf, 3.2);
    light.position.set(4, 7, 5);
    this.scene.add(light);
    this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
    this.camera.position.set(0, 2.8, 10.8);
    this.camera.lookAt(0, 0.5, 0);
    this.refresh();
  }
  refresh() {
    const up = UPGRADES.find((u) => u.id === this.selected),
      p = this.game.profile,
      level = p.upgrades[up.id] || 0,
      cost = upgradeCost(p.upgrades, up.id);
    for (const b of this.root.querySelectorAll("[data-category]")) b.setAttribute("aria-pressed", String(b.dataset.category === this.category));
    for (const b of this.root.querySelectorAll("[data-component]")) {
      const id = b.dataset.component, mark = p.upgrades[id] || 0, price = upgradeCost(p.upgrades, id);
      b.hidden = !CATEGORIES[this.category].includes(id);
      b.querySelector("small").textContent = `MARK ${String(mark).padStart(2, "0")} · ${price == null ? "COMPLETE" : "NEXT REFIT"}`;
      b.querySelector(".component-price").textContent = price == null ? "✓" : `${price.toLocaleString()} cr`;
      b.setAttribute(
        "aria-pressed",
        String(b.dataset.component === this.selected),
      );
      b.dataset.fitted = String((p.upgrades[b.dataset.component] || 0) > 0);
    }
    const detail = this.root.querySelector(".component-detail");
    detail.replaceChildren();
    const unit = UNITS[up.id];
    detail.innerHTML = `<div class="detail-heading"><h3>${up.name}</h3><span class="eyebrow">MARK ${level}${cost == null ? " / MAX" : ` → ${level + 1}`}</span></div><p>${up.blurb}</p><div class="stat-comparison"><div><span>FITTED</span><strong>${up.values[level]} <small>${unit}</small></strong></div><span>→</span><div><span>${cost == null ? "MAXIMUM" : "AFTER REFIT"}</span><strong>${up.values[Math.min(level + 1, up.values.length - 1)]} <small>${unit}</small></strong></div></div><p class="mount-caption">${MOUNTS[up.id]}</p>`;
    this.root.querySelector(".preview-state").textContent = this.preview && cost != null ? `PREVIEW · ${up.name.toUpperCase()} MK ${level + 1}` : "CURRENT FITOUT";
    const toggle = this.root.querySelector(".preview-toggle");
    toggle.setAttribute("aria-pressed", String(this.preview)); toggle.disabled = cost == null;
    toggle.textContent = this.preview ? "Showing next mark · view fitted boat" : "Showing fitted boat · preview next mark";
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
    this.root.querySelector(".ship-fitted").textContent = "Fitted now: " + fittedParts(
      p.upgrades,
    ).join(" · ");
    const upgrades = {...p.upgrades};
    if (this.preview && cost != null) upgrades[up.id] = level + 1;
    const key = JSON.stringify(upgrades);
    if (this.scene && key !== this.key) {
      this.key = key;
      const rotation = this.model?.group.rotation.y ?? this.angle;
      if (this.model) {
        this.scene.remove(this.model.group);
        this.model.group.traverse((o) => o.geometry?.dispose());
        this.model.materials.forEach((m) => m.dispose());
      }
      this.model = buildSubModel(upgrades);
      this.model.group.rotation.y = rotation;
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
    this.model.group.rotation.y += (this.angle - this.model.group.rotation.y) * .16;
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
