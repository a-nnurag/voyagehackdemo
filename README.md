# OpsDesk — Travel-Native Operations Ticketing (TBO VoyageHack)

> Linked by booking · Routed by reality · Escalated on purpose

A working MVP of OpsDesk: every ticket attaches to a **booking-keyed case** (TBOH + agency), and the **SLA deadline is tied to the trip** (check-in / LCD), not just the ticket.

## Run it

Requires **Node.js 22.13+** (uses the built-in `node:sqlite`). There are **no npm dependencies**.

```bash
npm start        # → http://localhost:3000
npm test         # self-checks for SLA, classifier, routing, linking
```

Data lives in `opsdesk.db` (SQLite), so a refresh or restart keeps the queue. It is seeded on first start. **Team & routing → Reset demo data** (Ops Lead) reseeds with timestamps relative to *now*, so do this right before you record.

## Deploy (Render, free)

The app is a long-running Node server with a SQLite file, so use a Node host (Render, Railway, Fly.io) rather than a static/serverless host like Netlify.

1. render.com → **New → Web Service** → connect this repo.
2. Runtime **Node**, build `npm install`, start `npm start`, instance **Free**.
3. Environment: `NODE_VERSION` = `22.13.0`.

`PORT` is read from the environment. The free plan's disk is wiped on restart, so the demo data simply reseeds. The free plan also sleeps when idle: open the URL a minute before presenting.

## Demo accounts (demo login, no passwords)

