/* Large peaceful animals. Pigment and motion weights are built into a single
   geometry per kind, retaining instancing even for tentacles and fin rays. */
import * as THREE from "three";
import { mergeGeometries, spindle, tube } from "./geo.js";

function part(g, color, weight = 0, arm = 0) {
  const flat = g.index ? g.toNonIndexed() : g;
  if (flat !== g) g.dispose();
  const p = flat.attributes.position, count = p.count;
  const colors = new Float32Array(count * 3), weights = new Float32Array(count), arms = new Float32Array(count);
  const c = new THREE.Color();
  for (let i = 0; i < count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    c.setHex(typeof color === "function" ? color(x, y, z) : color);
    c.toArray(colors, i * 3); weights[i] = typeof weight === "function" ? weight(x, y, z) : weight; arms[i] = arm;
  }
  flat.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  flat.setAttribute("aW", new THREE.BufferAttribute(weights, 1));
  flat.setAttribute("aArm", new THREE.BufferAttribute(arms, 1));
  return flat;
}
function merge(parts) {
  const result = mergeGeometries(parts);
  for (const name of ["aW", "aArm"]) {
    const data = new Float32Array(result.attributes.position.count); let at = 0;
    for (const p of parts) { data.set(p.attributes[name].array, at); at += p.attributes.position.count; }
    result.setAttribute(name, new THREE.BufferAttribute(data, 1));
  }
  parts.forEach((p) => p.dispose());
  return result;
}
function ellipsoid(rx, ry, rz, x, y, z, color, weight = 0, arm = 0) {
  const g = new THREE.SphereGeometry(1, 16, 10); g.scale(rx, ry, rz); g.translate(x, y, z);
  return part(g, color, weight, arm);
}
function fin(points, color, weight = 0, arm = 0) {
  const p = [], indices = [];
  for (const point of points) p.push(...point);
  for (let i = 1; i < points.length - 1; i++) indices.push(0, i, i + 1, 0, i + 1, i);
  const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(p, 3)); g.setIndex(indices);
  const flat = g.toNonIndexed(); g.dispose(); flat.computeVertexNormals();
  return part(flat, color, weight, arm);
}
const tailWeight = (x, y, z) => Math.max(0, Math.min(1, (.18 - z) / .73));

export function whaleGeometry(orca = false) {
  const parts = [], dark = orca ? 0x14252e : 0x496773, pale = orca ? 0xe4ecdf : 0xa5b5b5;
  const skin = (x, y, z) => y < -.055 && z > -.3 ? pale : dark;
  const body = spindle({ length: .89, radius: .13, rings: 24, segments: 20, flattenX: .85,
    profile: t => Math.pow(Math.sin(Math.PI * t), .58) * (.68 + .35 * t) });
  body.translate(0, 0, .03); parts.push(part(body, skin, tailWeight));
  parts.push(ellipsoid(.102, .081, .13, 0, -.009, .375, skin, 0));
  for (const side of [-1, 1]) {
    parts.push(fin([[side * .075, -.015, .21], [side * (orca ? .27 : .39), -.05, -.08], [side * .32, -.06, -.15], [side * .095, -.035, .06]],
      orca ? dark : pale, (x) => Math.min(1, Math.abs(x) * 2), side));
    parts.push(fin([[0, 0, -.37], [side * .27, .012, -.49], [side * .24, .002, -.58], [side * .06, 0, -.55], [0, 0, -.51]], dark, 1));
    parts.push(ellipsoid(.012, .014, .018, side * .098, .017, .345, 0x06121a));
    if (orca) parts.push(ellipsoid(.006, .025, .044, side * .102, .035, .3, pale));
    else for (let i = 0; i < 5; i++) {
      const z = .29 - i * .043;
      parts.push(ellipsoid(.008, .008, .009, side * .071, .075, z, 0x7b9298, 0));
    }
  }
  parts.push(fin([[0, .09, -.02], [0, orca ? .35 : .19, -.12], [0, .16, -.17], [0, .065, -.22]], dark, .2));
  // Throat pleats and a quiet mouth seam are modelled instead of texture decals.
  if (!orca) for (let i = -3; i <= 3; i++) {
    const points = [];
    for (let j = 0; j <= 12; j++) {
      const z = .3 - j * .025, t = (z - .03 + .445) / .89;
      const r = .13 * Math.pow(Math.sin(Math.PI * t), .58) * (.68 + .35 * t);
      const x = i * .014;
      const y = -r * Math.sqrt(Math.max(0, 1 - (x / (r * .85)) ** 2)) - .001;
      points.push(new THREE.Vector3(x, y, z));
    }
    parts.push(part(tube(points, { radius: .0013, taper: .6, segments: 12, radial: 3 }), 0x728990, tailWeight));
  }
  return merge(parts);
}

