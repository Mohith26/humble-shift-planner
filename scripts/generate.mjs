// Seeded synthetic day of drayage moves for a Port of Oakland operator, built on real roads
// (data/routes.json) and real terminal turn times (Oakland Portal), then planned.
// node scripts/generate.mjs  -> data/moves.json, data/results.json
import { readFileSync, writeFileSync } from 'node:fs';
import { mulberry32, buildInstance } from '../core/planner.mjs';

export const SEED = 20261111;
// Average total truck turn time per terminal, mean of the two Oakland Portal "Historical Truck
// Turn Times" snapshots (Nov 6 and Nov 10 2026). OICT = mean of East and West gates.
export const TURN_MIN = { Everport: (47 + 40) / 2, TraPac: (76 + 88) / 2, Matson: (45 + 38) / 2, OICT: (87 + 90 + 70 + 72) / 4 };
// Terminal share of gate trips (Fehr & Peers 2025 truck queuing study, average day; OICT ~ 2 gate complexes)
const TERMINAL_W = { OICT: 0.45, TraPac: 0.25, Everport: 0.24, Matson: 0.06 };
// Destination mix for a regional operator (assumption): near-Bay DCs plus Central Valley lanes.
const DC_W = { SanLeandro: 7, Hayward: 9, UnionCity: 6, Newark: 6, Richmond: 5, Livermore: 6, Fairfield: 4, Tracy: 9, Lathrop: 5, Stockton: 5, WestSac: 3, Patterson: 2 };
// Exports are mostly Central Valley agriculture.
const EXPORT_P = { Tracy: 0.45, Lathrop: 0.45, Stockton: 0.5, WestSac: 0.5, Patterson: 0.55, Fairfield: 0.3, Livermore: 0.2 };

