/* Workshop fittings and wayfinding for the Hull. Batched by material. */
import * as THREE from "three";
import { InteriorKit } from "./interior.js";
import { disposeTree } from "./geo.js";

export class DockDetail {
  constructor(base) {
    this.group = new THREE.Group(); this.group.name = "dock-workshop";
    base.scene.add(this.group);
    const k = this.kit = new InteriorKit(this.group, base.boxes);
    const navy = k.material(0x132e3e, .4, .55), steel = k.material(0x728a90, .5, .48);
    const pale = k.material(0xb9c4b7, .15), orange = k.material(0xc98b49, .3);
    const rubber = k.material(0x17282c, .05), copper = k.material(0x875c43, .6);
    const cyan = k.material(0x68dccd, .1, .6, 0x29877c);
    const warm = k.material(0xf0cb8e, .1, .5, 0xa77c3a);
    // Big, deliberately quiet signs replace the anonymous hangar walls.
    k.sign("THE HULL", "PELAGIC RESEARCH / TENDER STATION 07", 8.5, 0, 6.1, 10.9, Math.PI);
    k.sign("01 / ARRIVALS", "MOON POOL / PRESSURE LOCK", 4, -8.6, 3.3, 10.9, Math.PI);
    k.sign("02 / WORKSHOP", "MODULAR REFITS / COMPONENT SERVICE", 4, 12.9, 5.65, -.4, -Math.PI / 2, "#efc183");
    k.sign("03 / OBSERVATORY", "SPECIMEN ARCHIVE / FIELD RESEARCH", 4.5, 0, 4.65, -10.93);
    k.sign("MARKET / STORES", "SELL SPECIMENS / RESUPPLY", 3.5, -12.9, 3.1, -8.6, Math.PI / 2);
    // Framed wall bases and illuminated strips give the huge room a human scale.
    for (const side of [-1, 1]) {
      k.box(.14, .9, 21.8, navy, side * 12.92, .45, 0);
      k.box(.025, .06, 21.7, cyan, side * 12.82, .97, 0);
      for (const z of [-9.6, -2.8, 3, 9.6]) {
        k.box(.2, 3, .62, navy, side * 12.7, 2.5, z);
        k.box(.035, 2.2, .11, warm, side * 12.57, 2.5, z);
      }
    }
    // Guide lines follow safe walking lanes outside the moon pool.
    for (const z of [-4.65, 4.65]) for (let x = -10; x <= 10; x += .8) k.box(.42, .014, .065, cyan, x, .025, z);
    for (const x of [-8.25, 8.25]) for (let z = -9.5; z <= 9.5; z += .8) k.box(.065, .014, .42, orange, x, .026, z);
    for (let z = -10.5; z > -16; z -= .7) k.box(.07, .014, .38, cyan, 0, .025, z);
    // Service bench with drawers, tools, spare pressure rings and a vise.
    k.box(1.15, .95, 4.4, navy, 11.95, .48, .3, true);
    k.box(1.3, .09, 4.55, steel, 11.9, .99, .3);
    for (let i = 0; i < 5; i++) {
      const z = -1.5 + i * .85;
      for (const y of [.35, .7]) {
        k.box(.035, .27, .72, pale, 11.35, y, z);
        k.box(.07, .04, .24, copper, 11.3, y + .04, z);
      }
      k.line([12.84, 1.9, z], [12.84, 2.45, z + .14], .025, steel);
      k.ring(.09, .023, orange, 12.83, 2.43, z + .14, [0, Math.PI / 2, 0]);
    }
    k.box(.25, .17, .35, steel, 11.7, 1.11, -.9);
    k.cylinder(.025, .4, copper, 11.54, 1.11, -.9, [0, 0, Math.PI / 2]);
    for (const z of [1.7, 2.35]) {
      k.ring(.52, .065, steel, 12.55, 1.82, z, [0, Math.PI / 2, 0]);
      k.ring(.41, .018, orange, 12.52, 1.82, z, [0, Math.PI / 2, 0]);
    }
    // Spare thruster on a wheeled trolley, away from all interaction routes.
    k.box(1.55, .16, 1.4, navy, 10.7, .24, 5.45, true);
    for (const x of [10.15, 11.25]) for (const z of [4.95, 5.95]) k.cylinder(.14, .1, rubber, x, .14, z, [0, 0, Math.PI / 2]);
    k.cylinder(.42, .9, steel, 10.7, .72, 5.45, [Math.PI / 2, 0, 0]);
    k.ring(.42, .05, orange, 10.7, .72, 5.94);
    for (let i = 0; i < 5; i++) {
      const a = i * Math.PI * 2 / 5;
      k.box(.13, .66, .05, copper, 10.7, .72, 5.96, false, [0, 0, a]);
    }
    // Filled stores: oxygen bottles, stacked supply racks and coil hoses.
    k.box(1.8, .14, 3.4, navy, -11.8, .14, 1.0, true);
    for (const z of [0, 1, 2]) for (const x of [-12.25, -11.45]) {
      k.cylinder(.22, 1.35, pale, x, .92, z);
      k.cylinder(.10, .18, copper, x, 1.68, z);
      k.ring(.24, .035, orange, x, .65, z, [Math.PI / 2, 0, 0]);
      k.ring(.11, .022, cyan, x, 1.8, z, [Math.PI / 2, 0, 0]);
    }
    k.sign("LIFE SUPPORT", "OXYGEN / REGULATED SUPPLY", 2.2, -12.88, 2.65, 1, Math.PI / 2);
    for (const z of [4.9, 5.35, 5.8]) k.ring(.46, .05, copper, -12.7, 1.1, z, [0, Math.PI / 2, 0]);
    // Overhead truss braces and real cable geometry anchored to the gantry.
    for (const z of [-3.6, 3.6]) {
      for (let x = -7; x < 7; x += 1.4) {
        k.line([x, 7.5, z], [x + .7, 8.15, z], .035, steel);
        k.line([x + .7, 8.15, z], [x + 1.4, 7.5, z], .035, steel);
      }
      k.box(14.8, .07, .1, steel, 0, 8.15, z);
      k.box(13.5, .035, .12, cyan, 0, 7.15, z);
    }
    // Pool docking clamps and mooring bollards remain behind the railing.
    for (const x of [-4.7, 4.7]) for (const z of [-2.5, 2.5]) {
      k.box(.8, .4, .65, navy, x, .2, z);
      k.cylinder(.14, .65, steel, x, .54, z);
      k.box(.5, .12, .16, orange, x, .83, z);
    }
    // Observatory furnishings: readable map, a small briefing table, seating.
    k.sign("THE LIVING DEEP", "OBSERVE / DOCUMENT / RETURN", 4.4, 0, 3.62, -19.92);
    k.sign("SHELF → KELP → ABYSS", "GIANTS FOLLOW THE OPEN WATER", 3.3, -5.93, 2.65, -15.4, Math.PI / 2);
    k.box(1.35, .07, 1, pale, -3.6, .96, -13.4);
    for (const z of [-12.6, -14.3]) {
      k.box(.63, .14, .55, orange, -3.6, .55, z, true);
      for (const x of [-3.82, -3.38]) k.cylinder(.028, .5, steel, x, .25, z);
    }
    for (let i = 0; i < 3; i++) k.box(.36, .05, .48, i === 1 ? orange : navy, -3.65, 1.03 + i * .05, -13.45);
    k.cylinder(.07, .13, pale, -3.19, 1.065, -13.32);
    k.sign("FIELD ARCHIVE", "FIRST SIGHTINGS FUND THE NEXT DIVE", 2.4, 5.91, 2.65, -15.4, -Math.PI / 2);
    // Observatory interaction is separate from the trade terminals.
    base.items.push({ id: "research", label: "Marine field guide · habitats & sightings", x: -4.7, z: -15.4, reach: 2.3 });
    k.finish();
  }
  dispose() { disposeTree(this.group); this.kit.disposeTextures(); }
}
