/* Your boat, from the outside. Built from the profile's upgrade levels, so
 * the drydock shows you what you paid for: every refit adds or changes a part
 * you can walk round and look at.
 *
 *   hull      armour plates bolted along the flanks
 *   pressure  frame rings, more and heavier with each casing
 *   thrust    a bigger screw, then a duct round it, then side pods
 *   cargo     external cargo pods
 *   battery   cell racks on the deck, lit
 *   lights    lamp housings on the bow
 *   sonar     a dome under the chin that grows
 *   capture   the beam emitter ring
 *   harpoon   the deck gun and its barrel
 *   torpedo   tube doors either side of the bow
 *   net       the net drum aft
 *   repair    a drone parked on the sail
 *   reactor   a glowing core aft of the sail
 *   scrubber  wipers on the bow glass
 *   lattice   the charged mesh over the hull
 *
 * The bow points +Z, y is up, and the hull is about nine metres long. */

import * as THREE from "three";

import { spindle } from "./geo.js";

const LENGTH = 9;
const RADIUS = 1.25;

function lv(upgrades, id) {
  return Math.max(0, Math.floor(Number(upgrades && upgrades[id]) || 0));
}

export function buildSubModel(upgrades) {
  const group = new THREE.Group();
  group.name = "sub-model";
  const mats = [];
  const mat = (opts) => {
    const m = new THREE.MeshStandardMaterial(opts);
    // The room's reflections are bright work lamps; at full strength they
    // glaze the paint white.
    m.envMapIntensity = 0.4;
    mats.push(m);
    return m;
  };

  const hullLevel = lv(upgrades, "hull");
  const paint = mat({ color: 0xb87a1c, roughness: 0.66, metalness: 0.2 });
  const steel = mat({ color: 0x59636b, roughness: 0.45, metalness: 0.75 });
  const darkSteel = mat({ color: 0x22292f, roughness: 0.5, metalness: 0.7 });
  const glass = mat({ color: 0x9fe8ff, roughness: 0.05, metalness: 0.1, transparent: true, opacity: 0.45, emissive: 0x1d6f86, emissiveIntensity: 0.6 });
  const lamp = mat({ color: 0xffffff, emissive: 0xfff1cc, emissiveIntensity: 1.4 });
  const cellGlow = mat({ color: 0x0b1f14, emissive: 0x44ff9a, emissiveIntensity: 1.6 });
  const reactorGlow = mat({ color: 0x1b0d05, emissive: 0xff9d3c, emissiveIntensity: 1 + lv(upgrades, "reactor") * 0.8 });
  const latticeGlow = mat({ color: 0x06121a, emissive: 0x6fdcff, emissiveIntensity: 0.9, transparent: true, opacity: 0.8 });

  // The hull: a fat spindle, blunt at the bow for the viewport.
  const profile = (t) => {
    const body = Math.pow(Math.sin(Math.PI * Math.min(1, t * 0.92 + 0.04)), 0.55);
    return Math.max(0.12, body * (0.35 + 0.65 * Math.min(1, t * 3)));
  };
  const hull = new THREE.Mesh(spindle({ length: LENGTH, radius: RADIUS, profile, rings: 28, segments: 24 }), paint);
  group.add(hull);

  // A dark waterline stripe, so the shape reads from any side.
  const stripe = new THREE.Mesh(new THREE.CylinderGeometry(RADIUS * 1.005, RADIUS * 1.005, LENGTH * 0.62, 24, 1, true), darkSteel);
  stripe.rotation.x = Math.PI / 2;
  stripe.scale.set(1, 1, 0.14);
  stripe.position.y = -RADIUS * 0.45;
  group.add(stripe);

  // Bow viewport, and the wipers if the scrubbers are fitted.
  const dome = new THREE.Mesh(new THREE.SphereGeometry(RADIUS * 0.72, 20, 14, 0, Math.PI * 2, 0, Math.PI * 0.5), glass);
  dome.rotation.x = Math.PI / 2;
  dome.position.z = LENGTH * 0.44;
  group.add(dome);
  const scrub = lv(upgrades, "scrubber");
  for (let i = 0; i < scrub; i += 1) {
    const wiper = new THREE.Mesh(new THREE.BoxGeometry(0.05, RADIUS * 0.7, 0.05), darkSteel);
    wiper.position.set((i - (scrub - 1) / 2) * 0.35, RADIUS * 0.1, LENGTH * 0.44 + RADIUS * 0.62);
    wiper.rotation.z = 0.5 - i * 0.4;
    group.add(wiper);
  }

  // The sail, with its own little window.
  const sail = new THREE.Mesh(new THREE.BoxGeometry(0.9, 1.3, 2.4), paint);
  sail.position.set(0, RADIUS + 0.45, LENGTH * 0.06);
  group.add(sail);
  const sailCap = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, 2.4, 14, 1, false, 0, Math.PI), paint);
  sailCap.rotation.x = Math.PI / 2;
  sailCap.rotation.y = Math.PI / 2;
  sailCap.position.set(0, RADIUS + 1.1, LENGTH * 0.06);
  group.add(sailCap);
  const sailWin = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.3, 0.05), glass);
  sailWin.position.set(0, RADIUS + 0.75, LENGTH * 0.06 + 1.21);
  group.add(sailWin);
  const hatch = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.08, 16), steel);
  hatch.position.set(0, RADIUS + 1.58, LENGTH * 0.06 - 0.4);
  group.add(hatch);

  // Armour: plates in pairs along the flanks.
  for (let i = 0; i < hullLevel * 2; i += 1) {
    const side = i % 2 === 0 ? -1 : 1;
    const k = Math.floor(i / 2);
    const plate = new THREE.Mesh(new THREE.BoxGeometry(0.08, RADIUS * 0.9, 1.1), steel);
    plate.position.set(side * RADIUS * 0.98, 0.05, LENGTH * 0.18 - k * 1.3);
    group.add(plate);
  }

  // Pressure frames: rings round the hull.
  const pressure = lv(upgrades, "pressure");
  const rings = 2 + pressure * 2;
  for (let i = 0; i < rings; i += 1) {
    const z = LENGTH * 0.32 - (i / Math.max(1, rings - 1)) * LENGTH * 0.62;
    const t = 0.5 + z / LENGTH;
    const r = RADIUS * Math.max(0.35, profile(Math.min(1, Math.max(0, t)))) * 1.02;
    const ring = new THREE.Mesh(new THREE.TorusGeometry(r, 0.035 + pressure * 0.012, 6, 28), darkSteel);
    ring.position.z = z;
    group.add(ring);
  }

  // Propulsion: screw, then duct, then pods.
  const thrust = lv(upgrades, "thrust");
  const screw = new THREE.Group();
  screw.position.z = -LENGTH * 0.5 - 0.2;
  const hub = new THREE.Mesh(new THREE.ConeGeometry(0.18, 0.45, 12), steel);
  hub.rotation.x = -Math.PI / 2;
  screw.add(hub);
  const blades = 3 + thrust;
  const bladeLen = 0.55 + thrust * 0.1;
  for (let i = 0; i < blades; i += 1) {
    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.16, bladeLen, 0.03), steel);
    blade.position.y = bladeLen / 2;
    const arm = new THREE.Group();
    arm.rotation.z = (i / blades) * Math.PI * 2;
    blade.rotation.y = 0.5;
    arm.add(blade);
    screw.add(arm);
  }
  group.add(screw);
  if (thrust >= 1) {
    const duct = new THREE.Mesh(new THREE.TorusGeometry(bladeLen + 0.12, 0.09, 8, 28), paint);
    duct.scale.z = 3;
    duct.position.copy(screw.position);
    group.add(duct);
  }
  if (thrust >= 3) {
    for (const side of [-1, 1]) {
      const pod = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.22, 1.4, 14), darkSteel);
      pod.rotation.x = Math.PI / 2;
      pod.position.set(side * (RADIUS + 0.3), -0.35, -LENGTH * 0.34);
      group.add(pod);
    }
  }

  // Cargo pods slung under the hull.
  const cargo = lv(upgrades, "cargo");
  const pods = Math.ceil(cargo / 2);
  for (let i = 0; i < pods; i += 1) {
    for (const side of [-1, 1]) {
      const pod = new THREE.Mesh(new THREE.CapsuleGeometry(0.32, 1.3, 6, 12), paint);
      pod.rotation.x = Math.PI / 2;
      pod.position.set(side * (RADIUS * 0.72), -RADIUS * 0.82, LENGTH * 0.12 - i * 1.9);
      group.add(pod);
    }
  }

  // Cell racks on the deck, lit green.
  const battery = lv(upgrades, "battery");
  for (let i = 0; i < battery; i += 1) {
    const rack = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.22, 0.5), darkSteel);
    rack.position.set(0, RADIUS * 0.97, -LENGTH * 0.12 - i * 0.62);
    group.add(rack);
    const strip = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.04, 0.12), cellGlow);
    strip.position.set(0, RADIUS * 0.97 + 0.12, -LENGTH * 0.12 - i * 0.62);
    group.add(strip);
  }

  // Lamps on the bow: two stock, two more per mark.
  const lights = 2 + lv(upgrades, "lights") * 2;
  for (let i = 0; i < lights; i += 1) {
    const a = -0.9 + (i / Math.max(1, lights - 1)) * 1.8;
    const housing = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.17, 0.25, 12), darkSteel);
    housing.rotation.x = Math.PI / 2;
    const x = Math.sin(a) * RADIUS * 0.85;
    const y = -0.25 + Math.cos(a * 2) * 0.12;
    housing.position.set(x, y, LENGTH * 0.36);
    group.add(housing);
    const face = new THREE.Mesh(new THREE.CircleGeometry(0.12, 12), lamp);
    face.position.set(x, y, LENGTH * 0.36 + 0.13);
    group.add(face);
  }

  // Sonar dome under the chin.
  const sonar = lv(upgrades, "sonar");
  const domeR = 0.3 + sonar * 0.09;
  const sonarDome = new THREE.Mesh(new THREE.SphereGeometry(domeR, 14, 10), darkSteel);
  sonarDome.scale.set(1, 0.6, 1.4);
  sonarDome.position.set(0, -RADIUS * 0.85, LENGTH * 0.3);
  group.add(sonarDome);

  // Capture emitter: a ring on the chin that widens with each mark.
  const capture = lv(upgrades, "capture");
  const emitter = new THREE.Mesh(new THREE.TorusGeometry(0.22 + capture * 0.06, 0.04, 8, 20), mat({ color: 0x0b1d22, emissive: 0x7ee0d0, emissiveIntensity: 1.2 }));
  emitter.position.set(0, -RADIUS * 0.4, LENGTH * 0.43);
  group.add(emitter);

  // Deck gun: the barrel grows with the harpoon's marks.
  const harpoon = lv(upgrades, "harpoon");
  const mount = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.36, 0.3, 14), darkSteel);
  mount.position.set(0, RADIUS + 0.1, LENGTH * 0.28);
  group.add(mount);
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 1 + harpoon * 0.3, 10), steel);
  barrel.rotation.x = Math.PI / 2;
  barrel.position.set(0, RADIUS + 0.28, LENGTH * 0.28 + (1 + harpoon * 0.3) / 2);
  group.add(barrel);

  // Torpedo tube doors either side of the bow.
  const torpedo = lv(upgrades, "torpedo");
  const tubes = torpedo === 0 ? 0 : torpedo < 3 ? 2 : 4;
  for (let i = 0; i < tubes; i += 1) {
    const side = i % 2 === 0 ? -1 : 1;
    const row = Math.floor(i / 2);
    const door = new THREE.Mesh(new THREE.CircleGeometry(0.16, 14), darkSteel);
    door.position.set(side * RADIUS * 0.72, -0.1 - row * 0.38, LENGTH * 0.38);
    door.rotation.y = side * 0.9;
    group.add(door);
  }

  // Net drum aft.
  const net = lv(upgrades, "net");
  if (net > 0) {
    const drum = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.8 + net * 0.15, 16), mat({ color: 0x5a6e3a, roughness: 0.9 }));
    drum.rotation.z = Math.PI / 2;
    drum.position.set(0, RADIUS * 0.95 + 0.3, -LENGTH * 0.3);
    group.add(drum);
  }

  // Repair drone parked on the sail.
  if (lv(upgrades, "repair") > 0) {
    const drone = new THREE.Mesh(new THREE.SphereGeometry(0.22, 12, 8), steel);
    drone.scale.y = 0.6;
    drone.position.set(0.25, RADIUS + 1.7, LENGTH * 0.06 + 0.5);
    group.add(drone);
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 6), mat({ color: 0x100606, emissive: 0xff5040, emissiveIntensity: 2 }));
    eye.position.set(0.25, RADIUS + 1.7, LENGTH * 0.06 + 0.72);
    group.add(eye);
  }

  // Reactor: a glowing core aft of the sail.
  if (lv(upgrades, "reactor") > 0) {
    const core = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 0.5, 16), reactorGlow);
    core.position.set(0, RADIUS * 0.95 + 0.2, -LENGTH * 0.05 - 1.4);
    group.add(core);
    const cage = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.55, 8, 1, true), darkSteel);
    cage.position.copy(core.position);
    group.add(cage);
  }

  // The shock lattice: a lit mesh laid over the hull.
  const lattice = lv(upgrades, "lattice");
  if (lattice > 0) {
    const shell = new THREE.Mesh(
      spindle({ length: LENGTH * 0.8, radius: RADIUS * 1.04, profile, rings: 10 + lattice * 4, segments: 12 + lattice * 4 }),
      latticeGlow,
    );
    latticeGlow.wireframe = true;
    group.add(shell);
  }

  // Everything above the waterline of the moon pool should throw light around.
  group.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; } });
  return { group, screw, materials: mats };
}