export function makeMoves(n = 64, seed = SEED, routes = null) {
  const rnd = mulberry32(seed);
  const pick = (w) => { const tot = Object.values(w).reduce((a, b) => a + b, 0); let r = rnd() * tot; for (const [k, v] of Object.entries(w)) { r -= v; if (r <= 0) return k; } return Object.keys(w).at(-1); };
  const normal = () => { let u = 0, v = 0; while (!u) u = rnd(); while (!v) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const moves = [];
  while (moves.length < n) {
    const terminal = pick(TERMINAL_W), dc = pick(DC_W);
    const kind = rnd() < (EXPORT_P[dc] || 0.1) ? 'export' : 'import';
    // appointments: day gates 06:00-16:30 (60%), night gates 17:00-01:00 (40%): an autonomous
    // fleet has no driver shift, so it can work the night gates; 15-minute grid
    let hour;
    if (rnd() < 0.6) hour = 6 + rnd() * 10.5; else hour = 17 + rnd() * 8;
    const appt = Math.round(((hour - 5) * 60) / 15) * 15;
    const turnMean = TURN_MIN[terminal];
    const turn = (m) => Math.max(20, Math.round(m * (0.75 + 0.5 * rnd())));
    // payload: import boxes avg ~11 t, exports heavier (ag) ~17 t; legal max ~22 t on this platform
    const cargo = Math.min(22, Math.max(3, kind === 'export' ? 17 + 3.5 * normal() : 11 + 4.5 * normal()));
    // live unload / load at the customer dock: 2 h free time is the industry norm
    const dwell = Math.round(75 + rnd() * 75);
    const mv = { id: 'x', kind, terminal, dc, appt_min: appt, cargo_t: +cargo.toFixed(1), dwell_min: dwell, turn_out_min: turn(turnMean), turn_in_min: turn(turnMean * 0.6) };
    // keep only moves one Hauler can do from a full charge and still be recharged by 05:00
    if (routes && buildInstance({ routes, moves: [mv] }).outOfRange.length) continue;
    moves.push(mv);
  }
  moves.sort((a, b) => a.appt_min - b.appt_min);
  moves.forEach((m, i) => (m.id = 'MV-' + String(1041 + i)));
  return moves;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const routes = JSON.parse(readFileSync(new URL('../data/routes.json', import.meta.url)));
  const moves = makeMoves(+(process.argv[2] || 56), SEED, routes.routes);
  writeFileSync(new URL('../data/moves.json', import.meta.url), JSON.stringify({ seed: SEED, generated: 'scripts/generate.mjs', turn_min: TURN_MIN, moves }, null, 1));
  console.log('moves', moves.length);
}

// ------------------------------------------------------------------ plan + frontier -> results.json
import * as PL from '../core/planner.mjs';
export function computeResults(routesJson, movesJson, opts = {}) {
  const data = { routes: routesJson.routes, moves: movesJson.moves };
  const base = { chargers: 8, chargerKw: 250, subscriptionKw: 1000 };
  const levels = opts.levels || [700, 750, 800, 900, 1000, 1100, 1200, 1400];
  const frontier = [];
  const incumbents = [];
  let main = null;
  for (const S of levels) {
    const inst = PL.buildInstance(data, { ...base, subscriptionKw: S });
    const pl = PL.plan(inst, { incumbents, timeBudgetMs: opts.timeBudgetMs ?? 8000 });
    const g = PL.greedyBaseline(inst);
    if (pl.routes.length) incumbents.push(pl.routes);
    frontier.push({
      subscriptionKw: S, blocks: PL.subscriptionMonthly(S).blocks, monthly: +PL.subscriptionMonthly(S).monthly.toFixed(2),
      lbMatching: pl.lowerBounds.matching, lbLP: pl.lowerBounds.lp, lpValue: pl.lowerBounds.lpValue ?? null,
      fleet: pl.fleet, proven: pl.provenOptimal, energyCost: pl.metrics ? +pl.metrics.energyCost.toFixed(2) : null,
      peakKwh: pl.metrics ? +pl.metrics.byPeriod.peak.toFixed(1) : null,
      greedyFleet: g.fleet, greedyValid: g.metrics.valid, greedyEnergyCost: +g.metrics.energyCost.toFixed(2),
      ms: pl.stats.ms,
    });
    if (S === base.subscriptionKw) main = { inst, pl, g };
  }
  // dock-charging what-if: a charger at the customer dock used during live unload/load
  const dockFrontier = [];
  const dockInc = [];
  for (const S of opts.dockLevels || [400, 500, 600, 750, 1000]) {
    const instD = PL.buildInstance(data, { ...base, subscriptionKw: S, dockKw: 150 });
    const plD = PL.plan(instD, { incumbents: dockInc, timeBudgetMs: opts.timeBudgetMs ?? 8000 });
    if (plD.routes.length) dockInc.push(plD.routes);
    const gD = PL.greedyBaseline(instD);
    dockFrontier.push({ subscriptionKw: S, dockKw: 150, lbLP: plD.lowerBounds.lp, fleet: plD.fleet, proven: plD.provenOptimal,
      energyCost: plD.metrics ? +plD.metrics.energyCost.toFixed(2) : null, gridKwh: plD.metrics ? +plD.metrics.gridKwh.toFixed(1) : null, dockKwh: plD.metrics ? +plD.metrics.dockKwh.toFixed(1) : null,
      greedyFleet: gD.fleet, greedyValid: gD.metrics.valid });
  }
  const { inst, pl, g } = main;
  const gu = PL.greedyBaseline(inst, { ignoreCap: true });
  const r2 = (x) => Math.round(x * 100) / 100;
  return {
    generated_by: 'scripts/generate.mjs', seed: SEED,
    params: { ...base, battery_kwh: r2(inst.capKwh), curb_t: r2(inst.curbT), soc_max: inst.vehicle.maxSoc, soc_reserve: inst.vehicle.reserveSoc, tariff: 'PG&E BEV-2-S (Mar 1 2026)' },
    trips: inst.trips.map((t) => ({ id: t.id, kind: t.kind, terminal: t.terminal, dc: t.dc, s: r2(t.s), e: r2(t.e), arriveDc: r2(t.arriveDc), kwh: r2(t.energy), need: r2(t.need), mi: r2(t.miles), cargo_t: t.cargo_t, legs: t.legs.map((l) => ({ kwh: r2(l.kwh), mi: r2(l.mi), min: r2(l.min) })) })),
    plan: {
      fleet: pl.fleet, provenOptimal: pl.provenOptimal, lowerBounds: pl.lowerBounds, costLpBound: r2(pl.costLpBound), costGap: pl.costGap,
      routes: pl.routes.map((r) => ({ trips: r.trips, charges: r.charges.map(([t, f]) => [t, +f.toFixed(6)]) })),
      metrics: { valid: pl.metrics.valid, errors: pl.metrics.errors, peakKw: r2(pl.metrics.peakKw), energyCost: r2(pl.metrics.energyCost), gridKwh: r2(pl.metrics.gridKwh), dhMi: r2(pl.metrics.dhMi), byPeriod: pl.metrics.byPeriod, power: pl.metrics.power.map(r2) },
      stats: pl.stats,
    },
    baseline: {
      capped: { fleet: g.fleet, valid: g.metrics.valid, errors: g.metrics.errors.length, energyCost: r2(g.metrics.energyCost), peakKw: r2(g.metrics.peakKw), byPeriod: g.metrics.byPeriod, power: g.metrics.power.map(r2) },
      uncapped: { fleet: gu.fleet, energyCost: r2(gu.metrics.energyCost), peakKw: r2(gu.metrics.peakKw), byPeriod: gu.metrics.byPeriod, power: gu.metrics.power.map(r2), subscription: PL.subscriptionMonthly(gu.metrics.peakKw) },
    },
    frontier,
    dockFrontier,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const routesJson = JSON.parse(readFileSync(new URL('../data/routes.json', import.meta.url)));
  const movesJson = JSON.parse(readFileSync(new URL('../data/moves.json', import.meta.url)));
  const res = computeResults(routesJson, movesJson);
  writeFileSync(new URL('../data/results.json', import.meta.url), JSON.stringify(res));
  console.log('plan', res.plan.fleet, 'proven', res.plan.provenOptimal, 'LB', JSON.stringify(res.plan.lowerBounds), '$', res.plan.metrics.energyCost, 'gap', res.plan.costGap);
  console.log('baseline', JSON.stringify({ c: { f: res.baseline.capped.fleet, v: res.baseline.capped.valid, $: res.baseline.capped.energyCost }, u: { f: res.baseline.uncapped.fleet, peak: res.baseline.uncapped.peakKw, $: res.baseline.uncapped.energyCost } }));
  for (const f of res.frontier) console.log(JSON.stringify(f));
  for (const f of res.dockFrontier) console.log('dock', JSON.stringify(f));
}
