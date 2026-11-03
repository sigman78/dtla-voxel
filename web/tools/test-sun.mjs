// node tools/test-sun.mjs (Node with TypeScript stripping)
import assert from 'node:assert/strict';
import { dayOfYear, daysInYear, losAngelesDate, sunAt, trueNorthRotation, utcOffset } from '../src/sun.ts';

const rad = Math.PI / 180;
const day = (y, m, d) => dayOfYear(new Date(y, m - 1, d));
const near = (actual, expected, tolerance, label) => assert(Math.abs(actual - expected) < tolerance, `${label}: ${actual} vs ${expected}`);

// Independent NOAA/Meeus reference values generated using main.js calcAzEl,
// with calcRefraction disabled: our sunAt returns geometric, not apparent, elevation.
// https://gml.noaa.gov/grad/solcalc/main.js (retrieved 2026-11-03)
// This viewer retains NOAA's lower-precision fractional-year approximation.
const references = [
  [2026, 3, 20, 9, 107.8304918169, 24.4140918917],
  [2026, 6, 21, 13, 186.3448700566, 79.3306534511],
  [2026, 12, 21, 12, 182.3834629780, 32.4763975625],
  [2026, 11, 3, 16, 243.4705022965, 10.3031221088],
  [2024, 6, 21, 13, 186.2199983928, 79.3310245888],
  [2026, 6, 21, 19.8, 296.6099390562, 2.7672801962],
];
for (const [y, m, d, h, az, el] of references) {
  const actual = sunAt(day(y, m, d), h, y);
  near(actual.az / rad, az, .8, 'NOAA azimuth');
  near(actual.el / rad, el, .6, 'NOAA elevation');
}

// pyproj/PROJ EPSG:32611 at the dataset center: convergence = -0.6988162036267159°.
// Projecting a point 0.001° due north through scripts/aoi.py gives scene bearing 52.6988252274°.
near(trueNorthRotation(52) / rad, 52.6988162036, .00001, 'true north');
near(trueNorthRotation(52, [34.048, -118.248], 'EPSG:4326') / rad, 52, 1e-10, 'non-UTM fallback');
near(trueNorthRotation(0, [34, -117]) / rad, 0, 1e-10, 'UTM central meridian');
assert.equal(daysInYear(2024), 366);
assert.equal(daysInYear(2026), 365);
assert.equal(utcOffset(day(2026, 3, 8), 2026, 1.5), -8);
assert.equal(utcOffset(day(2026, 3, 8), 2026, 3), -7);
assert.equal(utcOffset(day(2026, 11, 1), 2026, .5), -7);
assert.equal(utcOffset(day(2026, 11, 1), 2026, 1.5), -8);
const la = losAngelesDate(new Date('2026-01-01T07:30:00Z'));
assert.deepEqual([la.getFullYear(), la.getMonth() + 1, la.getDate()], [2025, 12, 31]);
console.log('Solar references, true-north projection, leap year, DST and LA calendar passed');