/* A plain-language list of what is fitted, for the drydock's placard and
   for tests: which parts buildSubModel will draw for these levels. */
export function fittedParts(upgrades) {
  const parts = [];
  if (lv(upgrades, "hull") > 0) parts.push(`${lv(upgrades, "hull") * 2} armour plates`);
  parts.push(`${2 + lv(upgrades, "pressure") * 2} frame rings`);
  parts.push(`${3 + lv(upgrades, "thrust")}-blade screw${lv(upgrades, "thrust") >= 1 ? " in a duct" : ""}`);
  if (lv(upgrades, "thrust") >= 3) parts.push("side thruster pods");
  if (lv(upgrades, "cargo") > 0) parts.push(`${Math.ceil(lv(upgrades, "cargo") / 2) * 2} cargo pods`);
  if (lv(upgrades, "battery") > 0) parts.push(`${lv(upgrades, "battery")} cell racks`);
  parts.push(`${2 + lv(upgrades, "lights") * 2} lamps`);
  if (lv(upgrades, "torpedo") > 0) parts.push(`${lv(upgrades, "torpedo") < 3 ? 2 : 4} torpedo tubes`);
  if (lv(upgrades, "net") > 0) parts.push("net drum");
  if (lv(upgrades, "repair") > 0) parts.push("repair drone");
  if (lv(upgrades, "reactor") > 0) parts.push("trickle reactor");
  if (lv(upgrades, "scrubber") > 0) parts.push(`${lv(upgrades, "scrubber")} glass wipers`);
  if (lv(upgrades, "lattice") > 0) parts.push("shock lattice");
  return parts;
}
