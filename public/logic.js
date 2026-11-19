// Shared, deterministic core: classifier, travel-aware SLA, routing, link suggestions.
// Runs in the browser (window.Logic) and in Node (require) so the UI preview and the server agree.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Logic = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const H = 3600e3;

  const INTENTS = {
    refund: { label: 'Refund', theme: 'Refund delay', backlog: 'Auto-sync refund status from supplier API into the case', kw: ['refund', 'money back', 'reimburse', 'credit note', 'not credited', 'amount not received'] },
    cancellation: { label: 'Cancellation', theme: 'Cancellation dispute', backlog: 'Show supplier cancellation policy + LCD at booking time', kw: ['cancel', 'free cancellation', 'penalty', 'no-show'] },
    booking_change: { label: 'Booking modification', theme: 'Amendment requests', backlog: 'Self-serve name/date amendments in the agency portal', kw: ['change', 'modify', 'amend', 'name correction', 'extend', 'guest name'] },
    reconfirmation: { label: 'Reconfirmation', theme: 'Reservation not found', backlog: 'Automatic pre-arrival reconfirmation with the hotel', kw: ['no record', 'reconfirm', 'not found', 'hotel denied', 'walked'] },
    inventory_sync: { label: 'Rate / inventory mismatch', theme: 'Inventory sync', backlog: 'Rate-parity check against supplier feed before confirm', kw: ['rate mismatch', 'price differs', 'inventory', 'sold out', 'invoice'] },
    payment: { label: 'Payment issue', theme: 'Payment failures', backlog: 'Retry-safe payment capture + payment status page', kw: ['payment', 'charged twice', 'double charge', 'deducted', 'wallet', 'credit limit'] },
    special_request: { label: 'Special request', theme: 'Special requests', backlog: 'Structured special-request field passed to supplier', kw: ['wheelchair', 'accessible', 'early check-in', 'late checkout', 'transfer', 'extra bed', 'special request'] },
    other: { label: 'Other', theme: 'Other', backlog: '', kw: [] },
  };
  const PRIORITIES = ['urgent', 'high', 'medium', 'low'];
  const STATUSES = ['New', 'Open', 'Pending', 'Escalated', 'Resolved', 'Closed'];
  const CONFIDENCE_THRESHOLD = 0.6;

  // Mock supplier cancellation policies (versioned config, not user input). Tier: cancel ≥ h hours before check-in → refund %.
  const POLICIES = {
    FLEX24: { name: 'Flexible', summary: 'Free cancellation until 24h before check-in · 50% refund after that · no refund for no-show', tiers: [{ h: 24, refund: 100 }, { h: 0, refund: 50 }] },
    STD48: { name: 'Standard', summary: 'Free cancellation until 48h before check-in · 70% refund until 24h before · no refund after', tiers: [{ h: 48, refund: 100 }, { h: 24, refund: 70 }] },
    NRF: { name: 'Non-refundable', summary: 'Non-refundable rate · no refund on cancellation (supplier goodwill only)', tiers: [] },
  };

  // The policy sheet for a booking: dated refund windows, the LCD (last free-cancellation moment) and what a cancel now would refund.
  function policySheet(b, now) {
    const p = POLICIES[b.policy] || POLICIES.NRF;
    const rows = p.tiers.map((tier, i) => ({ from: i ? b.check_in - p.tiers[i - 1].h * H : null, until: b.check_in - tier.h * H, refund: tier.refund }));
    rows.push({ from: rows.length ? rows[rows.length - 1].until : null, until: null, refund: 0 });
    const cur = rows.find(r => r.until === null || now < r.until);
    rows.forEach(r => { r.current = r === cur; });
    const free = p.tiers.find(tier => tier.refund === 100);
    return { code: b.policy, name: p.name, summary: p.summary, rows, lcd: free ? b.check_in - free.h * H : null, refundNow: cur.refund, refundNowAmount: Math.round((b.value || 0) * cur.refund / 100) };
  }

  // Demo values — all configurable assumptions.
  const SLA = { timerH: { urgent: 2, high: 8, medium: 24, low: 48 }, checkInBufferH: 24, lcdBufferH: 12, highValueUSD: 2000, floorH: 1, atRiskH: 2, atRiskFrac: 0.25 };

  const kwRe = {};
  for (const k in INTENTS) kwRe[k] = INTENTS[k].kw.map(w => [w, new RegExp('\\b' + w.replace(/[-]/g, '\\-'), 'i')]);

  // Rules first. Below CONFIDENCE_THRESHOLD the ticket would go to the (small) LLM fallback.
  function classify(text, ctx = {}) {
    const scores = Object.keys(INTENTS).map(k => {
      const matched = kwRe[k].filter(([, re]) => re.test(text)).map(([w]) => w);
      return { k, n: matched.length, matched };
    }).sort((a, b) => b.n - a.n);
    const [best, second] = scores;
    const confidence = best.n === 0 ? 0.3 : best.n === second.n ? 0.5 : Math.min(0.95, 0.6 + 0.15 * (best.n - second.n));
    const intent = best.n === 0 ? 'other' : best.k;
    const hoursToTrip = ctx.check_in ? (ctx.check_in - (ctx.now || Date.now())) / H : Infinity;
    const urgency = ctx.priority === 'urgent' || ctx.priority === 'high' || hoursToTrip < 48 ? 'high' : 'normal';
    return { intent, label: INTENTS[intent].label, confidence, source: confidence >= CONFIDENCE_THRESHOLD ? 'rules' : 'llm_fallback', matched: best.matched, urgency };
  }

  function fmtDur(ms) {
    const m = Math.round(Math.abs(ms) / 60000);
    if (m < 60) return m + 'm';
    const h = Math.floor(m / 60);
    if (h < 48) return h + 'h ' + (m % 60) + 'm';
    return Math.floor(h / 24) + 'd ' + (h % 24) + 'h';
  }

  // due = soonest(created + priority timer (+paused time), check-in − buffer, LCD − buffer).
  // Pausing extends only the priority timer: trip dates don't move, so a near trip still forces at-risk.
  function computeSla(t, now) {
    const highValue = (t.booking_value || 0) >= SLA.highValueUSD;
    const timer = SLA.timerH[t.priority] * H / (highValue ? 2 : 1);
    const paused = (t.paused_ms || 0) + (t.status === 'Pending' && t.paused_at ? now - t.paused_at : 0);
    const cands = [{ label: `${t.priority} priority timer ${timer / H}h${highValue ? ' (halved: high-value booking)' : ''}${paused ? ' + ' + fmtDur(paused) + ' paused' : ''}`, at: t.created_at + timer + paused }];
    if (t.check_in) cands.push({ label: `check-in − ${SLA.checkInBufferH}h`, at: t.check_in - SLA.checkInBufferH * H });
    // An LCD already gone when the ticket opened can't drive urgency.
    if (t.lcd && t.lcd > t.created_at) cands.push({ label: `LCD − ${SLA.lcdBufferH}h`, at: t.lcd - SLA.lcdBufferH * H });
    const win = cands.reduce((a, b) => (b.at < a.at ? b : a));
    let due = win.at, driver = win.label;
    const floor = t.created_at + SLA.floorH * H;
    if (due < floor) { due = floor; driver = `trip imminent → ${SLA.floorH}h floor (${win.label} had already passed)`; }
    cands.forEach(c => { c.win = c === win; });
    const total = due - t.created_at - (win === cands[0] ? paused : 0), left = due - now; // window size excludes paused time
    const done = t.status === 'Resolved' || t.status === 'Closed';
    const state = done ? 'done' : left <= 0 ? 'breached' : left <= Math.max(SLA.atRiskH * H, total * SLA.atRiskFrac) ? 'at_risk' : 'on_track';
    return { due, state, driver, paused: t.status === 'Pending', candidates: cands, total, left };
  }

  // Filter (region, on shift, skill) then pick (seniors first when urgent, then least loaded).
  function route(t, agents, load) {
    const urgent = t.priority === 'urgent' || t.priority === 'high';
    const excluded = [];
    const pool = agents.filter(a => {
      if (!a.regions.includes(t.region) && !a.regions.includes('*')) return false;
      if (!a.on_shift) { excluded.push(`${a.name} (off shift)`); return false; }
      if (!a.skills.includes('*') && !a.skills.includes(t.intent)) { excluded.push(`${a.name} (no ${t.intent} skill)`); return false; }
      return true;
    });
    const head = `region=${t.region} · intent=${t.intent} · priority=${t.priority}`;
    const ex = excluded.length ? ` · excluded: ${excluded.join(', ')}` : '';
    if (!pool.length) return { owner: null, reason: `${head} → no eligible on-shift agent, left in triage${ex}` };
    const l = a => load[a.id] || 0;
    pool.sort((a, b) => (urgent ? Number(b.senior) - Number(a.senior) : 0) || l(a) - l(b) || (a.id < b.id ? -1 : 1));
    const p = pool[0];
    return { owner: p.id, reason: `${head}${urgent ? ' → seniors first' : ''} · picked ${p.name}${p.senior ? ' (senior)' : ''}, ${l(p)} open, least-loaded of ${pool.length} eligible${ex}` };
  }

  // merge = same agency + booking + intent; link = same agency + booking, other intent;
  // tracker = different agencies, same supplier + intent within 48h (probable supplier incident).
  function suggestLinks(t, others) {
    const out = [];
    for (const o of others) {
      if (o.id === t.id) continue;
      if (o.tboh === t.tboh && o.agency_id === t.agency_id) {
        const same = o.intent === t.intent;
        const canMerge = same && t.status !== 'Closed' && o.status !== 'Closed';
        out.push({ id: o.id, type: canMerge ? 'merge' : 'link', why: same ? `same agency + booking ${t.tboh} + intent` : `same agency + booking ${t.tboh}, different intent` });
      } else if (t.supplier && o.supplier === t.supplier && o.agency_id !== t.agency_id && o.intent === t.intent && Math.abs(o.created_at - t.created_at) < 48 * H) {
        out.push({ id: o.id, type: 'tracker', why: `other agency, same supplier ${t.supplier} + ${INTENTS[t.intent].label} within 48h → probable supplier incident` });
      }
    }
    return out;
  }

  return { H, INTENTS, PRIORITIES, STATUSES, SLA, POLICIES, CONFIDENCE_THRESHOLD, classify, computeSla, route, suggestLinks, policySheet, fmtDur };
});
