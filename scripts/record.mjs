// Records a scripted gameplay clip. Usage: node scripts/record.mjs <outDir>
// Produces frame-####.png files; assemble with ffmpeg afterwards.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const outDir = process.argv[2] || 'recording';
fs.mkdirSync(outDir, { recursive: true });

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const W = 1280, H = 720;

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: [`--window-size=${W},${H}`, '--use-angle=metal', '--enable-gpu', '--hide-scrollbars'],
  defaultViewport: { width: W, height: H },
});
const page = await browser.newPage();
await page.goto('http://localhost:5711/#dev', { waitUntil: 'networkidle0', timeout: 30000 });
await page.waitForFunction(() => !!window.__game?.player, { timeout: 15000 });
await page.evaluate(() => {
  const g = window.__game;
  g.player.damage = () => {};
  g.player.health = 100;
});
await new Promise((r) => setTimeout(r, 4000)); // warmup

const key = (code, down) => page.evaluate(([c, d]) => {
  const g = window.__game;
  if (d) g.input.keys.add(c); else g.input.keys.delete(c);
}, [code, down]);
const mouse = (btn, down) => page.evaluate(([b, d]) => { window.__game.input.mouseDown[b] = d; }, [btn, down]);
const look = (dyaw, dpitch) => page.evaluate(([y, p]) => {
  const g = window.__game;
  g.input.mouseDX += y; g.input.mouseDY += p;
}, [dyaw, dpitch]);

// Choreography: [t_ms, fn]
const steps = [
  [0, () => key('KeyW', true)],
  [200, () => look(150, 10)],
  [900, () => look(-220, -6)],
  [1800, () => look(90, 0)],
  [2600, () => mouse(0, true)],
  [3100, () => mouse(0, false)],
  [3300, () => key('ShiftLeft', true)],
  [3600, () => look(180, -4)],
  [4800, () => key('ShiftLeft', false)],
  [5000, () => mouse(2, true)],   // ADS
  [5450, () => mouse(0, true)],
  [6100, () => mouse(0, false)],
  [6300, () => mouse(2, false)],
  [6500, () => look(-260, -30)],  // sweep up at towers
  [7400, () => look(120, 34)],
  [8200, () => mouse(0, true)],
  [8900, () => mouse(0, false)],
  [9100, () => key('KeyW', false)],
];

const DURATION = 10000, INTERVAL = 90;
const t0 = Date.now();
let next = 0, frame = 0;
while (Date.now() - t0 < DURATION) {
  const t = Date.now() - t0;
  while (next < steps.length && steps[next][0] <= t) { await steps[next][1](); next++; }
  await page.screenshot({ path: path.join(outDir, `frame-${String(frame).padStart(4, '0')}.png`) });
  frame++;
  const behind = (Date.now() - t0) % INTERVAL;
  await new Promise((r) => setTimeout(r, Math.max(10, INTERVAL - behind)));
}
console.log('frames:', frame);
await browser.close();
