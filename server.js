'use strict';
// OpsDesk demo server — zero dependencies: node:http + node:sqlite (Node >= 22.13).
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const L = require('./public/logic.js');

const H = L.H, D = 24 * H;
const PORT = Number(process.env.PORT) || 3000;
const PUB = path.join(__dirname, 'public');
const db = new DatabaseSync(process.env.DB_FILE || path.join(__dirname, 'opsdesk.db'));

db.exec(`
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS agencies(id TEXT PRIMARY KEY, name TEXT, region TEXT, country TEXT);
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, name TEXT, role TEXT, agency_id TEXT, regions TEXT, skills TEXT, senior INTEGER, on_shift INTEGER);
CREATE TABLE IF NOT EXISTS tickets(id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, body TEXT, agency_id TEXT, tboh TEXT, supplier TEXT,
  intent TEXT, intent_source TEXT, confidence REAL, priority TEXT, region TEXT, check_in INTEGER, lcd INTEGER, booking_value REAL,
  status TEXT, pending_reason TEXT, owner_id TEXT, route_reason TEXT, created_at INTEGER, paused_ms INTEGER DEFAULT 0, paused_at INTEGER, resolved_at INTEGER);
CREATE INDEX IF NOT EXISTS t_case ON tickets(tboh, agency_id);
CREATE TABLE IF NOT EXISTS links(id INTEGER PRIMARY KEY AUTOINCREMENT, from_id INTEGER, to_id INTEGER, type TEXT, confirmed_by TEXT, at INTEGER);
CREATE TABLE IF NOT EXISTS comments(id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER, author TEXT, kind TEXT, body TEXT, at INTEGER);
CREATE TABLE IF NOT EXISTS side_convos(id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER, subject TEXT, recipients TEXT, created_by TEXT, at INTEGER);
CREATE TABLE IF NOT EXISTS side_msgs(id INTEGER PRIMARY KEY AUTOINCREMENT, side_id INTEGER, author TEXT, body TEXT, at INTEGER);
CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER, actor TEXT, action TEXT, detail TEXT, at INTEGER);
CREATE TABLE IF NOT EXISTS bookings(tboh TEXT PRIMARY KEY, agency_id TEXT, supplier TEXT, hotel TEXT, city TEXT, guest TEXT, check_in INTEGER, check_out INTEGER, value REAL, policy TEXT, status TEXT);
CREATE TABLE IF NOT EXISTS archive(id INTEGER PRIMARY KEY, created_at INTEGER, agency_id TEXT, region TEXT, intent TEXT, priority TEXT, status TEXT);
`);
// shortcut: inline migration for DBs created before created_by existed; use a migrations table if the schema keeps growing.
if (!db.prepare('PRAGMA table_info(tickets)').all().some(c => c.name === 'created_by')) db.exec('ALTER TABLE tickets ADD COLUMN created_by TEXT');

const q = (sql, ...a) => db.prepare(sql).all(...a);
const one = (sql, ...a) => db.prepare(sql).get(...a);
const run = (sql, ...a) => db.prepare(sql).run(...a);
const bad = (msg, status = 400) => { throw Object.assign(new Error(msg), { status }); };
const ev = (ticketId, actor, action, detail, at = Date.now()) => run('INSERT INTO events(ticket_id,actor,action,detail,at) VALUES (?,?,?,?,?)', ticketId, actor, action, detail, at);
const parseUser = u => u && { ...u, regions: JSON.parse(u.regions || '[]'), skills: JSON.parse(u.skills || '[]'), senior: !!u.senior, on_shift: !!u.on_shift };
const STAFF = ['agent', 'em', 'lead'];
const must = (me, roles) => { if (!roles.includes(me.role)) bad(`Role "${me.role}" cannot do this`, 403); };
const OPEN_SQL = "status NOT IN ('Resolved','Closed')";

function loadMap() {
  return Object.fromEntries(q(`SELECT owner_id, COUNT(*) c FROM tickets WHERE ${OPEN_SQL} AND owner_id IS NOT NULL GROUP BY owner_id`).map(r => [r.owner_id, r.c]));
}
function autoRoute(t) {
  return L.route(t, q("SELECT * FROM users WHERE role='agent'").map(parseUser), loadMap());
}
function userName(id) { return id ? (one('SELECT name FROM users WHERE id=?', id) || {}).name || id : 'Unassigned'; }

