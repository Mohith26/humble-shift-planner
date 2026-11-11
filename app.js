// Humble Fleet: Shift plan (concept). UI layer; every number is computed by core/planner.mjs.
import * as P from './core/planner.mjs';

const $ = (s, r = document) => r.querySelector(s);
const app = $('#app');
const LS_KEY = 'humble-shift-plan:v1';
const BAY = new Set(['SanLeandro', 'Hayward', 'UnionCity', 'Newark', 'Richmond', 'Livermore', 'Fairfield']);
const fmt = (x, d = 0) => Number(x).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const usd = (x, d = 0) => '$' + fmt(x, d);
const clock = (m) => P.fmtClock(m);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const S = {
  data: null, results: null, places: null,
  applied: null,  // { params, result }
  inst: null, metrics: null, baseline: null, baselineUncapped: null,
  haulers: [],    // [{name, route, timeline}]
  draft: null, busy: false, worker: null, reqId: 0,
  moveFilter: { q: '', kind: 'all', sort: 's', dir: 1 },
};

// ------------------------------------------------------------------ boot
async function boot() {
  try {
    const [routes, moves, results] = await Promise.all(['data/routes.json', 'data/moves.json', 'data/results.json'].map(async (u) => {
      const r = await fetch(u); if (!r.ok) throw new Error(u + ' ' + r.status); return r.json();
    }));
    S.data = { routes: routes.routes, moves: moves.moves };
    S.places = routes.places; S.results = results; S.routesMeta = routes;
  } catch (e) {
    app.innerHTML = `<div class="err" style="margin-top:44px"><div class="eyebrow"><span class="num">!</span> Couldn't load plan data</div><p>${esc(e.message)}</p><button class="btn btn-white" onclick="location.reload()">Retry</button></div>`;
    return;
  }
  const defaults = { subscriptionKw: S.results.params.subscriptionKw, chargers: S.results.params.chargers, chargerKw: S.results.params.chargerKw, reserve: 10 };
  const committed = { params: defaults, result: { ...S.results.plan, routes: S.results.plan.routes } };
  let applied = committed;
  try { const saved = JSON.parse(localStorage.getItem(LS_KEY) || 'null'); if (saved && saved.result && saved.result.routes) applied = saved; } catch { /* ignore */ }
  const urlParams = paramsFromUrl(applied.params);
  setApplied(applied);
  initWorker();
  if (!sameParams(urlParams, applied.params)) {
    // deep link to another scenario: plan it now
    if (sameParams(urlParams, defaults)) setApplied(committed, true);
    else { route(); replan(urlParams, true); }
  }
  window.addEventListener('hashchange', route);
  route();
}

function paramsFromUrl(fallback) {
  const q = new URLSearchParams(location.search);
  const num = (k, d) => (q.has(k) && Number.isFinite(+q.get(k)) ? +q.get(k) : d);
  return { subscriptionKw: num('kw', fallback.subscriptionKw), chargers: num('disp', fallback.chargers), chargerKw: num('dkw', fallback.chargerKw), reserve: num('res', fallback.reserve) };
}
function sameParams(a, b) { return ['subscriptionKw', 'chargers', 'chargerKw', 'reserve'].every((k) => +a[k] === +b[k]); }
function writeUrl(p) {
  const q = new URLSearchParams({ kw: p.subscriptionKw, disp: p.chargers, dkw: p.chargerKw, res: p.reserve });
  history.replaceState(null, '', location.pathname + '?' + q.toString() + location.hash);
}
function buildInst(p) {
  return P.buildInstance(S.data, { subscriptionKw: p.subscriptionKw, chargers: p.chargers, chargerKw: p.chargerKw, vehicle: { reserveSoc: p.reserve / 100 } });
}

function setApplied(applied, persist) {
  S.applied = applied;
  S.inst = buildInst(applied.params);
  const routes = applied.result.routes || [];
  S.metrics = routes.length ? P.evaluate(S.inst, routes) : null;
  const t0 = performance.now();
  S.baseline = P.greedyBaseline(S.inst);
  S.baselineUncapped = P.greedyBaseline(S.inst, { ignoreCap: true });
  S.baselineMs = performance.now() - t0;
  // hauler names by first departure
  const order = routes.map((r, i) => ({ r, i, s: S.inst.trips[r.trips[0]].s })).sort((a, b) => a.s - b.s);
  S.haulers = order.map((o, k) => ({ name: 'H-' + String(k + 1).padStart(2, '0'), route: o.r, timeline: S.metrics.timelines[o.i] }));
  S.tripHauler = new Map();
  S.haulers.forEach((h) => h.route.trips.forEach((t) => S.tripHauler.set(t, h.name)));
  if (persist) { try { localStorage.setItem(LS_KEY, JSON.stringify(applied)); } catch { /* quota */ } }
  writeUrl(applied.params);
}

function initWorker() {
  try {
    S.worker = new Worker('worker.js', { type: 'module' });
    S.worker.onmessage = onWorker;
    S.worker.onerror = () => { S.worker = null; };
    S.worker.postMessage({ type: 'init', data: S.data });
  } catch { S.worker = null; }
}

// ------------------------------------------------------------------ re-plan (what-if)
function replan(params, autoApply) {
  if (S.busy) return;
  S.busy = true; S.draftParams = params; S.autoApply = !!autoApply;
  renderBusy();
  const incumbents = [S.applied.result.routes];
  const id = ++S.reqId;
  if (S.worker) S.worker.postMessage({ type: 'plan', id, params: { subscriptionKw: params.subscriptionKw, chargers: params.chargers, chargerKw: params.chargerKw, vehicle: { reserveSoc: params.reserve / 100 } }, incumbents });
  else setTimeout(() => {
    try {
      const inst = buildInst(params); const t0 = Date.now();
      const pl = P.plan(inst, { incumbents, timeBudgetMs: 5000 });
      onWorker({ data: { type: 'result', id, ms: Date.now() - t0, result: { ...pl, routes: pl.routes.map((r) => ({ trips: r.trips, charges: r.charges })) } } });
    } catch (e) { onWorker({ data: { type: 'error', id, message: e.message } }); }
  }, 30);
}

function onWorker(e) {
  const m = e.data;
  if (m.type === 'ready') return;
  if (m.id !== S.reqId) return;
  S.busy = false;
  if (m.type === 'error') { S.draft = { error: m.message }; toast('Re-plan failed: ' + m.message); route(); return; }
  const draft = { params: S.draftParams, result: m.result, ms: m.ms };
  if (m.result.routes.length) {
    const inst = buildInst(draft.params);
    draft.metrics = P.evaluate(inst, m.result.routes);
  }
  S.draft = draft;
  if (S.autoApply && m.result.routes.length) { applyDraft(true); return; }
  route();
}

function applyDraft(quiet) {
  if (!S.draft || !S.draft.result || !S.draft.result.routes.length) return;
  setApplied({ params: S.draft.params, result: S.draft.result }, true);
  S.draft = null;
  if (!quiet) toast(`Plan applied. ${S.applied.result.fleet} Haulers on ${fmt(S.applied.params.subscriptionKw)} kW.`);
  route();
}