| Persona | Role | What they show |
|---|---|---|
| Ravi · Skyline Travels | Agency requester (client) | Raised the first refund ticket (#1) on TBOH-118204 |
| Meera · Skyline Travels | Agency requester (client), **same company as Ravi** | Raised the follow-up (#2) on the same booking. Ravi and Meera see each other's tickets and the shared booking history, and the chatbot tells Ravi *"Your colleague Meera already raised #2"* |
| Lena · EuroTrip GmbH | Agency requester (client), **different company** | Sees only EuroTrip's tickets. Opening a Skyline ticket returns "not found" |
| Fatima · Gulf Horizons / Daniel · Lion City Tours | Agency requesters | More agencies, used for the supplier-outage tracker |
| Rahul Verma | Ops agent (South Asia + APAC) | Queue, merge suggestions, side conversations |
| Priya Sharma | Ops agent, senior (South Asia) | Skill-restricted routing |
| Marco Rossi | Ops agent, senior (Europe) | Urgent EU routing, escalation |
| Anna Keller | Ops agent (Europe), **off shift** | Gets excluded by availability routing |
| Wei Tan | Ops agent (APAC), **off shift** | Was the original owner of the transferred ticket |
| Neha Kapoor | Escalation Manager | Escalation queue |
| Arjun Mehta | Ops Lead | Insights, uncapped export, shift toggles, reset |

## Feature checklist → problems

| # | Problem | Covered by |
|---|---|---|
| 0 | Booking data comes from TBO, not the user | A mock **booking store** holds hotel, supplier, guest, dates, value and a **cancellation policy** (Flexible / Standard / Non-refundable, with refund tiers, similar to redBus). The **LCD is computed from the policy**. The ticket form and the chatbot only offer the agency's own bookings, and the server ignores any dates or values sent from the form. Agencies get a **My bookings** page with the policy sheet and a "Raise ticket" button |
| 1 | Tickets without context | **Agency chatbot**: describe the problem in plain words. It detects the issue type, lets the agency pick one of **its own bookings** (an ID that isn't in the account is rejected), takes check-in and the refund policy from that booking, shows the expected response time, and raises the ticket. If the same issue is already open on that booking, it offers to add the message to that ticket instead of opening a duplicate. It also answers status questions ("status of TBOH-118204"). Plus: booking case panel (all contacts on TBOH + agency), merge / link / tracker suggestions that an agent confirms, rules-first intent classifier with confidence and a manual override, case assistant over the full history, activity timeline |
| 2 | Routing & ownership | Filter (region · skill · on shift), then pick (seniors first when urgent, then least-loaded). Every assignment stores a one-line reason. Assign / reassign / unassign. Views: triage, my queue, region and intent filters, linked cases |
| 3 | Side conversations | Explicit recipient list (any emails, not the group). Recipients don't change on transfer, and the timeline records that |
| 4 | SLA & escalation | `due = soonest(created + priority timer, check-in − 24h, LCD − 12h)`, timer halved for high-value bookings. States: on track / at risk / breached. Queue sorted by deadline (not FIFO). Pending pauses the timer, but trip dates still apply. **Escalate to Escalation Manager** is a first-class action |
| 5 | Feedback loop | The intent label doubles as the theme. The Insights page shows top themes this week, sample tickets, a suggested backlog item, and a supplier-incident detector |
| 6 | Data & archival | SQLite persistence and a 50,000-row archive. CSV export streams **all** rows in 5,000-row chunks (no 3K cap) |
| 7 | Roles & access | Server-side role checks on every endpoint. Requesters only ever see their own agency's tickets, and never internal notes or side conversations |

## Architecture

```
Browser (public/app.js) ── fetch + x-user ──► server.js (node:http)
        │                                         │  RBAC + validation on every call
        └── public/logic.js ◄── shared ───────────┤  classify · computeSla · route · suggestLinks
                                                  ▼
                                          SQLite: bookings · tickets · links · comments · side_convos · events (audit) · archive
```

The same `logic.js` runs in the browser (live SLA preview and countdowns) and on the server (the source of truth). That logic handles all money and time with deterministic code, no LLM.

## Assumptions (demo)

- Demo login instead of a real IdP. Single-tenant TBO org.
- Agent availability is simulated (shift toggles on **Team & routing**). Regional calendars are not modelled.
- The intent model is keyword rules with a confidence score. Below 60% confidence the ticket is flagged for an LLM fallback, which is stubbed in this demo, and an agent can override the intent.
- Bookings and cancellation policies are mock data, standing in for TBO's booking API. Policies are versioned config in `logic.js` (`POLICIES`). Tier rule: cancel at least *h* hours before check-in → refund %. LCD = the last moment of the 100% tier.
- SLA thresholds (2/8/24/48h timers, 24h check-in buffer, 12h LCD buffer, $2,000 high-value, 1h floor) are configurable assumptions in `logic.js`. "LCD" is used as written, pending TBO's definition.
- Scaling path: Postgres + read replica, CDC → warehouse for 50K+ extracts, websockets instead of 5s polling.

## 3–5 min demo script

**0:00 Hook (20s).** Log-in screen. "Today the same refund chased three times becomes three unlinked tickets. OpsDesk makes the booking the memory."

**Journey A: context & linkage (60s)**
1. Log in as **Ravi · Skyline Travels** → **My bookings**: every booking comes from TBO, with its cancellation policy sheet (refund tiers, the current one highlighted, LCD). *"Nobody types dates or LCDs. They come from the booking and the supplier policy."*
2. **+ New ticket** → preset **Repeat refund**. Booking TBOH-118204 fills in the hotel, dates and policy. Point out the auto-suggested intent (*Refund, rules 75%*), the live deadline (**24h**, check-in a month away), and **"2 prior contacts"**.
3. Switch the booking to **TBOH-118999 · Coral Bay Resort** (check-in tomorrow, free cancellation ends within hours) and the deadline drops to **1h**. *"Same issue, the trip is closer, the deadline tightens itself."* Switch back to TBOH-118204 → **Create ticket**.
4. **Switch user → Rahul Verma** → **All open** → open the new ticket. The booking case shows all 3 contacts. Click **Summarize this case**, then **Confirm merge** on #2. It becomes one thread, and #2 reopens because the agency chased again.

**Journey A2: agency chatbot (45s)**. As Ravi, click **💬 Chat with TBO support**.
- Type: *Need to cancel a booking, the guest cannot travel*. The bot spots a cancellation and lists **only Skyline's bookings** as buttons. Pick **TBOH-118999 · Coral Bay Resort**. The summary shows the check-in from the booking, the **cancellation policy** (*free until … ; cancelling now refunds 100% ($820)*) and *respond within 1h — prioritised because the trip is close*. Click **Submit ticket**, and it's raised and routed with the owner shown.
- Type: *Refund for TBOH-118204 is still not credited, third time asking*. The bot replies *"Your colleague Meera already raised #2 … add your message there?"* Click **Yes, add to #2**. There's no duplicate, and #2 reopens.
- Type: *status of TBOH-118204*. You get the live status, the owner, the response time and the latest reply from TBO.

**Client accounts: same company vs other company (20s)**. **Switch user → Meera · Skyline Travels**. She sees Ravi's tickets, each marked "Raised by", in one shared booking history. **Switch user → Lena · EuroTrip GmbH**: none of Skyline's tickets are visible. *"Colleagues share context, other agencies never see it."*

**Journey B: routing (40s)**
5. **Switch user → Marco Rossi** → **+ New ticket** → preset **Urgent EU check-in** → Create.
6. Open it and read the routing reason: *region=Europe · priority=urgent → seniors first · excluded: Anna Keller (off shift)*.

**Journey C: side conversation (40s)**
7. **Switch user → Lead (Arjun)** → open **#5 Wheelchair-accessible room**. The side conversation goes to 2 explicit supplier emails.
8. Owner → **Priya Sharma**. The timeline says *"side conversation keeps its 2 explicit recipients"*. Click **Simulate supplier reply**.

**Journey D: SLA & escalation (40s)**
9. Open **#3 Guest name change before check-in tomorrow** (at risk, driver *check-in − 24h*). Type a reason and click **Escalate to Escalation Manager**.
10. **Switch user → Neha Kapoor** → **Escalation queue** shows #3 and #6. Open #3 → Status **Resolved**.

**Journey E: insights & data (40s)**
11. **Switch user → Arjun** → **Insights & data**: top themes with samples and backlog items, plus the **Atlas Bedbank** incident across 3 agencies.
12. **Export all tickets (CSV)** exports *50,021 rows* in under a second. *"No 3K-row cap."*

**Close (20s).** "Rules decide money and time, AI only classifies. Humans confirm merges and own escalations. One platform, no add-ons."

## Files

`server.js` — API, RBAC, seed, SQLite · `public/logic.js` — classifier / SLA / routing / linking · `public/app.js` — UI · `test.js` — self-checks

**AI coding assistant used:** Claude Code (scaffolding the app). No third-party libraries.
