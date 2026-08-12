// Menu / pause / death screens for the ASHFALL PROTOCOL HUD.
// Pure DOM construction — all styling lives in src/hud/styles.js.

/** Tiny DOM helper shared with hud.js. */
export function el(tag, cls, parent, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  if (parent) parent.appendChild(n);
  return n;
}

const CONTROL_ROWS = [
  [['W', 'A', 'S', 'D'], 'MOVE'],
  [['SHIFT'], 'SPRINT'],
  [['SPACE'], 'JUMP'],
  [['C'], 'CROUCH'],
  [['R'], 'RELOAD'],
  [['MOUSE'], 'LOOK'],
  [['LMB'], 'FIRE'],
  [['RMB'], 'ADS'],
];

function buildControls(parent) {
  const grid = el('div', 'af-controls', parent);
  for (const [keys, action] of CONTROL_ROWS) {
    const kwrap = el('div', 'af-keys', grid);
    for (const k of keys) el('span', 'af-key', kwrap, k);
    el('span', 'af-act', grid, action);
  }
  return grid;
}

function statTriplet(parent) {
  const wrap = el('div', 'af-stats', parent);
  const mk = (label) => {
    const s = el('div', 'af-stat', wrap);
    const v = el('div', 'af-stat-val', s, '0');
    el('div', 'af-stat-lab', s, label);
    return v;
  };
  return { kills: mk('ELIMINATIONS'), score: mk('SCORE'), time: mk('SURVIVED') };
}

/**
 * Builds the full-screen menu into `root` (#menu).
 * Returns { root, panels: {menu, paused, over}, pauseStats, deathStats }.
 */
export function buildMenu(root, { noiseUrl, onPlay, onResume, onRedeploy } = {}) {
  root.classList.add('af-menu');
  root.dataset.phase = 'menu';

  // Backdrop layers (live 3D scene shows through).
  el('div', 'af-m-blur', root);
  el('div', 'af-m-shade', root);
  el('div', 'af-m-vin', root);
  const noise = el('div', 'af-m-noise', root);
  if (noiseUrl) noise.style.backgroundImage = `url(${noiseUrl})`;
  el('div', 'af-m-scan', root);
  el('div', 'af-m-bar top', root);
  el('div', 'af-m-bar bottom', root);

  // --- TITLE SCREEN ---
  const title = el('div', 'af-panel af-p-title', root);
  el('div', 'af-eyebrow', title, '// TASK FORCE EMBER — NIGHT OPERATION');
  el('h1', 'af-title', title, 'ASHFALL');
  const sub = el('div', 'af-subtitle', title);
  el('span', '', sub, 'PROTOCOL');
  el('div', 'af-divider', title);
  const playBtn = el('button', 'af-btn', title, 'PLAY');
  el('div', 'af-hint', title, 'POINTER LOCKS ON DEPLOY — ESC TO PAUSE');
  buildControls(title);

  // --- PAUSE SCREEN ---
  const paused = el('div', 'af-panel af-p-paused', root);
  el('div', 'af-eyebrow', paused, '// OPERATION SUSPENDED');
  el('h1', 'af-title af-t-sm', paused, 'PAUSED');
  const pauseStats = statTriplet(paused);
  el('div', 'af-divider', paused);
  const resumeBtn = el('button', 'af-btn', paused, 'RESUME');
  el('div', 'af-hint', paused, 'CLICK RESUME OR PRESS ENTER TO RE-ENGAGE');
  buildControls(paused);

  // --- DEATH SCREEN ---
  const over = el('div', 'af-panel af-p-over', root);
  el('div', 'af-eyebrow af-e-red', over, '// MISSION FAILED — SIGNAL LOST');
  el('h1', 'af-title af-t-sm af-t-red', over, 'YOU DIED');
  const deathStats = statTriplet(over);
  el('div', 'af-divider', over);
  const redeployBtn = el('button', 'af-btn af-btn-red', over, 'REDEPLOY');
  el('div', 'af-hint', over, 'PRESS ENTER TO REDEPLOY — FULL RESTART');

  // --- FOOTER ---
  const foot = el('div', 'af-m-foot', root);
  el('span', '', foot, 'ASHFALL ENGINE // BUILD 1.0.0');
  el('span', '', foot, 'SECTOR 07 — CINDER DISTRICT // 03:41 LOCAL');

  if (onPlay) playBtn.addEventListener('click', onPlay);
  if (onResume) resumeBtn.addEventListener('click', onResume);
  if (onRedeploy) redeployBtn.addEventListener('click', onRedeploy);

  return {
    root,
    panels: { menu: title, paused, over },
    pauseStats,
    deathStats,
  };
}
