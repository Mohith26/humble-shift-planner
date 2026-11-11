// Re-plans in a background thread so the page stays responsive.
import { buildInstance, plan } from './core/planner.mjs';
let data = null;
self.onmessage = (e) => {
  const { type } = e.data;
  if (type === 'init') { data = e.data.data; self.postMessage({ type: 'ready' }); return; }
  if (type === 'plan') {
    try {
      const inst = buildInstance(data, e.data.params);
      const t0 = Date.now();
      const pl = plan(inst, { incumbents: e.data.incumbents || [], timeBudgetMs: 5000 });
      self.postMessage({ type: 'result', id: e.data.id, ms: Date.now() - t0, result: {
        fleet: pl.fleet, provenOptimal: pl.provenOptimal, lowerBounds: pl.lowerBounds, costLpBound: pl.costLpBound, costGap: pl.costGap ?? null,
        infeasible: !!pl.infeasible, routes: pl.routes.map((r) => ({ trips: r.trips, charges: r.charges })), stats: pl.stats,
      } });
    } catch (err) { self.postMessage({ type: 'error', id: e.data.id, message: String(err && err.message || err) }); }
  }
};
