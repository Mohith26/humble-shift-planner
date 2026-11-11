// Humble Shift Planner core: route energy, trip building, column generation for the
// electric vehicle scheduling problem with depot charging under a grid subscription,
// a certified lower bound on fleet size, a price-and-dive integer plan, a greedy
// dispatcher baseline and an independent plan validator.
//
// Pure ES module, no dependencies. Runs in Node (tests, seed script) and in the browser.

// ---------------------------------------------------------------- constants
export const SLOT_MIN = 15;              // PG&E BEV measures demand in 15-minute intervals
export const DAY_START_HOUR = 5;         // service day runs 05:00 -> 05:00
export const N_SLOTS = 96;
const G = 9.81, RHO = 1.2, MPS_PER_MPH = 0.44704, M_PER_MI = 1609.344;

// PG&E Schedule BEV, BEV-2-S (secondary), total bundled rates effective Mar 1 2026.
export const TARIFF_BEV2S = {
  name: 'PG&E BEV-2-S',
  peak: 0.36977, offPeak: 0.15654, superOffPeak: 0.13327, // $/kWh
  blockKw: 50, blockMonthly: 95.56, minBlocks: 2, overagePerKw: 3.82,
  // peak 4-9 pm every day; super off-peak 9 am - 2 pm every day; off-peak otherwise
  periodOfHour(h) { return h >= 16 && h < 21 ? 'peak' : h >= 9 && h < 14 ? 'superOffPeak' : 'offPeak'; },
};

