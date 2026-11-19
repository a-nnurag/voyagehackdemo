// Builds out/OpsDesk_demo.mp4 from rec/demo.webm + rec/scenes.json, slides/<ID>.png and audio/<ID>.mp3.
// Needs ffmpeg on PATH. Run: node assemble.js
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const D = p => path.join(__dirname, p);
const DUR = JSON.parse(fs.readFileSync(D('audio/durations.json'), 'utf8'));
const REC = Object.fromEntries(JSON.parse(fs.readFileSync(D('rec/scenes.json'), 'utf8')).map(s => [s.id, s]));
const ORDER = ['S1', 'S2', 'S3', 'S4', 'D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8', 'S5', 'END'];
const LEAD = 0.25; // voice starts slightly after the cut
const SLIDE_TAIL = 1.0;
const ENC = ['-r', '30', '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2'];
const ff = args => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: 'inherit' });

const tmp = D('out/parts');
fs.mkdirSync(tmp, { recursive: true });
const parts = [];
for (const id of ORDER) {
  const out = path.join(tmp, `${id}.mp4`);
  const ms = Math.round(LEAD * 1000);
  const voice = DUR[id] ? ['-i', D(`audio/${id}.mp3`)] : ['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo'];
  const afx = `[1:a]aresample=48000,adelay=${ms}|${ms},apad[a]`;
  let len, vin, vfx;
  if (REC[id]) {
    len = REC[id].end - REC[id].start;
    vin = ['-ss', String(REC[id].start), '-t', String(len), '-i', D('rec/demo.webm')];
    // Playwright pads the 1536x864 viewport into the 1920x1080 canvas: crop the page, then upscale.
    vfx = `[0:v]crop=1536:864:0:0,scale=1920:1080:flags=lanczos,fps=30,fade=in:d=0.3,fade=out:st=${(len - 0.3).toFixed(2)}:d=0.3[v]`;
  } else {
    len = id === 'END' ? 5 : DUR[id] + LEAD + SLIDE_TAIL;
    vin = ['-loop', '1', '-framerate', '30', '-t', String(len), '-i', D(`slides/${id}.png`)];
    vfx = `[0:v]scale=1920:1080,fps=30,format=yuv420p,fade=in:d=0.4,fade=out:st=${(len - 0.4).toFixed(2)}:d=0.4[v]`;
  }
  ff([...vin, ...voice, '-filter_complex', `${vfx};${afx}`, '-map', '[v]', '-map', '[a]', '-t', len.toFixed(2), ...ENC, out]);
  parts.push(out);
  console.log(id.padEnd(4), len.toFixed(1) + 's');
}
const list = path.join(tmp, 'list.txt');
fs.writeFileSync(list, parts.map(p => `file '${p.replace(/\\/g, '/')}'`).join('\n'));
const final = D('out/OpsDesk_demo.mp4');
ff(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', final]);
console.log('Saved', final);
