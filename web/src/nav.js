/* Navigation arithmetic shared by the compass tape and the sea chart.
   Bearings are degrees clockwise from north, and north is -Z, because three.js
   looks down -Z and the compass has always called that the way ahead.

   Nothing here touches three.js, so it can be tested without a GPU. */

export const COMPASS_POINTS = [
  "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
  "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW",
];

/* How vague a place you have not been to is on the chart, in metres. Larger
   than the distance that counts as having found it, so a rumour still has to
   be searched. */
export const RUMOUR_RADIUS = 170;

export function bearingOf(x, z) {
  return (Math.atan2(x, -z) * 180 / Math.PI + 360) % 360;
}

export function compassPoint(deg) {
  const i = Math.round(((deg % 360) + 360) % 360 / 22.5) % 16;
  return COMPASS_POINTS[i];
}

export function formatRange(metres) {
  const m = Math.max(0, Number(metres) || 0);
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;
}

/* Where the rumour of a place is drawn: a fixed offset from the truth, taken
   from the landmark's own seed so it does not wander between openings, and
   never so far that the real spot falls outside the circle. */
export function rumourCentre(landmark) {
  const seed = Number(landmark.seed) >>> 0;
  const a = ((seed % 3600) / 3600) * Math.PI * 2;
  const r = RUMOUR_RADIUS * (0.25 + (((seed >>> 12) % 1000) / 1000) * 0.5);
  return {
    x: landmark.position.x + Math.cos(a) * r,
    z: landmark.position.z + Math.sin(a) * r,
    radius: RUMOUR_RADIUS,
  };
}
