// Drives the OpsDesk app through the demo scenes and records it, paced to each scene's voiceover.
// Needs the app running on http://localhost:3000. Run: node record.js
// Writes rec/demo.webm + rec/scenes.json ({id, start, end} seconds into the recording).
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const APP = process.env.APP_URL || 'http://localhost:3000';
const DUR = JSON.parse(fs.readFileSync(path.join(__dirname, 'audio', 'durations.json'), 'utf8'));
const REC = path.join(__dirname, 'rec');
const TAIL = 0.9; // seconds of hold after the narration ends

// Visible cursor + click ripple + caption bar. Attached to <html> because the app replaces <body> on login.
const OVERLAY = () => {
  const add = () => {
    if (document.getElementById('__cur')) return;
    const st = document.createElement('style');
    st.textContent = `#__cur{position:fixed;z-index:2147483647;width:22px;height:22px;margin:-3px 0 0 -3px;pointer-events:none;
        background:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='22' height='22'%3E%3Cpath d='M3 2l14 9-6 1.5L8 19z' fill='%23111' stroke='white' stroke-width='1.6'/%3E%3C/svg%3E") no-repeat;transition:transform .08s}
      #__cur.down{transform:scale(.8)}
      .__rip{position:fixed;z-index:2147483646;width:34px;height:34px;margin:-17px 0 0 -17px;border-radius:50%;border:3px solid #2f6bff;pointer-events:none;animation:__r .55s ease-out forwards}
      @keyframes __r{from{opacity:.9;transform:scale(.3)}to{opacity:0;transform:scale(1.6)}}
      #__cap{position:fixed;z-index:2147483645;left:24px;bottom:24px;background:rgba(16,32,74,.93);color:#fff;font:600 19px system-ui,Segoe UI,sans-serif;
        padding:11px 18px;border-radius:12px;border-left:5px solid #7fa6ff;box-shadow:0 8px 24px rgba(0,0,0,.25);opacity:0;transition:opacity .35s;max-width:60%;pointer-events:none}
      #__cap.on{opacity:1}`;
    document.documentElement.append(st);
    const c = Object.assign(document.createElement('div'), { id: '__cur' });
    const cap = Object.assign(document.createElement('div'), { id: '__cap' });
    document.documentElement.append(c, cap);
    addEventListener('mousemove', e => { c.style.left = e.clientX + 'px'; c.style.top = e.clientY + 'px'; }, true);
    addEventListener('mousedown', e => {
      c.classList.add('down');
      const r = Object.assign(document.createElement('div'), { className: '__rip' });
      r.style.left = e.clientX + 'px'; r.style.top = e.clientY + 'px';
      document.documentElement.append(r); setTimeout(() => r.remove(), 600);
    }, true);
    addEventListener('mouseup', () => c.classList.remove('down'), true);
  };
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', add); else add();
};

