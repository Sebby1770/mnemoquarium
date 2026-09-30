/* The colour grade, as numbers and as a curve, with no three.js in it.
 *
 * Contrast used to be applied as (c - 0.5) * k + 0.5 to the tone-mapped
 * picture while it was still linear. Linear 0.5 is sRGB 188, so every value
 * darker than about sRGB 70 was pushed below zero and clipped: open water
 * past a hundred metres, the lamp-lit floor past six hundred and every
 * floodlight beam rendered as pure black, and the only thing left on screen
 * was the unlit marine snow. The deep looked empty because the grade was
 * erasing it.
 *
 * Now the curve runs in display space, after the sRGB conversion, and it is
 * an S-curve that keeps its end points: black stays black, white stays white,
 * and nothing between them can fall off either end. The same curve is written
 * twice here — once in JS for the tests, once in GLSL for the composite — so
 * the two cannot drift apart without a test noticing. */

/* How each band is graded. The shelf is saturated and punchy; the deep bands
   get *less* contrast, not more, because nearly everything down there lives
   in the bottom tenth of the range, and a tinted lift so the blacks read as
   ink-blue water rather than a dead screen. Lift is in display units. */
export const GRADE = {
  air: { saturation: 1.08, contrast: 1.06, bloom: 0.55, lift: 0.0, tint: [1.0, 1.0, 1.0] },
  shelf: { saturation: 1.18, contrast: 1.12, bloom: 0.7, lift: 0.0, tint: [0.55, 0.85, 1.0] },
  kelp: { saturation: 1.12, contrast: 1.1, bloom: 0.75, lift: 0.006, tint: [0.3, 0.8, 0.75] },
  twilight: { saturation: 1.04, contrast: 1.06, bloom: 0.9, lift: 0.014, tint: [0.18, 0.42, 1.0] },
  midnight: { saturation: 0.98, contrast: 1.04, bloom: 1.05, lift: 0.019, tint: [0.2, 0.3, 1.0] },
  abyss: { saturation: 0.95, contrast: 1.03, bloom: 1.15, lift: 0.022, tint: [0.38, 0.26, 1.0] },
  // Inside the Hull: dry air, work lamps, and paint that should look like paint.
  base: { saturation: 1.0, contrast: 1.06, bloom: 0.28, lift: 0.0, tint: [1.0, 1.0, 1.0] },
};

/* The contrast knob maps onto how much of a smoothstep is blended in. A
   blend of k has a slope of 1 + k/2 at mid-grey, so k = 2(contrast - 1)
   gives the same mid-tone punch the old linear contrast promised, and it is
   capped at 1 so the curve can never fold back on itself. */
export function curveAmount(contrast) {
  return Math.min(1, Math.max(0, 2 * (contrast - 1)));
}

/* Display-space S-curve plus tinted lift for one channel. d and the result
   are in [0, 1]; tint is that channel's share of the lift colour. */
export function gradeCurve(d, contrast, lift = 0, tint = 1) {
  const x = Math.min(1, Math.max(0, d));
  const k = curveAmount(contrast);
  const s = x * x * (3 - 2 * x);
  const c = x + (s - x) * k;
  return c + lift * tint * (1 - c);
}

/* The same curve for the composite shader. Expects uContrast, uLift and
   uLiftTint to be declared by the caller. */
export const GRADE_GLSL = /* glsl */ `
  vec3 gradeCurve(vec3 d) {
    d = clamp(d, 0.0, 1.0);
    float k = clamp(2.0 * (uContrast - 1.0), 0.0, 1.0);
    d = mix(d, d * d * (3.0 - 2.0 * d), k);
    return d + uLift * uLiftTint * (1.0 - d);
  }`;