export function slotHour(t) { return (DAY_START_HOUR + (t * SLOT_MIN) / 60) % 24; }
export function slotPrice(t, tariff = TARIFF_BEV2S) { return tariff[tariff.periodOfHour(Math.floor(slotHour(t)))]; }
export function fmtClock(min) {
  const m = Math.round(min) + DAY_START_HOUR * 60;
  const h = Math.floor(m / 60) % 24, mm = ((m % 60) + 60) % 60;
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

// ---------------------------------------------------------------- vehicle + energy model
// Published: 200-mile range, 55 mph top speed, "20% lighter than a traditional tractor and
// trailer" (humblerobotics.ai). Everything else is an engineering assumption, listed here.
export const DEFAULT_VEHICLE = {
  ratedRangeMi: 200, topSpeedMph: 55,
  conventionalTractorT: 8.2, conventionalChassisT: 2.7, lighterBy: 0.20,
  containerTareT: 3.9,            // 40' high cube
  crr: 0.0055, cdaLoaded: 6.0, cdaBobtail: 3.2,
  etaDrive: 0.87, etaRegen: 0.60, etaCharge: 0.94,
  auxDriveKw: 4.0, auxIdleKw: 1.2, // autonomy compute + sensors + thermal
  refCargoT: 10,                   // reference payload for the rated range
  maxSoc: 0.90, reserveSoc: 0.10,  // daily charge ceiling and operating reserve
};

export function curbT(v = DEFAULT_VEHICLE) {
  return (v.conventionalTractorT + v.conventionalChassisT) * (1 - v.lighterBy);
}

// Energy (kWh, battery side) and time (s) to drive a resampled route at mass massT.
// Per segment: traction = m g Crr d + 1/2 rho CdA v^2 d + m g dz; positive traction drawn at
// etaDrive, negative traction recovered at etaRegen; plus auxiliary load over the drive time.
// Returns cumulative energy so callers can find the worst intermediate state of charge.
export function legEnergy(route, massT, opts = {}) {
  const v = opts.vehicle || DEFAULT_VEHICLE;
  const cda = opts.cda ?? v.cdaLoaded;
  const mult = opts.timeMult ?? 1;
  const m = massT * 1000;
  const vmax = v.topSpeedMph * MPS_PER_MPH;
  let e = 0, peak = 0, time = 0;
  const parts = { rolling: 0, aero: 0, climb: 0, regen: 0, aux: 0 };
  const { seg_d: D, seg_t: T, z } = route;
  for (let i = 0; i < D.length; i++) {
    const d = D[i];
    if (d <= 0) continue;
    const vFree = T[i] > 0 ? d / T[i] : vmax;
    const sp = Math.min(vFree, vmax);
    const dt = (d / sp) * mult;
    const dz = (z[i + 1] ?? z[i]) - z[i];
    const roll = m * G * v.crr * d, aero = 0.5 * RHO * cda * sp * sp * d, grade = m * G * dz;
    const traction = roll + aero + grade; // J
    const batt = traction > 0 ? traction / v.etaDrive : traction * v.etaRegen;
    if (traction > 0) {
      parts.rolling += roll / v.etaDrive / 3.6e6; parts.aero += aero / v.etaDrive / 3.6e6;
      if (grade > 0) parts.climb += grade / v.etaDrive / 3.6e6; else parts.regen += grade / v.etaDrive / 3.6e6;
    } else { parts.rolling += 0; parts.regen += batt / 3.6e6 - (roll + aero) / v.etaDrive / 3.6e6; parts.rolling += roll / v.etaDrive / 3.6e6; parts.aero += aero / v.etaDrive / 3.6e6; }
    parts.aux += (v.auxDriveKw * dt) / 3600;
    e += batt / 3.6e6 + (v.auxDriveKw * dt) / 3600;
    if (e > peak) peak = e;
    time += dt;
  }
  return { kwh: e, peakKwh: peak, s: time, mi: route.distance_m / M_PER_MI, parts };
}

// Battery capacity implied by the rated range at the reference payload on a flat road at 55 mph.
export function batteryKwh(v = DEFAULT_VEHICLE) {
  const flat = { seg_d: [M_PER_MI], seg_t: [M_PER_MI / (v.topSpeedMph * MPS_PER_MPH)], z: [0, 0], distance_m: M_PER_MI };
  const perMi = legEnergy(flat, curbT(v) + v.containerTareT + v.refCargoT, { vehicle: v }).kwh;
  return v.ratedRangeMi * perMi;
}

// Join legs (A>gate, gate>B) into one route object.
export function joinRoutes(...rs) {
  const out = { seg_d: [], seg_t: [], z: [], distance_m: 0 };
  for (const r of rs) {
    if (!r) continue;
    if (out.z.length) out.z.pop();
    out.seg_d.push(...r.seg_d); out.seg_t.push(...r.seg_t); out.z.push(...r.z);
    out.distance_m += r.distance_m;
  }
  return out;
}

export function pathRoute(routes, a, b) {
  if (a === b) return { seg_d: [], seg_t: [], z: [0], distance_m: 0 };
  const r1 = a === 'gate' ? null : routes[`${a}>gate`];
  const r2 = b === 'gate' ? null : routes[`gate>${b}`];
  return joinRoutes(r1, r2);
}

// Bay Area peak-period travel-time multiplier (assumption: +30% 06:30-09:30 and 15:30-19:00).
export function trafficMult(minFromStart) {
  const h = (DAY_START_HOUR + minFromStart / 60) % 24;
  return (h >= 6.5 && h < 9.5) || (h >= 15.5 && h < 19) ? 1.3 : 1.0;
}

// ---------------------------------------------------------------- instance building
// A move is one drayage job that starts and ends at a marine terminal:
//  import: pick up loaded box (terminal turn) -> drive loaded to DC -> live unload at the dock
//          (the Hauler is the chassis, so it stays under the box) -> return the empty -> turn
//  export: pick up empty -> drive to shipper -> live load -> return loaded -> turn
export function buildInstance(data, params = {}) {
  const v = { ...DEFAULT_VEHICLE, ...(params.vehicle || {}) };
  const routes = data.routes;
  const cap = batteryKwh(v);
  const curb = curbT(v);
  const P = {
    chargers: params.chargers ?? 8,
    chargerKw: params.chargerKw ?? 250,
    subscriptionKw: params.subscriptionKw ?? 1000,
    deadheadPerMi: params.deadheadPerMi ?? 0.25,
    depot: 'depot',
  };
  const socMax = v.maxSoc * cap, socMin = v.reserveSoc * cap;

  const legCache = new Map();
  const leg = (a, b, massT, cda, startMin) => {
    const mult = trafficMult(startMin);
    const key = `${a}|${b}|${massT.toFixed(2)}|${cda}|${mult}`;
    if (!legCache.has(key)) legCache.set(key, legEnergy(pathRoute(routes, a, b), massT, { vehicle: v, cda, timeMult: mult }));
    return legCache.get(key);
  };

  const trips = [];
  const outOfRange = [];
  for (const mv of data.moves) {
    const loadedT = curb + v.containerTareT + mv.cargo_t;
    const emptyT = curb + v.containerTareT;
    const outMass = mv.kind === 'import' ? loadedT : emptyT;
    const backMass = mv.kind === 'import' ? emptyT : loadedT;
    let t = mv.appt_min;
    const s = t;
    t += mv.turn_out_min;
    const l1 = leg(mv.terminal, mv.dc, outMass, v.cdaLoaded, t);
    const idle1 = (v.auxIdleKw * mv.turn_out_min) / 60;
    t += l1.s / 60;
    const arriveDc = t;
    t += mv.dwell_min;
    const idle2 = (v.auxIdleKw * mv.dwell_min) / 60;
    const l2 = leg(mv.dc, mv.terminal, backMass, v.cdaLoaded, t);
    t += l2.s / 60;
    t += mv.turn_in_min;
    const idle3 = (v.auxIdleKw * mv.turn_in_min) / 60;
    const e = t;
    const energy = idle1 + l1.kwh + idle2 + l2.kwh + idle3;
    const need = Math.max(idle1 + l1.peakKwh, idle1 + l1.kwh + idle2 + l2.peakKwh, energy);
    const trip = {
      id: mv.id, idx: trips.length, kind: mv.kind, terminal: mv.terminal, dc: mv.dc,
      s, e, arriveDc, energy, need, miles: l1.mi + l2.mi, cargo_t: mv.cargo_t,
      legs: [{ kwh: l1.kwh, mi: l1.mi, min: l1.s / 60 }, { kwh: l2.kwh, mi: l2.mi, min: l2.s / 60 }],
    };
    // feasible alone from a full depot charge?
    const toT = leg('depot', mv.terminal, curb, v.cdaBobtail, s - 30);
    if (socMax - toT.kwh - need < socMin - 1e-9) { outOfRange.push({ ...trip, reason: 'range', shortfall: socMin - (socMax - toT.kwh - need) }); continue; }
    // must also be back and recharged before the next service day starts
    const back = leg(mv.terminal, 'depot', curb, v.cdaBobtail, e);
    const refill = socMax - (socMax - toT.kwh - energy - back.kwh);
    const slotsNeeded = Math.ceil(refill / ((P.chargerKw * SLOT_MIN / 60) * v.etaCharge) - 1e-9);
    const firstSlot = Math.ceil((e + back.s / 60 + 3) / SLOT_MIN - 1e-9);
    if (firstSlot + slotsNeeded > N_SLOTS) { outOfRange.push({ ...trip, reason: 'horizon' }); continue; }
    trip.idx = trips.length;
    trips.push(trip);
  }
  trips.sort((a, b) => a.s - b.s || a.e - b.e);
  trips.forEach((tr, i) => (tr.idx = i));

  // bobtail deadheads between places, time-of-day dependent
  const dh = (a, b, startMin) => {
    if (a === b) return { kwh: 0, min: 0, mi: 0 };
    const r = leg(a, b, curb, v.cdaBobtail, startMin);
    return { kwh: r.kwh, min: r.s / 60 + 3, mi: r.mi }; // +3 min yard maneuver
  };

  const prices = Array.from({ length: N_SLOTS }, (_, t) => slotPrice(t));
  return {
    vehicle: v, capKwh: cap, socMax, socMin, curbT: curb,
    params: P, trips, outOfRange, prices, dh,
    slotKwhGrid: (P.chargerKw * SLOT_MIN) / 60,
    slotKwhBatt: ((P.chargerKw * SLOT_MIN) / 60) * v.etaCharge,
  };
}

// ---------------------------------------------------------------- lower bound without batteries
// Classic minimum path cover: a vehicle can chain i -> j if it can deadhead in time.
// Fleet >= n - maxMatching. Ignores batteries, so it is a relaxation (valid lower bound).
export function compatible(inst, i, j) {
  const a = inst.trips[i], b = inst.trips[j];
  if (b.s < a.e) return false;
  return a.e + inst.dh(a.terminal, b.terminal, a.e).min <= b.s + 1e-9;
}

export function matchingLowerBound(inst) {
  const n = inst.trips.length;
  const adj = Array.from({ length: n }, (_, i) => {
    const out = [];
    for (let j = 0; j < n; j++) if (i !== j && compatible(inst, i, j)) out.push(j);
    return out;
  });
  const matchR = new Int32Array(n).fill(-1);
  let size = 0;
  for (let u = 0; u < n; u++) {
    const seen = new Uint8Array(n);
    const aug = (x) => {
      for (const y of adj[x]) {
        if (seen[y]) continue;
        seen[y] = 1;
        if (matchR[y] < 0 || aug(matchR[y])) { matchR[y] = x; return true; }
      }
      return false;
    };
    if (aug(u)) size++;
  }
  return { bound: n - size, matching: size };
}

// ---------------------------------------------------------------- revised simplex
// min c x  s.t.  A x = b, x >= 0, starting from a feasible basis supplied by the caller.
// Columns are sparse: {idx:Int32Array, val:Float64Array}. Dense explicit B^-1 (m is ~100).
export class LP {
  constructor(m, b) {
    this.m = m; this.b = Float64Array.from(b);
    this.cols = []; this.cost = [];
    this.basis = new Int32Array(m).fill(-1);
    this.Binv = null; this.xB = null;
  }
  addCol(idx, val, c) {
    this.cols.push({ idx: Int32Array.from(idx), val: Float64Array.from(val) });
    this.cost.push(c);
    return this.cols.length - 1;
  }
  setBasis(basis) { // basis[i] = column index basic in row i; must be a feasible basis
    this.basis = Int32Array.from(basis);
    this.refactor();
  }
  refactor() {
    const m = this.m;
    const B = new Float64Array(m * m);
    for (let i = 0; i < m; i++) {
      const col = this.cols[this.basis[i]];
      for (let k = 0; k < col.idx.length; k++) B[col.idx[k] * m + i] = col.val[k];
    }
    const inv = new Float64Array(m * m);
    for (let i = 0; i < m; i++) inv[i * m + i] = 1;
    for (let c = 0; c < m; c++) { // Gauss-Jordan with partial pivoting
      let p = c, best = Math.abs(B[c * m + c]);
      for (let r = c + 1; r < m; r++) { const a = Math.abs(B[r * m + c]); if (a > best) { best = a; p = r; } }
      if (best < 1e-12) throw new Error('singular basis');
      if (p !== c) for (let k = 0; k < m; k++) {
        let t = B[c * m + k]; B[c * m + k] = B[p * m + k]; B[p * m + k] = t;
        t = inv[c * m + k]; inv[c * m + k] = inv[p * m + k]; inv[p * m + k] = t;
      }
      const d = B[c * m + c];
      for (let k = 0; k < m; k++) { B[c * m + k] /= d; inv[c * m + k] /= d; }
      for (let r = 0; r < m; r++) {
        if (r === c) continue;
        const f = B[r * m + c];
        if (f === 0) continue;
        for (let k = 0; k < m; k++) { B[r * m + k] -= f * B[c * m + k]; inv[r * m + k] -= f * inv[c * m + k]; }
      }
    }
    this.Binv = inv;
    this.xB = new Float64Array(m);
    for (let i = 0; i < m; i++) { let s = 0; for (let k = 0; k < m; k++) s += inv[i * m + k] * this.b[k]; this.xB[i] = s; }
    this.pivots = 0;
  }
  duals() {
    const m = this.m, y = new Float64Array(m);
    for (let i = 0; i < m; i++) {
      const cb = this.cost[this.basis[i]];
      if (cb === 0) continue;
      for (let k = 0; k < m; k++) y[k] += cb * this.Binv[i * m + k];
    }
    return y;
  }
  reducedCost(j, y) {
    const col = this.cols[j];
    let s = this.cost[j];
    for (let k = 0; k < col.idx.length; k++) s -= y[col.idx[k]] * col.val[k];
    return s;
  }
  solve(maxIter = 20000) {
    const m = this.m;
    const isBasic = new Uint8Array(this.cols.length);
    for (const j of this.basis) isBasic[j] = 1;
    let degenerate = 0;
    for (let it = 0; it < maxIter; it++) {
      const y = this.duals();
      const bland = degenerate > 60;
      let q = -1, best = -1e-9;
      for (let j = 0; j < this.cols.length; j++) {
        if (isBasic[j]) continue;
        const rc = this.reducedCost(j, y);
        if (rc < best) { q = j; best = rc; if (bland) break; }
      }
      if (q < 0) { this.y = y; return { status: 'optimal', obj: this.objective(), y }; }
      // direction d = B^-1 a_q
      const col = this.cols[q];
      const d = new Float64Array(m);
      for (let i = 0; i < m; i++) { let s = 0; for (let k = 0; k < col.idx.length; k++) s += this.Binv[i * m + col.idx[k]] * col.val[k]; d[i] = s; }
      let r = -1, ratio = Infinity;
      for (let i = 0; i < m; i++) {
        if (d[i] > 1e-10) {
          const t = Math.max(0, this.xB[i]) / d[i];
          if (t < ratio - 1e-12 || (Math.abs(t - ratio) <= 1e-12 && r >= 0 && this.basis[i] < this.basis[r])) { ratio = t; r = i; }
        }
      }
      if (r < 0) return { status: 'unbounded' };
      degenerate = ratio < 1e-12 ? degenerate + 1 : 0;
      // pivot
      const piv = d[r];
      for (let k = 0; k < m; k++) this.Binv[r * m + k] /= piv;
      this.xB[r] = ratio;
      for (let i = 0; i < m; i++) {
        if (i === r || d[i] === 0) continue;
        const f = d[i];
        for (let k = 0; k < m; k++) this.Binv[i * m + k] -= f * this.Binv[r * m + k];
        this.xB[i] -= f * ratio;
        if (Math.abs(this.xB[i]) < 1e-11) this.xB[i] = 0;
      }
      isBasic[this.basis[r]] = 0; isBasic[q] = 1;
      this.basis[r] = q;
      if (++this.pivots > 150) this.refactor();
    }
    return { status: 'iteration_limit' };
  }
  objective() { let s = 0; for (let i = 0; i < this.m; i++) s += this.cost[this.basis[i]] * this.xB[i]; return s; }
  values() { const x = new Float64Array(this.cols.length); for (let i = 0; i < this.m; i++) x[this.basis[i]] = this.xB[i]; return x; }
}

// ---------------------------------------------------------------- pricing (resource-constrained shortest path on the trip DAG)
// Labels at the end of trip j: reduced cost so far and battery energy (kWh). Extensions go
// trip i -> trip j directly, or via the depot with charging in the cheapest dual-adjusted
// 15-minute slots that fit between arrival and departure. A label dominates another at the same
// trip if it is no more expensive and has at least as much energy.
// Charging model: whole 15-minute slots at full charger power, plus one partial top-off slot
// only when filling to the ceiling. Slot cost = a[t] * fraction + b[t] (a: energy price and
// power-row dual, b: charger-row dual). For a fixed number of whole slots the cheapest set is
// optimal; the partial slot is chosen exactly by enumeration. So pricing is exact for the model.
function chargeOptions(inst, fromMin, toMin, soc, a, b, maxFrac) {
  const t0 = Math.max(0, Math.ceil(fromMin / SLOT_MIN - 1e-9));
  const t1 = Math.min(N_SLOTS, Math.floor(toMin / SLOT_MIN + 1e-9));
  const opts = [{ add: 0, cost: 0, slots: [] }];
  if (t1 <= t0) return opts;
  const room = inst.socMax - soc;
  if (room <= 1e-6) return opts;
  const avail = [];
  const eb = inst.slotKwhBatt;
  let nFull = Math.floor(room / eb + 1e-9);
  let frac = (room - nFull * eb) / eb;
  if (frac < 1e-6) frac = 0;
  const partialOnly = [];
  for (let t = t0; t < t1; t++) {
    if (!maxFrac || maxFrac[t] >= 1 - 1e-9) avail.push(t);
    else if (frac > 0 && maxFrac[t] >= frac - 1e-9) partialOnly.push(t);
  }
  avail.sort((x, y) => a[x] + b[x] - (a[y] + b[y]) || x - y);
  let cost = 0, add = 0;
  const slots = [];
  const kMax = Math.min(nFull, avail.length);
  for (let k = 0; k < kMax; k++) {
    const t = avail[k];
    cost += a[t] + b[t]; add += eb; slots.push([t, 1]);
    if (k < kMax - 1 || frac === 0 || kMax < nFull) opts.push({ add, cost, slots: slots.slice() });
    else opts.push({ add, cost, slots: slots.slice() });
  }
  // fill exactly to the ceiling: nFull whole slots + 1 partial (if any remainder)
  if (frac > 0 && avail.length + partialOnly.length >= nFull + 1 && avail.length >= nFull) {
    // prefix sums of whole-slot costs in sorted order
    const pre = [0];
    for (let k = 0; k < avail.length; k++) pre.push(pre[k] + a[avail[k]] + b[avail[k]]);
    let best = Infinity, bestP = -1, bestT = -1;
    for (let k = 0; k < avail.length; k++) {
      const t = avail[k];
      if (k >= nFull && avail.length < nFull + 1) break;
      if (k < nFull && avail.length < nFull + 1) continue;
      const whole = k < nFull ? pre[nFull + 1] - (a[t] + b[t]) : pre[nFull];
      const c = whole + frac * a[t] + b[t];
      if (c < best - 1e-12) { best = c; bestP = k; bestT = t; }
    }
    for (const t of partialOnly) {
      const c = pre[nFull] + frac * a[t] + b[t];
      if (c < best - 1e-12) { best = c; bestP = -1; bestT = t; }
    }
    if (bestT >= 0) {
      const wholeSlots = [];
      for (let k = 0, cnt = 0; cnt < nFull; k++) if (k !== bestP) { wholeSlots.push([avail[k], 1]); cnt++; }
      opts.push({ add: room, cost: best, slots: [...wholeSlots, [bestT, frac]].sort((x, y) => x[0] - y[0]) });
    }
  }
  return opts;
}

export function price(inst, duals, opts = {}) {
  const { trips, prices, params: P } = inst;
  const n = trips.length;
  const pi = duals.pi;                       // >= 0 per trip
  const mu = duals.mu || new Float64Array(N_SLOTS); // <= 0 per slot (power)
  const nu = duals.nu || new Float64Array(N_SLOTS); // <= 0 per slot (charger count)
  const sigma = duals.sigma || 0;            // <= 0 fleet row
  const fixedCost = opts.fixedCost ?? 0;      // per vehicle (phase A uses 1, energy 0)
  const energyWeight = opts.energyWeight ?? 1;
  const active = opts.active || null;         // Uint8Array of trips still to cover
  const maxFrac = opts.maxFrac || null;       // per-slot fraction of a charger's power still available (dive)
  const aCost = new Float64Array(N_SLOTS), bCost = new Float64Array(N_SLOTS);
  for (let t = 0; t < N_SLOTS; t++) {
    aCost[t] = energyWeight * prices[t] * inst.slotKwhGrid - mu[t] * P.chargerKw;
    bCost[t] = -nu[t];
  }
  const dhCost = energyWeight * P.deadheadPerMi;
  const labels = Array.from({ length: n }, () => []);
  const addLabel = (j, L) => {
    const arr = labels[j];
    for (const o of arr) if (o.rc <= L.rc + 1e-9 && o.soc >= L.soc - 1e-9) return false;
    for (let k = arr.length - 1; k >= 0; k--) if (L.rc <= arr[k].rc + 1e-9 && L.soc >= arr[k].soc - 1e-9) arr.splice(k, 1);
    arr.push(L);
    return true;
  };
  for (let j = 0; j < n; j++) {
    if (active && !active[j]) continue;
    const b = trips[j];
    // from depot at start of day (full)
    const d0 = inst.dh(P.depot, b.terminal, b.s - 30);
    if (inst.socMax - d0.kwh - b.need >= inst.socMin - 1e-9 && b.s - d0.min >= 0) {
      addLabel(j, { rc: fixedCost - sigma + d0.mi * dhCost - pi[j], soc: inst.socMax - d0.kwh - b.energy, prev: null, via: null });
    }
    for (let i = 0; i < j; i++) {
      if (active && !active[i]) continue;
      const a = trips[i];
      if (b.s < a.e) continue;
      const L = labels[i];
      if (!L.length) continue;
      const dd = inst.dh(a.terminal, b.terminal, a.e);
      if (a.e + dd.min <= b.s + 1e-9) {
        for (const la of L) {
          const soc = la.soc - dd.kwh;
          if (soc - b.need < inst.socMin - 1e-9) continue;
          addLabel(j, { rc: la.rc + dd.mi * dhCost - pi[j], soc: soc - b.energy, prev: la, from: i, via: null });
        }
      }
      // via depot with charging
      const toD = inst.dh(a.terminal, P.depot, a.e);
      const arr = a.e + toD.min;
      const fromD = inst.dh(P.depot, b.terminal, b.s - 30);
      const dep = b.s - fromD.min;
      if (dep - arr < SLOT_MIN) continue;
      for (const la of L) {
        const soc0 = la.soc - toD.kwh;
        if (soc0 < inst.socMin - 1e-9) continue;
        const ops = chargeOptions(inst, arr, dep, soc0, aCost, bCost, maxFrac);
        for (const o of ops) {
          if (o.add === 0) continue;
          const soc = soc0 + o.add - fromD.kwh;
          if (soc - b.need < inst.socMin - 1e-9) continue;
          addLabel(j, { rc: la.rc + (toD.mi + fromD.mi) * dhCost + o.cost - pi[j], soc: soc - b.energy, prev: la, from: i, via: o.slots });
        }
      }
    }
  }
  // close: go back to the depot and recharge to the start level before the next service day
  const ends = [];
  for (let i = 0; i < n; i++) {
    if (active && !active[i]) continue;
    const a = trips[i];
    const toD = inst.dh(a.terminal, P.depot, a.e);
    const arr = a.e + toD.min;
    for (const la of labels[i]) {
      const soc0 = la.soc - toD.kwh;
      if (soc0 < inst.socMin - 1e-9) continue;
      const need = inst.socMax - soc0;
      const ops = chargeOptions(inst, arr, N_SLOTS * SLOT_MIN, soc0, aCost, bCost, maxFrac);
      const o = ops[ops.length - 1];
      if (o.add < need - 1e-6) continue;
      const rc = la.rc + toD.mi * dhCost + o.cost;
      ends.push({ rc, la, i, tail: o.slots, toD });
    }
  }
  ends.sort((x, y) => x.rc - y.rc);
  const maxCols = opts.maxCols ?? 40;
  const out = [];
  const seen = new Set();
  for (const en of ends) {
    if (en.rc > -1e-7 || out.length >= maxCols) break;
    const col = reconstruct(inst, en);
    const key = col.trips.join(',') + '|' + col.charges.map((c) => c[0] + ':' + c[1].toFixed(3)).join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    col.rc = en.rc;
    out.push(col);
  }
  return { columns: out, bestRc: ends.length ? ends[0].rc : Infinity, labelCount: labels.reduce((s, l) => s + l.length, 0) };
}

function reconstruct(inst, en) {
  const tripsSeq = [], charges = [];
  for (const [t, f] of en.tail) charges.push([t, f]);
  let la = en.la, j = en.i;
  while (la) {
    tripsSeq.push(j);
    if (la.via) for (const [t, f] of la.via) charges.push([t, f]);
    j = la.from; la = la.prev;
  }
  tripsSeq.reverse();
  charges.sort((a, b) => a[0] - b[0]);
  return routeCost(inst, { trips: tripsSeq, charges });
}

// Recompute a route's true cost (energy $ at TOU price + deadhead wear) and miles.
export function routeCost(inst, col) {
  const { trips, params: P } = inst;
  let dhMi = 0;
  const seq = col.trips.map((i) => trips[i]);
  const depotCharges = new Set(col.charges.map((c) => c[0]));
  dhMi += inst.dh(P.depot, seq[0].terminal, seq[0].s - 30).mi;
  for (let k = 1; k < seq.length; k++) {
    const a = seq[k - 1], b = seq[k];
    const viaDepot = col.charges.some(([t]) => t * SLOT_MIN >= a.e && (t + 1) * SLOT_MIN <= b.s);
    if (viaDepot) dhMi += inst.dh(a.terminal, P.depot, a.e).mi + inst.dh(P.depot, b.terminal, b.s - 30).mi;
    else dhMi += inst.dh(a.terminal, b.terminal, a.e).mi;
  }
  const last = seq[seq.length - 1];
  dhMi += inst.dh(last.terminal, P.depot, last.e).mi;
  let energyCost = 0, gridKwh = 0;
  for (const [t, f] of col.charges) { energyCost += inst.prices[t] * inst.slotKwhGrid * f; gridKwh += inst.slotKwhGrid * f; }
  void depotCharges;
  return { trips: col.trips.slice(), charges: col.charges.map((c) => [c[0], c[1]]), dhMi, energyCost, gridKwh, cost: energyCost + dhMi * P.deadheadPerMi };
}

// ---------------------------------------------------------------- column generation master
// Rows: 0..n-1 cover (>= 1, with surplus s_j and artificial u_j), then lazily added power rows
// (sum kW <= subscription) and charger rows (sum plugs <= chargers), optional fleet row (<= K).
const BIG = 1e5;

export function solveMaster(inst, opts = {}) {
  const n = inst.trips.length;
  const mode = opts.mode || 'fleet'; // 'fleet': min #vehicles; 'cost': min $ with fleet <= K
  const K = opts.K ?? Infinity;
  const active = opts.active || new Uint8Array(n).fill(1);
  const capLeft = opts.capLeft || new Float64Array(N_SLOTS).fill(inst.params.subscriptionKw);
  const plugLeft = opts.plugLeft || new Float64Array(N_SLOTS).fill(inst.params.chargers);
  const kw = inst.params.chargerKw;
  const pool = opts.pool ? opts.pool.slice() : [];
  const newCols = [];
  const t0 = Date.now();
  const W = opts.vehicleWeight ?? 1000;
  const maxFrac = new Float64Array(N_SLOTS);
  for (let t = 0; t < N_SLOTS; t++) maxFrac[t] = plugLeft[t] >= 1 - 1e-9 ? Math.max(0, Math.min(1, capLeft[t] / kw)) : 0;
  const colCost = (c) => (mode === 'fleet' ? 1 : mode === 'weighted' ? W + c.cost : c.cost);

  // row layout
  const rows = []; // {type, key}
  const cover = new Int32Array(n).fill(-1);
  for (let j = 0; j < n; j++) if (active[j]) { cover[j] = rows.length; rows.push({ type: 'cover', j }); }
  const powerRow = new Int32Array(N_SLOTS).fill(-1), plugRow = new Int32Array(N_SLOTS).fill(-1);
  let fleetRow = -1;
  if (Number.isFinite(K)) { fleetRow = rows.length; rows.push({ type: 'fleet' }); }
  for (const t of opts.initialSlots || []) { powerRow[t] = rows.length; rows.push({ type: 'power', t }); plugRow[t] = rows.length; rows.push({ type: 'plug', t }); }

  let iterations = 0, generated = 0, rowsAdded = 0;
  let lp, routeIdx, lastRes;
  const buildLP = () => {
    const m = rows.length;
    const b = rows.map((r) => (r.type === 'cover' ? 1 : r.type === 'fleet' ? K : r.type === 'power' ? capLeft[r.t] : plugLeft[r.t]));
    lp = new LP(m, b);
    const basis = new Array(m);
    rows.forEach((r, i) => {
      if (r.type === 'cover') {
        lp.addCol([i], [-1], 0);              // surplus
        basis[i] = lp.addCol([i], [1], BIG);  // artificial (uncovered)
      } else {
        const sl = lp.addCol([i], [1], 0);    // slack
        const ov = lp.addCol([i], [-1], BIG); // overage (infeasible if used)
        basis[i] = b[i] >= 0 ? sl : ov;
      }
    });
    routeIdx = [];
    for (const c of pool) addRouteCol(c);
    lp.setBasis(basis);
  };
  const addRouteCol = (c) => {
    if (c.trips.some((j) => !active[j])) return;
    const idx = [], val = [];
    for (const j of c.trips) { idx.push(cover[j]); val.push(1); }
    if (fleetRow >= 0) { idx.push(fleetRow); val.push(1); }
    for (const [t, f] of c.charges) {
      if (powerRow[t] >= 0) { idx.push(powerRow[t]); val.push(kw * f); }
      if (plugRow[t] >= 0) { idx.push(plugRow[t]); val.push(1); }
    }
    const k = lp.addCol(idx, val, colCost(c));
    routeIdx.push([k, c]);
  };
  // seed pool with single-trip routes so every trip is coverable
  if (!pool.length) {
    for (let j = 0; j < n; j++) if (active[j]) {
      const r = price(inst, { pi: Float64Array.from({ length: n }, (_, i) => (i === j ? 1e6 : -1e6)) }, { active: Uint8Array.from({ length: n }, (_, i) => (i === j ? 1 : 0)), maxFrac, maxCols: 1 });
      if (r.columns[0]) { pool.push(r.columns[0]); newCols.push(r.columns[0]); }
    }
  }
  buildLP();

  const loadsFromLP = () => {
    const x = lp.values();
    const power = new Float64Array(N_SLOTS), plugs = new Float64Array(N_SLOTS);
    for (const [k, c] of routeIdx) {
      if (x[k] <= 1e-9) continue;
      for (const [t, f] of c.charges) { power[t] += x[k] * kw * f; plugs[t] += x[k]; }
    }
    return { x, power, plugs };
  };

  for (;;) {
    lastRes = lp.solve();
    if (lastRes.status !== 'optimal') throw new Error('LP ' + lastRes.status);
    iterations++;
    const y = lastRes.y;
    const pi = new Float64Array(n), mu = new Float64Array(N_SLOTS), nu = new Float64Array(N_SLOTS);
    rows.forEach((r, i) => {
      if (r.type === 'cover') pi[r.j] = y[i];
      else if (r.type === 'power') mu[r.t] = Math.min(0, y[i]);
      else if (r.type === 'plug') nu[r.t] = Math.min(0, y[i]);
    });
    const sigma = fleetRow >= 0 ? Math.min(0, y[fleetRow]) : 0;
    const pr = price(inst, { pi, mu, nu, sigma }, { fixedCost: mode === 'fleet' ? 1 : mode === 'weighted' ? W : 0, energyWeight: mode === 'fleet' ? 0 : 1, active, maxFrac, maxCols: opts.maxCols ?? 30 });
    if (pr.columns.length) {
      for (const c of pr.columns) { pool.push(c); newCols.push(c); addRouteCol(c); generated++; }
      continue;
    }
    // no improving column: check lazily-omitted capacity rows
    const { power, plugs } = loadsFromLP();
    const viol = [];
    for (let t = 0; t < N_SLOTS; t++) {
      if (powerRow[t] < 0 && power[t] > capLeft[t] + 1e-6) viol.push(t);
      else if (plugRow[t] < 0 && plugs[t] > plugLeft[t] + 1e-6) viol.push(t);
    }
    if (!viol.length) break;
    for (const t of viol) {
      if (powerRow[t] < 0) { powerRow[t] = rows.length; rows.push({ type: 'power', t }); rowsAdded++; }
      if (plugRow[t] < 0) { plugRow[t] = rows.length; rows.push({ type: 'plug', t }); rowsAdded++; }
    }
    buildLP();
  }
  const { x, power, plugs } = loadsFromLP();
  let artificial = 0;
  const artRows = [];
  rows.forEach((r, i) => { const k = lp.basis[i]; if (lp.cost[k] === BIG && lp.xB[i] > 1e-9) { artificial += lp.xB[i]; artRows.push({ ...r, v: lp.xB[i] }); } });
  const sol = routeIdx.filter(([k]) => x[k] > 1e-7).map(([k, c]) => ({ x: x[k], col: c }));
  return {
    obj: lastRes.obj, feasible: artificial < 1e-6, artRows, solution: sol, pool, newCols, power, plugs,
    stats: { iterations, generated, rows: rows.length, lazyRows: rowsAdded, ms: Date.now() - t0 },
    activeSlots: rows.filter((r) => r.type === 'power').map((r) => r.t),
  };
}

// ---------------------------------------------------------------- integer plan: price-and-dive
// Fix the column with the largest LP value, remove its trips and capacity, re-optimize with
// column generation, repeat. Returns a feasible integer plan (or null) and the root LP bound.
export function priceAndDive(inst, opts = {}) {
  const n = inst.trips.length;
  const mode = opts.mode || 'weighted';
  const kw = inst.params.chargerKw;
  const pool = opts.pool ? opts.pool.slice() : [];
  const slots = new Set(opts.initialSlots || []);
  const stats = { iterations: 0, generated: 0, dives: 0, backtracks: 0 };
  const budget = opts.backtracks ?? 40;
  const keyOf = (c) => c.trips.join(',') + '|' + c.charges.map((x) => x[0] + ':' + x[1].toFixed(3)).join(',');
  let root = null;
  // state
  const active = new Uint8Array(n).fill(1);
  const capLeft = new Float64Array(N_SLOTS).fill(inst.params.subscriptionKw);
  const plugLeft = new Float64Array(N_SLOTS).fill(inst.params.chargers);
  const chosen = [];
  const fits = (c) => c.charges.every(([t, f]) => capLeft[t] - kw * f >= -1e-6 && plugLeft[t] - 1 >= -1e-9);
  const apply = (c, sgn) => {
    for (const j of c.trips) active[j] = sgn > 0 ? 0 : 1;
    for (const [t, f] of c.charges) { capLeft[t] -= sgn * kw * f; plugLeft[t] -= sgn; }
  };
  const lpAt = () => {
    const r = solveMaster(inst, { mode, K: Number.isFinite(opts.K) ? opts.K - chosen.length : Infinity, vehicleWeight: opts.vehicleWeight, active, capLeft, plugLeft, pool: pool.filter((c) => c.trips.every((j) => active[j]) && fits(c)), initialSlots: [...slots] });
    for (const t of r.activeSlots) slots.add(t);
    stats.iterations += r.stats.iterations; stats.generated += r.stats.generated;
    for (const c of r.newCols) pool.push(c);
    if (!root) root = r;
    return r;
  };
  // depth-first dive; each level tries candidates in order of LP value until one stays feasible
  const deadline = opts.deadline ?? Infinity;
  const dive = () => {
    if (!active.some((a) => a)) return true;
    if (Date.now() > deadline) return false;
    const r = lpAt();
    if (!r.feasible) return false;
    // LP load per slot, used to prefer candidates that leave room for the rest of the LP solution
    const load = new Float64Array(N_SLOTS);
    for (const s of r.solution) for (const [t, f] of s.col.charges) load[t] += s.x * kw * f;
    const slack = (c, x) => { let m = Infinity; for (const [t, f] of c.charges) m = Math.min(m, capLeft[t] - kw * f - (load[t] - x * kw * f)); return m; };
    const rnd = opts.rng;
    const cands = r.solution.filter((s) => s.x > 1e-6 && fits(s.col))
      .map((s) => ({ ...s, ok: slack(s.col, s.x) >= -1e-6, jitter: rnd ? rnd() * (opts.jitter ?? 0.3) : 0 }))
      .sort((a, b) => (b.ok - a.ok) || (b.x + b.jitter) - (a.x + a.jitter) || b.col.trips.length - a.col.trips.length);
    const tried = new Set();
    for (const cand of cands) {
      const k = keyOf(cand.col);
      if (tried.has(k)) continue;
      tried.add(k);
      stats.dives++;
      chosen.push(cand.col); apply(cand.col, +1);
      if (dive()) return true;
      chosen.pop(); apply(cand.col, -1);
      if (++stats.backtracks > budget) return false;
      if (cand.x > 1 - 1e-6) break; // an integral column that fails means this subtree is dead
    }
    return false;
  };
  let ok = dive();
  let restarts = 0;
  const maxRestarts = opts.restarts ?? 6;
  while (!ok && restarts < maxRestarts && Date.now() < deadline) {
    restarts++;
    // reset state and dive again with a seeded random tie-break among near-equal candidates
    active.fill(1); capLeft.fill(inst.params.subscriptionKw); plugLeft.fill(inst.params.chargers); chosen.length = 0;
    opts.rng = mulberry32(1000 + restarts); opts.jitter = 0.15 + 0.05 * restarts;
    stats.backtracks = 0;
    ok = dive();
  }
  stats.restarts = restarts;
  return { plan: ok ? chosen.slice() : null, root, stats, reason: ok ? null : 'dive failed after ' + restarts + ' restarts' };
}

// ---------------------------------------------------------------- full planning pipeline
export function plan(inst, opts = {}) {
  const t0 = Date.now();
  const lb0 = matchingLowerBound(inst);
  // Phase A: minimum fleet LP (column generation to optimality) -> certified lower bound
  const A = solveMaster(inst, { mode: 'fleet' });
  const lbLP = A.feasible ? Math.ceil(A.obj - 1e-6) : null;
  if (!A.feasible) return { infeasible: true, lowerBounds: { matching: lb0.bound, lp: null }, routes: [], fleet: null, stats: { phaseA: A.stats, ms: Date.now() - t0 } };
  // Phase B: lexicographic objective (haulers first, then $) by price-and-dive
  const W = opts.vehicleWeight ?? 1000;
  const deadline = t0 + (opts.timeBudgetMs ?? 6000);
  let best = priceAndDive(inst, { mode: 'weighted', vehicleWeight: W, pool: A.pool, initialSlots: A.activeSlots, deadline });
  // if the weighted dive used more haulers than the bound, also try a pure fleet dive
  if (!best.plan || best.plan.length > lbLP) {
    const F = priceAndDive(inst, { mode: 'fleet', pool: A.pool, initialSlots: A.activeSlots, deadline: Math.max(deadline, Date.now() + 1500) });
    if (F.plan && (!best.plan || F.plan.length < best.plan.length)) best = F;
  }
  if (best.plan && Date.now() < deadline) {
    const Kf = best.plan.length;
    const Cd = priceAndDive(inst, { mode: 'cost', K: Kf, pool: A.pool.concat(best.plan), initialSlots: A.activeSlots, deadline, restarts: 1 });
    if (Cd.plan && Cd.plan.length <= Kf && evaluate(inst, Cd.plan).cost < evaluate(inst, best.plan).cost) best = { ...Cd, stats: { ...best.stats, costDive: Cd.stats } };
  }
  let routes = best.plan ? polishCharging(inst, best.plan) : [];
  // incumbents (e.g. plans computed at a tighter subscription) are valid here if they pass the
  // validator; keep whichever plan uses fewer haulers, then costs less
  for (const inc of opts.incumbents || []) {
    const m = evaluate(inst, inc);
    if (!m.valid) continue;
    const cur = routes.length ? evaluate(inst, routes) : null;
    if (!cur || inc.length < routes.length || (inc.length === routes.length && m.cost < cur.cost - 1e-6)) {
      routes = polishCharging(inst, inc);
      best = { ...best, plan: routes, fromIncumbent: true };
    }
  }
  const fleet = routes.length ? routes.length : null;
  // cost bound at this fleet size: LP with sum x <= fleet, min $ (exact pricing)
  let costLpBound = null;
  if (fleet) {
    const C = solveMaster(inst, { mode: 'cost', K: fleet, pool: A.pool.concat(routes), initialSlots: A.activeSlots });
    if (C.feasible) costLpBound = C.obj;
  }
  const out = {
    lowerBounds: { matching: lb0.bound, lp: lbLP, lpValue: A.obj },
    fleet, provenOptimal: fleet !== null && fleet === lbLP,
    costLpBound, routes,
    stats: { phaseA: A.stats, dive: best.stats, fromIncumbent: !!best.fromIncumbent, ms: Date.now() - t0 },
  };
  out.metrics = fleet ? evaluate(inst, routes) : null;
  if (out.metrics && costLpBound !== null) out.costGap = Math.max(0, (out.metrics.cost - costLpBound) / out.metrics.cost);
  return out;
}

// Charging polish: inside each depot visit the hauler's state of charge only rises, so a charge
// block can move to any other slot of the same visit without changing feasibility. Move blocks
// from expensive to cheaper slots while site power and dispensers allow (cheapest-first).
export function polishCharging(inst, routes) {
  const { params: P, prices } = inst;
  const kw = P.chargerKw;
  const out = routes.map((r) => ({ ...r, charges: r.charges.map((c) => [c[0], c[1]]) }));
  const power = new Float64Array(N_SLOTS), plugs = new Float64Array(N_SLOTS);
  for (const r of out) for (const [t, f] of r.charges) { power[t] += kw * f; plugs[t] += 1; }
  for (let pass = 0; pass < 6; pass++) {
    let moved = 0;
    for (const r of out) {
      const W = depotWindows(inst, r).map(([a, b]) => [Math.ceil(a / SLOT_MIN - 1e-9), Math.floor(b / SLOT_MIN + 1e-9)]);
      const used = new Set(r.charges.map((c) => c[0]));
      const order = r.charges.slice().sort((a, b) => prices[b[0]] - prices[a[0]]);
      for (const c of order) {
        const t = c[0], f = c[1];
        const cands = [];
        for (const [a, b] of W) for (let u = a; u < b; u++) {
          if (used.has(u) || prices[u] >= prices[t] - 1e-9) continue;
          if (power[u] + kw * f > P.subscriptionKw + 1e-6 || plugs[u] + 1 > P.chargers + 1e-9) continue;
          cands.push(u);
        }
        cands.sort((x, y) => prices[x] - prices[y] || power[x] - power[y] || Math.abs(x - t) - Math.abs(y - t));
        for (const u of cands) {
          c[0] = u;
          if (routeFeasible(inst, r)) {
            power[t] -= kw * f; plugs[t] -= 1; power[u] += kw * f; plugs[u] += 1;
            used.delete(t); used.add(u); moved++;
            break;
          }
          c[0] = t;
        }
      }
      r.charges.sort((a, b) => a[0] - b[0]);
      Object.assign(r, routeCost(inst, r));
    }
    if (!moved) break;
  }
  return out;
}

// Depot visits of a route (minutes): between moves where the route charges, plus the night.
export function depotWindows(inst, r) {
  const P = inst.params;
  const seq = r.trips.map((i) => inst.trips[i]);
  const w = [];
  const visits = (a, b) => r.charges.some(([t]) => t * SLOT_MIN >= a.e && (t + 1) * SLOT_MIN <= b.s);
  for (let k = 1; k < seq.length; k++) {
    const a = seq[k - 1], b = seq[k];
    if (visits(a, b)) w.push([a.e + inst.dh(a.terminal, P.depot, a.e).min, b.s - inst.dh(P.depot, b.terminal, b.s - 30).min]);
  }
  const last = seq[seq.length - 1];
  w.push([last.e + inst.dh(last.terminal, P.depot, last.e).min, N_SLOTS * SLOT_MIN]);
  return w;
}

// Replay one route's state of charge (same rules as evaluate) and return true if it is feasible.
export function routeFeasible(inst, r) {
  const m = evaluate(inst, [r], { single: true });
  return m.errors.length === 0;
}

// ---------------------------------------------------------------- baseline: greedy dispatcher
// What a dispatch desk does without an optimizer: take moves in appointment order, give each to
// the hauler that has been idle longest among those that can reach the terminal in time with
// enough charge (else add a hauler); haulers wait at the depot between moves and plug in on
// arrival at full charger power, first come first served, until the site subscription is full.
export function greedyBaseline(inst, opts = {}) {
  const { trips, params: P } = inst;
  const kw = P.chargerKw;
  const cap = opts.ignoreCap ? Infinity : P.subscriptionKw;
  const power = new Float64Array(N_SLOTS), plugs = new Float64Array(N_SLOTS);
  const haulers = []; // {free, soc, routes:[...], charges:[]}
  const chargeUntil = (h, untilMin) => {
    // charge from h.free (at depot) until untilMin or full, greedy in time order
    const t0 = Math.ceil(h.depotSince / SLOT_MIN - 1e-9), t1 = Math.min(N_SLOTS, Math.floor(untilMin / SLOT_MIN + 1e-9));
    for (let t = Math.max(t0, h.chargedTo); t < t1; t++) {
      const room = inst.socMax - h.soc;
      if (room <= 1e-6) break;
      if (plugs[t] + 1 > P.chargers || power[t] + kw > cap + 1e-9) continue;
      const f = Math.min(1, room / inst.slotKwhBatt);
      power[t] += kw * f; plugs[t] += 1; h.soc += inst.slotKwhBatt * f; h.charges.push([t, f]);
    }
    h.chargedTo = Math.max(h.chargedTo, t1);
  };
  for (const b of trips) {
    let best = null;
    for (const h of haulers) {
      const toT = inst.dh(P.depot, b.terminal, b.s - 30);
      const leave = b.s - toT.min;
      if (h.depotSince > leave) continue;
      // tentatively charge up to departure (charging is committed only if chosen)
      const snapP = power.slice(), snapN = plugs.slice(), snap = { soc: h.soc, ch: h.charges.length, to: h.chargedTo };
      chargeUntil(h, leave);
      const ok = h.soc - toT.kwh - b.need >= inst.socMin - 1e-9;
      const cand = { h, ok, soc: h.soc, idle: h.depotSince };
      power.set(snapP); plugs.set(snapN); h.soc = snap.soc; h.charges.length = snap.ch; h.chargedTo = snap.to;
      if (ok && (!best || cand.idle < best.idle)) best = cand;
    }
    if (!best) {
      const h = { id: haulers.length, soc: inst.socMax, depotSince: 0, chargedTo: 0, charges: [], trips: [] };
      haulers.push(h);
      best = { h };
    }
    const h = best.h;
    const toT = inst.dh(P.depot, b.terminal, b.s - 30);
    chargeUntil(h, b.s - toT.min);
    h.soc -= toT.kwh + b.energy;
    const back = inst.dh(b.terminal, P.depot, b.e);
    h.soc -= back.kwh;
    h.depotSince = b.e + back.min;
    h.chargedTo = Math.max(h.chargedTo, Math.ceil(h.depotSince / SLOT_MIN - 1e-9));
    h.trips.push(b.idx);
  }
  for (const h of haulers) chargeUntil(h, N_SLOTS * SLOT_MIN);
  const routes = haulers.map((h) => routeCostBaseline(inst, h));
  const m = evaluate(inst, routes, { allowDepotReturns: true });
  return { fleet: haulers.length, routes, metrics: m };
}

function routeCostBaseline(inst, h) {
  const { trips, params: P } = inst;
  let dhMi = 0;
  for (const i of h.trips) { const b = trips[i]; dhMi += inst.dh(P.depot, b.terminal, b.s - 30).mi + inst.dh(b.terminal, P.depot, b.e).mi; }
  let energyCost = 0, gridKwh = 0;
  for (const [t, f] of h.charges) { energyCost += inst.prices[t] * inst.slotKwhGrid * f; gridKwh += inst.slotKwhGrid * f; }
  return { trips: h.trips.slice(), charges: h.charges.slice().sort((a, b) => a[0] - b[0]), dhMi, energyCost, gridKwh, cost: energyCost + dhMi * P.deadheadPerMi, depotReturns: true };
}

// ---------------------------------------------------------------- independent validator + metrics
// Replays every route from scratch: timing, state of charge at each step, charging only while
// parked at the depot, charge ceiling, end-of-day recharge, coverage, site power and plugs.
export function evaluate(inst, routes, opts = {}) {
  const { trips, params: P } = inst;
  const errors = [];
  const covered = new Int32Array(trips.length);
  const power = new Float64Array(N_SLOTS), plugs = new Float64Array(N_SLOTS);
  let energyCost = 0, gridKwh = 0, dhMi = 0, minSocSeen = Infinity;
  const timelines = [];
  routes.forEach((r, ri) => {
    const seq = r.trips.map((i) => trips[i]);
    const chargeSet = new Map(r.charges.map(([t, f]) => [t, f]));
    for (const [t, f] of r.charges) { power[t] += P.chargerKw * f; plugs[t] += 1; energyCost += inst.prices[t] * inst.slotKwhGrid * f; gridKwh += inst.slotKwhGrid * f; }
    let soc = inst.socMax;
    const events = [];
    const chargeBetween = (from, to) => { // apply charges in slots fully inside [from, to)
      for (const [t, f] of r.charges) {
        if (t * SLOT_MIN >= from - 1e-9 && (t + 1) * SLOT_MIN <= to + 1e-9) {
          soc += inst.slotKwhBatt * f;
          if (soc > inst.socMax + 1e-3) errors.push(`route ${ri}: charge above ceiling at slot ${t}`);
          chargeSet.delete(t);
        }
      }
    };
    let loc = P.depot, now = 0;
    for (let k = 0; k < seq.length; k++) {
      const b = seq[k];
      const prev = k ? seq[k - 1] : null;
      const viaDepot = k === 0 || r.depotReturns || r.charges.some(([t]) => prev && t * SLOT_MIN >= prev.e && (t + 1) * SLOT_MIN <= b.s);
      if (k > 0 && viaDepot) {
        const toD = inst.dh(prev.terminal, P.depot, prev.e);
        soc -= toD.kwh; dhMi += toD.mi; now = prev.e + toD.min; loc = P.depot;
        if (soc < inst.socMin - 1e-6) errors.push(`route ${ri}: below reserve reaching depot after ${prev.id}`);
      }
      if (loc === P.depot) {
        const toT = inst.dh(P.depot, b.terminal, b.s - 30);
        const leave = b.s - toT.min;
        if (leave < now - 1e-6) errors.push(`route ${ri}: cannot reach ${b.id} in time from depot`);
        chargeBetween(now, leave);
        events.push({ type: 'depot', from: now, to: leave });
        soc -= toT.kwh; dhMi += toT.mi;
      } else {
        const dd = inst.dh(prev.terminal, b.terminal, prev.e);
        if (prev.e + dd.min > b.s + 1e-6) errors.push(`route ${ri}: cannot reach ${b.id} in time`);
        soc -= dd.kwh; dhMi += dd.mi;
      }
      if (soc - b.need < inst.socMin - 1e-6) errors.push(`route ${ri}: below reserve during ${b.id} (start ${soc.toFixed(1)} kWh, needs ${b.need.toFixed(1)})`);
      minSocSeen = Math.min(minSocSeen, soc - b.need);
      events.push({ type: 'move', trip: b.idx, from: b.s, to: b.e, socStart: soc, socEnd: soc - b.energy });
      soc -= b.energy;
      covered[b.idx]++;
      now = b.e; loc = b.terminal;
    }
    if (seq.length) {
      const last = seq[seq.length - 1];
      const toD = inst.dh(last.terminal, P.depot, last.e);
      soc -= toD.kwh; dhMi += toD.mi; now = last.e + toD.min;
      if (soc < inst.socMin - 1e-6) errors.push(`route ${ri}: below reserve returning to depot`);
      chargeBetween(now, N_SLOTS * SLOT_MIN);
      events.push({ type: 'depot', from: now, to: N_SLOTS * SLOT_MIN });
    }
    if (chargeSet.size) errors.push(`route ${ri}: ${chargeSet.size} charge slot(s) while away from the depot`);
    if (soc < inst.socMax - 1e-2) errors.push(`route ${ri}: ends day at ${(soc / inst.capKwh * 100).toFixed(1)}% < start ${(inst.socMax / inst.capKwh * 100).toFixed(0)}%`);
    timelines.push({ events, endSoc: soc });
  });
  if (!opts.single) for (let j = 0; j < trips.length; j++) if (covered[j] !== 1) errors.push(`move ${trips[j].id} covered ${covered[j]} times`);
  let peakKw = 0, maxPlugs = 0, overKw = 0;
  for (let t = 0; t < N_SLOTS; t++) { peakKw = Math.max(peakKw, power[t]); maxPlugs = Math.max(maxPlugs, plugs[t]); }
  if (peakKw > P.subscriptionKw + 1e-6) overKw = peakKw - P.subscriptionKw;
  if (maxPlugs > P.chargers + 1e-9 && !opts.single) errors.push(`charger count exceeded: ${maxPlugs} > ${P.chargers}`);
  const byPeriod = { peak: 0, offPeak: 0, superOffPeak: 0 };
  for (let t = 0; t < N_SLOTS; t++) byPeriod[TARIFF_BEV2S.periodOfHour(Math.floor(slotHour(t)))] += (power[t] * SLOT_MIN) / 60;
  const moveMiles = routes.reduce((s, r) => s + r.trips.reduce((a, i) => a + trips[i].miles, 0), 0);
  return {
    valid: errors.length === 0 && overKw === 0, errors, overKw,
    fleet: routes.length, moves: trips.length, peakKw, maxPlugs,
    power: Array.from(power), plugs: Array.from(plugs),
    gridKwh, energyCost, dhMi, moveMiles,
    cost: energyCost + dhMi * P.deadheadPerMi,
    costPerMove: (energyCost + dhMi * P.deadheadPerMi) / Math.max(1, trips.length),
    peakShareKwh: byPeriod.peak, byPeriod, minMarginKwh: minSocSeen - inst.socMin, timelines,
  };
}

// ---------------------------------------------------------------- utilities
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
export function subscriptionMonthly(kw, tariff = TARIFF_BEV2S) {
  const blocks = Math.max(tariff.minBlocks, Math.ceil(kw / tariff.blockKw - 1e-9));
  return { blocks, kw: blocks * tariff.blockKw, monthly: blocks * tariff.blockMonthly };
}
export const __test = { chargeOptions };