// ---------- seed (timestamps relative to now so SLA states are right whenever you demo) ----------
function seed() {
  db.exec('BEGIN');
  try {
    for (const t of ['agencies', 'users', 'bookings', 'tickets', 'links', 'comments', 'side_convos', 'side_msgs', 'events', 'archive']) db.exec(`DELETE FROM ${t}`);
    db.exec('DELETE FROM sqlite_sequence');
    const now = Date.now(), ago = h => now - h * H, ahead = h => now + h * H;
    [['sky', 'Skyline Travels', 'South Asia', 'IN'], ['euro', 'EuroTrip GmbH', 'Europe', 'DE'], ['gulf', 'Gulf Horizons', 'Middle East', 'AE'], ['lion', 'Lion City Tours', 'APAC', 'SG']]
      .forEach(a => run('INSERT INTO agencies VALUES (?,?,?,?)', ...a));
    [
      ['u-sky', 'Ravi · Skyline Travels', 'requester', 'sky', [], [], 0, 1],
      ['u-sky2', 'Meera · Skyline Travels', 'requester', 'sky', [], [], 0, 1],
      ['u-euro', 'Lena · EuroTrip GmbH', 'requester', 'euro', [], [], 0, 1],
      ['u-gulf', 'Fatima · Gulf Horizons', 'requester', 'gulf', [], [], 0, 1],
      ['u-lion', 'Daniel · Lion City Tours', 'requester', 'lion', [], [], 0, 1],
      ['a-priya', 'Priya Sharma', 'agent', null, ['South Asia'], ['refund', 'cancellation', 'payment', 'reconfirmation'], 1, 1],
      ['a-rahul', 'Rahul Verma', 'agent', null, ['South Asia', 'APAC'], ['*'], 0, 1],
      ['a-marco', 'Marco Rossi', 'agent', null, ['Europe'], ['*'], 1, 1],
      ['a-anna', 'Anna Keller', 'agent', null, ['Europe'], ['refund', 'booking_change', 'special_request'], 0, 0],
      ['a-omar', 'Omar Haddad', 'agent', null, ['Middle East'], ['*'], 0, 1],
      ['a-wei', 'Wei Tan', 'agent', null, ['APAC'], ['*'], 1, 0],
      ['em-neha', 'Neha Kapoor', 'em', null, ['*'], ['*'], 1, 1],
      ['lead-arjun', 'Arjun Mehta', 'lead', null, ['*'], ['*'], 1, 1],
    ].forEach(([id, name, role, ag, regions, skills, senior, shift]) =>
      run('INSERT INTO users VALUES (?,?,?,?,?,?,?,?)', id, name, role, ag, JSON.stringify(regions), JSON.stringify(skills), senior, shift));

    // Mock TBO booking store: the only source of hotel, dates, value and cancellation policy.
    const CITY = { sky: ['Goa', 'Sunrise Bay Resort'], euro: ['Zermatt', 'Hotel Edelweiss'], gulf: ['Dubai', 'Palm Crescent Hotel'], lion: ['Singapore', 'Orchard Residency'] };
    const GUESTS = ['A. Mehta', 'J. Fischer', 'S. Al-Mansoori', 'L. Tan', 'K. Iyer', 'M. Weber', 'R. Haddad', 'C. Lim', 'P. Nair', 'E. Rossi'];
    let g = 0;
    const BK = (agency, tboh, o) => run('INSERT OR IGNORE INTO bookings VALUES (?,?,?,?,?,?,?,?,?,?,?)', tboh, agency,
      o.supplier || o.hotel || CITY[agency][1], o.hotel || o.supplier || CITY[agency][1], o.city || CITY[agency][0], GUESTS[g++ % GUESTS.length],
      o.check_in, o.check_in + 2 * D, o.value, o.policy || 'FLEX24', o.bstatus || 'Confirmed');

    const T = o => {
      BK(o.agency, o.tboh, o);
      const bk = one('SELECT * FROM bookings WHERE tboh=?', o.tboh);
      o = { ...o, supplier: bk.supplier, check_in: bk.check_in, value: bk.value, lcd: L.policySheet(bk, o.at).lcd };
      const region = one('SELECT region FROM agencies WHERE id=?', o.agency).region;
      const c = L.classify(o.title + ' ' + o.body);
      const t = { ...o, agency_id: o.agency, region, intent: c.intent, priority: o.priority || 'medium', created_at: o.at };
      let owner = o.owner, reason = o.reason;
      if (owner === undefined) ({ owner, reason } = autoRoute(t));
      const status = o.status || (owner ? 'Open' : 'New');
      const r = run(`INSERT INTO tickets(title,body,agency_id,tboh,supplier,intent,intent_source,confidence,priority,region,check_in,lcd,booking_value,status,pending_reason,owner_id,route_reason,created_at,paused_ms,paused_at,resolved_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        o.title, o.body, o.agency, o.tboh, o.supplier || null, c.intent, c.source, c.confidence, t.priority, region, o.check_in ?? null, o.lcd ?? null,
        o.value || 0, status, o.pending || null, owner ?? null, reason || 'Awaiting triage', o.at, 0, o.paused_at ?? null,
        ['Resolved', 'Closed'].includes(status) ? o.at + 4 * H : null);
      const id = Number(r.lastInsertRowid);
      run('UPDATE tickets SET created_by=? WHERE id=?', o.by || { sky: 'Ravi', euro: 'Lena', gulf: 'Fatima', lion: 'Daniel' }[o.agency] + ' · ' + one('SELECT name FROM agencies WHERE id=?', o.agency).name, id);
      ev(id, 'Classifier', 'created', `via agency portal · intent ${c.label} (${c.source}, ${Math.round(c.confidence * 100)}%)`, o.at);
      ev(id, 'Router', 'assign', reason || 'No owner — triage', o.at + 1000);
      if (['Resolved', 'Closed'].includes(status)) ev(id, userName(owner), 'status', `Open → ${status}`, o.at + 4 * H);
      return id;
    };
    const C = (id, author, kind, body, at) => run('INSERT INTO comments(ticket_id,author,kind,body,at) VALUES (?,?,?,?,?)', id, author, kind, body, at);
    const SIDE = (id, subject, recipients, by, at, msgs) => {
      const sid = Number(run('INSERT INTO side_convos(ticket_id,subject,recipients,created_by,at) VALUES (?,?,?,?,?)', id, subject, JSON.stringify(recipients), by, at).lastInsertRowid);
      msgs.forEach(([a, b, t]) => run('INSERT INTO side_msgs(side_id,author,body,at) VALUES (?,?,?,?)', sid, a, b, t));
      ev(id, by, 'side_convo', `Started "${subject}" with ${recipients.join(', ')}`, at);
    };

    // Journey A: same refund, already chased twice — never linked in the old world.
    const s1 = T({ agency: 'sky', tboh: 'TBOH-118204', supplier: 'Bayview Grand Hotel', title: 'Refund not received for cancelled booking', body: 'Booking TBOH-118204 was called off inside the allowed window. Refund amount still not credited to our account.', bstatus: 'Cancelled', at: ago(144), check_in: ahead(25 * 24), value: 640, status: 'Resolved', owner: 'a-priya', reason: 'region=South Asia · intent=refund · priority=medium · picked Priya Sharma (senior), 0 open, least-loaded of 2 eligible' });
    C(s1, 'Priya Sharma', 'external', 'The hotel has initiated the refund. You should see it in 5–7 working days.', ago(141));
    C(s1, 'Priya Sharma', 'internal', 'Supplier says refund initiated — marking resolved.', ago(141));
    const s2 = T({ agency: 'sky', tboh: 'TBOH-118204', supplier: 'Bayview Grand Hotel', title: 'Follow-up: refund still pending', body: 'Following up again — more than a week and the refund is still not credited. Please check with the hotel.', by: 'Meera · Skyline Travels', at: ago(72), check_in: ahead(25 * 24), value: 640, status: 'Pending', pending: 'waiting_on_supplier', paused_at: ago(70), owner: 'a-rahul', reason: 'region=South Asia · intent=refund · priority=medium · picked Rahul Verma, 1 open, least-loaded of 2 eligible' });
    C(s2, 'Rahul Verma', 'internal', 'Did not see the earlier ticket. Asked supplier for UTR.', ago(70));
    ev(s2, 'Rahul Verma', 'status', 'Open → Pending (waiting on supplier · SLA clock paused)', ago(70));
    SIDE(s2, 'Refund status TBOH-118204', ['accounts@bayview-grand.example'], 'Rahul Verma', ago(70), [
      ['Rahul Verma', 'Please share the refund UTR for TBOH-118204.', ago(70)],
      ['accounts@bayview-grand.example', 'Refund batch delayed by a bank holiday — expected to settle by Friday.', ago(30)],
    ]);

    // Journey D: check-in tomorrow → at risk.
    T({ agency: 'euro', tboh: 'TBOH-220931', supplier: 'Alpine Resorts Group', title: 'Guest name change before check-in tomorrow', body: 'Please modify the guest name on TBOH-220931 — the lead guest name is misspelled and check-in is tomorrow.', policy: 'STD48', at: ago(0.5), check_in: ahead(25), value: 1200, owner: 'a-marco', reason: 'region=Europe · intent=booking_change · priority=medium · picked Marco Rossi (senior), 0 open, least-loaded of 1 eligible · excluded: Anna Keller (off shift)' });
    // Breached: guest arriving tonight.
    T({ agency: 'gulf', tboh: 'TBOH-330417', supplier: 'Corniche Palace', title: 'Hotel has no record of our reservation', body: 'Guest arriving tonight; hotel says there is no record of booking TBOH-330417. Please reconfirm urgently.', priority: 'high', policy: 'NRF', city: 'Abu Dhabi', at: ago(4), check_in: ahead(8), value: 900 });
    // Journey C: transferred ticket with an active supplier side conversation.
    const s5 = T({ agency: 'lion', tboh: 'TBOH-441876', supplier: 'Marina Suites', title: 'Wheelchair-accessible room and airport transfer', body: 'Guest needs a wheelchair accessible room and an airport transfer on arrival for TBOH-441876.', at: ago(20), check_in: ahead(5 * 24), value: 1500, owner: 'a-rahul', reason: 'Reassigned: Wei Tan went off shift → Rahul Verma (covers APAC)' });
    SIDE(s5, 'Accessible room + airport pickup — TBOH-441876', ['reservations@marina-suites.example', 'transport@marina-suites.example'], 'Wei Tan', ago(19), [
      ['Wei Tan', 'Please confirm an accessible room and arrange airport pickup at 14:30 on arrival day.', ago(19)],
      ['reservations@marina-suites.example', 'Accessible room confirmed. Transport desk to confirm pickup by tomorrow.', ago(14)],
    ]);
    run('UPDATE events SET detail=? WHERE ticket_id=? AND action=?', 'region=APAC · intent=special_request · priority=medium · picked Wei Tan (senior), 0 open, least-loaded of 1 eligible', s5, 'assign');
    ev(s5, 'Arjun Mehta', 'assign', 'Wei Tan → Rahul Verma (Wei off shift) · side conversation keeps its 2 explicit recipients', ago(3));
    // Escalation queue: already escalated.
    const s6 = T({ agency: 'euro', tboh: 'TBOH-220455', supplier: 'Alpine Resorts Group', title: 'Supplier refusing free cancellation within policy', body: 'Hotel charges a cancellation penalty although TBOH-220455 is still within the free cancellation deadline.', priority: 'high', at: ago(3), check_in: ahead(58), policy: 'STD48', value: 2400, owner: 'em-neha', status: 'Escalated', reason: 'Escalated by Marco Rossi: LCD in under 12h, supplier unresponsive' });
    ev(s6, 'Marco Rossi', 'escalate', '→ Neha Kapoor (Escalation Manager) · LCD in under 12h, supplier unresponsive', ago(1));
    // Tracker: three agencies, one supplier outage.
    T({ agency: 'sky', tboh: 'TBOH-551201', supplier: 'Atlas Bedbank', hotel: 'Hotel Lumen', city: 'Goa', title: 'Rate mismatch on supplier invoice', body: 'The rate on the supplier invoice differs from the booked rate for TBOH-551201.', priority: 'high', at: ago(2), check_in: ahead(9 * 24), value: 800, owner: null });
    T({ agency: 'gulf', tboh: 'TBOH-551388', supplier: 'Atlas Bedbank', hotel: 'Desert Pearl Hotel', title: 'Rate mismatch — invoice higher than booking', body: 'Supplier invoice for TBOH-551388 is higher than the confirmed rate.', at: ago(5), check_in: ahead(14 * 24), value: 450, owner: null });
    T({ agency: 'lion', tboh: 'TBOH-551902', supplier: 'Atlas Bedbank', hotel: 'Harbourfront Inn', title: 'Invoice rate mismatch', body: 'Rate mismatch between voucher and supplier invoice on TBOH-551902.', at: ago(9), check_in: ahead(20 * 24), value: 520 });

    // Background volume for insights (this week).
    [
      ['sky', 'TBOH-118877', 'Refund delayed for cancelled package', 'Refund not credited after 12 days.', 'Resolved', 30],
      ['euro', 'TBOH-229001', 'Refund not received after cancellation', 'Refund still pending; money back was promised last week.', 'Closed', 50],
      ['gulf', 'TBOH-331145', 'Refund status needed', 'Requesting status of refund approved by the hotel as an exception.', 'Resolved', 80],
      ['lion', 'TBOH-442210', 'Partial refund received', 'Partial refund only — amount not received in full.', 'Open', 20],
      ['sky', 'TBOH-119300', 'Need to extend stay by one night', 'Please modify the booking to extend the stay.', 'Resolved', 100],
      ['euro', 'TBOH-229450', 'Date change request', 'Agency wants to change dates; please amend the booking.', 'Closed', 120],
      ['gulf', 'TBOH-331502', 'Early check-in request', 'Guests land at 6am, early check-in requested.', 'Resolved', 60],
      ['sky', 'TBOH-119822', 'Charged twice for booking', 'Our wallet was charged twice for the same payment.', 'Resolved', 40],
      ['euro', 'TBOH-229777', 'Amount deducted but booking failed', 'Amount deducted from our credit limit but no voucher issued.', 'Open', 10],
      ['lion', 'TBOH-442555', 'Hotel denied check-in', 'Hotel says no record; please reconfirm the booking.', 'Closed', 90],
      ['sky', 'TBOH-119901', 'Sold out after confirmation', 'Supplier says room sold out; inventory was not updated.', 'Resolved', 35],
      ['gulf', 'TBOH-331777', 'Cancellation penalty dispute', 'Hotel applied a no-show penalty after our cancellation.', 'Resolved', 70],
    ].forEach(([agency, tboh, title, body, status, h], i) =>
      T({ agency, tboh, title, body, status, at: ago(h), check_in: ahead(10 * 24 + i * 24), value: 300 + i * 90, policy: ['FLEX24', 'STD48', 'NRF'][i % 3] }));

    // Bookings with no tickets yet — what agencies pick from when raising something new.
    [
      ['sky', 'TBOH-118999', { hotel: 'Coral Bay Resort', check_in: ahead(26), value: 820, policy: 'FLEX24' }],
      ['sky', 'TBOH-119450', { hotel: 'Ganga View Hotel', city: 'Rishikesh', check_in: ahead(30 * 24), value: 410, policy: 'STD48' }],
      ['sky', 'TBOH-119777', { hotel: 'Marine Drive Suites', city: 'Mumbai', check_in: ahead(6 * 24), value: 1250, policy: 'NRF' }],
      ['euro', 'TBOH-229817', { supplier: 'Alpine Resorts Group', check_in: ahead(20), value: 2600, policy: 'STD48' }],
      ['euro', 'TBOH-229900', { hotel: 'Canal House Hotel', city: 'Amsterdam', check_in: ahead(14 * 24), value: 980, policy: 'FLEX24' }],
      ['euro', 'TBOH-551640', { supplier: 'Atlas Bedbank', hotel: 'Hotel Lumen Berlin', city: 'Berlin', check_in: ahead(12 * 24), value: 700, policy: 'FLEX24' }],
      ['gulf', 'TBOH-331900', { supplier: 'Corniche Palace', city: 'Abu Dhabi', check_in: ahead(3 * 24), value: 1500, policy: 'STD48' }],
      ['lion', 'TBOH-442900', { supplier: 'Marina Suites', check_in: ahead(9 * 24), value: 700, policy: 'FLEX24' }],
    ].forEach(([agency, tboh, o]) => BK(agency, tboh, o));

    // 50,000 archived tickets (12 months) to prove export/query isn't capped at 3K rows.
    run(`INSERT INTO archive(id,created_at,agency_id,region,intent,priority,status)
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<50000)
      SELECT i, ? - i*630000,
        CASE i%4 WHEN 0 THEN 'sky' WHEN 1 THEN 'euro' WHEN 2 THEN 'gulf' ELSE 'lion' END,
        CASE i%4 WHEN 0 THEN 'South Asia' WHEN 1 THEN 'Europe' WHEN 2 THEN 'Middle East' ELSE 'APAC' END,
        CASE (i*7)%10 WHEN 0 THEN 'refund' WHEN 1 THEN 'refund' WHEN 2 THEN 'refund' WHEN 3 THEN 'inventory_sync' WHEN 4 THEN 'booking_change'
          WHEN 5 THEN 'booking_change' WHEN 6 THEN 'cancellation' WHEN 7 THEN 'reconfirmation' WHEN 8 THEN 'payment' ELSE 'special_request' END,
        CASE i%5 WHEN 0 THEN 'high' WHEN 1 THEN 'low' ELSE 'medium' END, 'Closed' FROM n`, ago(24 * 30));
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
if (!one('SELECT COUNT(*) n FROM bookings').n) seed(); // also reseeds DBs from before the booking store existed

// ---------- validation helpers ----------
const str = (v, min, max, name) => {
  const s = String(v ?? '').trim();
  if (s.length < min || s.length > max) bad(`${name} must be ${min}–${max} characters`);
  return s;
};
// ---------- bookings (mock TBO booking store) ----------
function listBookings(me) {
  const scope = me.role === 'requester' ? 'WHERE b.agency_id=?' : '';
  return q(`SELECT b.*, (SELECT COUNT(*) FROM tickets t WHERE t.tboh=b.tboh AND ${OPEN_SQL}) open_tickets FROM bookings b ${scope} ORDER BY b.check_in`, ...(scope ? [me.agency_id] : []));
}

// ---------- tickets ----------
function ticketFor(me, id) {
  const t = one('SELECT * FROM tickets WHERE id=?', Number(id));
  if (!t || (me.role === 'requester' && t.agency_id !== me.agency_id)) bad('Ticket not found', 404); // never reveal other agencies' tickets
  return t;
}

function listTickets(me) {
  const scope = me.role === 'requester' ? 'WHERE t.agency_id=?' : '';
  return q(`SELECT t.*, (SELECT COUNT(*) FROM links l WHERE l.from_id=t.id OR l.to_id=t.id) link_count,
    (SELECT COUNT(*) FROM tickets c WHERE c.tboh=t.tboh AND c.agency_id=t.agency_id) case_size FROM tickets t ${scope} ORDER BY t.id DESC`,
  ...(scope ? [me.agency_id] : []));
}

function createTicket(me, b) {
  // Booking facts (supplier, dates, value, LCD) come from the booking store + policy — never from the form.
  const bk = one('SELECT * FROM bookings WHERE tboh=?', String(b.tboh || '').trim().toUpperCase());
  if (!bk || (me.role === 'requester' && bk.agency_id !== me.agency_id)) bad('Booking not found in your account', 404);
  const agency = one('SELECT * FROM agencies WHERE id=?', bk.agency_id);
  const title = str(b.title, 3, 150, 'Title');
  const body = str(b.body, 3, 4000, 'Description');
  if (!L.PRIORITIES.includes(b.priority)) bad('Unknown priority');
  const { tboh, supplier, check_in, value } = bk;
  const lcd = L.policySheet(bk, Date.now()).lcd;
  const c = L.classify(title + ' ' + body, { priority: b.priority, check_in });
  const manual = b.intent && L.INTENTS[b.intent] && b.intent !== c.intent;
  const now = Date.now();
  const t = { title, body, agency_id: agency.id, tboh, supplier, intent: manual ? b.intent : c.intent, priority: b.priority, region: agency.region, check_in, lcd, booking_value: value, created_at: now, paused_ms: 0, status: 'New' };
  const r = autoRoute(t);
  t.status = r.owner ? 'Open' : 'New';
  const id = Number(run(`INSERT INTO tickets(title,body,agency_id,tboh,supplier,intent,intent_source,confidence,priority,region,check_in,lcd,booking_value,status,owner_id,route_reason,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  title, body, agency.id, tboh, supplier, t.intent, manual ? 'manual' : c.source, manual ? 1 : c.confidence, t.priority, agency.region, check_in, lcd, value, t.status, r.owner, r.reason, now).lastInsertRowid);
  run('UPDATE tickets SET created_by=? WHERE id=?', me.role === 'requester' ? me.name : `${me.name} (for ${agency.name})`, id);
  ev(id, me.name, 'created', `via ${b.channel === 'chatbot' && me.role === 'requester' ? 'agency chatbot' : me.role === 'requester' ? 'agency portal' : 'agent console'} · intent ${L.INTENTS[t.intent].label} (${manual ? 'manual' : c.source + ', ' + Math.round(c.confidence * 100) + '%'})`, now);
  ev(id, 'Router', 'assign', r.reason, now);
  const sla = L.computeSla(t, now);
  ev(id, 'SLA engine', 'sla', `Due in ${L.fmtDur(sla.due - now)} · driver: ${sla.driver}`, now);
  const prior = q('SELECT id FROM tickets WHERE tboh=? AND agency_id=? AND id<>? ORDER BY id', tboh, agency.id, id);
  if (prior.length) ev(id, 'Linker', 'case', `Attached to booking case ${tboh} · ${prior.length} prior contact(s): ${prior.map(p => '#' + p.id).join(', ')}`, now);
  return { id, intent: L.INTENTS[t.intent].label, confidence: c.confidence, source: manual ? 'manual' : c.source, owner: userName(r.owner), reason: r.reason, due_in: L.fmtDur(sla.due - now), driver: sla.driver, prior: prior.length };
}

function ticketDetail(me, id) {
  const t = ticketFor(me, id);
  const req = me.role === 'requester';
  const caseT = q('SELECT id,title,intent,status,created_at,owner_id,created_by FROM tickets WHERE tboh=? AND agency_id=? ORDER BY created_at', t.tboh, t.agency_id);
  const caseNotes = q(`SELECT c.* FROM comments c JOIN tickets t ON t.id=c.ticket_id WHERE t.tboh=? AND t.agency_id=? AND c.ticket_id<>? ${req ? "AND c.kind='external'" : ''} ORDER BY c.at DESC LIMIT 20`, t.tboh, t.agency_id, t.id);
  const links = q('SELECT l.*, CASE WHEN l.from_id=? THEN l.to_id ELSE l.from_id END other_id FROM links l WHERE l.from_id=? OR l.to_id=?', t.id, t.id, t.id)
    .map(l => ({ ...l, other: one('SELECT id,title,agency_id FROM tickets WHERE id=?', l.other_id) }))
    .filter(l => !req || l.other.agency_id === me.agency_id)
    .map(l => ({ type: l.type, other_id: l.other_id, other_title: l.other.title, confirmed_by: l.confirmed_by, at: l.at }));
  let suggestions = [];
  if (!req) {
    const linked = new Set(links.map(l => l.other_id));
    const others = q('SELECT * FROM tickets WHERE id<>? AND (tboh=? OR supplier=?)', t.id, t.tboh, t.supplier || '\u0000');
    suggestions = L.suggestLinks(t, others).filter(s => !linked.has(s.id)).map(s => {
      const o = others.find(x => x.id === s.id);
      return { ...s, title: o.title, agency_id: o.agency_id, status: o.status };
    });
  }
  const sides = req ? [] : q('SELECT * FROM side_convos WHERE ticket_id=? ORDER BY at', t.id).map(s => ({ ...s, recipients: JSON.parse(s.recipients), msgs: q('SELECT * FROM side_msgs WHERE side_id=? ORDER BY at', s.id) }));
  return {
    ticket: t, booking: one('SELECT * FROM bookings WHERE tboh=?', t.tboh) || null, case: caseT, case_notes: caseNotes, links, suggestions, sides,
    comments: q(`SELECT * FROM comments WHERE ticket_id=? ${req ? "AND kind='external'" : ''} ORDER BY at`, t.id),
    events: q(`SELECT * FROM events WHERE ticket_id=? ${req ? "AND action IN ('created','status','escalate','merge')" : ''} ORDER BY at, id`, t.id),
  };
}

function endPause(t, now) { return t.paused_at ? (t.paused_ms || 0) + now - t.paused_at : t.paused_ms || 0; }

function act(me, t, b) {
  const now = Date.now();
  switch (b.type) {
    case 'comment': {
      const kind = me.role === 'requester' ? 'external' : b.kind === 'internal' ? 'internal' : 'external';
      run('INSERT INTO comments(ticket_id,author,kind,body,at) VALUES (?,?,?,?,?)', t.id, me.name, kind, str(b.body, 1, 4000, 'Message'), now);
      if (me.role === 'requester' && ['Resolved', 'Pending'].includes(t.status)) {
        run("UPDATE tickets SET status='Open', pending_reason=NULL, paused_ms=?, paused_at=NULL, resolved_at=NULL WHERE id=?", endPause(t, now), t.id);
        ev(t.id, me.name, 'status', `${t.status} → Open (agency replied)`);
      }
      return {};
    }
    case 'status': {
      must(me, STAFF);
      const [s, reasonIn] = String(b.status || '').split(':');
      if (!L.STATUSES.includes(s) || s === 'Escalated') bad('Use the Escalate action to escalate');
      if (s === t.status && (s !== 'Pending' || reasonIn === t.pending_reason)) return {};
      const reason = s === 'Pending' ? (reasonIn === 'waiting_on_supplier' ? 'waiting_on_supplier' : 'waiting_on_customer') : null;
      const wasPaused = t.status === 'Pending' && t.paused_at;
      const paused_ms = wasPaused && s !== 'Pending' ? endPause(t, now) : t.paused_ms;
      const paused_at = s === 'Pending' ? (t.paused_at || now) : null;
      run('UPDATE tickets SET status=?, pending_reason=?, paused_ms=?, paused_at=?, resolved_at=? WHERE id=?', s, reason, paused_ms, paused_at, ['Resolved', 'Closed'].includes(s) ? (t.resolved_at || now) : null, t.id);
      ev(t.id, me.name, 'status', `${t.status} → ${s}${reason ? ` (${reason.replace(/_/g, ' ')} · SLA clock paused, trip dates still apply)` : ''}${wasPaused && s !== 'Pending' ? ' · SLA clock resumed' : ''}`);
      return {};
    }
    case 'assign': {
      must(me, STAFF);
      let owner = null, reason;
      if (b.owner_id === 'auto') ({ owner, reason } = autoRoute(t));
      else if (b.owner_id) {
        const u = one("SELECT * FROM users WHERE id=? AND role IN ('agent','em')", String(b.owner_id));
        if (!u) bad('Unknown agent');
        owner = u.id; reason = `Manually assigned by ${me.name}`;
      } else reason = `Unassigned by ${me.name} → back to triage`;
      const status = owner ? (t.status === 'New' ? 'Open' : t.status) : 'New';
      run('UPDATE tickets SET owner_id=?, route_reason=?, status=? WHERE id=?', owner, reason, status, t.id);
      const sides = q('SELECT recipients FROM side_convos WHERE ticket_id=?', t.id);
      const nRcpt = sides.reduce((n, s) => n + JSON.parse(s.recipients).length, 0);
      ev(t.id, me.name, 'assign', `${userName(t.owner_id)} → ${userName(owner)} · ${reason}${sides.length ? ` · ${sides.length} side conversation(s) keep their ${nRcpt} explicit recipient(s)` : ''}`);
      return {};
    }
    case 'escalate': {
      must(me, STAFF);
      if (t.status === 'Escalated') bad('Already escalated');
      const em = one("SELECT * FROM users WHERE role='em' ORDER BY on_shift DESC LIMIT 1");
      const why = String(b.reason || '').trim().slice(0, 300) || 'Trip-date risk';
      const sla = L.computeSla(t, now);
      run("UPDATE tickets SET status='Escalated', owner_id=?, route_reason=?, paused_ms=?, paused_at=NULL WHERE id=?", em.id, `Escalated by ${me.name}: ${why}`, endPause(t, now), t.id);
      ev(t.id, me.name, 'escalate', `→ ${em.name} (Escalation Manager) · ${why} · SLA ${sla.state.replace('_', ' ')}, ${sla.left >= 0 ? L.fmtDur(sla.left) + ' left' : L.fmtDur(sla.left) + ' over'}`);
      return {};
    }
    case 'intent': {
      must(me, STAFF);
      if (!L.INTENTS[b.intent]) bad('Unknown intent');
      run("UPDATE tickets SET intent=?, intent_source='manual', confidence=1 WHERE id=?", b.intent, t.id);
      ev(t.id, me.name, 'intent', `${L.INTENTS[t.intent].label} → ${L.INTENTS[b.intent].label} (manual correction)`);
      return {};
    }
    case 'link': {
      must(me, STAFF);
      const o = one('SELECT * FROM tickets WHERE id=?', Number(b.to_id));
      const sug = o && L.suggestLinks(t, [o]).find(s => s.type === b.link_type);
      if (!sug) bad('That link is not valid for these tickets');
      run('INSERT INTO links(from_id,to_id,type,confirmed_by,at) VALUES (?,?,?,?,?)', t.id, o.id, sug.type, me.name, now);
      if (sug.type !== 'merge') {
        ev(t.id, me.name, 'link', `${sug.type} → #${o.id} (${sug.why})`);
        ev(o.id, me.name, 'link', `${sug.type} ← #${t.id} (${sug.why})`);
        return {};
      }
      const [older, newer] = t.created_at <= o.created_at ? [t, o] : [o, t];
      run("UPDATE tickets SET status='Closed', resolved_at=?, paused_at=NULL WHERE id=?", now, newer.id);
      run('INSERT INTO comments(ticket_id,author,kind,body,at) VALUES (?,?,?,?,?)', older.id, 'OpsDesk', 'external', `Merged from #${newer.id} — ${newer.title}\n\n${newer.body}`, now);
      const reopen = ['Pending', 'Resolved'].includes(older.status);
      if (reopen) run("UPDATE tickets SET status='Open', pending_reason=NULL, paused_ms=?, paused_at=NULL, resolved_at=NULL WHERE id=?", endPause(older, now), older.id);
      ev(newer.id, me.name, 'merge', `Merged into #${older.id} (same agency + booking + intent) — confirmed by ${me.name}`);
      ev(older.id, me.name, 'merge', `#${newer.id} merged in — one thread for this booking${reopen ? ` · ${older.status} → Open (agency chased again)` : ''}`);
      return { goto: older.id };
    }
    case 'side_new': {
      must(me, STAFF);
      const recipients = String(b.recipients || '').split(/[,;\s]+/).filter(Boolean);
      if (!recipients.length || recipients.length > 10 || !recipients.every(r => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r))) bad('Recipients must be 1–10 valid email addresses');
      const subject = str(b.subject, 1, 150, 'Subject'), body = str(b.body, 1, 2000, 'Message');
      const sid = Number(run('INSERT INTO side_convos(ticket_id,subject,recipients,created_by,at) VALUES (?,?,?,?,?)', t.id, subject, JSON.stringify(recipients), me.name, now).lastInsertRowid);
      run('INSERT INTO side_msgs(side_id,author,body,at) VALUES (?,?,?,?)', sid, me.name, body, now);
      ev(t.id, me.name, 'side_convo', `Started "${subject}" with ${recipients.join(', ')}`);
      return {};
    }
    case 'side_reply': {
      must(me, STAFF);
      const s = one('SELECT * FROM side_convos WHERE id=? AND ticket_id=?', Number(b.side_id), t.id);
      if (!s) bad('Side conversation not found', 404);
      const author = b.as_recipient ? JSON.parse(s.recipients)[0] : me.name; // demo: simulate the supplier answering
      run('INSERT INTO side_msgs(side_id,author,body,at) VALUES (?,?,?,?)', s.id, author, str(b.body, 1, 2000, 'Message'), now);
      return {};
    }
    default: bad('Unknown action');
  }
}

