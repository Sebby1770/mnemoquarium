/* Stick arithmetic shared by the gamepad and the touch joystick.
 *
 * Radial, not per-axis: a per-axis deadzone snaps a diagonal to the nearest
 * axis and makes a slow turn feel notched. Past the deadzone the magnitude is
 * rescaled to start from zero, so there is no jump at the edge, and curved so
 * the first half of the throw is fine aim and the last half is speed.
 *
 * Nothing here touches the DOM or three.js, so it can be tested in node. */

export const DEADZONE = 0.16;

/* Returns [x, y] with magnitude in 0..1. */
export function shapeStick(x, y, deadzone = DEADZONE, exponent = 1.6) {
  const fx = Number(x) || 0;
  const fy = Number(y) || 0;
  const mag = Math.hypot(fx, fy);
  if (mag <= deadzone) return [0, 0];
  const live = Math.min(1, (mag - deadzone) / (1 - deadzone));
  const shaped = Math.pow(live, exponent);
  const k = shaped / mag;
  return [fx * k, fy * k];
}

/* A one-dimensional trigger or axis with the same treatment. */
export function shapeAxis(v, deadzone = DEADZONE, exponent = 1) {
  const f = Number(v) || 0;
  const a = Math.abs(f);
  if (a <= deadzone) return 0;
  const live = Math.min(1, (a - deadzone) / (1 - deadzone));
  return Math.sign(f) * Math.pow(live, exponent);
}

/* Touch joystick: the offset of the thumb from where it first landed, in CSS
   pixels, against the pad's radius. Pushing well past the rim asks for boost,
   the way pushing a keyboard player's Shift does. */
export function thumbVector(dx, dy, radius, boostAt = 1.35) {
  const r = Math.max(1, Number(radius) || 1);
  const raw = Math.hypot(dx, dy) / r;
  const [x, y] = shapeStick(dx / r / Math.max(1, raw), dy / r / Math.max(1, raw), 0.12, 1.25);
  return { x, y, boost: raw >= boostAt, reach: Math.min(1, raw) };
}

/* Edge detection for a set of buttons: which went down, which came up. */
export function edges(prev, next) {
  const down = [];
  const up = [];
  const n = Math.max(prev.length, next.length);
  for (let i = 0; i < n; i += 1) {
    const a = !!prev[i];
    const b = !!next[i];
    if (b && !a) down.push(i);
    else if (a && !b) up.push(i);
  }
  return { down, up };
}
