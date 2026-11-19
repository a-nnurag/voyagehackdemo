'use strict';
// Self-checks for the deterministic core. Run: npm test
const assert = require('node:assert/strict');
const L = require('./public/logic.js');
const H = L.H, now = Date.UTC(2026, 10, 16, 12);

// Travel-aware SLA: same refund, 24h when check-in is a month out, 2h when it's tomorrow.
const base = { priority: 'medium', created_at: now, status: 'Open', booking_value: 500 };
assert.equal(L.computeSla({ ...base, check_in: now + 30 * 24 * H }, now).due - now, 24 * H);
const near = L.computeSla({ ...base, check_in: now + 26 * H }, now);
assert.equal(near.due - now, 2 * H);
assert.equal(near.state, 'at_risk');
assert.match(near.driver, /check-in/);
// High value halves the timer.
assert.equal(L.computeSla({ ...base, booking_value: 5000 }, now).due - now, 12 * H);
// Trip date already inside the buffer → 1h floor, not an instant breach.
assert.equal(L.computeSla({ ...base, check_in: now + 5 * H }, now).due - now, 1 * H);
// Breached once the due time passes.
assert.equal(L.computeSla({ ...base, check_in: now + 5 * H }, now + 2 * H).state, 'breached');
// Pause extends the priority timer only — trip dates still bind.
const paused = { ...base, status: 'Pending', paused_at: now + 1 * H };
assert.equal(L.computeSla(paused, now + 5 * H).due - now, 28 * H);
assert.equal(L.computeSla({ ...paused, check_in: now + 30 * H }, now + 5 * H).due - now, 6 * H);
// Done tickets have no live state.
assert.equal(L.computeSla({ ...base, status: 'Resolved' }, now + 100 * H).state, 'done');

// Classifier: rules first, low confidence flagged for LLM fallback.
const c = L.classify('Refund still not credited for TBOH-1234');
assert.equal(c.intent, 'refund');
assert.equal(c.source, 'rules');
assert.equal(L.classify('hello there').source, 'llm_fallback');
assert.equal(L.classify('hello there').intent, 'other');
assert.equal(L.classify('x', { check_in: now + 10 * H, now }).urgency, 'high');

// Routing: filter (region, shift, skill) then seniors-first for urgent, else least-loaded.
const agents = [
  { id: 'a', name: 'A', regions: ['Europe'], skills: ['*'], senior: true, on_shift: true },
  { id: 'b', name: 'B', regions: ['Europe'], skills: ['*'], senior: false, on_shift: true },
  { id: 'c', name: 'C', regions: ['Europe'], skills: ['refund'], senior: false, on_shift: false },
  { id: 'd', name: 'D', regions: ['APAC'], skills: ['*'], senior: false, on_shift: true },
];
const t = { region: 'Europe', intent: 'refund', priority: 'urgent' };
assert.equal(L.route(t, agents, { a: 5, b: 0 }).owner, 'a');
assert.equal(L.route({ ...t, priority: 'low' }, agents, { a: 5, b: 0 }).owner, 'b');
assert.match(L.route(t, agents, {}).reason, /C \(off shift\)/);
assert.equal(L.route({ ...t, region: 'Middle East' }, agents, {}).owner, null);

// Linking: merge / link / tracker.
const tk = { id: 1, tboh: 'TBOH-1', agency_id: 'x', intent: 'refund', supplier: 'S', status: 'Open', created_at: now };
const sug = L.suggestLinks(tk, [
  { id: 2, tboh: 'TBOH-1', agency_id: 'x', intent: 'refund', status: 'Pending', created_at: now },
  { id: 3, tboh: 'TBOH-1', agency_id: 'x', intent: 'payment', status: 'Open', created_at: now },
  { id: 4, tboh: 'TBOH-9', agency_id: 'y', intent: 'refund', supplier: 'S', status: 'Open', created_at: now - 3 * H },
  { id: 5, tboh: 'TBOH-1', agency_id: 'y', intent: 'refund', status: 'Open', created_at: now }, // other agency, same TBOH: never merged
]);
assert.deepEqual(sug.map(s => [s.id, s.type]), [[2, 'merge'], [3, 'link'], [4, 'tracker']]);

// Cancellation policy sheet: LCD and refund-now come from the policy, never from user input.
const bk = { policy: 'FLEX24', check_in: now + 48 * H, value: 600 };
assert.equal(L.policySheet(bk, now).lcd, now + 24 * H);
assert.equal(L.policySheet(bk, now).refundNow, 100);
assert.equal(L.policySheet(bk, now + 30 * H).refundNow, 50);
assert.equal(L.policySheet(bk, now + 30 * H).refundNowAmount, 300);
assert.equal(L.policySheet(bk, now + 50 * H).refundNow, 0); // no-show
const std = L.policySheet({ policy: 'STD48', check_in: now + 30 * H, value: 1000 }, now);
assert.deepEqual([std.refundNow, std.rows.length], [70, 3]);
assert.equal(L.policySheet({ policy: 'NRF', check_in: now + 99 * H, value: 1 }, now).lcd, null);
// An LCD that had already passed when the ticket opened doesn't drive the deadline.
assert.equal(L.computeSla({ ...base, lcd: now - H }, now).due - now, 24 * H);
assert.equal(L.computeSla({ ...base, lcd: now + 14 * H }, now).due - now, 2 * H);

console.log('All OpsDesk logic checks passed ✓');