export function squidGeometry() {
  const parts = [], red = 0x9c554c, light = 0xe2b7a0;
  const mantle = spindle({ length: .48, radius: .082, rings: 20, segments: 16 });
  mantle.translate(0, .018, -.22); parts.push(part(mantle, (x, y) => y < 0 ? 0xcb8b74 : red, 0));
  parts.push(ellipsoid(.09, .07, .08, 0, 0, .025, red));
  for (const side of [-1, 1]) {
    parts.push(fin([[0, .014, -.45], [side * .19, .014, -.26], [side * .12, .014, -.16], [0, .014, -.13]], red,
      x => Math.min(1, Math.abs(x) * 5), 12));
    parts.push(ellipsoid(.022, .038, .04, side * .08, .014, .018, light));
    parts.push(ellipsoid(.012, .025, .026, side * .10, .014, .032, 0x10232d));
  }
  for (let i = 0; i < 10; i++) {
    const angle = i * Math.PI * 2 / 10, long = i === 2 || i === 7, length = long ? .83 : .43;
    const points = [];
    for (let j = 0; j <= 10; j++) {
      const t = j / 10, radius = .042 + Math.sin(t * Math.PI * .75) * (long ? .16 : .13);
      points.push(new THREE.Vector3(Math.cos(angle) * radius, Math.sin(angle) * radius, .06 + t * length));
    }
    const weight = (x, y, z) => Math.max(0, (z - .06) / .84);
    parts.push(part(tube(points, { radius: long ? .009 : .014, taper: .12, segments: 20, radial: 5 }), red, weight, i));
    if (long) {
      const p = points.at(-2); parts.push(ellipsoid(.024, .013, .07, p.x, p.y, p.z, light, weight, i));
    }
    // A sparse double row still reads as suckers at playable distances.
    for (let j = 2; j < 9; j += 2) {
      const p = points[j]; parts.push(ellipsoid(.009, .006, .009, p.x * .94, p.y * .94, p.z, light, weight, i));
    }
  }
  return merge(parts);
}

export function serpentGeometry() {
  const parts = [];
  const body = spindle({ length: 1.12, radius: .053, rings: 42, segments: 12,
    profile: t => Math.pow(Math.sin(Math.PI * t), .7) * (.35 + t * .9) });
  parts.push(part(body, (x, y) => y > .015 ? 0x426998 : 0x9bc4ca, tailWeight));
  parts.push(ellipsoid(.063, .051, .087, 0, .003, .51, 0x8cbdc9, 0));
  for (const side of [-1, 1]) {
    parts.push(ellipsoid(.009, .010, .016, side * .057, .023, .54, 0xe7ce8c));
    const horn = [new THREE.Vector3(side * .035, .035, .47), new THREE.Vector3(side * .065, .105, .43), new THREE.Vector3(side * .095, .14, .35)];
    parts.push(part(tube(horn, { radius: .009, taper: .05, segments: 10, radial: 5 }), 0xc8eae3));
    parts.push(fin([[side * .04, 0, .35], [side * .21, .08, .18], [side * .13, -.02, .06], [side * .03, -.02, .18]], 0x64cbbc, .3, side));
  }
  for (let i = 0; i < 16; i++) {
    const z = .39 - i * .06;
    parts.push(fin([[0, .035, z], [0, .12 - i * .003, z - .04], [0, .03, z - .065]], i % 2 ? 0xa2ead9 : 0x5a9fae, tailWeight));
    for (const side of [-1, 1]) parts.push(ellipsoid(.005, .007, .012, side * .048 * (1 - i / 22), .01, z, 0xb6ffdb, tailWeight));
  }
  return merge(parts);
}

export function cathedralGeometry() {
  const parts = [];
  parts.push(ellipsoid(.075, .055, .21, 0, 0, .015, 0x777598));
  for (const side of [-1, 1]) {
    const outline = [[side * .04, 0, .19], [side * .18, .035, .14], [side * .48, .05, -.10], [side * .31, 0, -.12], [side * .16, 0, -.21], [side * .035, 0, -.16]];
    parts.push(fin(outline, 0x60709f, x => Math.min(1, Math.abs(x) * 2), 0));
    for (let i = 0; i < 7; i++) {
      const z = .11 - i * .047, x = side * (.38 - Math.abs(i - 3) * .05);
      parts.push(part(tube([new THREE.Vector3(side * .05, .009, z + .045), new THREE.Vector3(x * .6, .02, z), new THREE.Vector3(x, .025, z - .07)],
        { radius: .003, taper: .4, segments: 8, radial: 3 }), 0x9de2e1, x => Math.min(1, Math.abs(x) * 2), 0));
    }
    parts.push(ellipsoid(.009, .012, .013, side * .042, .034, .16, 0xf0da91));
  }
  for (let i = -2; i <= 2; i++) {
    const x = i * .022;
    parts.push(part(tube([new THREE.Vector3(x, .045, .12), new THREE.Vector3(x * 1.4, .12 + (2 - Math.abs(i)) * .023, .04), new THREE.Vector3(x * 2, .1, -.05)],
      { radius: .007, taper: .12, segments: 10, radial: 5 }), 0xa9cfe2, .15, 1));
  }
  for (const side of [-1, 1]) parts.push(part(tube([new THREE.Vector3(side * .03, 0, -.17), new THREE.Vector3(side * .055, -.04, -.36), new THREE.Vector3(side * .09, -.025, -.63)],
    { radius: .012, taper: .06, segments: 24, radial: 4 }), 0xa1d4e7, (x, y, z) => Math.max(0, -z), 1));
  return merge(parts);
}