// ------------------------------------------------------------------ router
function route() {
  const h = location.hash.replace(/^#\/?/, '') || 'plan';
  const [view, id] = h.split('/');
  document.querySelectorAll('.navlinks a').forEach((a) => a.classList.toggle('on', a.dataset.nav === (view === 'hauler' || view === 'haulers' ? 'plan' : view === 'move' ? 'moves' : view)));
  hideTip();
  if (!S.applied) return;
  if (view === 'hauler' || view === 'haulers') return renderHauler(id || (S.haulers[0] && S.haulers[0].name));
  if (view === 'moves') return renderMoves();
  if (view === 'move') return renderMove(id);
  if (view === 'lanes') return renderLanes();
  if (view === 'method') return renderMethod();
  return renderPlan();
}

function tabs(active) {
  const t = [['plan', '01', 'Plan'], ['haulers', '02', 'Haulers'], ['moves', '03', 'Moves'], ['lanes', '04', 'Lanes'], ['method', '05', 'Method']];
  return `<div class="tabs" role="tablist">${t.map(([k, n, l]) => `<a role="tab" aria-selected="${k === active}" class="${k === active ? 'on' : ''}" href="#/${k}"><span class="num">${n}</span>${l}</a>`).join('')}<span class="spacer"></span><span class="kbd"><kbd>?</kbd> shortcuts</span></div>`;
}

function header(title, sub, withImg) {
  const p = S.applied.params;
  return `<section class="head"><div><div class="eyebrow"><span class="num">01</span>SHIFT PLAN · PORT OF OAKLAND DRAYAGE · SERVICE DAY 05:00 TO 05:00</div><h1>${title}</h1><div class="sub">${sub || `${fmt(S.inst.trips.length)} container moves · ${fmt(p.subscriptionKw)} kW ${P.TARIFF_BEV2S.name} subscription · ${p.chargers} dispensers × ${p.chargerKw} kW`}</div></div>${withImg ? '<img class="hauler" src="assets/hauler.png" alt="Humble Hauler with a 40-foot container">' : ''}</section>`;
}

// ------------------------------------------------------------------ plan view
function renderPlan() {
  const r = S.applied.result, m = S.metrics, p = S.applied.params;
  const g = S.baseline, gu = S.baselineUncapped;
  const lb = r.lowerBounds;
  const sub = P.subscriptionMonthly(p.subscriptionKw);
  const gSub = P.subscriptionMonthly(gu.metrics.peakKw);
  const title = r.fleet ? `<span class="grad">${r.fleet} Haulers</span> cover all ${S.inst.trips.length} moves` : 'No feasible plan';
  app.innerHTML = header(title, null, true) + tabs('plan') + `
  <section class="kpis" aria-label="Plan summary">
    <div class="kpi"><div class="lab"><span class="num">01</span>Haulers needed</div><div class="val">${r.fleet ?? 'none'}${r.provenOptimal ? ' <span class="badge ok" title="Equal to the LP lower bound">Proven minimum</span>' : r.fleet ? ` <span class="badge warn">bound ${lb.lp}</span>` : ''}</div>
      <div class="cmp">First-come dispatch: <span class="bad">${g.fleet}</span>${g.metrics.valid ? '' : ' (and cannot recharge by 05:00)'} · bound ${lb.lp}</div></div>
    <div class="kpi"><div class="lab"><span class="num">02</span>Grid peak</div><div class="val">${fmt(m.peakKw)}<small>/ ${fmt(p.subscriptionKw)} kW</small></div>
      <div class="cmp">${sub.blocks} BEV-2 blocks (${usd(sub.monthly)}/mo) · first-come uncapped: <span class="bad">${fmt(gu.metrics.peakKw)} kW</span></div></div>
    <div class="kpi"><div class="lab"><span class="num">03</span>Energy cost / day</div><div class="val">${usd(m.energyCost)}<small>${usd(m.energyCost / S.inst.trips.length, 2)}/move</small></div>
      <div class="cmp">First-come: <span class="bad">${usd(g.metrics.energyCost)}</span> · <b>${fmt(100 * (1 - m.energyCost / g.metrics.energyCost))}% less</b> · ${fmt(m.byPeriod.peak)} kWh in 4-9 PM peak</div></div>
    <div class="kpi"><div class="lab"><span class="num">04</span>Moves covered</div><div class="val">${S.inst.trips.length}<small>/ ${S.data.moves.length}</small></div>
      <div class="cmp">${m.valid ? '<b>Validated</b>: every SOC, slot and dispenser replayed' : '<span class="bad">' + m.errors.length + ' issues</span>'} · min reserve margin ${fmt(m.minMarginKwh)} kWh</div></div>
  </section>
  <div class="grid2">
    <div>
      <section class="panel" aria-label="Hauler schedule">
        <div class="ph"><span class="num">05</span><h2>Hauler schedule</h2><div class="meta"><span>${fmt(m.gridKwh)} kWh from grid</span><span>${fmt(m.dhMi)} deadhead mi</span></div></div>
        <div class="pb">${gantt()}<div class="legend" style="margin-top:12px">
          <span><i style="background:var(--green)"></i>Bay Area move</span><span><i style="background:var(--lime)"></i>Central Valley move</span>
          <span><i style="background:repeating-linear-gradient(135deg,var(--lime) 0 3px,#c8d67e 3px 5px)"></i>Export (loaded on return)</span>
          <span><i style="background:var(--eblue);height:4px"></i>Charging</span><span><i style="background:var(--orange);height:4px"></i>Charging in 4-9 PM peak</span>
          <span><i style="background:#ecfd9a33"></i>Super off-peak 9-2</span><span><i style="background:#ef682c40"></i>Peak 4-9</span></div></div>
      </section>
      <section class="panel" aria-label="Depot load">
        <div class="ph"><span class="num">06</span><h2>Depot load, 15-minute intervals</h2><div class="meta">PG&amp;E bills the worst 15 minutes over the subscription at $3.82/kW</div></div>
        <div class="pb">${loadChart()}</div>
      </section>
    </div>
    <aside>
      ${certificate()}
      ${frontierPanel()}
      ${whatIf()}
    </aside>
  </div>`;
  bindGantt();
  bindWhatIf();
}

function regionClass(dc) { return BAY.has(dc) ? 'mv-bay' : 'mv-cv'; }
function xPct(min) { return (100 * min) / (P.N_SLOTS * P.SLOT_MIN); }

function touStrip() {
  let s = '';
  for (let t = 0; t < P.N_SLOTS; t++) {
    const per = P.TARIFF_BEV2S.periodOfHour(Math.floor(P.slotHour(t)));
    if (per === 'offPeak') continue;
    s += `<i style="left:${xPct(t * 15)}%;width:${xPct(15)}%;background:${per === 'peak' ? '#ef682c59' : '#ecfd9a33'}"></i>`;
  }
  return s;
}

function gantt() {
  const ticks = [];
  for (let h = 0; h <= 24; h += 3) ticks.push(`<span style="left:${xPct(h * 60)}%">${clock(h * 60)}</span>`);
  const grid = [];
  for (let h = 3; h < 24; h += 3) grid.push(`<i style="left:${xPct(h * 60)}%"></i>`);
  const rows = S.haulers.map((h, k) => {
    const bars = [];
    for (const ti of h.route.trips) {
      const t = S.inst.trips[ti];
      const cls = `${regionClass(t.dc)} ${t.kind === 'export' ? 'mv-exp' : ''}`;
      bars.push(`<span class="bar ${cls}" data-trip="${ti}" style="left:${xPct(t.s)}%;width:${Math.max(0.25, xPct(t.e - t.s))}%"></span>`);
    }
    for (const [t, f] of h.route.charges) {
      const peak = P.TARIFF_BEV2S.periodOfHour(Math.floor(P.slotHour(t))) === 'peak';
      bars.push(`<span class="bar chg ${peak ? 'peak' : ''}" data-chg="${h.name}:${t}:${f}" style="left:${xPct(t * 15)}%;width:${Math.max(0.15, xPct(15 * f) - 0.05)}%"></span>`);
    }
    return `<div class="g-row" data-h="${h.name}" role="link" tabindex="0" aria-label="${h.name}: ${h.route.trips.length} moves"><span class="rl">${h.name}</span><div class="g-track">${bars.join('')}</div></div>`;
  });
  return `<div class="gantt" id="gantt"><div class="g-axis"><span></span><div class="g-ticks">${ticks.join('')}<div class="g-tou">${touStrip()}</div></div></div><div class="g-grid">${grid.join('')}</div>${rows.join('')}</div>`;
}

function bindGantt() {
  const g = $('#gantt'); if (!g) return;
  g.addEventListener('mousemove', (e) => {
    const b = e.target.closest('.bar');
    if (!b) return hideTip();
    if (b.dataset.trip) showTip(e, tripTip(+b.dataset.trip));
    else { const [hn, t, f] = b.dataset.chg.split(':'); showTip(e, chargeTip(hn, +t, +f)); }
  });
  g.addEventListener('mouseleave', hideTip);
  g.addEventListener('click', (e) => { const row = e.target.closest('.g-row'); const bar = e.target.closest('.bar'); if (bar && bar.dataset.trip) location.hash = '#/move/' + S.inst.trips[+bar.dataset.trip].id; else if (row) location.hash = '#/hauler/' + row.dataset.h; });
  g.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.dataset.h) location.hash = '#/hauler/' + e.target.dataset.h; });
}

