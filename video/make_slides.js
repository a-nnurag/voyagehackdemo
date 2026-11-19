// Renders stand-in deck slides to slides/<ID>.png (1920x1080). Replace any PNG with your own deck slide and re-run assemble.js.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const CSS = `*{box-sizing:border-box;margin:0}body{width:1920px;height:1080px;font-family:'Segoe UI',system-ui,sans-serif;color:#0f1d40;
  background:linear-gradient(135deg,#f5f8ff 0%,#e8efff 100%);padding:110px 140px;display:flex;flex-direction:column;justify-content:center}
  .k{font:700 26px 'Segoe UI';letter-spacing:.14em;text-transform:uppercase;color:#2f6bff;margin-bottom:22px}
  h1{font:800 76px/1.08 'Segoe UI';margin-bottom:56px;max-width:1500px}
  .grid{display:grid;gap:30px}.g2{grid-template-columns:1fr 1fr}.g3{grid-template-columns:repeat(3,1fr)}
  .c{background:#fff;border-radius:22px;padding:38px 40px;box-shadow:0 10px 30px rgba(20,40,100,.08);border-top:7px solid #2f6bff}
  .c.r{border-top-color:#e5484d}.c h3{font:700 36px 'Segoe UI';margin-bottom:14px}.c p{font:400 28px/1.4 'Segoe UI';color:#44506b}
  .f{margin-top:44px;font:600 32px 'Segoe UI';background:#10204a;color:#fff;border-radius:18px;padding:26px 36px}
  .f b{color:#9cb8ff}.row{display:flex;align-items:center;gap:22px}.ar{font:700 50px 'Segoe UI';color:#2f6bff}
  .box{flex:1;background:#fff;border-radius:18px;padding:30px;text-align:center;box-shadow:0 10px 30px rgba(20,40,100,.08);font:600 30px/1.3 'Segoe UI'}
  .box small{display:block;font:400 23px 'Segoe UI';color:#5a6683;margin-top:8px}.box.d{background:#10204a;color:#fff}.box.d small{color:#b9c8f0}
  .dark{background:radial-gradient(circle at 30% 30%,#1d3a8a,#0b1530);color:#fff;justify-content:center;align-items:center;text-align:center}
  .dark h1{font-size:120px;margin-bottom:30px}.dark p{font:500 40px 'Segoe UI';color:#b9c8f0}.dark .tag{font:700 46px/1.5 'Segoe UI';color:#fff;margin-top:40px}`;

const SLIDES = {
  S2: `<div class="k">The problem</div><h1>Generic ticketing breaks on B2B travel</h1>
    <div class="grid g2">
      <div class="c r"><h3>Context gets lost</h3><p>Repeat contacts become new tickets. Agencies re-explain every time.</p></div>
      <div class="c r"><h3>First come, first served</h3><p>Routing ignores region, seniority and who is actually on shift.</p></div>
      <div class="c r"><h3>One clock for every ticket</h3><p>Check-in tomorrow or next month: same SLA.</p></div>
      <div class="c r"><h3>Threads break, data is capped</h3><p>Supplier recipients reset on transfer. Exports stop at 3,000 rows.</p></div>
    </div>`,
  S3: `<div class="k">Our idea</div><h1>Two ideas behind OpsDesk</h1>
    <div class="grid g2">
      <div class="c"><h3>1 · The booking is the memory</h3><p>Every ticket, supplier thread and past contact attaches to one case, keyed on TBO booking ID + agency.</p></div>
      <div class="c"><h3>2 · The deadline follows the trip</h3><p>As check-in and the last cancellation date approach, the SLA tightens by itself.</p></div>
    </div>
    <div class="f">SLA due = soonest of <b>priority timer</b> · <b>check-in − 24h</b> · <b>last cancellation date − 12h</b></div>`,
  S4: `<div class="k">How it works</div><h1>Classify once. Rules decide. Humans own the edges.</h1>
    <div class="row">
      <div class="box">Agency chatbot · email · agent<small>booking picked from TBO, never typed</small></div><div class="ar">→</div>
      <div class="box d">Classifier<small>rules first · AI fallback only below 60% confidence</small></div><div class="ar">→</div>
      <div class="box">One label<small>intent · priority · booking</small></div>
    </div>
    <div class="grid g3" style="margin-top:36px">
      <div class="c"><h3>Routing</h3><p>Region → shift → skill, with a written reason.</p></div>
      <div class="c"><h3>Travel-aware SLA</h3><p>Check-in and cancellation policy drive the deadline.</p></div>
      <div class="c"><h3>Insights</h3><p>Themes, supplier incidents, uncapped export.</p></div>
    </div>
    <div class="f">Humans confirm merges and own escalations. <b>AI never decides money or time.</b></div>`,
  S5: `<div class="k">Why OpsDesk</div><h1>Isolated tickets → travel-aware cases</h1>
    <div class="grid g3">
      <div class="c"><h3>Predictable cost</h3><p>Rules do the heavy lifting. AI only classifies the unclear tail.</p></div>
      <div class="c"><h3>One platform</h3><p>Routing, SLA, side conversations and insights. No stack of paid add-ons.</p></div>
      <div class="c"><h3>Humans in control</h3><p>Agents confirm merges. Escalation managers own the risky cases.</p></div>
    </div>
    <div class="f">Linked by booking. <b>Routed by reality.</b> Escalated on purpose.</div>`,
  END: `<h1>OpsDesk</h1><p>Travel-native operations ticketing for TBO</p>
    <div class="tag">Linked by booking · Routed by reality · Escalated on purpose</div>
    <p style="margin-top:60px;font-size:30px">TBO VoyageHack 4.0</p>`,
};

(async () => {
  const out = path.join(__dirname, 'slides');
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  for (const [id, html] of Object.entries(SLIDES)) {
    const file = path.join(out, `${id}.png`);
    if (fs.existsSync(file) && !process.argv.includes('--force')) { console.log(id, 'kept (exists)'); continue; } // never overwrite a real deck slide
    await page.setContent(`<style>${CSS}</style><body class="${id === 'END' ? 'dark' : ''}">${html}</body>`);
    await page.screenshot({ path: file });
    console.log(id, '→', file);
  }
  await browser.close();
})();
