// Headless screenshot harness. Usage:
//   node scripts/shot.mjs <outDir> [--wide] [--shots=menu,street,combat,ads,upward]
// Writes PNGs + console.log lines (console.json) to outDir.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const outDir = process.argv[2] || 'shots';
const wide = process.argv.includes('--wide');
const shotsArg = process.argv.find((a) => a.startsWith('--shots='));
const wanted = shotsArg ? shotsArg.slice(8).split(',') : ['menu', 'street', 'combat', 'ads', 'upward'];
fs.mkdirSync(outDir, { recursive: true });

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const W = wide ? 1920 : 1600, H = wide ? 1080 : 900;

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: [`--window-size=${W},${H}`, '--use-angle=metal', '--enable-gpu', '--hide-scrollbars'],
  defaultViewport: { width: W, height: H },
});
const page = await browser.newPage();
const consoleLog = [];
page.on('console', (m) => consoleLog.push({ type: m.type(), text: m.text().slice(0, 500) }));
page.on('pageerror', (e) => consoleLog.push({ type: 'pageerror', text: String(e).slice(0, 800) }));

// --- menu shot first (no #dev) ---------------------------------------------
if (wanted.includes('menu')) {
  await page.goto('http://localhost:5711/', { waitUntil: 'networkidle0', timeout: 30000 });
  await new Promise((r) => setTimeout(r, 3500));
  await page.screenshot({ path: path.join(outDir, 'menu.png') });
}

// --- gameplay shots via #dev ------------------------------------------------
await page.goto('about:blank'); // force a real reload (hash-only goto won't re-run main.js)
await page.goto('http://localhost:5711/#dev', { waitUntil: 'networkidle0', timeout: 30000 });
// God mode ASAP (before enemies can kill the posing player), then warmup.
await page.waitForFunction(() => !!window.__game?.player, { timeout: 15000 });
await page.evaluate(() => {
  const g = window.__game;
  g.player.damage = () => {};
  g.player.health = 100;
  g.state.phase = 'playing';
});
await new Promise((r) => setTimeout(r, 4500)); // warmup: shaders, env, spawns

const setView = (pos, yaw, pitch) => page.evaluate(([p, y, x]) => {
  const g = window.__game;
  if (!g?.player?.rig) return 'no-player';
  g.player.rig.position.set(p[0], p[1], p[2]);
  g.player.velocity?.set?.(0, 0, 0);
  g.player.rig.rotation.y = y;
  if (typeof g.player._pitch === 'number') g.player._pitch = x;
  g.camera.rotation.x = x;
  return 'ok';
}, [pos, yaw, pitch]);

const holdFire = async (ms) => {
  await page.evaluate(() => { window.__game.input.mouseDown[0] = true; });
  await new Promise((r) => setTimeout(r, ms));
  await page.evaluate(() => { window.__game.input.mouseDown[0] = false; });
};
const holdAds = (on) => page.evaluate((v) => { window.__game.input.mouseDown[2] = v; }, on);

if (wanted.includes('street')) {
  await setView([0, 0, 8], 0.35, 0.02);
  await new Promise((r) => setTimeout(r, 900));
  await page.screenshot({ path: path.join(outDir, 'street.png') });
}
if (wanted.includes('combat')) {
  await setView([6, 0, -2], -0.6, 0.0);
  await new Promise((r) => setTimeout(r, 700));
  // Screenshot MID-burst so the muzzle flash/tracer are actually on screen.
  await page.evaluate(() => { window.__game.input.mouseDown[0] = true; });
  await new Promise((r) => setTimeout(r, 130));
  await page.screenshot({ path: path.join(outDir, 'combat.png') });
  await new Promise((r) => setTimeout(r, 170));
  await page.evaluate(() => { window.__game.input.mouseDown[0] = false; });
  await new Promise((r) => setTimeout(r, 400));
}
if (wanted.includes('ads')) {
  await holdAds(true);
  await new Promise((r) => setTimeout(r, 600));
  await holdFire(180);
  await page.screenshot({ path: path.join(outDir, 'ads.png') });
  await holdAds(false);
}
if (wanted.includes('upward')) {
  await setView([-8, 0, 12], 2.4, 0.35); // look up at buildings + sky
  await new Promise((r) => setTimeout(r, 900));
  await page.screenshot({ path: path.join(outDir, 'upward.png') });
}

const fps = await page.evaluate(() => new Promise((res) => {
  let n = 0; const t0 = performance.now();
  const tick = () => { n++; if (performance.now() - t0 < 2000) requestAnimationFrame(tick); else res(Math.round(n / 2)); };
  requestAnimationFrame(tick);
}));
const stats = await page.evaluate(() => {
  const g = window.__game;
  return {
    phase: g?.state?.phase,
    enemies: g?.world?.enemies?.filter((e) => e.alive).length ?? -1,
    drawCalls: g?.renderer?.info?.render?.calls,
    triangles: g?.renderer?.info?.render?.triangles,
    health: g?.player?.health,
    ammo: g?.weapons?.ammo,
  };
});
stats.fps = fps;
fs.writeFileSync(path.join(outDir, 'console.json'), JSON.stringify({ stats, consoleLog }, null, 2));
console.log(JSON.stringify(stats));
console.log('errors:', consoleLog.filter((m) => ['error', 'pageerror'].includes(m.type)).length);
await browser.close();
