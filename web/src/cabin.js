/* A small research vessel: bridge, working lab, engineering and a lived-in
   crew nook. All routes remain on one deck and share the dock's controller. */
import * as THREE from "three";
import { disposeTree, spindle } from "./geo.js";
import { InteriorKit, seaWindow } from "./interior.js";
import { AMBIENT_KINDS } from "./ambient.js";

export class Cabin {
  constructor(game) {
    this.game = game;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x081a27);
    this.boxes = []; this.items = []; this.resources = []; this.time = 0;
    const k = this.kit = new InteriorKit(this.scene, this.boxes);
    const wall = k.material(0x829598, .22), cream = k.material(0xc5c4aa, .1);
    const trim = this.dark = k.material(0x3c5565, .25, .62);
    const floor = k.material(0x41515a, .15), rubber = k.material(0x101d27, 0);
    const brass = this.paint = k.material(0xb88642, .55, .4);
    const cyan = this.green = k.material(0x60dec9, .15, .5, 0x31bca9);
    const amber = k.material(0xecc77b, .1, .5, 0xc09042);
    const coral = k.material(0xc86651, .1);
    this.lights = [new THREE.HemisphereLight(0xb9e5ec, 0x263842, 1.5), new THREE.DirectionalLight(0xffe0ac, 2.1)];
    this.lights[1].position.set(-3, 5, 1); this.scene.add(...this.lights);
    this.scene.add(new THREE.AmbientLight(0x6eaaa9, .3));
    this.night = false;
    // Fine seams and a ribbed deck break up otherwise blank procedural panels.
    const panel = document.createElement("canvas"); panel.width = panel.height = 256;
    const pc = panel.getContext("2d"); pc.fillStyle = "#e7ece7"; pc.fillRect(0, 0, 256, 256);
    pc.strokeStyle = "#b4c1bc"; pc.lineWidth = 2; pc.strokeRect(3, 3, 250, 250);
    for (const x of [12, 244]) for (const y of [12, 244]) { pc.fillStyle = "#98a7a5"; pc.beginPath(); pc.arc(x, y, 2, 0, Math.PI * 2); pc.fill(); }
    const wt = new THREE.CanvasTexture(panel); wt.colorSpace = THREE.SRGBColorSpace;
    wt.wrapS = wt.wrapT = THREE.RepeatWrapping; wt.repeat.set(7, 2); wall.map = wt; this.resources.push(wt);
    const deck = document.createElement("canvas"); deck.width = deck.height = 128;
    const dc = deck.getContext("2d"); dc.fillStyle = "#a5b0b6"; dc.fillRect(0, 0, 128, 128);
    dc.strokeStyle = "#71848b"; dc.lineWidth = 2;
    for (let y = 8; y < 128; y += 12) { dc.beginPath(); dc.moveTo(4, y); dc.lineTo(124, y); dc.stroke(); }
    const ft = new THREE.CanvasTexture(deck); ft.colorSpace = THREE.SRGBColorSpace;
    ft.wrapS = ft.wrapT = THREE.RepeatWrapping; ft.repeat.set(4, 10); floor.map = ft; this.resources.push(ft);
    // Pressure hull, faceted shoulders and continuous floor seams.
    k.box(5.8, .18, 14, floor, 0, -.09, 0);
    k.box(5.8, .12, 14, wall, 0, 3.35, 0);
    for (const side of [-1, 1]) {
      k.box(.16, 3.4, 14, wall, side * 2.9, 1.6, 0, true);
      k.box(.8, .16, 14, cream, side * 2.65, 3.04, 0, false, [0, 0, side * .6]);
      k.box(.09, .34, 13.8, trim, side * 2.78, .22, 0);
      k.box(.025, .035, 13.7, cyan, side * 2.69, .42, 0);
      k.cylinder(.05, 13.8, brass, side * 2.32, 3.09, 0, [Math.PI / 2, 0, 0]);
      k.cylinder(.035, 13.8, trim, side * 2.1, 3.18, 0, [Math.PI / 2, 0, 0]);
    }
    k.box(5.8, 3.5, .16, wall, 0, 1.65, -7, true);
    k.box(5.8, 3.5, .16, wall, 0, 1.65, 7, true);
    for (let z = -6.6; z < 7; z += 1.1) {
      k.box(5.5, .012, .018, trim, 0, .008, z);
      for (const x of [-.72, .72]) k.box(.035, .015, .65, amber, x, .02, z);
    }
    for (const z of [-6.65, -4.5, -2.3, .1, 2.5, 4.7, 6.7]) {
      for (const side of [-1, 1]) {
        k.box(.10, 2.85, .12, trim, side * 2.72, 1.42, z);
        k.box(.8, .12, .12, trim, side * 2.4, 2.93, z, false, [0, 0, side * -.65]);
        for (const y of [.65, 2.4]) k.cylinder(.027, .012, brass, side * 2.65, y, z, [0, 0, Math.PI / 2], 6);
      }
      k.box(4.25, .12, .12, trim, 0, 3.19, z);
      k.box(1.9, .03, .16, cream, 0, 3.09, z);
      k.box(1.6, .012, .085, amber, 0, 3.06, z);
    }
    // Open bulkheads frame each bay without interrupting the central aisle.
    for (const [z, title, subtitle] of [[-2.1, "01 / BRIDGE", "OBSERVATION & NAVIGATION"], [2.45, "02 / RESEARCH", "LIFE SUPPORT / ENGINEERING"]]) {
      for (const side of [-1, 1]) {
        k.box(1.45, 2.8, .15, trim, side * 2.13, 1.4, z, true);
        k.box(.06, 2.55, .18, cyan, side * 1.37, 1.3, z);
      }
      k.box(5.6, .4, .19, trim, 0, 2.95, z);
      k.sign(title, subtitle, 2.25, 0, 2.95, z + .11);
    }
    this.waterView = seaWindow();
    // Wide bridge glass with structural mullions and curved side glazing.
    k.box(5.18, 1.6, .055, this.waterView, 0, 2.14, -6.84);
    for (const x of [-2.65, -1.75, 0, 1.75, 2.65]) k.box(.07, 1.85, .1, trim, x, 2.17, -6.73);
    k.box(5.35, .10, .12, trim, 0, 1.34, -6.71);
    k.sign("MNEMO / 01", "DEEP SEA RESEARCH VESSEL", 2.2, 0, 3.0, -6.7);
    for (const side of [-1, 1]) {
      for (const z of [-3.4, -1.05, 5.5]) {
        k.ring(.53, .075, brass, side * 2.77, 1.94, z, [0, Math.PI / 2, 0]);
        k.add(new THREE.CircleGeometry(.49, 32), this.waterView, side * 2.79, 1.94, z, [0, Math.PI / 2, 0]);
        for (let i = 0; i < 8; i++) {
          const a = i * Math.PI / 4;
          k.cylinder(.025, .04, trim, side * 2.7, 1.94 + Math.sin(a) * .54, z + Math.cos(a) * .54, [0, 0, Math.PI / 2], 6);
        }
      }
    }
    // Bridge: sloped console, analogue dials and the three live instruments.
    k.box(4.4, .86, .85, trim, 0, .46, -5.7, true);
    k.box(4.65, .12, 1.08, cream, 0, .96, -5.62, false, [-.15, 0, 0]);
    this.displays = [];
    for (const [i, x] of [-1.25, 0, 1.25].entries()) {
      this.screen(x, 1.32, -5.38, .98, .54, 0, i);
      for (let n = 0; n < 5; n++) k.box(.09, .045, .07, n === 0 ? coral : n < 3 ? cyan : brass, x - .32 + n * .16, 1.08, -5.24);
      k.ring(.09, .018, brass, x + .43, 1.12, -5.18);
    }
    for (const side of [-1, 1]) {
      k.cylinder(.05, .28, trim, side * .45, 1.05, -5.07, [.3, 0, 0]);
      k.box(.18, .07, .09, rubber, side * .45, 1.2, -5.03);
    }
    // Offset pilot seat leaves a clear path to the helm.
    k.cylinder(.10, .5, brass, -1.65, .3, -3.7);
    k.box(.62, .16, .65, rubber, -1.65, .62, -3.7, true);
    k.box(.62, .72, .12, rubber, -1.65, 1.05, -3.37, false, [.12, 0, 0]);
    for (const x of [-2.05, -1.25]) k.box(.09, .07, .5, brass, x, .92, -3.63);
    this.items.push({ id: "helm", label: "Take the helm", x: 0, z: -5.15, reach: 2.6 });
    // Port engineering rack; real fittings change with installed upgrades.
    k.box(.8, 1.5, 1.55, trim, -2.28, .75, .4, true);
    this.screen(-1.865, 1.4, .4, 1.12, .62, Math.PI / 2, 3);
    k.sign("ENGINEERING", "PRESSURE / POWER / COMPONENTS", 1.45, -2.77, 2.72, .25, Math.PI / 2);
    this.items.push({ id: "engineering", label: "Engineering · inspect / refit components", x: -1.7, z: .4, reach: 1.65 });
    // Starboard observation table, sonar and a field journal.
    k.box(.84, .87, 1.65, cream, 2.25, .46, -.5, true);
    k.box(.92, .07, 1.75, trim, 2.23, .95, -.5);
    this.screen(1.78, 1.4, -.5, 1.25, .72, -Math.PI / 2, 4);
    k.sign("FIELD STATION", "CATALOGUE THE LIVING DEEP", 1.55, 2.77, 2.7, -.5, -Math.PI / 2);
    this.items.push({ id: "research", label: "Marine field guide · sightings & habitats", x: 1.65, z: -.5, reach: 1.7 });
    for (let i = 0; i < 3; i++) k.box(.28, .06, .4, i === 1 ? coral : brass, 2.13, 1.02 + i * .065, .09);
    // Aft compartment: transparent specimen canisters, cell bank, crew berth.
    k.box(.88, .82, 1.7, trim, -2.25, .41, 3.65, true);
    k.box(.94, .08, 1.85, cream, -2.25, .86, 3.65);
    k.sign("SPECIMEN LAB", "LIVE STORAGE / NO FEEDING", 1.55, -2.77, 2.75, 3.75, Math.PI / 2);
    this.items.push({ id: "cargo", label: "Inspect specimen storage", x: -1.68, z: 3.65, reach: 1.6 });
    k.box(.74, 1.75, 1.75, trim, 2.31, .875, 3.7, true);
    k.sign("CELL ARRAY", "MODULAR / ISOLATED / SEALED", 1.55, 2.77, 2.7, 3.75, -Math.PI / 2);
    this.items.push({ id: "power", label: "Inspect battery bank", x: 1.72, z: 3.7, reach: 1.6 });
    for (const y of [.42, .86, 1.30]) for (let i = 0; i < 7; i++) k.box(.025, .065, .13, brass, 1.923, y, 3.02 + i * .2);
    k.box(.95, .45, 1.9, trim, -2.2, .26, 5.75, true);
    k.box(.9, .16, 1.8, k.material(0x597a7e, 0), -2.2, .55, 5.75);
    k.box(.78, .12, .4, cream, -2.2, .69, 6.27);
    k.box(.91, .035, .9, coral, -2.2, .65, 5.35);
    k.sign("OFF WATCH", "HOME IS A PRESSURE HULL", 1.45, -2.78, 1.5, 5.75, Math.PI / 2, "#e7be82");
    // Locker, mug and life support valves make the aft area feel inhabited.
    k.box(.7, 1.5, 1.15, cream, 2.3, .75, 5.9, true);
    k.box(.05, .33, .045, brass, 1.91, .94, 5.9);
    for (const z of [5.55, 6.05]) k.ring(.13, .022, coral, 1.89, 1.7, z, [0, Math.PI / 2, 0]);
    k.sign("QUIET WATCH", "E / CHANGE CABIN LIGHTING", 1.25, 2.77, 2.27, 5.8, -Math.PI / 2);
    this.items.push({ id: "lighting", label: "Cabin lights · toggle night watch", x: 1.72, z: 5.85, reach: 1.6 });
    // Circular pressure door, wheel, locking dogs and inset number plate.
    k.box(1.7, 2.72, .1, trim, 0, 1.4, 6.85);
    k.ring(.76, .085, brass, 0, 1.44, 6.72);
    k.add(new THREE.CircleGeometry(.72, 32), cream, 0, 1.44, 6.77, [0, Math.PI, 0]);
    k.ring(.25, .027, coral, 0, 1.44, 6.66);
    for (let i = 0; i < 6; i++) {
      const a = i * Math.PI / 3;
      k.line([0, 1.44, 6.65], [Math.cos(a) * .25, 1.44 + Math.sin(a) * .25, 6.65], .012, brass);
      k.box(.14, .09, .08, trim, Math.cos(a) * .73, 1.44 + Math.sin(a) * .73, 6.67);
    }
    k.sign("03 / AIRLOCK", "HATCH SECURED UNDER WAY", 1.6, 0, 2.65, 6.65, Math.PI, "#e7be82");
    this.items.push({ id: "exit-cabin", label: "Disembark into the Hull", x: 0, z: 6.25, reach: 2 });
    k.finish();
    this.components = new THREE.Group(); this.scene.add(this.components);
    this.refresh();
  }
  screen(x, y, z, width, height, yaw, kind) {
    const canvas = document.createElement("canvas"); canvas.width = 512; canvas.height = 288;
    const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
    this.resources.push(texture);
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(width, height), new THREE.MeshBasicMaterial({ map: texture }));
    screen.position.set(x, y, z); screen.rotation.y = yaw; this.scene.add(screen);
    const nx = Math.sin(yaw), nz = Math.cos(yaw);
    this.kit.box(width + .07, height + .07, .045, this.dark, x - nx * .025, y, z - nz * .025, false, [0, yaw, 0]);
    this.displays.push({ canvas, texture, kind });
  }
  refresh() {
    for (const obj of [...this.components.children]) {
      this.components.remove(obj); obj.traverse((n) => n.geometry?.dispose());
    }
    const k = new InteriorKit(this.components), up = this.game.profile.upgrades;
    for (let i = 0; i < 2 + (up.battery || 0); i++) {
      const z = 3.12 + (i % 3) * .48, y = .6 + Math.floor(i / 3) * .66;
      k.cylinder(.15, .52, this.paint, 1.98, y, z);
      k.cylinder(.155, .10, this.green, 1.98, y + .12, z);
    }
    this.specimens = [];
    const glass = this.glass || (this.glass = new THREE.MeshStandardMaterial({ color: 0x8ddcca, transparent: true, opacity: .18, depthWrite: false, roughness: .15 }));
    for (let i = 0; i < 2 + Math.min(3, up.cargo || 0); i++) {
      const z = 3.02 + i * .29;
      k.cylinder(.12, .64, glass, -2.12, 1.24, z);
      for (const y of [.93, 1.57]) k.cylinder(.14, .06, this.paint, -2.12, y, z);
      k.cylinder(.075, .015, this.green, -2.12, .98, z);
      if (i < this.game.profile.cargo.length) {
        const fish = new THREE.Mesh(spindle({ length: .18, radius: .045, rings: 8, segments: 6 }), this.paint);
        fish.position.set(-2.12, 1.24, z); this.components.add(fish); this.specimens.push(fish);
      }
    }
    for (let i = 0; i < 2 + (up.pressure || 0); i++) k.box(.025, .065, .12, this.green, -1.858, .43 + i * .10, .4);
    if (up.reactor) { k.cylinder(.19, .65, this.green, -2.12, .7, 1); k.ring(.24, .025, this.paint, -2.12, .7, 1, [Math.PI / 2, 0, 0]); }
    if (up.repair) k.box(.33, .19, .4, this.paint, -2.16, 1.64, .9);
    k.finish();
    this.items.find((i) => i.id === "exit-cabin").label = this.game.sub.docked ? "Disembark into the Hull" : "Hatch secured · return to the helm";
  }
  toggleLights() {
    this.night = !this.night;
    this.lights[0].intensity = this.night ? .7 : 1.5;
    this.lights[1].intensity = this.night ? .3 : 2.1;
    this.game.toast(this.night ? "Night watch · instruments and aisle lights" : "Cabin lights · working light restored");
  }
  openGuide() {
    if (!this.guide) {
      this.guide = document.createElement("dialog"); this.guide.className = "marine-guide";
      this.guide.setAttribute("aria-label", "Marine field guide");
      this.guide.addEventListener("keydown", (event) => event.stopPropagation());
      const title = document.createElement("h2"); title.textContent = "The living deep";
      const intro = document.createElement("p"); intro.textContent = "Observe wildlife from the helm to log a sighting. These animals are peaceful; each first sighting earns a research fee.";
      this.guideList = document.createElement("div"); this.guideList.className = "marine-guide-list";
      const close = document.createElement("button"); close.textContent = "Return to the vessel";
      close.addEventListener("click", () => this.guide.close());
      this.guide.append(title, intro, this.guideList, close); document.body.append(this.guide);
      this.guide.addEventListener("close", () => { this.game.base.keys = Object.create(null); });
    }
    this.guideList.replaceChildren();
    const seen = this.game.profile.stats.sighted || [];
    for (const [id, spec] of Object.entries(AMBIENT_KINDS)) {
      const row = document.createElement("article"); row.dataset.seen = seen.includes(id) ? "1" : "0";
      const name = document.createElement("strong"); name.textContent = `${seen.includes(id) ? "✓ " : ""}${spec.name}`;
      const habitat = document.createElement("span"); habitat.textContent = `${spec.depth[0]}–${spec.depth[1]} m · ${spec.pay} cr · ${seen.includes(id) ? "logged" : "unobserved"}`;
      const desc = document.createElement("p"); desc.textContent = spec.hint || spec.line;
      row.append(name, habitat, desc); this.guideList.append(row);
    }
    this.game.base.keys = Object.create(null);
    if (document.pointerLockElement) document.exitPointerLock();
    this.guide.showModal();
  }
  update(dt) {
    this.time += dt; this.waterView.uniforms.time.value = this.time;
    this.waterView.uniforms.depth.value = this.game.sub.depth;
    for (const [i, fish] of this.specimens.entries()) fish.rotation.y = this.time * .5 + i;
    this.readoutTimer = (this.readoutTimer || 0) - dt;
    if (this.readoutTimer > 0) return; this.readoutTimer = .2;
    const g = this.game;
    const readings = [["DEPTH / METRES", Math.round(g.sub.depth), `${g.stats.pressureRating} M RATED`],
      ["CELL ARRAY", `${Math.round(g.sub.battery / g.stats.batteryMax * 100)}%`, "RESERVE CAPACITY"],
      ["HULL INTEGRITY", `${Math.round(g.sub.hull / g.stats.hullMax * 100)}%`, "PRESSURE SEAL / NOMINAL"],
      ["ENGINEERING", `MK ${g.profile.upgrades.pressure || 0}`, `${g.stats.pressureRating} M / CASING`]];
    this.displays.forEach(({ canvas, texture, kind }) => {
      const ctx = canvas.getContext("2d"); ctx.fillStyle = "#071a24"; ctx.fillRect(0, 0, 512, 288);
      ctx.strokeStyle = "#17434a"; ctx.lineWidth = 1;
      for (let x = 0; x < 512; x += 32) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, 288); ctx.stroke(); }
      for (let y = 0; y < 288; y += 32) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(512, y); ctx.stroke(); }
      ctx.fillStyle = "#97b8ba"; ctx.font = "19px monospace";
      if (kind === 4) {
        ctx.fillText("PASSIVE HYDROPHONE / 150 M", 20, 30);
        ctx.strokeStyle = "#468c83";
        for (const r of [35, 65, 95]) { ctx.beginPath(); ctx.arc(145, 157, r, 0, Math.PI * 2); ctx.stroke(); }
        ctx.beginPath(); ctx.moveTo(145, 157); ctx.lineTo(145 + Math.cos(this.time) * 95, 157 + Math.sin(this.time) * 95); ctx.stroke();
        ctx.fillStyle = "#8af6d8";
        for (const group of g.ambient?.kinds || []) for (const a of group.animals) {
          if (!a.alive) continue;
          const dx = a.position.x - g.sub.position.x, dz = a.position.z - g.sub.position.z;
          if (Math.hypot(dx, dz) > 150) continue;
          ctx.beginPath(); ctx.arc(145 + dx * .6, 157 + dz * .6, group.spec.size[1] > 6 ? 4 : 2, 0, Math.PI * 2); ctx.fill();
        }
        ctx.font = "48px monospace"; ctx.fillText(String((g.profile.stats.sighted || []).length).padStart(2, "0"), 285, 140);
        ctx.font = "17px monospace"; ctx.fillText("KINDS LOGGED", 285, 178); ctx.fillText("E / FIELD GUIDE", 285, 227);
      } else {
        const r = readings[kind]; ctx.fillText(r[0], 22, 40);
        ctx.fillStyle = "#96f2d5"; ctx.font = "76px monospace"; ctx.fillText(String(r[1]), 22, 140);
        ctx.font = "18px monospace"; ctx.fillText(r[2], 22, 189);
        for (let i = 0; i < 22; i++) { ctx.fillStyle = i > 18 ? "#c7a167" : "#387d76"; ctx.fillRect(24 + i * 21, 224, 13, 25); }
      }
      texture.needsUpdate = true;
    });
  }
  dispose() {
    this.guide?.remove(); disposeTree(this.scene);
    this.kit.disposeTextures(); this.resources.forEach((r) => r.dispose());
  }
}
