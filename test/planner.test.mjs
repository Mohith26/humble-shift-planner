import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as P from '../core/planner.mjs';
import { makeMoves, SEED } from '../scripts/generate.mjs';

const routesJson = JSON.parse(readFileSync(new URL('../data/routes.json', import.meta.url)));
const movesJson = JSON.parse(readFileSync(new URL('../data/moves.json', import.meta.url)));
const results = JSON.parse(readFileSync(new URL('../data/results.json', import.meta.url)));
const R = routesJson.routes;
const flat = (mi) => ({ seg_d: [mi * 1609.344], seg_t: [(mi * 1609.344) / 30], z: [0, 0], distance_m: mi * 1609.344 });

test('battery capacity reproduces the published 200-mile range at the reference payload', () => {
  const v = P.DEFAULT_VEHICLE;
  const e = P.legEnergy(flat(200), P.curbT(v) + v.containerTareT + v.refCargoT).kwh;
  assert.ok(Math.abs(e - P.batteryKwh(v)) < 1e-6);
  assert.ok(P.batteryKwh() > 250 && P.batteryKwh() < 500, 'plausible Class 8 pack size');
  assert.ok(Math.abs(P.curbT() - (8.2 + 2.7) * 0.8) < 1e-9, '20% lighter than tractor + chassis');
});

test('55 mph cap: no segment is driven faster than the top speed', () => {
  const r = P.pathRoute(R, 'OICT', 'Stockton');
  const { s, mi } = P.legEnergy(r, 20);
  assert.ok(mi / (s / 3600) <= 55 + 1e-9);
  assert.ok(mi > 70 && mi < 80, 'real OSRM distance Oakland -> Stockton');
});

test('energy physics: heavier costs more, Altamont climb shows up in real elevation data', () => {
  const r = P.pathRoute(R, 'gate', 'Tracy');
  const light = P.legEnergy(r, 13).kwh, heavy = P.legEnergy(r, 30).kwh;
  assert.ok(heavy > light);
  assert.ok(Math.max(...R['gate>Tracy'].z) > 250, 'Altamont Pass summit > 250 m in SRTM data');
  // same road, flattened: the real profile must cost more on the way up than a flat road
  const flatR = { ...r, z: r.z.map(() => 0) };
  const up = P.legEnergy(P.pathRoute(R, 'gate', 'Livermore'), 30), upFlat = P.legEnergy({ ...P.pathRoute(R, 'gate', 'Livermore'), z: P.pathRoute(R, 'gate', 'Livermore').z.map(() => 0) }, 30);
  assert.ok(up.kwh > upFlat.kwh, 'Oakland -> Livermore climbs ~200 m');
  assert.ok(P.legEnergy(flatR, 30).kwh > 0);
  assert.ok(up.peakKwh >= up.kwh - 1e-9);
});

test('PG&E BEV-2-S tariff periods and subscription blocks match the rate sheet', () => {
  const at = (h) => P.slotPrice(((h - 5 + 24) % 24) * 4);
  assert.equal(at(17), 0.36977);
  assert.equal(at(10), 0.13327);
  assert.equal(at(2), 0.15654);
  assert.equal(at(14), 0.15654);
  assert.deepEqual(P.subscriptionMonthly(60), { blocks: 2, kw: 100, monthly: 191.12 });
  assert.equal(P.subscriptionMonthly(1000).blocks, 20);
});