function tripTip(ti) {
  const t = S.inst.trips[ti];
  const ev = findMoveEvent(ti);
  return `<div class="t1">${t.id} · ${t.kind.toUpperCase()} · ${S.tripHauler.get(ti)}</div>
  <div class="row"><span>${esc(S.places[t.terminal].name.split(' (')[0])} → ${esc(S.places[t.dc].name)}</span></div>
  <div class="row"><span>Gate appointment</span><b>${clock(t.s)}</b></div><div class="row"><span>Back at terminal</span><b>${clock(t.e)}</b></div>
  <div class="row"><span>Distance</span><b>${fmt(t.miles, 1)} mi</b></div><div class="row"><span>Energy</span><b>${fmt(t.energy, 1)} kWh</b></div>
  <div class="row"><span>Cargo</span><b>${fmt(t.cargo_t, 1)} t</b></div>
  ${ev ? `<div class="row"><span>State of charge</span><b>${pct(ev.socStart)} → ${pct(ev.socEnd)}</b></div>` : ''}`;
}
function chargeTip(hn, t, f) {
  const kw = S.applied.params.chargerKw * f;
  const per = P.TARIFF_BEV2S.periodOfHour(Math.floor(P.slotHour(t)));
  return `<div class="t1">${hn} · CHARGING</div><div class="row"><span>Slot</span><b>${clock(t * 15)}-${clock(t * 15 + 15)}</b></div>
  <div class="row"><span>Power</span><b>${fmt(kw)} kW</b></div><div class="row"><span>Rate</span><b>${per === 'peak' ? 'Peak' : per === 'superOffPeak' ? 'Super off-peak' : 'Off-peak'} $${S.inst.prices[t].toFixed(5)}/kWh</b></div>
  <div class="row"><span>Cost</span><b>${usd(S.inst.prices[t] * S.inst.slotKwhGrid * f, 2)}</b></div>`;
}
function pct(kwh) { return fmt((100 * kwh) / S.inst.capKwh) + '%'; }
function findMoveEvent(ti) {
  for (const h of S.haulers) for (const ev of h.timeline.events) if (ev.type === 'move' && ev.trip === ti) return ev;
  return null;
}
function showTip(e, html) {
  const tip = $('#tip'); tip.innerHTML = html; tip.style.display = 'block';
  const w = tip.offsetWidth, hgt = tip.offsetHeight;
  tip.style.left = Math.min(window.innerWidth - w - 12, e.clientX + 14) + 'px';
  tip.style.top = Math.min(window.innerHeight - hgt - 12, e.clientY + 14) + 'px';
}
function hideTip() { const t = $('#tip'); if (t) t.style.display = 'none'; }

function loadChart() {
  const W = 860, H = 230, L = 46, R = 10, T = 12, B = 26;
  const p = S.applied.params;
  const plan = S.metrics.power, base = S.baselineUncapped.metrics.power;
  const ymax = Math.ceil(Math.max(p.subscriptionKw, ...base, ...plan) / 250) * 250 + 50;
  const x = (t) => L + ((W - L - R) * t) / P.N_SLOTS, y = (v) => T + (H - T - B) * (1 - v / ymax);
  let bands = '';
  for (let t = 0; t < P.N_SLOTS; t++) {
    const per = P.TARIFF_BEV2S.periodOfHour(Math.floor(P.slotHour(t)));
    if (per !== 'offPeak') bands += `<rect x="${x(t)}" y="${T}" width="${x(t + 1) - x(t) + 0.3}" height="${H - T - B}" fill="${per === 'peak' ? '#ef682c' : '#ecfd9a'}" opacity="${per === 'peak' ? 0.1 : 0.06}"/>`;
  }
  let grid = '';
  for (let v = 0; v <= ymax; v += 250) grid += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="#fafff2" stroke-opacity=".07"/><text x="${L - 6}" y="${y(v) + 3}" text-anchor="end">${fmt(v)}</text>`;
  for (let h = 0; h <= 24; h += 3) grid += `<text x="${x(h * 4)}" y="${H - 8}" text-anchor="middle">${clock(h * 60)}</text>`;
  const step = (arr) => arr.map((v, t) => `${t ? 'L' : 'M'}${x(t)},${y(v)} L${x(t + 1)},${y(v)}`).join(' ');
  const area = `${step(plan)} L${x(P.N_SLOTS)},${y(0)} L${x(0)},${y(0)} Z`;
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Depot power by 15-minute slot: plan peak ${fmt(S.metrics.peakKw)} kW, first-come peak ${fmt(S.baselineUncapped.metrics.peakKw)} kW">
    <defs><linearGradient id="lg" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#83ecff" stop-opacity=".55"/><stop offset="1" stop-color="#83ecff" stop-opacity=".05"/></linearGradient></defs>
    ${bands}${grid}
    <path d="${area}" fill="url(#lg)"/><path d="${step(plan)}" fill="none" stroke="#83ecff" stroke-width="1.5"/>
    <path d="${step(base)}" fill="none" stroke="#ef682c" stroke-width="1.2" stroke-dasharray="4 3"/>
    <line x1="${L}" x2="${W - R}" y1="${y(p.subscriptionKw)}" y2="${y(p.subscriptionKw)}" stroke="#ecfd9a" stroke-width="1.2"/>
    <text x="${W - R - 4}" y="${y(p.subscriptionKw) - 5}" text-anchor="end" style="fill:#ecfd9a">Subscription ${fmt(p.subscriptionKw)} kW</text>
  </svg><div class="chart-note"><span><i style="background:#83ecff"></i>Shift plan</span><span><i style="background:#ef682c"></i>First-come charging (no limit): peak ${fmt(S.baselineUncapped.metrics.peakKw)} kW, ${usd(S.baselineUncapped.metrics.energyCost)}/day</span><span><i style="background:#ecfd9a"></i>Subscription</span></div>`;
}

function certificate() {
  const r = S.applied.result, lb = r.lowerBounds;
  const st = r.stats || {};
  const vals = [r.fleet, S.baseline.fleet, lb.lp, lb.matching].filter((v) => v != null);
  const lo = Math.min(...vals) - 2, hi = Math.max(...vals);
  const bar = (v) => `${Math.max(6, (70 * (v - lo)) / (hi - lo))}px`;
  return `<section class="panel" aria-label="Optimality certificate"><div class="ph"><span class="num">07</span><h2>Certificate</h2><div class="meta">${r.provenOptimal ? '<span class="badge ok">Optimal</span>' : `<span class="badge warn">gap ${r.fleet && lb.lp ? r.fleet - lb.lp : '?'}</span>`}</div></div>
  <div class="pb"><div class="ladder">
    <div class="st"><span class="n">${lb.matching}</span><div class="b" style="height:${bar(lb.matching)}"></div><span class="lb">No-battery bound</span></div>
    <div class="st"><span class="n">${lb.lp ?? '-'}</span><div class="b" style="height:${bar(lb.lp || 0)}"></div><span class="lb">LP bound</span></div>
    <div class="st hi"><span class="n">${r.fleet ?? '-'}</span><div class="b" style="height:${bar(r.fleet || 0)}"></div><span class="lb">This plan</span></div>
    <div class="st"><span class="n">${S.baseline.fleet}</span><div class="b" style="height:${bar(S.baseline.fleet)};background:#ef682c66"></div><span class="lb">First-come</span></div>
  </div>
  <div class="cert">
    <span class="k">LP relaxation (column generation, solved to optimality)</span><span class="v">${lb.lpValue != null ? fmt(lb.lpValue, 2) : '-'}</span>
    <span class="k">Energy cost vs LP bound at ${r.fleet ?? '-'} Haulers</span><span class="v">${r.costGap != null ? '+' + fmt(100 * r.costGap, 1) + '%' : '-'}</span>
    <div class="hr"></div>
    <span class="k">Pricing rounds / routes generated</span><span class="v">${st.phaseA ? fmt(st.phaseA.iterations) + ' / ' + fmt(st.phaseA.generated + (st.dive ? st.dive.generated : 0)) : '-'}</span>
    <span class="k">Capacity rows added lazily</span><span class="v">${st.phaseA ? fmt(st.phaseA.lazyRows) : '-'}</span>
    <span class="k">Solve time</span><span class="v">${st.ms != null ? fmt(st.ms / 1000, 2) + ' s' : '-'}</span>
  </div></div></section>`;
}