// ---------- insights & export ----------
function insights() {
  const now = Date.now(), week = now - 7 * D;
  const themes = q('SELECT intent, COUNT(*) c FROM tickets WHERE created_at>=? GROUP BY intent ORDER BY c DESC', week).map(r => ({
    ...r, theme: L.INTENTS[r.intent].theme, backlog: L.INTENTS[r.intent].backlog,
    samples: q('SELECT id,title,status FROM tickets WHERE intent=? AND created_at>=? ORDER BY created_at DESC LIMIT 3', r.intent, week),
  }));
  const open = q(`SELECT * FROM tickets WHERE ${OPEN_SQL}`);
  const states = open.map(t => L.computeSla(t, now).state);
  return {
    health: {
      open: open.length, at_risk: states.filter(s => s === 'at_risk').length, breached: states.filter(s => s === 'breached').length,
      escalated: open.filter(t => t.status === 'Escalated').length, triage: open.filter(t => !t.owner_id).length,
    },
    themes,
    incidents: q(`SELECT supplier, intent, COUNT(DISTINCT agency_id) agencies, COUNT(*) c FROM tickets WHERE created_at>=? AND supplier IS NOT NULL AND ${OPEN_SQL} GROUP BY supplier, intent HAVING agencies>1`, now - 2 * D),
    regions: q(`SELECT region, COUNT(*) c FROM tickets WHERE ${OPEN_SQL} GROUP BY region ORDER BY c DESC`),
    archive_total: one('SELECT COUNT(*) n FROM archive').n,
    archive_themes: q('SELECT intent, COUNT(*) c FROM archive GROUP BY intent ORDER BY c DESC').map(r => ({ ...r, theme: L.INTENTS[r.intent].theme })),
  };
}

