/* How one real frame becomes simulation time.
 *
 * Every step is at most MAX_DT, so a long frame never teleports the boat
 * through a wall. It used to be clamped to MAX_DT, which made anything under
 * 20 fps run in slow motion — a laptop drawing twelve frames a second played
 * the sea at sixty percent speed. Now a slow frame is cut into several steps
 * instead, up to MAX_STEPS: a hitch (a tab coming back, a GC pause) must not
 * be replayed as a burst of simulation, and on a machine that is slow because
 * of the CPU, more steps would only make the next frame slower still.
 *
 * No three.js here, so it can be tested in node. */

export const MAX_DT = 1 / 20;
export const MAX_STEPS = 4;

export function splitFrame(raw) {
  const t = Number(raw) > 0 ? Math.min(Number(raw), MAX_DT * MAX_STEPS) : 0;
  if (t === 0) return { steps: 1, dt: 0 };
  const steps = Math.max(1, Math.ceil(t / MAX_DT - 1e-9));
  return { steps, dt: t / steps };
}