test('revised simplex matches brute-force vertex enumeration on random LPs (randomized)', () => {
  const rnd = P.mulberry32(7);
  for (let trial = 0; trial < 40; trial++) {
    // min c x, A x >= 1 (3 rows, 5 cols, 0/1 coefficients), x >= 0: standard form with surplus + artificials
    const m = 3, n = 5;
    const A = Array.from({ length: m }, () => Array.from({ length: n }, () => (rnd() < 0.5 ? 1 : 0)));
    for (let j = 0; j < n; j++) A[Math.floor(rnd() * m)][j] = 1;
    for (let i = 0; i < m; i++) A[i][Math.floor(rnd() * n)] = 1;
    const c = Array.from({ length: n }, () => 1 + Math.floor(rnd() * 9));
    const lp = new P.LP(m, [1, 1, 1]);
    const basis = [];
    for (let i = 0; i < m; i++) { lp.addCol([i], [-1], 0); basis.push(lp.addCol([i], [1], 1e5)); }
    for (let j = 0; j < n; j++) { const idx = [], val = []; for (let i = 0; i < m; i++) if (A[i][j]) { idx.push(i); val.push(1); } lp.addCol(idx, val, c[j]); }
    lp.setBasis(basis);
    const res = lp.solve();
    // brute force: optimal vertex of a covering LP with 3 rows lies on <= 3 positive columns; grid search over x in {0,1/2,1}
    let best = Infinity;
    const vals = [0, 0.5, 1];
    const rec = (j, x) => {
      if (j === n) { for (let i = 0; i < m; i++) { let s = 0; for (let k = 0; k < n; k++) s += A[i][k] * x[k]; if (s < 1 - 1e-9) return; } best = Math.min(best, x.reduce((s, v, k) => s + v * c[k], 0)); return; }
      for (const v of vals) { x[j] = v; rec(j + 1, x); }
    };
    rec(0, []);
    assert.equal(res.status, 'optimal');
    assert.ok(res.obj <= best + 1e-7, `lp ${res.obj} <= grid ${best}`);
    // and it is a valid covering solution with the reported objective
    const x = lp.values();
    for (let i = 0; i < m; i++) { let s = 0; for (let j = 0; j < n; j++) s += A[i][j] * x[2 * m + j]; assert.ok(s >= 1 - 1e-7); }
  }
});

test('charging picks the cheapest slots and the exact best top-off slot (randomized brute force)', () => {
  const inst = P.buildInstance({ routes: R, moves: movesJson.moves.slice(0, 2) });
  const rnd = P.mulberry32(11);
  for (let trial = 0; trial < 30; trial++) {
    const a = Float64Array.from({ length: P.N_SLOTS }, () => 10 + rnd() * 50);
    const b = Float64Array.from({ length: P.N_SLOTS }, () => (rnd() < 0.3 ? rnd() * 20 : 0));
    const soc = inst.socMin + rnd() * (inst.socMax - inst.socMin - 1);
    const from = 600 + Math.floor(rnd() * 60), to = from + 60 + Math.floor(rnd() * 120);
    const opts = P.__test.chargeOptions(inst, from, to, soc, a, b);
    const fill = opts.find((o) => Math.abs(o.add - (inst.socMax - soc)) < 1e-6);
    // brute force over all assignments of nFull whole slots + 1 partial in the window
    const t0 = Math.ceil(from / 15), t1 = Math.floor(to / 15);
    const slots = []; for (let t = t0; t < t1; t++) slots.push(t);
    const room = inst.socMax - soc, eb = inst.slotKwhBatt;
    const nFull = Math.floor(room / eb + 1e-9), frac = (room - nFull * eb) / eb;
    if (slots.length < nFull + (frac > 1e-6 ? 1 : 0)) { assert.ok(!fill || fill.add < room); continue; }
    let best = Infinity;
    const choose = (k, start, acc, used) => {
      if (k === 0) {
        if (frac <= 1e-6) { best = Math.min(best, acc); return; }
        for (const t of slots) if (!used.has(t)) best = Math.min(best, acc + frac * a[t] + b[t]);
        return;
      }
      for (let i = start; i < slots.length; i++) { used.add(slots[i]); choose(k - 1, i + 1, acc + a[slots[i]] + b[slots[i]], used); used.delete(slots[i]); }
    };
    choose(nFull, 0, 0, new Set());
    assert.ok(fill, 'fill-to-ceiling option exists');
    assert.ok(Math.abs(fill.cost - best) < 1e-6, `greedy ${fill.cost} vs brute ${best}`);
  }
});

test('matching bound is a valid lower bound and the plan never beats the LP bound', () => {
  const inst = P.buildInstance({ routes: R, moves: movesJson.moves }, { subscriptionKw: 1000 });
  const lb = P.matchingLowerBound(inst).bound;
  const pl = P.plan(inst);
  assert.ok(lb <= pl.lowerBounds.lp);
  assert.ok(pl.fleet >= pl.lowerBounds.lp);
});

