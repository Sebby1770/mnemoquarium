/* On foot, inside the Hull: the two rules that make walking feel solid.
 *
 * The body is a circle on the floor plane and the room is a list of
 * axis-aligned boxes (walls, railings, consoles, the edge of the moon pool).
 * Resolving a move pushes the circle out of every box it overlaps along the
 * shortest way out, which is what lets you slide along a wall instead of
 * sticking to it.
 *
 * Nothing here touches three.js, so it can be tested without a GPU. */

/* boxes: [{ minX, maxX, minZ, maxZ }]. Returns the resolved [x, z]. */
export function resolveCircle(x, z, radius, boxes) {
  let px = x;
  let pz = z;
  // Two passes settle corners, where pushing out of one box pushes into the next.
  for (let pass = 0; pass < 2; pass += 1) {
    for (const b of boxes) {
      const cx = Math.max(b.minX, Math.min(px, b.maxX));
      const cz = Math.max(b.minZ, Math.min(pz, b.maxZ));
      const dx = px - cx;
      const dz = pz - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 >= radius * radius) continue;
      if (d2 > 1e-10) {
        // Outside the box but touching it: push straight away from the nearest point.
        const d = Math.sqrt(d2);
        px = cx + (dx / d) * radius;
        pz = cz + (dz / d) * radius;
      } else {
        // The centre is inside the box: leave by the nearest face.
        const left = px - b.minX;
        const right = b.maxX - px;
        const back = pz - b.minZ;
        const front = b.maxZ - pz;
        const m = Math.min(left, right, back, front);
        if (m === left) px = b.minX - radius;
        else if (m === right) px = b.maxX + radius;
        else if (m === back) pz = b.minZ - radius;
        else pz = b.maxZ + radius;
      }
    }
  }
  return [px, pz];
}

/* What the player would use if they pressed E: the nearest thing in reach
   that they are more or less looking at. (fx, fz) is the flat facing vector.
   items: [{ x, z, reach? }]. Returns the item or null. */
export function pickInteractable(px, pz, fx, fz, items, reach = 2.6, cone = 0.55) {
  const fl = Math.hypot(fx, fz) || 1;
  const ux = fx / fl;
  const uz = fz / fl;
  let best = null;
  let bestScore = -Infinity;
  for (const item of items) {
    const dx = item.x - px;
    const dz = item.z - pz;
    const d = Math.hypot(dx, dz);
    const r = item.reach || reach;
    if (d > r) continue;
    // Standing on top of it counts as looking at it.
    const facing = d < 0.3 ? 1 : (dx * ux + dz * uz) / d;
    if (facing < cone) continue;
    const score = facing * 2 - d / r;
    if (score > bestScore) {
      bestScore = score;
      best = item;
    }
  }
  return best;
}