(async () => {
  const api = (p, user) => fetch(APP + p, { method: 'POST', headers: { 'x-user': user, 'content-type': 'application/json' }, body: '{}' });
  if (!(await api('/api/reset', 'lead-arjun')).ok) throw new Error('Could not reset demo data — is the app running on ' + APP + '?');

  fs.rmSync(REC, { recursive: true, force: true });
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1536, height: 864 }, deviceScaleFactor: 1.25, recordVideo: { dir: REC, size: { width: 1920, height: 1080 } }, acceptDownloads: true });
  await ctx.addInitScript(OVERLAY);
  const page = await ctx.newPage();
  const t0 = Date.now();
  const now = () => (Date.now() - t0) / 1000;
  const wait = s => page.waitForTimeout(s * 1000);
  const log = [];

  // Human-looking pointer: glide to the element, then click.
  const moveTo = async loc => {
    await loc.scrollIntoViewIfNeeded();
    const b = await loc.boundingBox();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 22 });
    return b;
  };
  const click = async (sel, opts = {}) => {
    const loc = typeof sel === 'string' ? page.locator(sel).first() : sel;
    await loc.waitFor({ state: 'visible', timeout: 15000 });
    const b = await moveTo(loc);
    await wait(opts.pause ?? 0.3);
    await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  };
  const type = async (sel, text) => { await click(sel); await page.locator(sel).pressSequentially(text, { delay: 38 }); };
  const smooth = (sel, block = 'start') => page.locator(sel).first().evaluate((el, block) => el.scrollIntoView({ behavior: 'smooth', block }), block);
  const caption = text => page.evaluate(t => { const c = document.getElementById('__cap'); if (!c) return; c.textContent = t || ''; c.classList.toggle('on', !!t); }, text);
  const switchUser = async id => { await click('#switchBtn'); await wait(0.6); await click(`.persona[data-u="${id}"]`); await page.locator('#nav').waitFor(); await wait(0.5); };
  const chip = text => page.locator('[data-chip]', { hasText: text }).first();

  const scene = async (id, cap, fn) => {
    const start = now();
    await caption(cap);
    try { await fn(); } catch (e) {
      await page.screenshot({ path: path.join(__dirname, `fail-${id}.png`) });
      throw e;
    }
    const left = DUR[id] + TAIL - (now() - start);
    if (left > 0) await wait(left);
    log.push({ id, start: +start.toFixed(2), end: +now().toFixed(2) });
    console.log(id.padEnd(3), `${start.toFixed(1)}s → ${now().toFixed(1)}s (voice ${DUR[id]}s)`);
  };

  // Pre-roll (cut out later): sign in as the agent for the hook.
  await page.goto(APP);
  await page.evaluate(() => localStorage.setItem('opsdesk.user', 'a-rahul'));
  await page.reload();
  await page.locator('.row').first().waitFor();
  await wait(1);

  await scene('S1', 'Today: one issue → many disconnected tickets', async () => {
    await wait(1.5);
    await click('.row[data-id="2"]');
    await wait(2.5);
    await smooth('#detail .card:has(.case-row)', 'center');
    await wait(1);
    await moveTo(page.locator('.case-row').first());
    await wait(2);
    await moveTo(page.locator('.case-row').nth(1));
  });

  await scene('D1', 'Bookings + cancellation policy come from TBO — never typed in', async () => {
    await switchUser('u-sky');
    await click('#nav a[data-v="bookings"]');
    await page.locator('.bk-card').first().waitFor();
    await wait(1.5);
    await moveTo(page.locator('.policy tr.now').first());
    await wait(2.5);
    await moveTo(page.locator('.policy small').first());
    await wait(2);
    await page.mouse.wheel(0, 420);
  });

  await scene('D2', 'Problem 1 · Agency chatbot: intent, booking & urgency in one conversation', async () => {
    await click('#chatOpen');
    await wait(0.8);
    await type('#chatF input[name=m]', 'Need to cancel a booking, the guest cannot travel');
    await page.keyboard.press('Enter');
    await chip('TBOH-118999').waitFor();
    await wait(1.5);
    await click(chip('TBOH-118999'));
    await page.getByText("Here's the ticket I'll raise").last().waitFor();
    await wait(5.5);
    await click(chip('Submit ticket'));
    await page.getByText('raised.').last().waitFor();
  });

  await scene('D3', 'One issue = one case: no duplicate tickets', async () => {
    await type('#chatF input[name=m]', 'Refund for TBOH-118204 is still not credited, third time asking');
    await page.keyboard.press('Enter');
    await chip('Yes, add to').waitFor();
    await wait(3);
    await click(chip('Yes, add to'));
    await page.getByText('Done — added to').last().waitFor();
  });

  await scene('D4', 'Agent sees the whole booking case — no re-explaining', async () => {
    await click('#chatMin');
    await switchUser('a-rahul');
    await click('.row[data-id="2"]');
    await page.locator('.bk-card').waitFor();
    await wait(1);
    await smooth('#detail .card:has(.bk-card)');
    await wait(2.5);
    await smooth('#detail .card:has(.case-row)');
    await wait(1.5);
    await moveTo(page.locator('[data-link]').first());
    await wait(1.5);
    await click('[data-q="summary"]');
    await wait(0.6);
    await smooth('#ans', 'center');
  });

  await scene('D5', 'Problem 2 · Routed by region + priority + availability, with a reason', async () => {
    await switchUser('a-marco');
    await click('#newBtn');
    await click('[data-p="urgent"]');
    await wait(1.5);
    await click('#nf button.primary');
    await page.locator('#detail .reason').waitFor();
    await wait(0.8);
    await moveTo(page.locator('#detail .reason'));
  });

  await scene('D6', 'Problem 3 · Supplier recipients survive transfer', async () => {
    await switchUser('lead-arjun');
    await click('.row[data-id="5"]');
    await page.locator('#detail .side').waitFor();
    await smooth('#detail .side', 'center');
    await wait(1.2);
    await moveTo(page.locator('#detail .rcpts'));
    await wait(1);
    await smooth('#detail .actions', 'center');
    await moveTo(page.locator('#aOwner'));
    await page.selectOption('#aOwner', 'a-priya');
    await page.locator('#detail .tl li', { hasText: 'keep their' }).waitFor();
    await smooth('#detail .tl li:last-child', 'center');
    await moveTo(page.locator('#detail .tl li:last-child'));
  });

  await scene('D7', 'Problem 4 · Travel-aware SLA → escalate to the Escalation Manager', async () => {
    await click('.row[data-id="3"]');
    await page.locator('#escReason').waitFor();
    await moveTo(page.locator('#detail .sla.big'));
    await wait(1);
    await type('#escReason', 'Check-in tomorrow, supplier silent');
    await click('#aEsc');
    await wait(1.2);
    await switchUser('em-neha');
    await wait(0.6);
    await click('.row[data-id="3"]');
  });

  await scene('D8', 'Problems 5 & 6 · Insights + export with no 3K-row cap', async () => {
    await switchUser('lead-arjun');
    await click('#nav a[data-v="insights"]');
    await page.locator('.theme').first().waitFor();
    await wait(1.5);
    await moveTo(page.locator('.backlog').first());
    await wait(1.5);
    await moveTo(page.locator('.incident').first());
    await wait(1.5);
    await smooth('#expBtn', 'center');
    await wait(0.8);
    const dl = page.waitForEvent('download');
    await click('#expBtn');
    await dl;
    await page.locator('#expRes', { hasText: 'rows' }).waitFor();
    await moveTo(page.locator('#expRes'));
  });

  await caption('');
  await wait(1);
  const video = page.video();
  await ctx.close();
  await browser.close();
  fs.renameSync(await video.path(), path.join(REC, 'demo.webm'));
  fs.writeFileSync(path.join(REC, 'scenes.json'), JSON.stringify(log, null, 2));
  console.log('Saved rec/demo.webm and rec/scenes.json');
})().catch(e => { console.error(e); process.exit(1); });