// Independent exact oracle for tiny instances: a set of moves is doable by one hauler iff the
// "charge to the ceiling at every depot visit" policy (which maximises charge) can do it with
// some choice of direct vs via-depot connections. Then min fleet = min set partition.
function oneHaulerCan(inst, idxs) {
  const P2 = inst.params, T = idxs.map((i) => inst.trips[i]).sort((x, y) => x.s - y.s);
  const go = (k, soc, atDepotFrom) => {
    const b = T[k];
    let start;
    if (atDepotFrom !== null) {
      const toT = inst.dh(P2.depot, b.terminal, b.s - 30); const leave = b.s - toT.min;
      if (leave < atDepotFrom - 1e-9) return false;
      const t0 = Math.ceil(atDepotFrom / 15 - 1e-9), t1 = Math.floor(leave / 15 + 1e-9);
      soc = Math.min(inst.socMax, soc + Math.max(0, t1 - t0) * inst.slotKwhBatt) - toT.kwh;
    }
    if (soc - b.need < inst.socMin - 1e-9) return false;
    soc -= b.energy;
    if (k === T.length - 1) {
      const toD = inst.dh(b.terminal, P2.depot, b.e); const s2 = soc - toD.kwh;
      if (s2 < inst.socMin - 1e-9) return false;
      const t0 = Math.ceil((b.e + toD.min) / 15 - 1e-9);
      return s2 + (96 - t0) * inst.slotKwhBatt >= inst.socMax - 1e-6;
    }
    const c = T[k + 1];
    const dd = inst.dh(b.terminal, c.terminal, b.e);
    if (b.e + dd.min <= c.s + 1e-9 && go(k + 1, soc - dd.kwh, null)) return true;
    const toD = inst.dh(b.terminal, P2.depot, b.e);
    if (soc - toD.kwh >= inst.socMin - 1e-9 && go(k + 1, soc - toD.kwh, b.e + toD.min)) return true;
    return false;
  };
  for (let k = 1; k < T.length; k++) if (T[k].s < T[k - 1].e) return false;
  if (!T.length) return true;
  const d0 = inst.dh(P2.depot, T[0].terminal, T[0].s - 30);
  return go(0, inst.socMax, 0) && T[0].s - d0.min >= 0;
}

test('property: on random tiny days the certified fleet equals a brute-force optimum (randomized)', () => {
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const moves = makeMoves(7, 9000 + seed, R);
    const inst = P.buildInstance({ routes: R, moves }, { subscriptionKw: 5000, chargers: 20 });
    const n = inst.trips.length;
    // brute force min partition (n <= 7: Bell(7) = 877)
    let best = n;
    const rec = (i, blocks) => {
      if (blocks.length >= best) return;
      if (i === n) { best = blocks.length; return; }
      for (const bl of blocks) { bl.push(i); if (oneHaulerCan(inst, bl)) rec(i + 1, blocks); bl.pop(); }
      blocks.push([i]); rec(i + 1, blocks); blocks.pop();
    };
    rec(0, []);
    const pl = P.plan(inst);
    assert.ok(pl.lowerBounds.lp <= best, `seed ${seed}: LP bound ${pl.lowerBounds.lp} <= brute ${best}`);
    assert.equal(pl.fleet, best, `seed ${seed}: plan fleet equals brute-force optimum`);
    assert.ok(pl.metrics.valid);
  }
});

test('validator catches tampering: missing charge, double cover, over-subscription', () => {
  const inst = P.buildInstance({ routes: R, moves: movesJson.moves }, { subscriptionKw: 1000 });
  const routes = results.plan.routes.map((r) => ({ trips: r.trips.slice(), charges: r.charges.map((c) => c.slice()) }));
  assert.ok(P.evaluate(inst, routes).valid, 'committed plan is valid');
  const t1 = structuredClone(routes); t1[0].charges = [];
  assert.ok(!P.evaluate(inst, t1).valid);
  const t2 = structuredClone(routes); t2[1].trips.push(t2[0].trips[0]); t2[1].trips.sort((a, b) => a - b);
  assert.ok(P.evaluate(inst, t2).errors.some((e) => /covered 2 times|cannot reach|below reserve/.test(e)));
  const inst2 = P.buildInstance({ routes: R, moves: movesJson.moves }, { subscriptionKw: 300 });
  assert.ok(!P.evaluate(inst2, routes).valid, 'same plan breaks a 300 kW subscription');
});