export const GIANT_MOTION = {
  humpback: `float w=aW*aW; transformed.y+=sin(uTime*.85+aPhase+position.z*3.)*w*.065;
    if(abs(aArm)>.5) transformed.y+=sin(uTime*.65+aPhase)*aW*.045;`,
  orca: `float w=aW*aW; transformed.y+=sin(uTime*1.35+aPhase+position.z*3.)*w*.075;
    if(abs(aArm)>.5) transformed.y+=sin(uTime+aPhase)*aW*.035;`,
  giantsquid: `if(aArm>11.){transformed.y+=sin(uTime*1.9+aPhase+aW*3.)*aW*.035;}
    else {float w=aW*aW; transformed.x+=sin(uTime*1.6+aPhase+aArm*1.1-aW*5.)*w*.12; transformed.y+=cos(uTime*1.4+aPhase+aArm-aW*5.)*w*.12;}`,
  glassserpent: `float w=clamp((.45-position.z)/1.1,0.,1.); transformed.x+=sin(uTime*1.1+aPhase+w*7.)*w*.10; transformed.y+=sin(uTime*.65+aPhase+w*5.)*w*.03;`,
  cathedralray: `float w=aW*aW; if(aArm<.5){transformed.y+=sin(uTime*.65+aPhase-aW*2.)*w*.13;} else {transformed.x+=sin(uTime+aPhase+aW*5.)*aW*.04;}`,
};

const skin = { color: 0xffffff, vertexColors: true, roughness: .7, metalness: .03 };
export const GIANTS = {
  humpback: { name: "Humpback Whale", count: 2, depth: [12, 230], size: [13, 19], speed: 2.7, pay: 140,
    clearance: .18, pod: true, motion: "whale", build: () => whaleGeometry(false), material: skin, colours: [0xffffff],
    hint: "A travelling pair in open shelf and kelp water. Give their long flippers room; calves follow the larger whale.",
    line: "a humpback and its companion cross the light, flukes rising in slow unison." },
  orca: { name: "Orca", count: 3, depth: [8, 190], size: [5.5, 8], speed: 4.2, pay: 110,
    clearance: .22, pod: true, motion: "whale", build: () => whaleGeometry(true), material: skin, colours: [0xffffff],
    hint: "A fast-moving pod above the kelp. The tall dorsal and white eye patch distinguish them from sharks.",
    line: "three black-and-white shapes turn together: the pod has its own destination." },
  giantsquid: { name: "Giant Squid", count: 2, depth: [190, 900], size: [13, 19], speed: 1.7, pay: 230,
    clearance: .20, motion: "jet", build: squidGeometry, material: skin, colours: [0xffffff],
    hint: "Search the twilight water. Ten arms trail a copper mantle; approach too closely and it jets away in ink.",
    line: "a giant squid unfurls two impossibly long feeding tentacles, then vanishes behind its ink." },
  glassserpent: { name: "Glass Serpent", count: 1, depth: [480, 1450], size: [23, 32], speed: 2.4, pay: 360,
    clearance: .2, rare: true, motion: "serpent", build: serpentGeometry,
    material: { ...skin, emissive: 0x366e87, emissiveIntensity: .45 }, colours: [0xffffff],
    hint: "A rare blue ribbon beyond the twilight shelf. Antlers and a luminous dorsal crest mark this gentle deep-water myth.",
    line: "antlers catch the lamplight. the glass serpent folds the dark around a body longer than your boat." },
  cathedralray: { name: "Cathedral Ray", count: 1, depth: [760, 1560], size: [17, 24], speed: 1.7, pay: 420,
    clearance: .24, rare: true, motion: "ray", build: cathedralGeometry,
    material: { ...skin, emissive: 0x46577c, emissiveIntensity: .4, side: THREE.DoubleSide }, colours: [0xffffff],
    hint: "An abyssal rarity with branching luminous wings, a crown of spires and twin trailing ribbons. Watch the open water above the floor.",
    line: "the cathedral ray passes overhead: a crown, two vaulted wings, and a blue light of its own." },
};
