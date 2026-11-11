// Fetches real road routes (OSRM, OpenStreetMap) and SRTM 30 m elevations (OpenTopoData)
// for every leg the planner needs, and writes data/routes.json.
// Run once: node scripts/fetch_routes.mjs   (takes ~3 min; respects the public APIs' 1 req/s limits)
import { writeFileSync } from 'node:fs';

export const PLACES = {
  gate:      { name: 'Port of Oakland gate (Maritime St & 7th St)', kind: 'gate',     ll: [37.8045, -122.3095] },
  depot:     { name: 'Depot, West Oakland',                          kind: 'depot',    ll: [37.8010, -122.3045] },
  OICT:      { name: 'OICT (Berths 55-59)',                          kind: 'terminal', ll: [37.7955, -122.3179] },
  TraPac:    { name: 'TraPac (Berths 25-33)',                        kind: 'terminal', ll: [37.8070, -122.3240] },
  Everport:  { name: 'Everport (Berths 35-38)',                      kind: 'terminal', ll: [37.8005, -122.3330] },
  Matson:    { name: 'Matson (Berths 60-63)',                        kind: 'terminal', ll: [37.7985, -122.3060] },
  SanLeandro:{ name: 'San Leandro',     kind: 'dc', ll: [37.7120, -122.1890] },
  Hayward:   { name: 'Hayward',         kind: 'dc', ll: [37.6290, -122.1100] },
  UnionCity: { name: 'Union City',      kind: 'dc', ll: [37.5960, -122.0670] },
  Newark:    { name: 'Newark',          kind: 'dc', ll: [37.5150, -122.0100] },
  Richmond:  { name: 'Richmond',        kind: 'dc', ll: [37.9550, -122.3570] },
  Livermore: { name: 'Livermore',       kind: 'dc', ll: [37.7000, -121.8150] },
  Fairfield: { name: 'Fairfield',       kind: 'dc', ll: [38.2350, -122.0800] },
  Tracy:     { name: 'Tracy',           kind: 'dc', ll: [37.7380, -121.4700] },
  Lathrop:   { name: 'Lathrop',         kind: 'dc', ll: [37.8000, -121.2900] },
  Stockton:  { name: 'Stockton',        kind: 'dc', ll: [37.8930, -121.2290] },
  WestSac:   { name: 'West Sacramento', kind: 'dc', ll: [38.5600, -121.5450] },
  Patterson: { name: 'Patterson',       kind: 'dc', ll: [37.4650, -121.1550] },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const STEP_M = 250; // resample spacing for elevation

async function osrm(a, b) {
  const [la1, lo1] = PLACES[a].ll, [la2, lo2] = PLACES[b].ll;
  const u = `https://router.project-osrm.org/route/v1/driving/${lo1},${la1};${lo2},${la2}?overview=full&geometries=geojson&annotations=distance,duration`;
  for (let t = 0; t < 5; t++) {
    const r = await fetch(u);
    if (r.ok) { const j = await r.json(); if (j.code === 'Ok') return j.routes[0]; }
    await sleep(2000);
  }
  throw new Error('osrm failed ' + a + '->' + b);
}

async function elev(points) {
  const out = [];
  for (let i = 0; i < points.length; i += 100) {
    const chunk = points.slice(i, i + 100);
    const u = 'https://api.opentopodata.org/v1/srtm30m?locations=' + chunk.map(([la, lo]) => `${la.toFixed(5)},${lo.toFixed(5)}`).join('|');
    let j;
    for (let t = 0; t < 6; t++) {
      const r = await fetch(u);
      if (r.ok) { j = await r.json(); if (j.status === 'OK') break; }
      await sleep(2500);
    }
    if (!j || j.status !== 'OK') throw new Error('elevation failed');
    out.push(...j.results.map((x) => x.elevation ?? 0));
    await sleep(1100);
  }
  return out;
}

// Resample the OSRM polyline into ~STEP_M chunks: for each chunk keep distance (m),
// free-flow duration (s, OSRM car profile) and the end coordinate.
function resample(route) {
  const coords = route.geometry.coordinates; // [lon, lat]
  const ann = route.legs[0].annotation;
  const segs = [];
  let acc = { d: 0, t: 0 };
  for (let i = 0; i < ann.distance.length; i++) {
    acc.d += ann.distance[i]; acc.t += ann.duration[i];
    if (acc.d >= STEP_M || i === ann.distance.length - 1) {
      const [lo, la] = coords[i + 1];
      segs.push({ d: acc.d, t: acc.t, ll: [la, lo] });
      acc = { d: 0, t: 0 };
    }
  }
  return segs;
}

const LEGS = [];
for (const k of Object.keys(PLACES)) {
  if (k === 'gate') continue;
  LEGS.push(['gate', k], [k, 'gate']);
}

const routes = {};
const [la0, lo0] = PLACES.gate.ll;
for (const [a, b] of LEGS) {
  const r = await osrm(a, b);
  await sleep(1100);
  const segs = resample(r);
  const startLL = [r.geometry.coordinates[0][1], r.geometry.coordinates[0][0]];
  const z = await elev([startLL, ...segs.map((s) => s.ll)]);
  // light 5-point smoothing to suppress SRTM noise on overpasses (raw kept for the profile)
  const zs = z.map((_, i) => { let s = 0, n = 0; for (let k = -2; k <= 2; k++) if (z[i + k] !== undefined) { s += z[i + k]; n++; } return s / n; });
  routes[`${a}>${b}`] = {
    from: a, to: b,
    distance_m: Math.round(r.distance), osrm_duration_s: Math.round(r.duration),
    seg_d: segs.map((s) => +s.d.toFixed(1)),
    seg_t: segs.map((s) => +s.t.toFixed(1)),
    z: zs.map((v) => +v.toFixed(1)),
    poly: [startLL, ...segs.map((s) => s.ll)].filter((_, i, arr) => i % 4 === 0 || i === arr.length - 1).map(([la, lo]) => [+la.toFixed(5), +lo.toFixed(5)]),
  };
  console.log(a, '>', b, (r.distance / 1609.34).toFixed(1), 'mi', segs.length, 'segs, max z', Math.max(...zs).toFixed(0));
}

writeFileSync(new URL('../data/routes.json', import.meta.url), JSON.stringify({
  fetched_at: new Date().toISOString(),
  sources: {
    roads: 'OSRM public demo server (router.project-osrm.org), OpenStreetMap data (ODbL)',
    elevation: 'OpenTopoData srtm30m (NASA SRTM 30 m), 5-point moving average',
  },
  resample_m: STEP_M,
  places: PLACES,
  routes,
}));
console.log('wrote data/routes.json');