function exportCsv(res) {
  const cell = v => { const s = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const iso = ms => (ms ? new Date(ms).toISOString() : '');
  const live = q('SELECT * FROM tickets ORDER BY id');
  const archiveN = one('SELECT COUNT(*) n FROM archive').n;
  res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="opsdesk-export.csv"', 'x-row-count': String(live.length + archiveN) });
  res.write('id,source,created_at,agency_id,region,tboh,intent,priority,status,owner,sla_state\n');
  const now = Date.now();
  res.write(live.map(t => [t.id, 'live', iso(t.created_at), t.agency_id, t.region, t.tboh, t.intent, t.priority, t.status, t.owner_id, L.computeSla(t, now).state].map(cell).join(',')).join('\n') + '\n');
  // Chunked so memory stays flat; the same loop scales to millions of rows (or swap for COPY/CDC in Postgres).
  const stmt = db.prepare('SELECT * FROM archive WHERE id>? ORDER BY id LIMIT 5000');
  for (let last = 0; ;) {
    const rows = stmt.all(last);
    if (!rows.length) break;
    res.write(rows.map(r => ['A' + r.id, 'archive', iso(r.created_at), r.agency_id, r.region, '', r.intent, r.priority, r.status, '', 'done'].join(',')).join('\n') + '\n');
    last = rows[rows.length - 1].id;
  }
  res.end();
}

// ---------- http ----------
const send = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
function readBody(req) {
  return new Promise((ok, no) => {
    let s = '';
    req.on('data', c => { s += c; if (s.length > 1e5) { no(Object.assign(new Error('Body too large'), { status: 413 })); req.destroy(); } });
    req.on('end', () => { try { ok(s ? JSON.parse(s) : {}); } catch { no(Object.assign(new Error('Invalid JSON'), { status: 400 })); } });
  });
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
function serveStatic(p, res) {
  const file = path.normalize(path.join(PUB, p === '/' ? 'index.html' : p));
  if (!file.startsWith(PUB)) return send(res, 403, { error: 'Forbidden' });
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname, m = req.method;
    if (!p.startsWith('/api/')) return serveStatic(p, res);
    if (p === '/api/users' && m === 'GET') // demo login list (no passwords — documented demo auth)
      return send(res, 200, { users: q('SELECT * FROM users ORDER BY role, name').map(parseUser), agencies: q('SELECT * FROM agencies') });
    const me = parseUser(one('SELECT * FROM users WHERE id=?', String(req.headers['x-user'] || '')));
    if (!me) return send(res, 401, { error: 'Pick a demo user first' });

    let mt;
    if (p === '/api/tickets' && m === 'GET') return send(res, 200, { tickets: listTickets(me) });
    if (p === '/api/bookings' && m === 'GET') return send(res, 200, { bookings: listBookings(me) });
    if (p === '/api/tickets' && m === 'POST') { must(me, ['requester', 'agent', 'lead']); return send(res, 201, createTicket(me, await readBody(req))); }
    if ((mt = p.match(/^\/api\/tickets\/(\d+)$/)) && m === 'GET') return send(res, 200, ticketDetail(me, mt[1]));
    if ((mt = p.match(/^\/api\/tickets\/(\d+)\/action$/)) && m === 'POST') {
      const b = await readBody(req);
      return send(res, 200, act(me, ticketFor(me, mt[1]), b) || {});
    }
    if (p === '/api/insights' && m === 'GET') { must(me, ['lead', 'em']); return send(res, 200, insights()); }
    if (p === '/api/export.csv' && m === 'GET') { must(me, ['lead']); return exportCsv(res); }
    if (p === '/api/team' && m === 'GET') {
      must(me, ['lead']);
      const load = loadMap();
      return send(res, 200, { agents: q("SELECT * FROM users WHERE role IN ('agent','em') ORDER BY role, name").map(parseUser).map(a => ({ ...a, load: load[a.id] || 0 })) });
    }
    if ((mt = p.match(/^\/api\/users\/([\w-]+)\/shift$/)) && m === 'POST') {
      must(me, ['lead']);
      const b = await readBody(req);
      const r = run("UPDATE users SET on_shift=? WHERE id=? AND role='agent'", b.on_shift ? 1 : 0, mt[1]);
      if (!r.changes) bad('Unknown agent', 404);
      return send(res, 200, {});
    }
    if (p === '/api/reset' && m === 'POST') { must(me, ['lead']); seed(); return send(res, 200, {}); }
    send(res, 404, { error: 'Not found' });
  } catch (e) {
    if (!e.status) console.error(e);
    if (!res.headersSent) send(res, e.status || 500, { error: e.status ? e.message : 'Internal error' });
  }
}).listen(PORT, () => console.log(`OpsDesk running → http://localhost:${PORT}`));
