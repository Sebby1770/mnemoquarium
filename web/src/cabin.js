/* A walkable pressure hull. Uses the same first-person controller as the dock. */
import * as THREE from "three";
import { disposeTree } from "./geo.js";

export class Cabin {
  constructor(game) {
    this.game = game;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x091b24);
    this.boxes = [];
    this.items = [];
    this.resources = [];
    const mat = (color, glow = 0) =>
      new THREE.MeshStandardMaterial({
        color,
        roughness: 0.8,
        metalness: 0.12,
        emissive: glow,
        emissiveIntensity: 0.45,
      });
    const wall = mat(0x89958b),
      trim = mat(0x354d54),
      floor = mat(0x43565b),
      brass = mat(0xc09350);
    this.paint = mat(0xd1a63f);
    this.dark = mat(0x264751);
    this.green = mat(0x4ed6bb, 0x228c74);
    this.scene.add(new THREE.AmbientLight(0xd0e4df, 1.2));
    this.scene.add(new THREE.HemisphereLight(0xc9eced, 0x172b36, 2));
    const key = new THREE.DirectionalLight(0xffebc9, 2.0);
    key.position.set(-2, 4, -2);
    this.scene.add(key);
    const panelCanvas = document.createElement("canvas");
    panelCanvas.width = 256;
    panelCanvas.height = 256;
    const pg = panelCanvas.getContext("2d");
    pg.fillStyle = "#88988f";
    pg.fillRect(0, 0, 256, 256);
    pg.strokeStyle = "#65796f";
    pg.lineWidth = 4;
    pg.strokeRect(4, 4, 248, 248);
    for (const x of [14, 242])
      for (const y of [14, 242]) {
        pg.fillStyle = "#b8c6b6";
        pg.beginPath();
        pg.arc(x, y, 3, 0, Math.PI * 2);
        pg.fill();
      }
    const panelTexture = new THREE.CanvasTexture(panelCanvas);
    panelTexture.colorSpace = THREE.SRGBColorSpace;
    panelTexture.wrapS = panelTexture.wrapT = THREE.RepeatWrapping;
    panelTexture.repeat.set(1, 3);
    wall.map = panelTexture;
    wall.color.setHex(0xffffff);
    this.resources.push(panelTexture);
    this.box(3.8, 0.14, 10, floor, 0, -0.07, 0);
    this.box(3.8, 0.14, 10, wall, 0, 2.75, 0);
    this.box(0.16, 2.8, 10, wall, -1.9, 1.35, 0, true);
    this.box(0.16, 2.8, 10, wall, 1.9, 1.35, 0, true);
    this.box(3.8, 2.8, 0.16, wall, 0, 1.35, -5, true);
    this.box(3.8, 2.8, 0.16, wall, 0, 1.35, 5, true);
    for (const z of [-4.5, -2.5, 0, 2.5, 4.5]) {
      this.box(0.09, 2.7, 0.1, trim, -1.77, 1.35, z);
      this.box(0.09, 2.7, 0.1, trim, 1.77, 1.35, z);
      this.box(3.55, 0.12, 0.1, trim, 0, 2.58, z);
      this.box(1.6, 0.025, 0.1, this.green, 0, 2.5, z);
    }
    for (const side of [-1, 1]) {
      this.box(0.035, 0.025, 9.3, brass, side * 0.85, 0.025, 0);
      for (const z of [-3.2, 3.25]) this.porthole(side * 1.79, 1.6, z, side);
    }
    // A quiet moving water view, with no sun disc or bloom.
    this.waterView = new THREE.ShaderMaterial({
      uniforms: { time: { value: 0 } },
      side: THREE.DoubleSide,
      vertexShader:
        "varying vec2 vUv; void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}",
      fragmentShader: `
      varying vec2 vUv; uniform float time;
      void main(){vec3 c=mix(vec3(.025,.10,.14),vec3(.12,.38,.43),vUv.y);
      float sand=(1.-smoothstep(.20,.22,vUv.y+.025*sin(vUv.x*12.0)));c=mix(c,vec3(.18,.27,.25),sand);
      for(int i=0;i<5;i++){float fi=float(i);vec2 p=vec2(fract(time*.012+fi*.213),.35+fi*.105);vec2 d=(vUv-p)*vec2(1.,3.);float fish=1.-smoothstep(.012,.021,length(d));c=mix(c,vec3(.04,.17,.21),fish);}
      gl_FragColor=vec4(c,1.);}`,
    });
    this.scene.traverse((o) => {
      if (o.geometry?.type === "CircleGeometry") o.material = this.waterView;
    });
    // Forward observation window above a broad, reachable helm.
    this.box(2.8, 1.25, 0.04, this.waterView, 0, 1.83, -4.88);
    this.box(0.07, 1.25, 0.06, trim, 0, 1.83, -4.82);
    this.box(2.7, 0.8, 0.72, trim, 0, 0.55, -4.2, true);
    this.displays = [];
    for (const [i, x] of [-0.8, 0, 0.8].entries()) {
      const canvas = document.createElement("canvas");
      canvas.width = 256;
      canvas.height = 128;
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      this.resources.push(texture);
      const screen = this.box(
        0.7,
        0.35,
        0.04,
        new THREE.MeshBasicMaterial({ map: texture }),
        x,
        1.1,
        -3.81,
      );
      this.displays.push({ canvas, texture });
      for (let n = 0; n < 3; n++)
        this.box(
          0.05,
          0.025,
          0.05,
          n === 0 ? this.green : brass,
          x - 0.18 + n * 0.16,
          0.975,
          -3.92,
        );
    }
    this.label("01 / FLIGHT DECK", 0, 2.3, -4.76);
    this.label("HELM / NAVIGATION", 0, 2.54, -4.78);
    this.items.push({
      id: "helm",
      label: "Take the helm",
      x: 0,
      z: -3.9,
      reach: 2.5,
    });
    this.box(1.05, 2.1, 0.12, trim, 0, 1.05, 4.84);
    this.label("ACCESS HATCH", 0, 2.32, 4.75, Math.PI);
    const wheel = new THREE.Mesh(
      new THREE.TorusGeometry(0.28, 0.025, 6, 20),
      brass,
    );
    wheel.position.set(0, 1.2, 4.74);
    this.scene.add(wheel);
    this.items.push({
      id: "exit-cabin",
      label: "Disembark into the Hull",
      x: 0,
      z: 4.15,
      reach: 2,
    });
    this.label("ENGINEERING", -1.67, 2.18, 0, Math.PI / 2);
    this.label("CELL ARRAY", 1.67, 2.18, 1.25, -Math.PI / 2);
    this.label("SPECIMEN HOLD", -1.67, 2.18, 2.4, Math.PI / 2);
    this.box(0.62, 1.55, 1.35, trim, -1.45, 0.78, -0.2, true);
    this.box(0.04, 0.45, 0.75, this.green, -1.1, 1.4, -0.2);
    this.items.push({
      id: "engineering",
      label: "Engineering · components and hull",
      x: -1.1,
      z: -0.2,
      reach: 1.8,
    });
    this.box(0.62, 1.25, 1.5, trim, 1.45, 0.63, 1.2, true);
    this.items.push({
      id: "power",
      label: "Inspect the battery bank",
      x: 1.15,
      z: 1.2,
      reach: 1.8,
    });
    this.box(0.6, 1.1, 1.55, trim, -1.45, 0.55, 2.6, true);
    this.items.push({
      id: "cargo",
      label: "Inspect specimen storage",
      x: -1.1,
      z: 2.6,
      reach: 1.8,
    });
    this.components = new THREE.Group();
    this.scene.add(this.components);
    this.refresh();
  }
  box(w, h, d, mat, x, y, z, collide = false, parent = this.scene) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    mesh.position.set(x, y, z);
    parent.add(mesh);
    if (collide)
      this.boxes.push({
        minX: x - w / 2,
        maxX: x + w / 2,
        minZ: z - d / 2,
        maxZ: z + d / 2,
      });
    return mesh;
  }
  label(text, x, y, z, rotation = 0) {
    const c = document.createElement("canvas");
    c.width = 768;
    c.height = 96;
    const g = c.getContext("2d");
    g.fillStyle = "#102e38";
    g.fillRect(0, 0, 768, 96);
    g.fillStyle = "#baebd9";
    g.font = "36px monospace";
    g.textAlign = "center";
    g.fillText(text, 384, 62);
    const texture = new THREE.CanvasTexture(c);
    texture.colorSpace = THREE.SRGBColorSpace;
    this.resources.push(texture);
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(1.45, 0.18),
      new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide }),
    );
    mesh.position.set(x, y, z);
    mesh.rotation.y = rotation;
    this.scene.add(mesh);
  }
  porthole(x, y, z, side) {
    const rim = new THREE.Mesh(
      new THREE.TorusGeometry(0.4, 0.055, 8, 24),
      this.dark,
    );
    rim.rotation.y = Math.PI / 2;
    rim.position.set(x, y, z);
    this.scene.add(rim);
    const pane = new THREE.Mesh(
      new THREE.CircleGeometry(0.37, 24),
      new THREE.MeshBasicMaterial({ color: 0x226477, side: THREE.DoubleSide }),
    );
    pane.rotation.y = Math.PI / 2;
    pane.position.set(x + side * 0.015, y, z);
    this.scene.add(pane);
  }
  refresh() {
    for (const obj of [...this.components.children]) {
      this.components.remove(obj);
      obj.traverse((n) => n.geometry?.dispose());
    }
    const up = this.game.profile.upgrades;
    for (let i = 0; i < 2 + (up.battery || 0); i++)
      this.box(
        0.4,
        0.4,
        0.15,
        this.green,
        1.1,
        0.45 + Math.floor(i / 3) * 0.5,
        0.7 + (i % 3) * 0.4,
        false,
        this.components,
      );
    for (let i = 0; i < 1 + (up.cargo || 0); i++)
      this.box(
        0.36,
        0.25,
        0.28,
        this.paint,
        -1.1,
        0.35 + Math.floor(i / 3) * 0.32,
        2.15 + (i % 3) * 0.42,
        false,
        this.components,
      );
    if (up.reactor)
      this.box(
        0.15,
        0.5,
        0.5,
        this.green,
        -1.06,
        0.6,
        -0.2,
        false,
        this.components,
      );
    if (up.repair)
      this.box(
        0.36,
        0.2,
        0.4,
        this.paint,
        -1.45,
        1.66,
        -0.2,
        false,
        this.components,
      );
    this.items.find((i) => i.id === "exit-cabin").label = this.game.sub.docked
      ? "Disembark into the Hull"
      : "Hatch secured · return to the helm";
  }
  update(dt) {
    this.waterView.uniforms.time.value += dt;
    this.readoutTimer = (this.readoutTimer || 0) - dt;
    if (this.readoutTimer > 0) return;
    this.readoutTimer = 0.5;
    const g = this.game;
    const readings = [
      [
        "DEPTH / METRES",
        Math.round(g.sub.depth),
        `${g.stats.pressureRating} M RATED`,
      ],
      [
        "CELL ARRAY",
        `${Math.round((g.sub.battery / g.stats.batteryMax) * 100)}%`,
        "POWER STABLE",
      ],
      [
        "HULL INTEGRITY",
        `${Math.round(g.sub.hull)}`,
        `${g.stats.hullMax} MAX / SEALED`,
      ],
    ];
    this.displays.forEach(({ canvas, texture }, i) => {
      const ctx = canvas.getContext("2d"),
        r = readings[i];
      ctx.fillStyle = "#071a22";
      ctx.fillRect(0, 0, 256, 128);
      ctx.strokeStyle = "#386b71";
      ctx.strokeRect(4, 4, 248, 120);
      ctx.fillStyle = "#8daea7";
      ctx.font = "13px monospace";
      ctx.fillText(r[0], 12, 23);
      ctx.fillStyle = "#a4f1d0";
      ctx.font = "38px monospace";
      ctx.fillText(String(r[1]), 12, 74);
      ctx.font = "12px monospace";
      ctx.fillText(r[2], 12, 107);
      texture.needsUpdate = true;
    });
  }
  dispose() {
    disposeTree(this.scene);
    for (const r of this.resources) r.dispose();
  }
}
