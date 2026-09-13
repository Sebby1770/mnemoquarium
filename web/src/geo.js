/* Procedural geometry helpers. three.js addons are not vendored, so anything
   the examples folder would normally hand us (mergeGeometries, in particular)
   lives here instead, written against core BufferGeometry only. */

import * as THREE from "three";

/* Merge a list of already-transformed geometries into one. Everything is
   flattened to non-indexed first: fish and monsters are low-poly enough that
   the extra vertices cost nothing, and it removes every index-offset bug. */
export function mergeGeometries(geometries) {
  const parts = [];
  for (const g of geometries) {
    if (!g || !g.attributes || !g.attributes.position) continue;
    const flat = g.index ? g.toNonIndexed() : g;
    if (!flat.attributes.normal) flat.computeVertexNormals();
    parts.push({ flat, owned: flat !== g });
  }
  if (!parts.length) return new THREE.BufferGeometry();

  let total = 0;
  for (const { flat } of parts) total += flat.attributes.position.count;

  const position = new Float32Array(total * 3);
  const normal = new Float32Array(total * 3);
  const uv = new Float32Array(total * 2);

  let cursor = 0;
  for (const { flat, owned } of parts) {
    const p = flat.attributes.position;
    const n = flat.attributes.normal;
    const t = flat.attributes.uv;
    position.set(p.array.subarray(0, p.count * 3), cursor * 3);
    if (n) normal.set(n.array.subarray(0, n.count * 3), cursor * 3);
    if (t) uv.set(t.array.subarray(0, t.count * 2), cursor * 2);
    cursor += p.count;
    // Only dispose the copies we made; the caller still owns its originals.
    if (owned) flat.dispose();
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.BufferAttribute(position, 3));
  out.setAttribute("normal", new THREE.BufferAttribute(normal, 3));
  out.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  out.computeBoundingSphere();
  return out;
}

/* A body of revolution around +Z. `profile(t)` returns the radius at t in
   0..1 along the length; the result is centred on the origin and one unit of
   `length` is one metre. flatten squashes it laterally, which is the whole
   difference between an eel and an angelfish. */
export function spindle(opts) {
  const {
    length = 1,
    radius = 0.18,
    profile = (t) => Math.sin(Math.PI * t),
    rings = 14,
    segments = 10,
    flattenX = 1,
    flattenY = 1,
  } = opts || {};

  const points = [];
  for (let i = 0; i <= rings; i += 1) {
    const t = i / rings;
    // Lathe hates a zero radius at the ends (degenerate normals), so pin a
    // sliver of width on the nose and tail.
    const r = Math.max(0.0035, radius * profile(t));
    points.push(new THREE.Vector2(r, (t - 0.5) * length));
  }

  const g = new THREE.LatheGeometry(points, segments);
  // Lathe builds around +Y; the whole game points things down +Z.
  g.rotateX(Math.PI / 2);
  g.scale(flattenX, flattenY, 1);
  g.computeVertexNormals();
  return g;
}

/* A flat fin or blade in the XZ plane, pointing down -Z from the origin, with
   a little thickness so it catches the lamps from the side. */
export function blade(opts) {
  const {
    length = 0.4,
    width = 0.3,
    taper = 0.25,
    sweep = 0.2,
    thickness = 0.012,
  } = opts || {};

  const shape = [
    [0, 0],
    [width * 0.5, -length * sweep],
    [width * 0.5 * taper, -length],
    [-width * 0.5 * taper, -length],
    [-width * 0.5, -length * sweep],
  ];

  const verts = [];
  const push = (x, z, y) => verts.push(x, y, z);
  // Two fans, one per face, so the fin is solid from both sides.
  for (const dir of [1, -1]) {
    const y = thickness * 0.5 * dir;
    for (let i = 1; i < shape.length - 1; i += 1) {
      const a = shape[0];
      const b = dir > 0 ? shape[i] : shape[i + 1];
      const c = dir > 0 ? shape[i + 1] : shape[i];
      push(a[0], a[1], y);
      push(b[0], b[1], y);
      push(c[0], c[1], y);
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
  g.computeVertexNormals();
  return g;
}

/* A tapering tube along a curve — tentacles, serpent bodies, kelp stalks. */
export function tube(points, opts) {
  const { radius = 0.1, taper = 0.2, segments = 18, radial = 6 } = opts || {};
  const curve = new THREE.CatmullRomCurve3(points);
  const g = new THREE.TubeGeometry(curve, segments, radius, radial, false);
  // TubeGeometry has a constant radius, so taper it by hand along its length.
  const pos = g.attributes.position;
  const count = pos.count;
  const perRing = radial + 1;
  for (let i = 0; i < count; i += 1) {
    const ring = Math.floor(i / perRing);
    const t = ring / Math.max(1, segments);
    const scale = 1 - (1 - taper) * t;
    const centre = curve.getPointAt(Math.min(1, t));
    pos.setXYZ(
      i,
      centre.x + (pos.getX(i) - centre.x) * scale,
      centre.y + (pos.getY(i) - centre.y) * scale,
      centre.z + (pos.getZ(i) - centre.z) * scale,
    );
  }
  g.computeVertexNormals();
  return g;
}

/* Dispose everything hanging off an object3D subtree. Every manager calls this
   from its own dispose(); geometries and materials are not garbage collected. */
export function disposeTree(root) {
  if (!root) return;
  root.traverse((node) => {
    if (node.geometry) node.geometry.dispose();
    const material = node.material;
    if (!material) return;
    if (Array.isArray(material)) material.forEach((m) => m && m.dispose());
    else material.dispose();
  });
  if (root.parent) root.parent.remove(root);
}
