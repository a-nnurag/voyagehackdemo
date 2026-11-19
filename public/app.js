'use strict';
const L = window.Logic;
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const S = { users: [], agencies: [], me: null, view: null, tickets: null, listErr: null, sel: null, detail: null, f: { region: '', intent: '', closed: false } };
const STAFF = ['agent', 'em', 'lead'];
const isStaff = () => STAFF.includes(S.me.role);
const ROLE = { requester: 'Agency requester', agent: 'Ops agent', em: 'Escalation manager', lead: 'Ops lead' };
const VIEWS = {
  requester: [['mine', 'My agency tickets'], ['bookings', 'My bookings']],
  agent: [['mine', 'My queue'], ['triage', 'Triage (unassigned)'], ['all', 'All open'], ['escalations', 'Escalation queue'], ['linked', 'Linked cases']],
  em: [['escalations', 'Escalation queue'], ['all', 'All open'], ['linked', 'Linked cases'], ['insights', 'Insights']],
  lead: [['all', 'All open'], ['triage', 'Triage (unassigned)'], ['escalations', 'Escalation queue'], ['linked', 'Linked cases'], ['insights', 'Insights & data'], ['team', 'Team & routing']],
};
const PAGES = ['insights', 'team', 'bookings']; // non-queue views
const SLA_TXT = { on_track: 'On track', at_risk: 'At risk', breached: 'Breached', done: 'Done' };
const uName = id => (id && S.users.find(u => u.id === id)?.name) || 'Unassigned';
const aName = id => S.agencies.find(a => a.id === id)?.name || id;
const ilabel = k => L.INTENTS[k]?.label || k;
const fmtTime = ms => (ms ? new Date(ms).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
const isOpen = t => !['Resolved', 'Closed'].includes(t.status);

async function api(path, body, method) {
  const r = await fetch(path, { method: method || (body ? 'POST' : 'GET'), headers: { 'content-type': 'application/json', 'x-user': S.me?.id || '' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}
function toast(html, kind = 'ok') {
  const t = document.createElement('div');
  t.className = 'toast ' + kind; t.innerHTML = html;
  $('#toasts')?.append(t);
  setTimeout(() => t.remove(), 7000);
}
function slaBadge(t, big) {
  const s = L.computeSla(t, Date.now());
  if (s.state === 'done') return `<span class="sla done">${t.status}</span>`;
  return `<span class="sla ${s.state}${big ? ' big' : ''}">${s.paused ? '⏸ ' : ''}${SLA_TXT[s.state]} · ${L.fmtDur(s.left)} ${s.left >= 0 ? 'left' : 'over'}</span>`;
}

// ---------- login ----------
async function boot() {
  try {
    const d = await api('/api/users');
    S.users = d.users; S.agencies = d.agencies;
  } catch (e) {
    document.body.innerHTML = `<div class="error">Can't reach the OpsDesk server: ${esc(e.message)}. Is <code>npm start</code> running?</div>`;
    return;
  }
  let saved = null;
  try { saved = localStorage.getItem('opsdesk.user'); } catch { /* private mode */ }
  if (saved && S.users.some(u => u.id === saved)) login(saved); else renderLogin();
}
function renderLogin() {
  const sub = u => u.role === 'requester' ? aName(u.agency_id) : u.role === 'agent' ? `${u.regions.join(', ')}${u.senior ? ' · senior' : ''}${u.on_shift ? '' : ' · off shift'}` : ROLE[u.role];
  document.body.innerHTML = `<div class="login"><div class="login-card">
    <div class="brand big">Ops<b>Desk</b></div>
    <p class="tag">Travel-native operations ticketing for TBO · Linked by booking · Routed by reality · Escalated on purpose</p>
    <h3>Demo login — pick a persona</h3>
    ${['requester', 'agent', 'em', 'lead'].map(g => `<div class="lg"><h4>${ROLE[g]}</h4><div class="lg-row">
      ${S.users.filter(u => u.role === g).map(u => `<button class="persona" data-u="${u.id}"><b>${esc(u.name)}</b><small>${esc(sub(u))}</small></button>`).join('')}
    </div></div>`).join('')}
    <p class="muted" style="margin-top:18px">Demo auth (no passwords). Role permissions and agency data isolation are enforced by the server.</p>
  </div></div>`;
  $$('.persona').forEach(b => { b.onclick = () => login(b.dataset.u); });
}
function login(id) {
  S.me = S.users.find(u => u.id === id);
  if (!S.me) return renderLogin();
  try { localStorage.setItem('opsdesk.user', id); } catch { /* ignore */ }
  Object.assign(S, { view: VIEWS[S.me.role][0][0], sel: null, detail: null, tickets: null, bookings: null, f: { region: '', intent: '', closed: false } });
  document.body.innerHTML = `<header>
      <div class="brand">Ops<b>Desk</b></div><span class="tag">Linked by booking · Routed by reality · Escalated on purpose</span>
      <span class="grow"></span>
      ${S.me.role !== 'em' ? '<button class="primary" id="newBtn">+ New ticket</button>' : ''}
      <div class="me"><b>${esc(S.me.name)}</b><small>${ROLE[S.me.role]}</small></div>
      <button class="ghost" id="switchBtn">Switch user</button>
    </header>
    <div class="layout"><nav id="nav"></nav><main id="main"></main></div><div id="toasts"></div>`;
  $('#switchBtn').onclick = () => { try { localStorage.removeItem('opsdesk.user'); } catch { /* ignore */ } S.me = null; renderLogin(); };
  if ($('#newBtn')) $('#newBtn').onclick = () => openNew();
  go(S.view);
  chatInit();
}

// ---------- navigation ----------
function go(view) {
  S.view = view;
  $('#nav').innerHTML = VIEWS[S.me.role].map(([k, l]) => `<a class="${S.view === k ? 'on' : ''}" data-v="${k}">${l}<span class="cnt" data-c="${k}"></span></a>`).join('') +
    `<div class="foot">Queue order = travel-aware deadline, not FIFO.<br>Data persists in SQLite — refresh-safe.</div>`;
  $$('#nav a').forEach(a => { a.onclick = () => go(a.dataset.v); });
  if (view === 'insights') return renderInsights();
  if (view === 'team') return renderTeam();
  if (view === 'bookings') return renderBookings();
  renderQueue();
  loadList();
}
document.addEventListener('click', e => {
  const a = e.target.closest('[data-open]');
  if (!a) return;
  const id = Number(a.dataset.open);
  if (!$('#rows')) { S.sel = id; S.f.closed = true; go(VIEWS[S.me.role].find(v => !PAGES.includes(v[0]))[0]); } else loadDetail(id);
});

// ---------- queue ----------
function viewFilter(t, view = S.view) {
  switch (view) {
    case 'mine': return S.me.role === 'requester' ? true : t.owner_id === S.me.id && isOpen(t);
    case 'triage': return !t.owner_id && isOpen(t);
    case 'escalations': return t.status === 'Escalated';
    case 'linked': return t.link_count > 0 || t.case_size > 1;
    default: return isOpen(t);
  }
}
function renderQueue() {
  const title = VIEWS[S.me.role].find(v => v[0] === S.view)[1];
  const regions = [...new Set(S.agencies.map(a => a.region))];
  $('#main').innerHTML = `<section class="split">
    <div class="list"><div class="list-head"><h2>${title}</h2>
      ${isStaff() ? `<div class="filters">
        <select id="fRegion" aria-label="Region"><option value="">All regions</option>${regions.map(r => `<option ${S.f.region === r ? 'selected' : ''}>${r}</option>`).join('')}</select>
        <select id="fIntent" aria-label="Intent"><option value="">All intents</option>${Object.keys(L.INTENTS).map(k => `<option value="${k}" ${S.f.intent === k ? 'selected' : ''}>${ilabel(k)}</option>`).join('')}</select>
        <label><input type="checkbox" id="fClosed" ${S.f.closed ? 'checked' : ''}> show closed</label></div>` : ''}
      <p class="hint">Sorted by travel-aware deadline — soonest trip risk first</p></div>
      <div id="rows"><div class="empty">Loading tickets…</div></div></div>
    <div class="detail" id="detail"><div class="empty big">Select a ticket to see its booking case, SLA and timeline.</div></div>
  </section>`;
  if (isStaff()) {
    $('#fRegion').onchange = e => { S.f.region = e.target.value; renderList(); };
    $('#fIntent').onchange = e => { S.f.intent = e.target.value; renderList(); };
    $('#fClosed').onchange = e => { S.f.closed = e.target.checked; renderList(); };
  }
  if (S.sel) loadDetail(S.sel);
}
async function loadList() {
  try { S.tickets = (await api('/api/tickets')).tickets; S.listErr = null; } catch (e) { S.listErr = e.message; }
  renderList();
}
function renderList() {
  const el = $('#rows');
  if (!el) return;
  if (S.listErr) { el.innerHTML = `<div class="error">Couldn't load tickets: ${esc(S.listErr)} <button id="retry">Retry</button></div>`; $('#retry').onclick = loadList; return; }
  if (!S.tickets) return;
  const now = Date.now();
  const rows = S.tickets
    .filter(t => viewFilter(t) || (S.f.closed && !isOpen(t) && ['all', 'linked'].includes(S.view)))
    .filter(t => (!S.f.region || t.region === S.f.region) && (!S.f.intent || t.intent === S.f.intent))
    .map(t => ({ t, s: L.computeSla(t, now) }))
    .sort((a, b) => (a.s.state === 'done') - (b.s.state === 'done') || a.s.due - b.s.due);
  el.innerHTML = rows.length ? rows.map(({ t }) => `<div class="row ${t.id === S.sel ? 'sel' : ''}" data-id="${t.id}">
      <div class="r1">${slaBadge(t)}<span class="st st-${t.status}">${t.status}</span><span class="pri p-${t.priority}">${t.priority}</span></div>
      <div class="r2"><span class="mono muted">#${t.id}</span> ${esc(t.title)}</div>
      <div class="r3">${S.me.role === 'requester' ? `Raised by ${esc(t.created_by === S.me.name ? 'you' : t.created_by)}` : esc(aName(t.agency_id))} · <span class="mono">${esc(t.tboh)}</span> · ${esc(ilabel(t.intent))} · ${esc(t.region)} · ${esc(uName(t.owner_id))}
        ${t.case_size > 1 ? ` <span class="chip case">${t.case_size} contacts on booking</span>` : ''}${t.link_count ? ' <span class="chip case">linked</span>' : ''}</div>
    </div>`).join('') : '<div class="empty">Nothing here — this queue is clear.</div>';
  $$('.row', el).forEach(r => { r.onclick = () => loadDetail(Number(r.dataset.id)); });
  for (const [k] of VIEWS[S.me.role]) {
    const c = $(`[data-c="${k}"]`);
    if (c && !PAGES.includes(k)) c.textContent = S.tickets.filter(t => viewFilter(t, k)).length;
  }
}
setInterval(() => { if (S.me && $('#rows')) loadList(); }, 5000); // near-real-time queue + live SLA countdowns

// ---------- ticket detail ----------
async function loadDetail(id) {
  S.sel = id;
  $$('.row').forEach(r => r.classList.toggle('sel', Number(r.dataset.id) === id));
  const el = $('#detail');
  if (!el) return;
  if (!S.detail || S.detail.ticket.id !== id) el.innerHTML = '<div class="empty big">Loading…</div>';
  try { S.detail = await api('/api/tickets/' + id); renderDetail(); } catch (e) { el.innerHTML = `<div class="error">${esc(e.message)}</div>`; }
}
async function act(type, body = {}) {
  const t = S.detail.ticket;
  try {
    const r = await api(`/api/tickets/${t.id}/action`, { type, ...body });
    await loadList();
    await loadDetail(r.goto || t.id);
    return true;
  } catch (e) { toast(esc(e.message), 'err'); return false; }
}

function renderDetail() {
  const d = S.detail, t = d.ticket, staff = isStaff(), s = L.computeSla(t, Date.now());
  const owners = S.users.filter(u => u.role === 'agent' || u.role === 'em');
  const src = t.intent_source === 'manual' ? 'manual' : `${t.intent_source === 'rules' ? 'rules' : 'low confidence → LLM fallback'} · ${Math.round(t.confidence * 100)}%`;
  const statusOpts = [['New', 'New'], ['Open', 'Open'], ['Pending:waiting_on_customer', 'Pending · waiting on agency'], ['Pending:waiting_on_supplier', 'Pending · waiting on supplier'], ['Resolved', 'Resolved'], ['Closed', 'Closed']];
  const curStatus = t.status === 'Pending' ? `Pending:${t.pending_reason}` : t.status;
  $('#detail').innerHTML = `
  <div class="d-title"><span class="mono muted">#${t.id}</span><h2>${esc(t.title)}</h2></div>
  <div class="chips">
    <span class="st st-${t.status}">${t.status}</span><span class="pri p-${t.priority}">${t.priority}</span>
    <span class="chip">${esc(aName(t.agency_id))}</span><span class="chip">Raised by ${esc(t.created_by || '—')}</span><span class="chip mono">${esc(t.tboh)}</span><span class="chip">${esc(t.region)}</span>
    ${t.supplier ? `<span class="chip">Supplier: ${esc(t.supplier)}</span>` : ''}
    <span class="chip intent">Intent: ${esc(ilabel(t.intent))} <small>${src}</small></span>
  </div>
  <p class="body">${esc(t.body)}</p>
  ${staff ? `<div class="actions">
    <label>Status <select id="aStatus">${t.status === 'Escalated' ? '<option selected>Escalated</option>' : ''}${statusOpts.map(([v, l]) => `<option value="${v}" ${v === curStatus ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    <label>Owner <select id="aOwner"><option value="">${esc(uName(t.owner_id))}</option><option value="auto">⚡ Auto-route</option>${owners.filter(u => u.id !== t.owner_id).map(u => `<option value="${u.id}">${esc(u.name)}${u.role === 'em' ? ' (EM)' : u.on_shift ? '' : ' (off shift)'}</option>`).join('')}${t.owner_id ? '<option value="none">Unassign → triage</option>' : ''}</select></label>
    <label>Intent <select id="aIntent">${Object.keys(L.INTENTS).map(k => `<option value="${k}" ${k === t.intent ? 'selected' : ''}>${ilabel(k)}</option>`).join('')}</select></label>
    ${t.status !== 'Escalated' && isOpen(t) ? '<span class="esc"><input id="escReason" placeholder="Escalation reason" maxlength="300"><button class="danger" id="aEsc">Escalate to Escalation Manager</button></span>' : ''}
  </div>` : ''}
  <div class="grid2">
    <div class="card"><h3>Travel-aware SLA</h3>${slaBadge(t, true)}
      <div class="due">Due <b>${fmtTime(s.due)}</b></div>
      <ul class="cands">${s.candidates.map(c => `<li class="${c.win ? 'win' : ''}">${esc(c.label)} → ${fmtTime(c.at)}</li>`).join('')}</ul>
      <p class="muted" style="margin:6px 0 0;font-size:12.5px">Deadline = soonest of the above. Driver: <b>${esc(s.driver)}</b>${s.paused ? `<br>⏸ Clock paused (${esc((t.pending_reason || '').replace(/_/g, ' '))}) — trip dates still apply.` : ''}</p>
      <p class="muted" style="margin:6px 0 0;font-size:12.5px">Check-in ${fmtTime(t.check_in)} · LCD ${t.lcd ? fmtTime(t.lcd) : "none"} (from cancellation policy) · booking value $${Number(t.booking_value).toLocaleString()}</p></div>
    <div class="card"><h3>Ownership & routing</h3><div class="owner">${esc(uName(t.owner_id))}</div><p class="reason">${esc(t.route_reason || '—')}</p></div>
  </div>
  ${d.booking ? `<div class="card"><h3>Booking & cancellation policy <small>— from TBO's booking system</small></h3>${bookingCard(d.booking)}</div>` : ""}
  <div class="card"><h3>Booking case · ${esc(t.tboh)} · ${esc(aName(t.agency_id))} <small>— ${d.case.length} contact${d.case.length > 1 ? 's' : ''} on this booking</small></h3>
    ${d.case.map(c => `<div class="case-row ${c.id === t.id ? 'cur' : ''}" data-open="${c.id}"><span class="mono">#${c.id}</span> · ${fmtTime(c.created_at)} · ${esc(ilabel(c.intent))} · <span class="st st-${c.status}">${c.status}</span> · ${esc(c.title)} <small>· raised by ${esc(c.created_by || '—')} · owner ${esc(uName(c.owner_id))}</small></div>`).join('')}
    ${d.suggestions.length ? `<div class="sugg"><h4>Suggested links <small>— nothing changes until an agent confirms</small></h4>
      ${d.suggestions.map(x => `<div class="sg sg-${x.type}"><span class="lt">${x.type}</span><a data-open="${x.id}">#${x.id} ${esc(x.title)}</a><small>${esc(aName(x.agency_id))} · ${esc(x.why)}</small><button data-link="${x.id}" data-type="${x.type}">Confirm ${x.type}</button></div>`).join('')}</div>` : ''}
    ${d.links.length ? `<div class="links"><h4>Confirmed links</h4>${d.links.map(l => `<div><span class="lt">${l.type}</span> <a data-open="${l.other_id}">#${l.other_id} ${esc(l.other_title)}</a> <small>· confirmed by ${esc(l.confirmed_by)}</small></div>`).join('')}</div>` : ''}
  </div>
  <div class="card"><h3>Case assistant <small>— answers from the booking's full history, no re-explaining</small></h3>
    <div class="qchips"><button data-q="summary">Summarize this case</button><button data-q="supplier">What did the supplier say?</button><button data-q="deadline">Why this deadline?</button><button data-q="owner">Who owns it and why?</button></div>
    <form class="inline" id="askF"><input name="q" placeholder="Ask about this booking…" maxlength="200"><button>Ask</button></form>
    <div class="ans" id="ans"></div></div>
  <div class="card"><h3>Conversation <small>${staff ? '— internal notes are never shown to the agency' : ''}</small></h3>
    ${d.comments.map(c => `<div class="cmt ${c.kind}"><b>${esc(c.author)}</b><span class="kind">${c.kind === 'internal' ? 'Internal note' : 'Reply'}</span> <small>${fmtTime(c.at)}</small><p>${esc(c.body)}</p></div>`).join('') || '<div class="empty">No messages yet.</div>'}
    <form class="composer" id="cmtF"><textarea name="body" required maxlength="4000" placeholder="${staff ? 'Reply to the agency or add an internal note…' : 'Add a message for TBO support…'}"></textarea>
      <div class="row-f">${staff ? '<label><input type="radio" name="kind" value="external" checked> Reply to agency</label><label><input type="radio" name="kind" value="internal"> Internal note</label>' : ''}<button class="primary">Send</button></div></form></div>
  ${staff ? `<div class="card"><h3>Side conversations <small>— explicit recipients, not tied to the ticket's group; they survive transfer</small></h3>
    ${d.sides.map(sc => `<div class="side"><b>${esc(sc.subject)}</b>
      <div class="rcpts">To: ${sc.recipients.map(r => `<span class="chip">${esc(r)}</span>`).join('')} <small>· started by ${esc(sc.created_by)}</small></div>
      ${sc.msgs.map(m => `<div class="msg"><b>${esc(m.author)}</b> <small>${fmtTime(m.at)}</small><p>${esc(m.body)}</p></div>`).join('')}
      <form data-side="${sc.id}"><input name="body" placeholder="Reply to recipients…" maxlength="2000"><button>Send</button><button type="button" class="ghost" data-sim="${sc.id}">Simulate supplier reply</button></form></div>`).join('') || '<div class="empty">No side conversations yet.</div>'}
    <details><summary>+ New side conversation</summary><form id="sideNew">
      <input name="recipients" placeholder="Recipients — any emails, comma-separated (e.g. reservations@hotel.example)" required>
      <input name="subject" placeholder="Subject" required maxlength="150" value="${esc(t.tboh)} — ">
      <textarea name="body" placeholder="Message" required maxlength="2000"></textarea><button class="primary">Start thread</button></form></details></div>` : ''}
  <div class="card"><h3>Activity timeline <small>— audit of every change and who made it</small></h3>
    <ol class="tl">${d.events.map(e => `<li class="ev-${e.action}"><small>${fmtTime(e.at)}</small> · <b>${esc(e.actor)}</b> · <span class="act">${esc(e.action.replace('_', ' '))}</span> — ${esc(e.detail)}</li>`).join('')}</ol></div>`;

  // handlers
  if (staff) {
    $('#aStatus').onchange = e => act('status', { status: e.target.value });
    $('#aOwner').onchange = async e => {
      const v = e.target.value;
      if (!v) return;
      if (await act('assign', { owner_id: v === 'none' ? null : v })) toast(`Owner → <b>${esc(uName(S.detail.ticket.owner_id))}</b><br><small style="color:#cdd8f5">${esc(S.detail.ticket.route_reason)}</small>`);
    };
    $('#aIntent').onchange = e => act('intent', { intent: e.target.value });
    if ($('#aEsc')) $('#aEsc').onclick = async () => {
      if (await act('escalate', { reason: $('#escReason').value })) toast('Escalated to <b>Neha Kapoor</b> (Escalation Manager) — now in the Escalation queue');
    };
    $$('[data-link]').forEach(b => {
      b.onclick = async () => {
        if (await act('link', { to_id: Number(b.dataset.link), link_type: b.dataset.type })) toast(b.dataset.type === 'merge' ? 'Merged — one thread for this booking' : `Confirmed ${b.dataset.type}`);
      };
    });
    $$('form[data-side]').forEach(f => {
      f.onsubmit = e => { e.preventDefault(); if (f.body.value.trim()) act('side_reply', { side_id: Number(f.dataset.side), body: f.body.value }); };
    });
    $$('[data-sim]').forEach(b => {
      b.onclick = () => {
        const f = b.closest('form');
        act('side_reply', { side_id: Number(b.dataset.sim), as_recipient: true, body: f.body.value.trim() || 'Acknowledged — checking with the property and will revert within 2 hours.' });
      };
    });
    $('#sideNew').onsubmit = e => {
      e.preventDefault();
      const f = e.target;
      act('side_new', { recipients: f.recipients.value, subject: f.subject.value, body: f.body.value });
    };
  }
  $('#cmtF').onsubmit = e => {
    e.preventDefault();
    const f = e.target;
    act('comment', { body: f.body.value, kind: f.kind?.value || 'external' });
  };
  const answer = q => { $('#ans').textContent = askCase(q, S.detail); };
  $$('[data-q]').forEach(b => { b.onclick = () => answer(b.dataset.q); });
  $('#askF').onsubmit = e => { e.preventDefault(); answer(e.target.q.value); };
}

// Deterministic case assistant over linked history (an LLM could draft prose on top; facts come from data).
function askCase(qIn, d) {
  const q = String(qIn || '').toLowerCase(), t = d.ticket, s = L.computeSla(t, Date.now());
  if (/supplier|hotel|side|vendor/.test(q)) {
    const msgs = d.sides.flatMap(sc => sc.msgs.map(m => ({ ...m, subject: sc.subject, to: sc.recipients }))).sort((a, b) => b.at - a.at);
    const inbound = msgs.find(m => m.to.includes(m.author));
    if (!msgs.length) return S.me.role === 'requester' ? 'Supplier threads are handled by TBO ops — you will get a reply on this ticket.' : 'No supplier side conversation on this ticket yet. Start one below with explicit recipients.';
    return inbound ? `Latest supplier reply (${fmtTime(inbound.at)}) from ${inbound.author}:\n“${inbound.body}”\nThread: ${inbound.subject} · recipients: ${inbound.to.join(', ')}` : `Supplier hasn't replied yet. Last message sent ${fmtTime(msgs[0].at)} by ${msgs[0].author}.`;
  }
  if (/deadline|sla|due|urgent|when|why this/.test(q)) {
    return `${SLA_TXT[s.state]} — due ${fmtTime(s.due)} (${L.fmtDur(s.left)} ${s.left >= 0 ? 'left' : 'over'}).\nDriver: ${s.driver}.\nCandidates: ${s.candidates.map(c => `${c.label} → ${fmtTime(c.at)}`).join('; ')}.${s.paused ? '\nClock is paused while pending, but trip dates still apply.' : ''}`;
  }
  if (/owner|who|assign|route/.test(q)) return `Owned by ${uName(t.owner_id)}.\nWhy: ${t.route_reason || '—'}`;
  const same = d.case.filter(c => c.intent === t.intent);
  const notes = d.case_notes.slice(0, 3).map(n => `• #${n.ticket_id} ${n.kind === 'internal' ? '(internal) ' : ''}${n.author}: “${n.body}”`).join('\n');
  return [
    `Booking ${t.tboh} · ${aName(t.agency_id)} — ${d.case.length} contact(s) since ${fmtTime(d.case[0].created_at)}:`,
    d.case.map(c => `• #${c.id} ${fmtTime(c.created_at)} · ${ilabel(c.intent)} · ${c.status}`).join('\n'),
    same.length > 1 ? `⚠ ${ilabel(t.intent)} has been raised ${same.length} times on this booking — treat as a repeat chaser; don't ask the agency to re-explain.` : '',
    notes ? `Latest notes across the case:\n${notes}` : '',
    `Current SLA: ${SLA_TXT[s.state]}, due ${fmtTime(s.due)} (${s.driver}).`,
  ].filter(Boolean).join('\n');
}

// ---------- agency chatbot: raise or chase a ticket in conversation ----------
// Deterministic flow on top of the same rules classifier + SLA engine; asks only for what it couldn't extract.
const CB = { open: false, msgs: [], draft: null, dupe: null, step: 'start', busy: false };
const TBOH_RE = /TBOH[-\s]?(\d{4,10})/i;
const URGENT_RE = /\b(urgent|asap|immediately|tonight|stranded|denied|no record)\b/i;

function chatInit() {
  Object.assign(CB, { open: false, msgs: [], draft: null, dupe: null, step: 'start', busy: false });
  if (S.me.role !== 'requester') return;
  const w = document.createElement('div');
  w.id = 'chat';
  document.body.append(w);
  CB.msgs.push({ who: 'bot', text: `Hi ${S.me.name.split(' ')[0]}! I'm the OpsDesk assistant. Describe a problem with a booking and I'll raise a ticket for you — or ask me for the status of a booking.`, chips: [
    ['Report a problem', () => botSay('Describe it in a sentence or two — include the booking ID (TBOH-…) if you have it.')],
    ['Check ticket status', () => { CB.step = 'status'; botSay('Send the booking ID (TBOH-…) or ticket number (#12).'); }],
  ] });
  renderChat();
}
function renderChat() {
  const w = $('#chat');
  if (!w) return;
  if (!CB.open) {
    w.innerHTML = '<button class="chat-launch" id="chatOpen">💬 Chat with TBO support</button>';
    $('#chatOpen').onclick = () => { CB.open = true; renderChat(); };
    return;
  }
  const last = CB.msgs[CB.msgs.length - 1];
  const chips = !CB.busy && last?.who === 'bot' && last.chips?.length ? last.chips : [];
  w.innerHTML = `<div class="chat-panel" role="dialog" aria-label="OpsDesk assistant">
    <div class="chat-h"><div><b>OpsDesk assistant</b><small>Raise or chase a ticket in chat</small></div><button class="ghost" id="chatMin" aria-label="Minimise chat">—</button></div>
    <div class="chat-body" id="chatBody">${CB.msgs.map(m => `<div class="cm ${m.who}">${esc(m.text)}</div>`).join('')}
      ${CB.busy ? '<div class="cm bot typing">Working on it…</div>' : ''}
      ${chips.length ? `<div class="chat-chips">${chips.map((c, i) => `<button data-chip="${i}">${esc(c[0])}</button>`).join('')}</div>` : ''}</div>
    <form class="chat-in" id="chatF"><input name="m" placeholder="Type your message…" maxlength="2000" autocomplete="off" aria-label="Message"><button class="primary">Send</button></form>
  </div>`;
  $('#chatMin').onclick = () => { CB.open = false; renderChat(); };
  $$('[data-chip]', w).forEach(b => {
    b.onclick = () => {
      const [label, fn] = chips[Number(b.dataset.chip)];
      CB.msgs.push({ who: 'user', text: label });
      chatRun(fn);
    };
  });
  $('#chatF').onsubmit = e => {
    e.preventDefault();
    const text = e.target.m.value.trim();
    if (!text || CB.busy) return;
    CB.msgs.push({ who: 'user', text });
    chatRun(() => chatHandle(text));
  };
  const body = $('#chatBody');
  body.scrollTop = body.scrollHeight;
  $('#chatF').m.focus();
}
function botSay(text, chips = []) { CB.msgs.push({ who: 'bot', text, chips }); renderChat(); }
async function chatRun(fn) {
  CB.busy = true; renderChat();
  try { await fn(); } catch (e) { CB.busy = false; botSay(`Sorry, that didn't work: ${e.message}`); }
  CB.busy = false; renderChat();
}
// The bot never asks for dates or values: the agency picks one of its own bookings and the rest comes from the booking store.
async function bookingChips() {
  const list = (await getBookings()).filter(b => b.check_in > Date.now() || b.status === 'Cancelled').slice(0, 8);
  return list.map(b => [`${b.tboh} · ${b.hotel}, ${fmtDate(b.check_in)}`, () => { CB.draft.tboh = b.tboh; return chatNext(); }]);
}
async function findBooking(tboh) { return (await getBookings()).find(b => b.tboh === tboh) || null; }
const chatReset = () => { CB.draft = null; CB.dupe = null; CB.step = 'start'; };

async function chatHandle(text) {
  const d = CB.draft, tb = text.match(TBOH_RE);
  if (CB.step === 'tboh') {
    if (!tb) return botSay('Pick one of your bookings below, or type its ID (TBOH-…).', await bookingChips());
    if (!(await findBooking('TBOH-' + tb[1]))) return botSay(`I can't find TBOH-${tb[1]} in your agency's bookings. Here are your bookings:`, await bookingChips());
    d.tboh = 'TBOH-' + tb[1];
    return chatNext();
  }
  if (CB.step === 'dedupe') return /\b(yes|add|same|ok)\b/i.test(text) ? chatAppend(CB.dupe) : chatNext();
  if (CB.step === 'confirm') {
    if (/^(y|yes|ok|submit|go|confirm)\b/i.test(text)) return chatSubmit();
    d.body += '\n' + text; // extra detail goes into the ticket
    return chatNext();
  }
  if (CB.step === 'intent') {
    d.body += '\n' + text;
    d.intent = L.classify(d.body).intent;
    return chatNext();
  }
  if (CB.step === 'status' || (/\b(status|update|where|progress)\b/i.test(text) && (tb || /#\d+/.test(text)))) return chatStatus(text);
  if (text.length < 8) return botSay('Could you describe the problem in a few more words?');
  // A new issue: extract what we can, ask only for what's missing.
  const c = L.classify(text);
  const first = text.split(/[.!?\n]/)[0].trim();
  const known = tb && (await findBooking('TBOH-' + tb[1]));
  CB.draft = { body: text, title: (first.length >= 8 ? first : text).slice(0, 100), intent: c.intent, tboh: known ? known.tboh : null, priority: URGENT_RE.test(text) ? 'high' : 'medium', deduped: false };
  if (tb && !known) botSay(`Note: TBOH-${tb[1]} isn't one of your agency's bookings, so I'll ask you to pick the right one.`);
  if (c.source !== 'rules') {
    CB.step = 'intent';
    return botSay("Thanks. I'm not fully sure what kind of issue this is — which fits best? (or add a bit more detail)", Object.keys(L.INTENTS).map(k => [L.INTENTS[k].label, () => { CB.draft.intent = k; return chatNext(); }]));
  }
  botSay(`Got it — this looks like a ${c.label.toLowerCase()} issue.`);
  return chatNext();
}

async function chatNext() {
  const d = CB.draft;
  if (!d.tboh) { CB.step = 'tboh'; return botSay("Which booking is this about? Here are your agency's bookings:", await bookingChips()); }
  if (!d.deduped) {
    d.deduped = true;
    S.tickets = (await api('/api/tickets')).tickets; // server scopes this to the agency's own tickets
    const prior = S.tickets.filter(t => t.tboh === d.tboh && t.status !== 'Closed');
    CB.dupe = prior.find(t => t.intent === d.intent && t.status !== 'Resolved') || prior.find(t => t.intent === d.intent) || null;
    if (CB.dupe) {
      CB.step = 'dedupe';
      const by = CB.dupe.created_by === S.me.name ? 'You already have' : `Your colleague ${(CB.dupe.created_by || '').split(' · ')[0]} already raised`;
      return botSay(`${by} #${CB.dupe.id} “${CB.dupe.title}” on ${d.tboh} (${CB.dupe.status}, with ${uName(CB.dupe.owner_id)}).\nShall I add your message there, so the same agent continues with the full history instead of starting over?`,
        [[`Yes, add to #${CB.dupe.id}`, () => chatAppend(CB.dupe)], ['No, raise a separate ticket', () => chatNext()]]);
    }
    if (prior.length) botSay(`I can see ${prior.length} earlier contact(s) on ${d.tboh} — I'll attach this to the same booking case so the agent sees everything.`);
  }
  CB.step = 'confirm';
  const bk = await findBooking(d.tboh), now = Date.now(), p = L.policySheet(bk, now);
  const s = L.computeSla({ priority: d.priority, booking_value: bk.value, check_in: bk.check_in, lcd: p.lcd, created_at: now, status: 'New' }, now);
  const tripDriven = !s.candidates[0].win || s.driver.startsWith('trip');
  const money = ['refund', 'cancellation'].includes(d.intent)
    ? `\n• Cancellation policy (${p.name}): ${p.lcd ? `free until ${fmtTime(p.lcd)}; ` : ''}cancelling now refunds ${p.refundNow}% ($${p.refundNowAmount.toLocaleString()})` : '';
  return botSay(`Here's the ticket I'll raise:\n• Issue: ${d.title}\n• Type: ${ilabel(d.intent)}\n• Booking: ${d.tboh} · ${bk.hotel}, ${bk.city}\n• Check-in: ${fmtTime(bk.check_in)} (from your booking)${money}\n• Priority: ${d.priority}\n• We'll respond within ${L.fmtDur(s.due - now)}${tripDriven ? ' — prioritised because the trip is close' : ''}`, [
    ['Submit ticket', chatSubmit],
    ...(d.priority !== 'urgent' ? [['Mark as urgent', () => { d.priority = 'urgent'; return chatNext(); }]] : []),
    ['Cancel', () => { chatReset(); botSay('No problem — nothing was raised.'); }],
  ]);
}
async function chatSubmit() {
  const d = CB.draft;
  const r = await api('/api/tickets', { tboh: d.tboh, title: d.title, body: d.body, priority: d.priority, intent: d.intent, channel: 'chatbot' });
  chatReset();
  botSay(`✅ Ticket #${r.id} raised.\n• Assigned to: ${r.owner}\n• Response due in: ${r.due_in}${r.prior ? `\n• Linked to ${r.prior} earlier contact(s) on this booking` : ''}\nAnything else?`, [[`Open #${r.id}`, () => chatOpen(r.id)]]);
  loadList();
}
async function chatAppend(t) {
  await api(`/api/tickets/${t.id}/action`, { type: 'comment', body: `[via chat] ${CB.draft.body}` });
  const reopened = ['Resolved', 'Pending'].includes(t.status);
  chatReset();
  botSay(`Done — added to #${t.id}. ${uName(t.owner_id)} already has the full history, so there's no need to repeat yourself.${reopened ? ' The ticket is reopened so it gets looked at again.' : ''}`, [[`Open #${t.id}`, () => chatOpen(t.id)]]);
  loadList();
}
function chatOpen(id) { S.sel = id; go('mine'); }
async function chatStatus(text) {
  const tb = text.match(TBOH_RE), num = text.match(/#(\d+)/);
  if (!tb && !num) { CB.step = 'status'; return botSay('Send the booking ID (TBOH-…) or ticket number (#12).'); }
  CB.step = 'start';
  S.tickets = (await api('/api/tickets')).tickets;
  const hits = S.tickets.filter(t => (num ? t.id === Number(num[1]) : t.tboh === 'TBOH-' + tb[1])).slice(0, 3);
  if (!hits.length) return botSay("I couldn't find that among your agency's tickets. Want to report a new problem instead?");
  const lines = await Promise.all(hits.map(async t => {
    const det = await api('/api/tickets/' + t.id);
    const lastReply = det.comments.filter(c => c.author !== S.me.name).pop();
    const s = L.computeSla(t, Date.now());
    const when = s.state === 'done' ? '' : ` · response due ${s.left >= 0 ? 'in ' + L.fmtDur(s.left) : 'now (overdue — flagged to the team)'}`;
    return `#${t.id} ${t.title} (raised by ${t.created_by === S.me.name ? 'you' : t.created_by})\n  ${t.status}${t.pending_reason ? ' (' + t.pending_reason.replace(/_/g, ' ') + ')' : ''} · ${uName(t.owner_id)}${when}${lastReply ? `\n  Latest from TBO: “${lastReply.body.slice(0, 160)}”` : ''}`;
  }));
  return botSay(lines.join('\n\n'), hits.map(t => [`Open #${t.id}`, () => chatOpen(t.id)]));
}

// ---------- bookings (mock TBO booking store) & new ticket ----------
const fmtDate = ms => (ms ? new Date(ms).toLocaleDateString([], { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
async function getBookings() {
  if (!S.bookings) S.bookings = (await api('/api/bookings')).bookings; // server scopes to the agency for requesters
  return S.bookings;
}
const bookingLabel = b => `${b.tboh} · ${b.hotel}, ${b.city} · check-in ${fmtDate(b.check_in)}${isStaff() ? ' · ' + aName(b.agency_id) : ''}${b.status === 'Cancelled' ? ' · cancelled' : ''}`;

function policyHtml(b) {
  const p = L.policySheet(b, Date.now());
  const when = r => (r.from === null && r.until === null ? 'Any time' : r.from === null ? `Before ${fmtTime(r.until)}` : r.until === null ? `After ${fmtTime(r.from)} / no-show` : `${fmtTime(r.from)} – ${fmtTime(r.until)}`);
  return `<div class="policy"><div class="pol-h"><b>${esc(p.name)} cancellation policy</b><span class="mono muted">${p.code}</span></div>
    <table><thead><tr><th>If cancelled</th><th>Refund</th></tr></thead><tbody>
    ${p.rows.map(r => `<tr class="${r.current ? 'now' : ''}"><td>${when(r)}${r.current ? ' <span class="nowtag">now</span>' : ''}</td><td>${r.refund}% · $${Math.round((b.value * r.refund) / 100).toLocaleString()}</td></tr>`).join('')}
    </tbody></table>
    <small>${p.lcd ? `LCD (last free cancellation): <b>${fmtTime(p.lcd)}</b>` : 'No free-cancellation window — LCD: none'} · read from the supplier policy sheet, not entered by anyone</small></div>`;
}
function bookingCard(b) {
  return `<div class="bk-card"><div class="bk-top"><div><b>${esc(b.hotel)}</b>, ${esc(b.city)}<br><small>Supplier: ${esc(b.supplier)} · Lead guest: ${esc(b.guest)}</small></div>
      <div class="bk-meta"><span class="mono">${esc(b.tboh)}</span><span class="st st-${b.status === 'Cancelled' ? 'Pending' : 'Resolved'}">${esc(b.status)}</span></div></div>
    <div class="bk-dates"><span>Check-in <b>${fmtTime(b.check_in)}</b></span><span>Check-out <b>${fmtDate(b.check_out)}</b></span><span>Value <b>$${Number(b.value).toLocaleString()}</b></span></div>
    ${policyHtml(b)}</div>`;
}

async function renderBookings() {
  const main = $('#main');
  main.innerHTML = '<div class="empty big">Loading your bookings…</div>';
  S.bookings = null;
  let list;
  try { list = await getBookings(); } catch (e) { main.innerHTML = `<div class="error">${esc(e.message)}</div>`; return; }
  main.innerHTML = `<div class="page"><h2>My bookings</h2>
    <p class="muted">Pulled from TBO's booking system. Raise a ticket against any booking — its hotel, dates, value and cancellation policy come with it, so nobody re-types them.</p>
    <div class="bk-grid">${list.map(b => `<div class="card">${bookingCard(b)}
      <div class="bk-foot">${b.open_tickets ? `<span class="chip case">${b.open_tickets} open ticket${b.open_tickets > 1 ? 's' : ''}</span>` : '<small>No open tickets</small>'}<button class="primary" data-raise="${b.tboh}">Raise ticket</button></div></div>`).join('') || '<div class="empty">No bookings on this account.</div>'}</div></div>`;
  $$('[data-raise]').forEach(btn => { btn.onclick = () => openNew(btn.dataset.raise); });
}

const PRESETS = {
  repeat: { label: 'Repeat refund (Skyline)', tboh: 'TBOH-118204', title: 'Third follow-up: refund still not received', body: 'This is our third time asking. Booking TBOH-118204 was cancelled on time but the refund is still not credited.', priority: 'medium' },
  urgent: { label: 'Urgent EU check-in', tboh: 'TBOH-229817', title: 'Guest name correction needed — check-in tomorrow', body: 'Please amend the guest name on TBOH-229817. The lead guest name is misspelled and check-in is tomorrow morning.', priority: 'urgent' },
  tracker: { label: 'Supplier outage', tboh: 'TBOH-551640', title: 'Supplier invoice rate mismatch', body: 'Rate mismatch: the Atlas Bedbank invoice for TBOH-551640 is higher than our booked rate.', priority: 'medium' },
};
async function openNew(preTboh) {
  let list;
  try { list = await getBookings(); } catch (e) { toast(esc(e.message), 'err'); return; }
  const presets = Object.entries(PRESETS).filter(([, p]) => list.some(b => b.tboh === p.tboh));
  const dlg = document.createElement('dialog');
  dlg.className = 'modal';
  dlg.innerHTML = `<form id="nf" novalidate>
    <h2>New ticket</h2>
    ${presets.length ? `<div class="presets">Demo presets: ${presets.map(([k, p]) => `<button type="button" data-p="${k}">${esc(p.label)}</button>`).join('')}</div>` : ''}
    <div class="fgrid">
      <label class="full">Booking <small>— choose from ${S.me.role === 'requester' ? 'your agency\'s' : 'all'} TBO bookings; hotel, dates, value and cancellation policy come from the booking</small>
        <select name="tboh" required><option value="">Select a booking…</option>${list.map(b => `<option value="${b.tboh}">${esc(bookingLabel(b))}</option>`).join('')}</select></label>
      <div class="full" id="bkCard"></div>
      <label class="full">Title<input name="title" required maxlength="150"></label>
      <label class="full">Description<textarea name="body" required maxlength="4000"></textarea></label>
      <label>Priority<select name="priority">${L.PRIORITIES.map(p => `<option ${p === 'medium' ? 'selected' : ''}>${p}</option>`).join('')}</select></label>
      <label class="two">Intent <small id="sugg"></small><select name="intent">${Object.keys(L.INTENTS).map(k => `<option value="${k}">${ilabel(k)}</option>`).join('')}</select></label>
    </div>
    <div class="preview"><div><small>Travel-aware deadline (live)</small><div class="big" id="pvDue">—</div><small id="pvWhy">Select a booking</small></div>
      <div><small>Booking memory</small><div class="big" id="pvCase">—</div><small id="pvCaseWhy">Select a booking to see prior contacts</small></div></div>
    <div class="form-err" id="nfErr"></div>
    <div class="mfoot"><button type="button" id="nfCancel">Cancel</button><button class="primary">Create ticket</button></div>
  </form>`;
  document.body.append(dlg);
  dlg.showModal();
  const f = $('#nf', dlg);
  let intentTouched = false, shownTboh = null;
  const val = n => f.elements[n]?.value;
  const update = () => {
    const bk = list.find(b => b.tboh === val('tboh'));
    if (val('tboh') !== shownTboh) {
      shownTboh = val('tboh');
      $('#bkCard', dlg).innerHTML = bk ? bookingCard(bk) : '<div class="empty">Pick a booking to see its details and cancellation policy.</div>';
    }
    const c = L.classify(val('title') + ' ' + val('body'), { priority: val('priority'), check_in: bk?.check_in });
    if (!intentTouched) f.intent.value = c.intent;
    $('#sugg', dlg).textContent = (val('title') + val('body')).trim() ? `— suggested: ${c.label} (${c.source === 'rules' ? 'rules' : 'low confidence → LLM fallback'}, ${Math.round(c.confidence * 100)}%${c.matched.length ? ': ' + c.matched.join(', ') : ''})` : '';
    if (!bk) { $('#pvDue', dlg).textContent = '—'; $('#pvCase', dlg).textContent = '—'; return; }
    const now = Date.now();
    const s = L.computeSla({ priority: val('priority'), booking_value: bk.value, check_in: bk.check_in, lcd: L.policySheet(bk, now).lcd, created_at: now, status: 'New' }, now);
    $('#pvDue', dlg).textContent = L.fmtDur(s.due - now);
    $('#pvWhy', dlg).textContent = 'driver: ' + s.driver;
    const prior = (S.tickets || []).filter(t => t.tboh === bk.tboh);
    $('#pvCase', dlg).textContent = `${prior.length} prior contact${prior.length === 1 ? '' : 's'}`;
    $('#pvCaseWhy', dlg).textContent = prior.length ? prior.map(t => `#${t.id} ${ilabel(t.intent)} (${t.status})`).join(' · ') : 'New booking case';
  };
  f.oninput = e => { if (e.target.name === 'intent') intentTouched = true; update(); };
  f.onchange = update;
  $$('[data-p]', dlg).forEach(b => {
    b.onclick = () => {
      const p = PRESETS[b.dataset.p];
      for (const k of ['tboh', 'title', 'body', 'priority']) f.elements[k].value = p[k];
      intentTouched = false;
      update();
    };
  });
  if (preTboh) f.tboh.value = preTboh;
  const close = () => { dlg.close(); dlg.remove(); };
  $('#nfCancel', dlg).onclick = close;
  dlg.addEventListener('cancel', () => dlg.remove());
  f.onsubmit = async e => {
    e.preventDefault();
    if (!val('tboh')) { $('#nfErr', dlg).textContent = 'Select a booking first.'; return; }
    try {
      const r = await api('/api/tickets', { tboh: val('tboh'), title: val('title'), body: val('body'), priority: val('priority'), intent: val('intent') });
      close();
      S.bookings = null; // open-ticket counts changed
      toast(`<b>Ticket #${r.id} created</b><br>Intent: ${esc(r.intent)} (${esc(r.source)}${r.source === 'manual' ? '' : ' ' + Math.round(r.confidence * 100) + '%'})<br>Owner: ${esc(r.owner)}<br>SLA: due in ${esc(r.due_in)} — ${esc(r.driver)}${r.prior ? `<br>Linked to booking case: ${r.prior} prior contact(s)` : ''}`);
      S.sel = r.id;
      go(S.me.role === 'requester' ? 'mine' : 'all');
    } catch (err) { $('#nfErr', dlg).textContent = err.message; }
  };
  update();
}

// ---------- insights & data ----------
async function renderInsights() {
  const main = $('#main');
  main.innerHTML = '<div class="empty big">Crunching themes…</div>';
  let d;
  try { d = await api('/api/insights'); } catch (e) { main.innerHTML = `<div class="error">${esc(e.message)}</div>`; return; }
  const max = Math.max(1, ...d.themes.map(x => x.c));
  const amax = Math.max(1, ...d.archive_themes.map(x => x.c));
  const tile = (l, v, k = '') => `<div class="tile ${k}"><small>${l}</small><b>${v}</b></div>`;
  main.innerHTML = `<div class="page"><h2>Insights & data</h2>
    <p class="muted">Themes come from the same classifier label that drives routing and SLA — classify once, use three times. This view is a plain SQL GROUP BY over that label.</p>
    <div class="tiles">${tile('Open tickets', d.health.open)}${tile('SLA at risk', d.health.at_risk, 'warn')}${tile('SLA breached', d.health.breached, 'bad')}${tile('Escalated', d.health.escalated)}${tile('In triage', d.health.triage)}</div>
    <div class="grid2">
      <div class="card"><h3>Top themes this week</h3>
        ${d.themes.map(x => `<div class="theme"><div class="th-h"><b>${esc(x.theme)}</b><span>${x.c}</span></div><div class="bar"><i style="width:${(x.c / max) * 100}%"></i></div>
          <div class="samples">${x.samples.map(s => `<a data-open="${s.id}">#${s.id} ${esc(s.title)} <small>(${s.status})</small></a>`).join('')}</div>
          ${x.backlog ? `<div class="backlog">→ Suggested product backlog item: ${esc(x.backlog)}</div>` : ''}</div>`).join('') || '<div class="empty">No tickets this week.</div>'}</div>
      <div>
        <div class="card"><h3>Probable supplier incidents <small>— same supplier + theme across agencies, last 48h</small></h3>
          ${d.incidents.map(i => `<div class="incident"><b>${esc(i.supplier)}</b> · ${esc(L.INTENTS[i.intent].theme)} — ${i.c} open tickets from ${i.agencies} agencies → link as one tracker</div>`).join('') || '<div class="empty">None detected.</div>'}</div>
        <div class="card"><h3>Open load by region</h3>${d.regions.map(r => `<div class="th-h"><span>${esc(r.region)}</span><b>${r.c}</b></div>`).join('')}</div>
        <div class="card"><h3>12-month archive · ${d.archive_total.toLocaleString()} tickets</h3>
          ${d.archive_themes.map(x => `<div class="th-h"><span>${esc(x.theme)}</span><span>${x.c.toLocaleString()}</span></div><div class="bar alt"><i style="width:${(x.c / amax) * 100}%"></i></div>`).join('')}</div>
      </div>
    </div>
    ${S.me.role === 'lead' ? `<div class="card"><h3>Export — no 3K-row cap</h3>
      <p>Streams every live + archived ticket as CSV in one request, read from the database in 5,000-row chunks (constant memory).</p>
      <button class="primary" id="expBtn">Export all tickets (CSV)</button> <b id="expRes"></b>
      <p class="muted" style="font-size:12.5px">Retention stance (demo): live tickets stay in the operational store; tickets resolved > 12 months move to the archive table — same database, still queryable, no extra archive fee. At scale: Postgres + read replica, CDC → warehouse for 50K+ extracts and near-real-time dashboards.</p></div>` : ''}
  </div>`;
  if ($('#expBtn')) $('#expBtn').onclick = exportAll;
}
async function exportAll() {
  const btn = $('#expBtn'), res = $('#expRes');
  btn.disabled = true; res.textContent = 'Exporting…';
  const t0 = performance.now();
  try {
    const r = await fetch('/api/export.csv', { headers: { 'x-user': S.me.id } });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
    const blob = await r.blob();
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'opsdesk-export.csv' });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    res.textContent = `✓ ${Number(r.headers.get('x-row-count')).toLocaleString()} rows · ${(blob.size / 1e6).toFixed(1)} MB · ${((performance.now() - t0) / 1000).toFixed(1)}s`;
  } catch (e) { res.textContent = 'Export failed: ' + e.message; }
  btn.disabled = false;
}

// ---------- team & routing (lead) ----------
async function renderTeam() {
  const main = $('#main');
  main.innerHTML = '<div class="empty big">Loading team…</div>';
  let d;
  try { d = await api('/api/team'); } catch (e) { main.innerHTML = `<div class="error">${esc(e.message)}</div>`; return; }
  main.innerHTML = `<div class="page"><h2>Team & routing</h2>
    <p class="muted">Routing = <b>filter</b> (region · skill · on shift) then <b>pick</b> (seniors first when priority is high/urgent, then least-loaded). Toggle shifts to simulate availability — new tickets route around off-shift agents.</p>
    <div class="card" style="padding:0;overflow:auto"><table class="team"><thead><tr><th>Agent</th><th>Regions</th><th>Skills</th><th>Seniority</th><th>Open load</th><th>Availability</th></tr></thead><tbody>
    ${d.agents.map(a => `<tr><td><b>${esc(a.name)}</b>${a.role === 'em' ? ' <small>(Escalation Manager)</small>' : ''}</td><td>${esc(a.regions.join(', '))}</td><td>${esc(a.skills.map(s => (s === '*' ? 'all' : ilabel(s))).join(', '))}</td>
      <td>${a.senior ? 'Senior' : 'Junior'}</td><td>${a.load}</td>
      <td>${a.role === 'agent' ? `<label class="switch"><input type="checkbox" data-shift="${a.id}" ${a.on_shift ? 'checked' : ''}> ${a.on_shift ? 'On shift' : 'Off shift'}</label>` : 'On call'}</td></tr>`).join('')}
    </tbody></table></div>
    <div class="card"><h3>Demo data</h3><p class="muted">Reset re-seeds every journey with timestamps relative to now (use before each recording).</p><button class="danger" id="resetBtn">Reset demo data</button></div></div>`;
  $$('[data-shift]').forEach(c => {
    c.onchange = async () => {
      try {
        await api(`/api/users/${c.dataset.shift}/shift`, { on_shift: c.checked });
        const u = S.users.find(x => x.id === c.dataset.shift);
        if (u) u.on_shift = c.checked;
        renderTeam();
      } catch (e) { toast(esc(e.message), 'err'); }
    };
  });
  $('#resetBtn').onclick = async () => {
    if (!confirm('Reset all demo data? Tickets you created will be removed.')) return;
    try {
      await api('/api/reset', {});
      S.users = (await api('/api/users')).users;
      toast('Demo data reset');
      renderTeam();
    } catch (e) { toast(esc(e.message), 'err'); }
  };
}

boot();
