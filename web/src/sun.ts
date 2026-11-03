// Downtown Los Angeles, America/Los_Angeles: UTC-8, UTC-7 from the 2nd Sunday of March to the 1st Sunday of November
const RAD = Math.PI / 180, LAT = 34.048 * RAD, LON = -118.248;
const laCalendar = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric', month: 'numeric', day: 'numeric' });
// A calendar date in LA, even when the viewer's computer is in another time zone.
export function losAngelesDate(now = new Date()) {
  const parts = Object.fromEntries(laCalendar.formatToParts(now).map(p => [p.type, p.value]));
  return new Date(+parts.year, +parts.month - 1, +parts.day);
}
export const SOLAR_YEAR = losAngelesDate().getFullYear();
export const daysInYear = (year = SOLAR_YEAR) => (Date.UTC(year + 1, 0, 1) - Date.UTC(year, 0, 1)) / 864e5;

// day of the month of the n-th Sunday of a month (month 0-based)
const nthSunday = (year: number, month: number, n: number) => { const first = new Date(Date.UTC(year, month, 1)).getUTCDay(); return 1 + (7 - first) % 7 + 7 * (n - 1); };
export const dayOfYear = (d: Date) => Math.round((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - Date.UTC(d.getFullYear(), 0, 0)) / 864e5);
export const dateOf = (day: number, year = SOLAR_YEAR) => new Date(year, 0, day);

export function utcOffset(day: number, year = SOLAR_YEAR, hour = 12) {
  const start = dayOfYear(new Date(year, 2, nthSunday(year, 2, 2))), end = dayOfYear(new Date(year, 10, nthSunday(year, 10, 1)));
  // The repeated fall-back hour uses standard time; nonexistent spring 02:xx uses DST.
  return (day > start || (day === start && hour >= 2)) && (day < end || (day === end && hour < 1)) ? -7 : -8;
}

// NOAA low-precision declination and equation of time; hour is local clock time
export function sunAt(day: number, hour: number, year = SOLAR_YEAR) {
  const g = 2 * Math.PI / daysInYear(year) * (day - 1 + (hour - 12) / 24);
  const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g)
    - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const eot = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const solar = hour - utcOffset(day, year, hour) + LON / 15 + eot / 60;
  const H = (solar - 12) * 15 * RAD;
  const el = Math.asin(Math.sin(LAT) * Math.sin(decl) + Math.cos(LAT) * Math.cos(decl) * Math.cos(H));
  const az = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(LAT) - Math.tan(decl) * Math.cos(LAT)) + Math.PI;
  return { el, az };
}

// UTM grid north is not true north. At DTLA the convergence is about -0.698816°.
// Spherical transverse-Mercator convergence agrees with PROJ here to <0.00001°.
export function trueNorthRotation(thetaDeg: number, center: [number, number] = [34.048, -118.248], crs = 'EPSG:32611') {
  const utm = /^EPSG:32[67](\d{2})$/.exec(crs);
  const zone = utm ? +utm[1] : 0;
  const convergence = zone >= 1 && zone <= 60
    ? Math.atan(Math.tan((center[1] - (zone * 6 - 183)) * RAD) * Math.sin(center[0] * RAD)) : 0;
  // The pipeline rotates east/north into (u,v), then scene z = -v.
  return thetaDeg * RAD - convergence;
}

const elDeg = (day: number, h: number) => sunAt(day, h).el / RAD;

export function solarNoon(day: number) {
  let lo = 9, hi = 16;
  for (let i = 0; i < 30; i++) { const m = (lo + hi) / 2; if (elDeg(day, m + 1e-3) > elDeg(day, m)) lo = m; else hi = m; }
  return lo;
}

// the hour the sun is at `deg` elevation, in the morning or the evening
export function hourAt(day: number, deg: number, evening: boolean) {
  const noon = solarNoon(day);
  let lo = evening ? noon : noon - 12, hi = evening ? noon + 12 : noon;
  for (let i = 0; i < 30; i++) {
    const m = (lo + hi) / 2, above = elDeg(day, m) > deg;
    if (above === evening) lo = m; else hi = m;
  }
  return (lo + hi) / 2;
}

// Clear-sky transmittance of the direct beam at 610, 550, 465 nm: Rayleigh (Bucholtz), a hazier basin than Warsaw's
// (Ångström β 0.08, α 1.3), ozone (Chappuis band); Kasten-Young air mass
const TAU = [0.248, 0.309, 0.42];
export const airMass = (elDeg: number) => { const h = Math.max(elDeg, -0.5); return 1 / (Math.sin(h * RAD) + 0.50572 * (h + 6.07995) ** -1.6364); };
export const beam = (elDeg: number) => TAU.map((t) => Math.exp(-airMass(elDeg) * t)) as [number, number, number];