function frontierPanel() {
  const F = S.results.frontier, cur = S.applied.params.subscriptionKw;
  const W = 380, H = 190, L = 34, R = 10, T = 14, B = 30;
  const xs = F.map((f) => f.subscriptionKw);
  const vals = F.flatMap((f) => [f.fleet, f.lbLP, f.greedyFleet]).filter((v) => v != null);
  const y0 = Math.min(...vals) - 1, y1 = Math.max(...vals) + 1;
  const x = (v) => L + ((W - L - R) * (v - xs[0])) / (xs[xs.length - 1] - xs[0]);
  const y = (v) => T + (H - T - B) * (1 - (v - y0) / (y1 - y0));
  let g = '';
  for (let v = y0; v <= y1; v++) g += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="#fafff2" stroke-opacity=".06"/><text x="${L - 6}" y="${y(v) + 3}" text-anchor="end">${v}</text>`;
  for (const f of F) g += `<text x="${x(f.subscriptionKw)}" y="${H - 12}" text-anchor="middle">${f.subscriptionKw >= 1000 ? (f.subscriptionKw / 1000).toFixed(1) + 'k' : f.subscriptionKw}</text>`;
  const line = (key) => F.filter((f) => f[key] != null).map((f, i) => `${i ? 'L' : 'M'}${x(f.subscriptionKw)},${y(f[key])}`).join(' ');
  const pts = F.map((f) => (f.fleet != null ? `<circle cx="${x(f.subscriptionKw)}" cy="${y(f.fleet)}" r="${f.subscriptionKw === cur ? 5 : 3.5}" fill="${f.proven ? '#81f2b2' : '#0000'}" stroke="#81f2b2" stroke-width="1.5"><title>${f.subscriptionKw} kW: ${f.fleet} Haulers${f.proven ? ' (proven)' : ''}</title></circle>` : `<text x="${x(f.subscriptionKw)}" y="${y(f.lbLP ?? y1) - 8}" text-anchor="middle" style="fill:#ef682c">?</text>`)).join('');
  const greedyInvalid = F.filter((f) => !f.greedyValid).map((f) => `<circle cx="${x(f.subscriptionKw)}" cy="${y(f.greedyFleet)}" r="3.5" fill="#000" stroke="#ef682c" stroke-width="1.5"><title>${f.subscriptionKw} kW: first-come dispatch cannot recharge the fleet</title></circle>`).join('');
  const tightest = F.filter((f) => f.fleet != null && f.proven).sort((a, b) => a.subscriptionKw - b.subscriptionKw)[0];
  const greedyMin = F.filter((f) => f.greedyValid).sort((a, b) => a.subscriptionKw - b.subscriptionKw)[0];
  return `<section class="panel" aria-label="Fleet versus grid subscription"><div class="ph"><span class="num">08</span><h2>Haulers vs grid subscription</h2><div class="meta">precomputed</div></div>
  <div class="pb"><svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Haulers needed at each subscription level">${g}
    <line x1="${x(cur)}" x2="${x(cur)}" y1="${T}" y2="${H - B}" stroke="#ecfd9a" stroke-opacity=".5" stroke-dasharray="2 3"/>
    <path d="${line('greedyFleet')}" fill="none" stroke="#ef682c" stroke-width="1.2" stroke-dasharray="4 3"/>${greedyInvalid}
    <path d="${line('lbLP')}" fill="none" stroke="#ecfd9a" stroke-width="1" stroke-opacity=".7"/>
    <path d="${line('fleet')}" fill="none" stroke="#81f2b2" stroke-width="1.5"/>${pts}</svg>
  <div class="chart-note"><span><i style="background:#81f2b2"></i>Plan (filled = proven)</span><span><i style="background:#ecfd9a"></i>LP bound</span><span><i style="background:#ef682c"></i>First-come (hollow = can't recharge)</span></div>
  <p style="font-size:.85rem;color:var(--g-400);margin:10px 0 0">${tightest ? `Down to <b style="color:var(--optimist)">${fmt(tightest.subscriptionKw)} kW</b> the plan still needs only ${tightest.fleet} Haulers (proven). ` : ''}${greedyMin ? `First-come charging needs ${greedyMin.greedyFleet} Haulers and at least ${fmt(greedyMin.subscriptionKw)} kW to recharge the fleet by 05:00.` : ''}</p></div></section>`;
}

function whatIf() {
  const p = S.applied.params;
  const kwOpts = []; for (let v = 500; v <= 1600; v += 50) kwOpts.push(v);
  const sel = (id, opts, cur, fmtFn) => `<select id="${id}">${opts.map((o) => `<option value="${o}" ${+o === +cur ? 'selected' : ''}>${fmtFn(o)}</option>`).join('')}</select>`;
  const d = S.draft;
  let draftHtml = '';
  if (S.busy) draftHtml = `<div class="draft show"><div class="eyebrow"><span class="spin light"></span>Planning: column generation + dive (up to ~6 s)</div></div>`;
  else if (d && d.error) draftHtml = `<div class="draft show"><div class="eyebrow"><span class="num">!</span>Re-plan failed</div><p style="color:var(--g-400)">${esc(d.error)}</p></div>`;
  else if (d) {
    const ok = d.result.routes.length > 0;
    const cur = S.metrics;
    draftHtml = `<div class="draft show"><div class="eyebrow"><span class="num">●</span>DRAFT · ${fmt(d.params.subscriptionKw)} kW · ${d.params.chargers}×${d.params.chargerKw} kW · reserve ${d.params.reserve}% · ${fmt(d.ms / 1000, 1)} s</div>
      ${ok ? `<div class="dl"><span class="h"></span><span class="h">Applied</span><span class="h">Draft</span>
        <span>Haulers</span><span>${S.applied.result.fleet}</span><span>${d.result.fleet}${d.result.provenOptimal ? ' ✓' : ` (≥${d.result.lowerBounds.lp})`}</span>
        <span>Peak kW</span><span>${fmt(cur.peakKw)}</span><span>${fmt(d.metrics.peakKw)}</span>
        <span>$/day</span><span>${usd(cur.energyCost)}</span><span>${usd(d.metrics.energyCost)}</span>
        <span>Valid</span><span>${cur.valid ? 'yes' : 'no'}</span><span>${d.metrics.valid ? 'yes' : 'no'}</span></div>
        <div style="display:flex;gap:8px"><button class="btn btn-green btn-sm" id="applyBtn">Apply plan <kbd>A</kbd></button><button class="btn btn-ghost btn-sm" id="discardBtn">Discard</button></div>`
      : `<p style="color:var(--orange);margin:8px 0 0">${d.result.infeasible ? `No plan exists: the LP shows the grid cannot deliver the day's energy at ${fmt(d.params.subscriptionKw)} kW with these dispensers.` : `No plan found within the time budget. Lower bound: ${d.result.lowerBounds.lp} Haulers.`}</p>`}</div>`;
  }
  return `<section class="panel whatif" aria-label="What-if"><div class="ph"><span class="num">09</span><h2>What if</h2><div class="meta">re-solves in your browser</div></div><div class="pb">
    <div class="fields">
      <div class="field"><label for="f-kw">Grid subscription</label>${sel('f-kw', kwOpts, p.subscriptionKw, (v) => `${fmt(v)} kW · ${P.subscriptionMonthly(v).blocks} blocks`)}</div>
      <div class="field"><label for="f-disp">Dispensers</label>${sel('f-disp', [4, 6, 8, 10, 12], p.chargers, (v) => v)}</div>
      <div class="field"><label for="f-dkw">Dispenser power</label>${sel('f-dkw', [150, 250, 350], p.chargerKw, (v) => v + ' kW')}</div>
      <div class="field"><label for="f-res">Reserve at all times</label>${sel('f-res', [10, 15, 20], p.reserve, (v) => v + '%')}</div>
    </div>
    <div class="acts"><button class="btn btn-white btn-sm" id="replanBtn" ${S.busy ? 'disabled' : ''}>Re-plan <kbd>R</kbd></button>
      <button class="btn btn-ghost btn-sm" id="csvBtn">Dispatch CSV</button><button class="btn btn-ghost btn-sm" id="jsonBtn">Plan JSON</button>
      ${localStorage.getItem(LS_KEY) ? '<button class="btn btn-ghost btn-sm" id="resetBtn">Reset</button>' : ''}</div>
    ${draftHtml}</div></section>`;
}

function readWhatIf() {
  return { subscriptionKw: +$('#f-kw').value, chargers: +$('#f-disp').value, chargerKw: +$('#f-dkw').value, reserve: +$('#f-res').value };
}
function bindWhatIf() {
  const b = $('#replanBtn'); if (!b) return;
  b.onclick = () => replan(readWhatIf());
  const a = $('#applyBtn'); if (a) a.onclick = () => applyDraft();
  const d = $('#discardBtn'); if (d) d.onclick = () => { S.draft = null; route(); };
  $('#csvBtn').onclick = exportCsv; $('#jsonBtn').onclick = exportJson;
  const r = $('#resetBtn'); if (r) r.onclick = () => { localStorage.removeItem(LS_KEY); history.replaceState(null, '', location.pathname + location.hash); location.reload(); };
}
function renderBusy() { if ((location.hash || '#/plan').startsWith('#/plan') || location.hash === '') route(); }

// ------------------------------------------------------------------ hauler drill-down
function socSeries(h) {
  const inst = S.inst, pts = [];
  const r = h.route;
  const charges = r.charges.slice().sort((a, b) => a[0] - b[0]);
  let soc = inst.socMax, now = 0;
  pts.push([0, soc]);
  const chargeTo = (from, to) => {
    for (const [t, f] of charges) if (t * 15 >= from - 1e-9 && (t + 1) * 15 <= to + 1e-9) { pts.push([t * 15, soc]); soc += inst.slotKwhBatt * f; pts.push([t * 15 + 15 * f, soc]); }
  };
  for (const ev of h.timeline.events) {
    if (ev.type === 'depot') { pts.push([ev.from, pts[pts.length - 1][1]]); soc = pts[pts.length - 1][1]; chargeTo(ev.from, ev.to); pts.push([ev.to, soc]); }
    else { pts.push([ev.from, ev.socStart]); pts.push([ev.to, ev.socEnd]); soc = ev.socEnd; }
    now = ev.to;
  }
  void now;
  return pts;
}

function renderHauler(name) {
  const idx = Math.max(0, S.haulers.findIndex((h) => h.name === name));
  const h = S.haulers[idx];
  if (!h) { app.innerHTML = header('No Haulers in this plan') + tabs('haulers'); return; }
  const inst = S.inst;
  const pts = socSeries(h);
  const W = 860, H = 240, L = 40, R = 10, T = 12, B = 26;
  const x = (m) => L + ((W - L - R) * m) / 1440, y = (k) => T + (H - T - B) * (1 - k / inst.capKwh);
  let grid = '';
  for (const p of [0, 25, 50, 75, 100]) grid += `<line x1="${L}" x2="${W - R}" y1="${y((p / 100) * inst.capKwh)}" y2="${y((p / 100) * inst.capKwh)}" stroke="#fafff2" stroke-opacity=".07"/><text x="${L - 6}" y="${y((p / 100) * inst.capKwh) + 3}" text-anchor="end">${p}%</text>`;
  for (let hr = 0; hr <= 24; hr += 3) grid += `<text x="${x(hr * 60)}" y="${H - 8}" text-anchor="middle">${clock(hr * 60)}</text>`;
  let bands = '';
  for (const tr of h.route.trips) { const t = inst.trips[tr]; bands += `<rect x="${x(t.s)}" y="${T}" width="${x(t.e) - x(t.s)}" height="${H - T - B}" fill="${BAY.has(t.dc) ? '#81f2b2' : '#ecfd9a'}" opacity=".07"/>`; }
  const path = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join(' ');
  const rows = [];
  let cost = 0;
  for (const ev of h.timeline.events) {
    if (ev.type === 'move') {
      const t = inst.trips[ev.trip];
      rows.push(`<tr data-move="${t.id}"><td class="mono">${clock(t.s)}-${clock(t.e)}</td><td><b>${t.id}</b> <span class="pill ${t.kind === 'export' ? 'exp' : ''}">${t.kind}</span></td><td>${esc(S.places[t.terminal].name.split(' (')[0])} → ${esc(S.places[t.dc].name)}</td><td class="num">${fmt(t.miles, 1)} mi</td><td class="num">−${fmt(t.energy, 1)} kWh</td><td class="num">${pct(ev.socStart)} → ${pct(ev.socEnd)}</td></tr>`);
    } else {
      const cs = h.route.charges.filter(([t]) => t * 15 >= ev.from - 1e-9 && (t + 1) * 15 <= ev.to + 1e-9);
      if (!cs.length) continue;
      const kwh = cs.reduce((s, [, f]) => s + inst.slotKwhBatt * f, 0);
      const c = cs.reduce((s, [t, f]) => s + inst.prices[t] * inst.slotKwhGrid * f, 0); cost += c;
      const span = `${clock(cs[0][0] * 15)}-${clock(cs[cs.length - 1][0] * 15 + 15)}`;
      rows.push(`<tr class="chgrow"><td class="mono">${span}</td><td><span class="pill" style="color:var(--eblue);border-color:#83ecff40">charge</span></td><td>Depot, ${cs.length} × 15-min block${cs.length > 1 ? 's' : ''} at ${S.applied.params.chargerKw} kW</td><td class="num">${usd(c, 2)}</td><td class="num">+${fmt(kwh, 1)} kWh</td><td class="num"></td></tr>`);
    }
  }
  const prev = S.haulers[(idx - 1 + S.haulers.length) % S.haulers.length].name, next = S.haulers[(idx + 1) % S.haulers.length].name;
  const miles = h.route.trips.reduce((s, i) => s + inst.trips[i].miles, 0);
  app.innerHTML = `<div class="crumbs"><a href="#/plan">Shift plan</a><span>/</span><a href="#/haulers">Haulers</a><span>/</span><span>${h.name}</span></div>` +
    header(`<span class="grad">${h.name}</span> · ${h.route.trips.length} moves`, `${fmt(miles, 0)} loaded and empty miles · ${usd(cost, 2)} of charging · ${fmt(inst.capKwh)} kWh pack, ${fmt(100 * inst.vehicle.maxSoc)}% daily ceiling, ${S.applied.params.reserve}% reserve`, true) + tabs('haulers') + `
  <div class="toolbar"><a class="btn btn-ghost btn-sm" href="#/hauler/${prev}" aria-label="Previous Hauler (K)">← ${prev}</a><a class="btn btn-ghost btn-sm" href="#/hauler/${next}" aria-label="Next Hauler (J)">${next} →</a>
    <select class="search" style="flex:0 0 160px" id="hsel" aria-label="Jump to Hauler">${S.haulers.map((x2) => `<option ${x2.name === h.name ? 'selected' : ''}>${x2.name}</option>`).join('')}</select></div>
  <div class="dgrid"><div>
    <section class="panel"><div class="ph"><span class="num">01</span><h2>State of charge</h2><div class="meta">reserve ${S.applied.params.reserve}% · ceiling ${fmt(100 * inst.vehicle.maxSoc)}%</div></div><div class="pb">
      <svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="State of charge over the day for ${h.name}">
      <defs><linearGradient id="sg" x1="0" x2="1"><stop offset="0" stop-color="#edfd9a"/><stop offset="1" stop-color="#81f2b2"/></linearGradient></defs>
      ${bands}${grid}<line x1="${L}" x2="${W - R}" y1="${y(inst.socMin)}" y2="${y(inst.socMin)}" stroke="#ef682c" stroke-dasharray="4 3"/>
      <line x1="${L}" x2="${W - R}" y1="${y(inst.socMax)}" y2="${y(inst.socMax)}" stroke="#fafff2" stroke-opacity=".25" stroke-dasharray="2 3"/>
      <path d="${path}" fill="none" stroke="url(#sg)" stroke-width="2"/></svg>
      <div class="chart-note"><span><i style="background:linear-gradient(90deg,#edfd9a,#81f2b2)"></i>State of charge</span><span><i style="background:#ef682c"></i>Reserve</span><span>Shaded: on a move</span></div></div></section>
    <section class="panel"><div class="ph"><span class="num">02</span><h2>Day sheet</h2><div class="meta">click a move for its route and energy</div></div>
      <table class="tbl"><thead><tr><th>Time</th><th>Event</th><th>Where</th><th class="num">Dist / cost</th><th class="num">Energy</th><th class="num">SOC</th></tr></thead><tbody>${rows.join('')}</tbody></table></section>
  </div><aside>
    <section class="panel"><div class="ph"><span class="num">03</span><h2>Why this sequence</h2></div><div class="pb" style="color:var(--g-400);font-size:.9rem;line-height:1.55">
      ${whyText(h)}</div></section>
  </aside></div>`;
  $('#hsel').onchange = (e) => (location.hash = '#/hauler/' + e.target.value);
  app.querySelectorAll('tr[data-move]').forEach((tr) => (tr.onclick = () => (location.hash = '#/move/' + tr.dataset.move)));
}

function whyText(h) {
  const inst = S.inst;
  const ts = h.route.trips.map((i) => inst.trips[i]);
  const minEv = h.timeline.events.filter((e) => e.type === 'move').reduce((m, e) => Math.min(m, e.socStart - inst.trips[e.trip].need), Infinity);
  const peakBlocks = h.route.charges.filter(([t]) => P.TARIFF_BEV2S.periodOfHour(Math.floor(P.slotHour(t))) === 'peak').length;
  const nightBlocks = h.route.charges.filter(([t]) => P.slotHour(t) >= 21 || P.slotHour(t) < 5).length;
  const midBlocks = h.route.charges.filter(([t]) => P.TARIFF_BEV2S.periodOfHour(Math.floor(P.slotHour(t))) === 'superOffPeak').length;
  return `<p style="margin-top:0">${h.name} chains ${ts.length} moves (${ts.map((t) => S.places[t.dc].name).join(', ')}). The tightest point leaves <b style="color:var(--optimist)">${fmt(minEv - inst.socMin, 1)} kWh</b> above the ${S.applied.params.reserve}% reserve.</p>
  <p>Charging: ${midBlocks} block${midBlocks === 1 ? '' : 's'} in the 9 AM-2 PM super off-peak, ${nightBlocks} overnight, ${peakBlocks} in the 4-9 PM peak${peakBlocks ? ' (no cheaper slot was free while it was parked)' : ''}.</p>
  <p>Every block is a whole 15-minute interval at ${S.applied.params.chargerKw} kW (the last one may top off partially), which is how PG&amp;E measures demand on the BEV rate.</p>`;
}

// ------------------------------------------------------------------ moves table + move detail
function renderMoves() {
  const f = S.moveFilter;
  const inst = S.inst;
  let list = inst.trips.slice();
  if (f.kind !== 'all') list = list.filter((t) => t.kind === f.kind);
  if (f.q) { const q = f.q.toLowerCase(); list = list.filter((t) => [t.id, t.terminal, S.places[t.dc].name, S.tripHauler.get(t.idx) || ''].join(' ').toLowerCase().includes(q)); }
  const key = { s: (t) => t.s, id: (t) => t.id, mi: (t) => t.miles, kwh: (t) => t.energy, dc: (t) => S.places[t.dc].name, h: (t) => S.tripHauler.get(t.idx) || '' }[f.sort] || ((t) => t.s);
  list.sort((a, b) => (key(a) > key(b) ? 1 : key(a) < key(b) ? -1 : 0) * f.dir);
  const th = (k, l, num) => `<th class="${num ? 'num' : ''}" data-sort="${k}" aria-sort="${f.sort === k ? (f.dir > 0 ? 'ascending' : 'descending') : 'none'}">${l}${f.sort === k ? (f.dir > 0 ? ' ↑' : ' ↓') : ''}</th>`;
  const out = S.inst.outOfRange.length;
  app.innerHTML = header(`<span class="grad">${inst.trips.length} moves</span> on ${S.haulers.length} Haulers`, `Gate appointments at OICT, TraPac, Everport and Matson · ${fmt(inst.trips.reduce((s, t) => s + t.miles, 0))} miles · ${fmt(inst.trips.reduce((s, t) => s + t.energy, 0))} kWh${out ? ` · ${out} out of range` : ''}`) + tabs('moves') + `
  <div class="toolbar"><input class="search" id="q" placeholder="Search move, terminal, destination, Hauler  ( / )" value="${esc(f.q)}" aria-label="Search moves">
    <div class="chips">${['all', 'import', 'export'].map((k) => `<button class="chip ${f.kind === k ? 'on' : ''}" data-kind="${k}">${k[0].toUpperCase() + k.slice(1)}</button>`).join('')}</div>
    <span style="margin-left:auto;font-family:var(--mono);font-size:.75rem;color:var(--g-600)">${list.length} shown</span></div>
  <section class="panel">${list.length ? `<table class="tbl"><thead><tr>${th('id', 'Move')}${th('s', 'Gate appt')}<th>Type</th><th>Terminal</th>${th('dc', 'Destination')}<th class="num">Cargo</th>${th('mi', 'Miles', 1)}${th('kwh', 'kWh', 1)}<th class="num">% pack</th>${th('h', 'Hauler')}</tr></thead><tbody>
    ${list.map((t) => `<tr data-move="${t.id}"><td class="mono">${t.id}</td><td class="mono">${clock(t.s)}</td><td><span class="pill ${t.kind === 'export' ? 'exp' : ''}">${t.kind}</span></td><td>${t.terminal}</td><td>${esc(S.places[t.dc].name)}</td><td class="num">${fmt(t.cargo_t, 1)} t</td><td class="num">${fmt(t.miles, 1)}</td><td class="num">${fmt(t.energy, 1)}</td><td class="num">${fmt((100 * t.energy) / inst.capKwh)}%</td><td class="mono">${S.tripHauler.get(t.idx) || '-'}</td></tr>`).join('')}
  </tbody></table>` : `<div class="empty"><div class="t">No moves match</div>Try another search or clear the filter.</div>`}</section>`;
  const q = $('#q');
  q.oninput = () => { f.q = q.value; const pos = q.selectionStart; renderMoves(); const q2 = $('#q'); q2.focus(); q2.setSelectionRange(pos, pos); };
  app.querySelectorAll('.chip').forEach((c) => (c.onclick = () => { f.kind = c.dataset.kind; renderMoves(); }));
  app.querySelectorAll('th[data-sort]').forEach((h) => (h.onclick = () => { if (f.sort === h.dataset.sort) f.dir *= -1; else { f.sort = h.dataset.sort; f.dir = 1; } renderMoves(); }));
  app.querySelectorAll('tr[data-move]').forEach((tr) => (tr.onclick = () => (location.hash = '#/move/' + tr.dataset.move)));
}

let mapObj = null;
function renderMove(id) {
  const inst = S.inst;
  const t = inst.trips.find((x) => x.id === id);
  if (!t) { app.innerHTML = header('Move not found', `No move ${esc(id)} in this plan.`) + tabs('moves') + `<div class="empty"><div class="t">Nothing here</div><a href="#/moves">Back to moves</a></div>`; return; }
  const R = S.data.routes;
  const out = P.pathRoute(R, t.terminal, t.dc), back = P.pathRoute(R, t.dc, t.terminal);
  const v = inst.vehicle, curb = inst.curbT;
  const loaded = curb + v.containerTareT + t.cargo_t, empty = curb + v.containerTareT;
  const e1 = P.legEnergy(out, t.kind === 'import' ? loaded : empty, { vehicle: v }), e2 = P.legEnergy(back, t.kind === 'import' ? empty : loaded, { vehicle: v });
  const parts = {}; for (const k of Object.keys(e1.parts)) parts[k] = e1.parts[k] + e2.parts[k];
  const idle = t.energy - e1.kwh - e2.kwh; // note: legs in the plan include peak-hour time multipliers for aux
  const ev = findMoveEvent(t.idx);
  // elevation profile from real SRTM samples
  const prof = []; let d = 0;
  out.z.forEach((z, i) => { prof.push([d, z, 0]); d += out.seg_d[i] || 0; });
  const dOut = d;
  back.z.forEach((z, i) => { prof.push([d, z, 1]); d += back.seg_d[i] || 0; });
  const W = 860, H = 170, L = 40, Rr = 10, T = 10, B = 24;
  const zmax = Math.max(50, ...prof.map((p) => p[1])) * 1.1;
  const x = (m) => L + ((W - L - Rr) * m) / d, y = (z) => T + (H - T - B) * (1 - z / zmax);
  const pathOf = (leg) => prof.filter((p) => p[2] === leg).map((p, i) => `${i ? 'L' : 'M'}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join(' ');
  let grid = '';
  for (let z = 0; z <= zmax; z += 100) grid += `<line x1="${L}" x2="${W - Rr}" y1="${y(z)}" y2="${y(z)}" stroke="#fafff2" stroke-opacity=".07"/><text x="${L - 6}" y="${y(z) + 3}" text-anchor="end">${z} m</text>`;
  for (let mi = 0; mi <= d / 1609.344; mi += 20) grid += `<text x="${x(mi * 1609.344)}" y="${H - 8}" text-anchor="middle">${mi} mi</text>`;
  const pcol = { rolling: '#81f2b2', aero: '#ecfd9a', climb: '#ef682c', aux: '#83ecff' };
  const pos = ['rolling', 'aero', 'climb', 'aux'];
  const posTot = pos.reduce((s, k) => s + parts[k], 0) + Math.max(0, idle);
  app.innerHTML = `<div class="crumbs"><a href="#/plan">Shift plan</a><span>/</span><a href="#/moves">Moves</a><span>/</span><span>${t.id}</span></div>` +
    header(`<span class="grad">${t.id}</span> · ${esc(S.places[t.terminal].name.split(' (')[0])} → ${esc(S.places[t.dc].name)}`, `${t.kind === 'import' ? 'Import: loaded out, live unload at the dock, empty back' : 'Export: empty out, live load at the shipper, loaded back'} · gate ${clock(t.s)} · back ${clock(t.e)} · ${S.tripHauler.get(t.idx) || ''}`) + tabs('moves') + `
  <div class="dgrid"><div>
    <section class="panel"><div class="ph"><span class="num">01</span><h2>Route</h2><div class="meta">OpenStreetMap via OSRM · ${fmt(t.miles, 1)} mi round trip</div></div><div class="pb"><div id="map" role="img" aria-label="Map of the route"></div></div></section>
    <section class="panel"><div class="ph"><span class="num">02</span><h2>Elevation (NASA SRTM 30 m)</h2><div class="meta">out ${fmt(dOut / 1609.344, 1)} mi · back ${fmt((d - dOut) / 1609.344, 1)} mi</div></div><div class="pb">
      <svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Elevation profile">${grid}<line x1="${x(dOut)}" x2="${x(dOut)}" y1="${T}" y2="${H - B}" stroke="#fafff2" stroke-opacity=".25" stroke-dasharray="2 3"/>
      <path d="${pathOf(0)}" fill="none" stroke="#ecfd9a" stroke-width="1.6"/><path d="${pathOf(1)}" fill="none" stroke="#81f2b2" stroke-width="1.6"/></svg>
      <div class="chart-note"><span><i style="background:#ecfd9a"></i>Out (${t.kind === 'import' ? 'loaded' : 'empty'})</span><span><i style="background:#81f2b2"></i>Back (${t.kind === 'import' ? 'empty' : 'loaded'})</span></div></div></section>
  </div><aside>
    <section class="panel"><div class="ph"><span class="num">03</span><h2>Energy</h2><div class="meta">${fmt((100 * t.energy) / inst.capKwh)}% of pack</div></div><div class="pb">
      <div style="font-family:var(--display);font-size:2.4rem;letter-spacing:-.02em">${fmt(t.energy, 1)}<span style="font-size:1rem;color:var(--g-500);font-family:var(--sans)"> kWh</span></div>
      <div class="stack">${pos.map((k) => `<span style="width:${(100 * parts[k]) / posTot}%;background:${pcol[k]}" title="${k}"></span>`).join('')}<span style="width:${(100 * Math.max(0, idle)) / posTot}%;background:#5f5e5d" title="idle"></span></div>
      <div class="kv">
        <span class="k">Rolling resistance</span><span class="v">${fmt(parts.rolling, 1)} kWh</span>
        <span class="k">Aerodynamic drag at ≤55 mph</span><span class="v">${fmt(parts.aero, 1)} kWh</span>
        <span class="k">Climbing</span><span class="v">${fmt(parts.climb, 1)} kWh</span>
        <span class="k">Regen on descents</span><span class="v">${fmt(parts.regen, 1)} kWh</span>
        <span class="k">Autonomy compute + sensors</span><span class="v">${fmt(parts.aux + Math.max(0, idle), 1)} kWh</span>
        <span class="k">Gross weight out / back</span><span class="v">${fmt(t.kind === 'import' ? loaded : empty, 1)} / ${fmt(t.kind === 'import' ? empty : loaded, 1)} t</span>
        <span class="k">Worst point vs start</span><span class="v">−${fmt(t.need, 1)} kWh</span>
        ${ev ? `<span class="k">State of charge</span><span class="v">${pct(ev.socStart)} → ${pct(ev.socEnd)}</span>` : ''}
      </div></div></section>
    <section class="panel"><div class="ph"><span class="num">04</span><h2>Timing</h2></div><div class="pb"><div class="kv">
      <span class="k">Terminal turn (Oakland Portal avg)</span><span class="v">${fmt(S.data.moves.find((m) => m.id === t.id).turn_out_min)} min</span>
      <span class="k">Drive out</span><span class="v">${fmt(t.legs[0].min)} min</span>
      <span class="k">At the dock (${t.kind === 'import' ? 'live unload' : 'live load'})</span><span class="v">${fmt(S.data.moves.find((m) => m.id === t.id).dwell_min)} min</span>
      <span class="k">Drive back</span><span class="v">${fmt(t.legs[1].min)} min</span>
      <span class="k">Empty/load return turn</span><span class="v">${fmt(S.data.moves.find((m) => m.id === t.id).turn_in_min)} min</span>
    </div></div></section>
  </aside></div>`;
  drawMap(t);
}

function drawMap(t) {
  if (!window.L) { $('#map').innerHTML = '<div class="empty">Map library unavailable</div>'; return; }
  if (mapObj) { mapObj.remove(); mapObj = null; }
  mapObj = L.map('map', { zoomControl: true, attributionControl: true, scrollWheelZoom: false });
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', { attribution: 'Tiles &copy; Esri, HERE, Garmin, &copy; OpenStreetMap contributors', maxZoom: 16 }).addTo(mapObj);
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}', { maxZoom: 16, opacity: 0.8 }).addTo(mapObj);
  const R = S.data.routes;
  const legs = (a, b) => [a === 'gate' ? null : R[`${a}>gate`], b === 'gate' ? null : R[`gate>${b}`]].filter(Boolean).flatMap((r) => r.poly);
  const outLine = L.polyline(legs(t.terminal, t.dc), { color: '#ecfd9a', weight: 3, opacity: 0.9 }).addTo(mapObj);
  L.polyline(legs(t.dc, t.terminal), { color: '#81f2b2', weight: 2, opacity: 0.8, dashArray: '6 6' }).addTo(mapObj);
  const pin = (k, c) => L.circleMarker(S.places[k].ll, { radius: 6, color: c, fillColor: '#000', fillOpacity: 1, weight: 2 }).bindTooltip(S.places[k].name).addTo(mapObj);
  pin(t.terminal, '#81f2b2'); pin(t.dc, '#ecfd9a'); pin('depot', '#83ecff');
  mapObj.fitBounds(outLine.getBounds(), { padding: [30, 30] });
}

// ------------------------------------------------------------------ lanes
function renderLanes() {
  const inst = S.inst, v = inst.vehicle, R = S.data.routes;
  const dcs = Object.entries(S.places).filter(([, p]) => p.kind === 'dc').map(([k]) => k);
  const rows = dcs.map((dc) => {
    const out = P.legEnergy(P.pathRoute(R, 'OICT', dc), inst.curbT + v.containerTareT + 11, { vehicle: v });
    const back = P.legEnergy(P.pathRoute(R, dc, 'OICT'), inst.curbT + v.containerTareT, { vehicle: v });
    const rt = out.kwh + back.kwh;
    const usable = inst.socMax - inst.socMin;
    const n = inst.trips.filter((t) => t.dc === dc).length;
    const climb = Math.max(...R[`gate>${dc}`].z);
    return { dc, mi: out.mi + back.mi, out: out.kwh, back: back.kwh, rt, frac: rt / usable, perPack: Math.floor(usable / rt), n, climb, kwhmi: rt / (out.mi + back.mi) };
  }).sort((a, b) => a.mi - b.mi);
  app.innerHTML = header(`<span class="grad">${dcs.length} lanes</span> from the Port of Oakland`, `Round trip OICT ↔ destination with an 11 t import box out and the empty back, on real roads and elevation`) + tabs('lanes') + `
  <section class="panel"><table class="tbl"><thead><tr><th>Destination</th><th class="num">Round trip</th><th class="num">Highest point</th><th class="num">Out (loaded)</th><th class="num">Back (empty)</th><th class="num">kWh/mi</th><th class="num">% of usable pack</th><th class="num">Round trips per charge</th><th class="num">Moves today</th></tr></thead><tbody>
  ${rows.map((r) => `<tr><td>${esc(S.places[r.dc].name)}</td><td class="num">${fmt(r.mi, 1)} mi</td><td class="num">${fmt(r.climb)} m</td><td class="num">${fmt(r.out, 1)} kWh</td><td class="num">${fmt(r.back, 1)} kWh</td><td class="num">${fmt(r.kwhmi, 2)}</td><td class="num"><span style="display:inline-block;width:70px;height:6px;background:#fafff214;border-radius:3px;vertical-align:middle;margin-right:8px;position:relative"><span style="position:absolute;left:0;top:0;bottom:0;width:${Math.min(100, 100 * r.frac)}%;background:${r.frac > 0.8 ? '#ef682c' : 'linear-gradient(90deg,#edfd9a,#81f2b2)'};border-radius:3px"></span></span>${fmt(100 * r.frac)}%</td><td class="num">${r.perPack}</td><td class="num">${r.n}</td></tr>`).join('')}
  </tbody></table></section>
  <p style="color:var(--g-500);font-size:.85rem;margin-top:12px">Usable pack = ${fmt(100 * v.maxSoc)}% ceiling minus ${S.applied.params.reserve}% reserve = ${fmt(inst.socMax - inst.socMin)} kWh of a ${fmt(inst.capKwh)} kWh pack (sized from the published 200-mile range). Altamont Pass (I-580) shows up as the ~300 m high point on every Central Valley lane.</p>`;
}

// ------------------------------------------------------------------ method
function renderMethod() {
  const r = S.applied.result;
  app.innerHTML = header('How the <span class="grad">shift plan</span> works', 'Electric vehicle scheduling with depot charging under a grid subscription, solved with a certificate') + tabs('method') + `
  <div class="method">
    <h3>The problem</h3>
    <p>Each move is fixed by its terminal gate appointment. A Hauler can chain moves if it can get from one terminal to the next in time and its battery never drops below the reserve. Between moves it may go to the depot and charge in whole 15-minute blocks. Every Hauler must be back at the starting charge by 05:00. Site power in any 15-minute interval cannot exceed the PG&amp;E BEV-2 subscription, and plugged-in Haulers cannot exceed the dispensers.</p>
    <h3>Lower bound you can trust</h3>
    <ol><li><b>No-battery bound.</b> Ignoring batteries, the minimum fleet is a minimum path cover: <code>moves − maximum matching</code> (${r.lowerBounds.matching} Haulers here).</li>
    <li><b>Battery + grid bound.</b> A set-covering LP over all feasible Hauler days, solved by column generation. New days are priced with a resource-constrained shortest path over the time-ordered moves (labels = reduced cost and battery energy, with dominance). Charging inside a depot visit is chosen exactly: the cheapest whole blocks under the LP's power and dispenser prices, plus the best top-off block by enumeration. Power and dispenser rows are added lazily only for intervals the LP overloads. When pricing finds no improving day, the LP value is a valid lower bound: ⌈${r.lowerBounds.lpValue != null ? fmt(r.lowerBounds.lpValue, 2) : '-'}⌉ = ${r.lowerBounds.lp ?? '-'}.</li></ol>
    <h3>A plan that meets it</h3>
    <p>A price-and-dive search fixes the day with the largest LP value that still fits the remaining site power, re-solves with new columns, and backtracks with randomized restarts. A polish pass moves charging blocks to cheaper intervals inside the same depot visit. An independent validator then replays every Hauler: arrival times, state of charge at the worst point of every move, charge ceiling, overnight recharge, coverage, site power and dispensers. If the plan's fleet equals the LP bound, it is optimal.</p>
    <h3>Data</h3>
    <ul><li>Roads: OSRM on OpenStreetMap for every terminal, depot and destination leg; speed capped at the Hauler's 55 mph.</li>
    <li>Elevation: NASA SRTM 30 m via OpenTopoData, every 250 m (Altamont Pass is in the data).</li>
    <li>Energy: rolling resistance, drag, grade with regen, and autonomy compute load, with the pack sized so the published 200-mile range holds at a 10 t payload. Mass: the published "20% lighter than a tractor + chassis".</li>
    <li>Tariff: PG&amp;E BEV-2-S, effective Mar 1 2026 (peak 4-9 PM $0.36977, off-peak $0.15654, super off-peak 9 AM-2 PM $0.13327, $95.56 per 50 kW block).</li>
    <li>Turn times: Port of Oakland Portal historical truck turn times (Nov 6 and Nov 10 2026). Move list, payloads and dock times are synthetic (seed ${S.results.seed}).</li></ul>
    <h3>Limits</h3>
    <ul><li>Optimality is for this model: whole 15-minute blocks at dispenser power, a fixed appointment per move, one depot, deterministic travel times with a simple peak-hour multiplier.</li>
    <li>The integer search is a heuristic; when it misses the bound the gap is shown, not hidden.</li>
    <li>Battery size, drag and compute load are engineering assumptions, not Humble data.</li></ul>
  </div>`;
}

// ------------------------------------------------------------------ export
function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function exportCsv() {
  const inst = S.inst;
  const lines = ['hauler,event,id,start,end,from,to,kwh,cost_usd,soc_start_pct,soc_end_pct'];
  for (const h of S.haulers) {
    for (const ev of h.timeline.events) {
      if (ev.type === 'move') { const t = inst.trips[ev.trip]; lines.push([h.name, 'move', t.id, clock(t.s), clock(t.e), t.terminal, t.dc, t.energy.toFixed(2), '', ((100 * ev.socStart) / inst.capKwh).toFixed(1), ((100 * ev.socEnd) / inst.capKwh).toFixed(1)].join(',')); }
    }
    for (const [t, f] of h.route.charges) lines.push([h.name, 'charge', `slot-${t}`, clock(t * 15), clock(t * 15 + 15 * f), 'depot', 'depot', (inst.slotKwhBatt * f).toFixed(2), (inst.prices[t] * inst.slotKwhGrid * f).toFixed(2), '', ''].join(','));
  }
  download(`humble-shift-plan-${S.applied.params.subscriptionKw}kW.csv`, lines.join('\n'), 'text/csv');
  toast('Dispatch sheet exported');
}
function exportJson() {
  const out = { params: S.applied.params, fleet: S.applied.result.fleet, provenOptimal: S.applied.result.provenOptimal, lowerBounds: S.applied.result.lowerBounds, metrics: { peakKw: S.metrics.peakKw, energyCost: S.metrics.energyCost, gridKwh: S.metrics.gridKwh, valid: S.metrics.valid }, haulers: S.haulers.map((h) => ({ name: h.name, moves: h.route.trips.map((i) => S.inst.trips[i].id), charges: h.route.charges.map(([t, f]) => ({ start: clock(t * 15), fraction: f })) })) };
  download(`humble-shift-plan-${S.applied.params.subscriptionKw}kW.json`, JSON.stringify(out, null, 2), 'application/json');
  toast('Plan JSON exported');
}

function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 2600); }

// ------------------------------------------------------------------ keyboard
document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const tag = (e.target.tagName || '').toLowerCase();
  const help = $('#help');
  if (e.key === 'Escape') { help.classList.remove('show'); if (tag === 'input') e.target.blur(); return; }
  if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
  const views = { 1: 'plan', 2: 'haulers', 3: 'moves', 4: 'lanes', 5: 'method' };
  if (views[e.key]) { location.hash = '#/' + views[e.key]; return; }
  if (e.key === '?') { help.classList.toggle('show'); return; }
  if (e.key === '/') { e.preventDefault(); if (!location.hash.startsWith('#/moves')) location.hash = '#/moves'; setTimeout(() => $('#q') && $('#q').focus(), 30); return; }
  if (e.key === 'e' || e.key === 'E') { exportCsv(); return; }
  if ((e.key === 'r' || e.key === 'R') && $('#replanBtn')) { replan(readWhatIf()); return; }
  if ((e.key === 'a' || e.key === 'A') && S.draft && !S.busy) { applyDraft(); return; }
  if ((e.key === 'j' || e.key === 'k') && location.hash.startsWith('#/hauler')) {
    const cur = location.hash.split('/')[2] || S.haulers[0].name;
    const i = S.haulers.findIndex((h) => h.name === cur);
    const n = S.haulers[(i + (e.key === 'j' ? 1 : -1) + S.haulers.length) % S.haulers.length];
    location.hash = '#/hauler/' + n.name;
  }
});
$('#exportBtn').addEventListener('click', () => S.applied && exportCsv());
$('#help').addEventListener('click', (e) => { if (e.target.id === 'help') e.target.classList.remove('show'); });

boot();