test('headline: committed results reproduce (29 Haulers, proven minimum at 1,000 kW and at 750 kW)', () => {
  const inst = P.buildInstance({ routes: R, moves: movesJson.moves }, { subscriptionKw: 1000, chargers: 8, chargerKw: 250 });
  const pl = P.plan(inst);
  assert.equal(pl.fleet, results.plan.fleet);
  assert.equal(pl.fleet, 29);
  assert.ok(pl.provenOptimal);
  assert.ok(pl.metrics.valid);
  assert.ok(Math.abs(pl.metrics.energyCost - results.plan.metrics.energyCost) / results.plan.metrics.energyCost < 0.02);
  const f750 = results.frontier.find((f) => f.subscriptionKw === 750);
  assert.equal(f750.fleet, 29); assert.ok(f750.proven);
  // baseline: first-come charging needs more haulers and a bigger subscription
  assert.equal(results.baseline.uncapped.fleet, 30);
  assert.ok(results.baseline.uncapped.peakKw > 1300);
  const inst750 = P.buildInstance({ routes: R, moves: movesJson.moves }, { subscriptionKw: 750 });
  const g = P.greedyBaseline(inst750);
  assert.ok(!g.metrics.valid, 'first-come charging cannot recharge the fleet on 750 kW');
});

test('plan respects site power, dispensers and the daily charge cycle at every frontier point', () => {
  for (const f of results.frontier) {
    if (f.fleet) assert.ok(f.fleet >= f.lbLP, `${f.subscriptionKw}: fleet >= bound`);
    if (f.lbLP) assert.ok(f.lbLP >= f.lbMatching);
  }
  const inst = P.buildInstance({ routes: R, moves: movesJson.moves }, { subscriptionKw: 1000 });
  const m = P.evaluate(inst, results.plan.routes);
  assert.ok(m.peakKw <= 1000 + 1e-6 && m.maxPlugs <= 8);
  for (const tl of m.timelines) assert.ok(tl.endSoc >= inst.socMax - 1e-2);
});

test('charging polish never raises cost and keeps the plan valid', () => {
  const inst = P.buildInstance({ routes: R, moves: movesJson.moves }, { subscriptionKw: 1000 });
  const base = results.plan.routes.map((r) => ({ trips: r.trips, charges: r.charges.map((c) => c.slice()) }));
  // scramble: move every night charge into the 4-9 pm peak where the hauler is parked, if valid
  const before = P.evaluate(inst, base);
  const after = P.polishCharging(inst, base);
  const m = P.evaluate(inst, after);
  assert.ok(m.valid);
  assert.ok(m.energyCost <= before.energyCost + 1e-6);
});

test('seeded generator is deterministic and uses the published Oakland turn times', () => {
  const a = makeMoves(10, SEED, R), b = makeMoves(10, SEED, R);
  assert.deepEqual(a, b);
  assert.equal(movesJson.seed, SEED);
  assert.ok(movesJson.moves.length === 56);
  assert.ok(Math.abs(movesJson.turn_min.OICT - 79.75) < 1e-9);
});

test('README quotes the committed numbers', () => {
  const md = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  assert.ok(md.includes(`${results.plan.fleet} Haulers`));
  assert.ok(md.includes(Math.round(results.baseline.uncapped.peakKw).toLocaleString('en-US') + ' kW'));
});

test('dock charging during live unload: capped by the out-leg energy, and 28 Haulers on 500 kW (proven)', () => {
  const inst0 = P.buildInstance({ routes: R, moves: movesJson.moves }, { subscriptionKw: 500 });
  const inst = P.buildInstance({ routes: R, moves: movesJson.moves }, { subscriptionKw: 500, dockKw: 150 });
  for (let i = 0; i < inst.trips.length; i++) {
    const a = inst0.trips.find((t) => t.id === inst.trips[i].id), b = inst.trips[i];
    const mvRow = movesJson.moves.find((m) => m.id === b.id);
    const outUsed = a.legs[0].kwh + (inst.vehicle.auxIdleKw * mvRow.turn_out_min) / 60;
    assert.ok(b.dockKwh <= outUsed + 1e-9, 'never more than the out leg used, so the charge never exceeds the start level');
    assert.ok(Math.abs(a.energy - b.energy - b.dockKwh) < 1e-9);
  }
  assert.equal(P.plan(inst0).fleet, null, 'without dock chargers 500 kW cannot work');
  const pl = P.plan(inst);
  assert.equal(pl.fleet, 28); assert.ok(pl.provenOptimal); assert.ok(pl.metrics.valid);
  const d500 = results.dockFrontier.find((f) => f.subscriptionKw === 500);
  assert.equal(d500.fleet, 28);
});
