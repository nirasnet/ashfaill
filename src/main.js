// Engine bootstrap + integration. OWNED by the integrator — subsystem agents read, don't edit.
import * as THREE from 'three';
import { EventBus, World, Input } from './core.js';
import { AtmosphereSystem } from './atmosphere.js';
import { LevelSystem } from './level.js';
import { PlayerSystem } from './player.js';
import { WeaponSystem } from './weapons.js';
import { EffectsSystem } from './effects.js';
import { EnemySystem } from './enemies.js';
import { HudSystem } from './hud.js';
import { AudioSystem } from './audio.js';
import { PostFxSystem } from './postfx.js';

const canvas = document.getElementById('game');
const renderer = new THREE.WebGLRenderer({
  canvas, antialias: false, powerPreference: 'high-performance', stencil: false,
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap; // PCFSoft is deprecated in r185 and falls back to PCF anyway
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping; // postfx.js may take over tone mapping
renderer.toneMappingExposure = 1.0;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(74, window.innerWidth / window.innerHeight, 0.05, 900);
camera.rotation.order = 'YXZ';

const ctx = {
  renderer, scene, camera, canvas,
  events: new EventBus(),
  world: new World(),
  input: new Input(canvas),
  player: null,   // set by PlayerSystem.init
  weapons: null,  // set by WeaponSystem.init
  state: { phase: 'menu', kills: 0, score: 0, timeAlive: 0 },
  time: 0,
};

const systems = {
  atmosphere: new AtmosphereSystem(),
  level: new LevelSystem(),
  player: new PlayerSystem(),
  weapons: new WeaponSystem(),
  effects: new EffectsSystem(),
  enemies: new EnemySystem(),
  hud: new HudSystem(),
  audio: new AudioSystem(),
  postfx: new PostFxSystem(),
};
// Init order matters: environment first, then actors, then presentation.
const initOrder = ['atmosphere', 'level', 'player', 'weapons', 'effects', 'enemies', 'hud', 'audio', 'postfx'];
const updateOrder = ['player', 'weapons', 'enemies', 'effects', 'atmosphere', 'hud', 'audio'];

for (const name of initOrder) {
  try { await systems[name].init(ctx); }
  catch (err) { console.error(`[init:${name}]`, err); }
}

// Pointer lock <-> game state. hud.js renders the menu into #menu and calls
// ctx.requestStart() when its play button is clicked.
ctx.requestStart = () => {
  canvas.requestPointerLock({ unadjustedMovement: true }).catch?.(() => canvas.requestPointerLock());
};
document.addEventListener('pointerlockchange', () => {
  ctx.input.locked = document.pointerLockElement === canvas;
  if (ctx.input.locked && ctx.state.phase === 'menu') {
    ctx.state.phase = 'playing';
    ctx.events.emit('game:start');
  } else if (!ctx.input.locked && ctx.state.phase === 'playing') {
    ctx.state.phase = 'paused';
    ctx.events.emit('game:pause');
  } else if (ctx.input.locked && ctx.state.phase === 'paused') {
    ctx.state.phase = 'playing';
    ctx.events.emit('game:resume');
  }
});
ctx.events.on('game:over', () => { document.exitPointerLock(); ctx.state.phase = 'over'; });

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  systems.postfx.resize?.(window.innerWidth, window.innerHeight);
});

// Dev/CI hook: window.__game exposes ctx for the screenshot harness; visiting
// with #dev starts gameplay without pointer lock (headless Chrome can't lock).
window.__game = ctx;
if (location.hash.includes('dev')) {
  ctx.state.phase = 'playing';
  ctx.input.locked = true;
  ctx.events.emit('game:start');
  document.getElementById('menu').style.display = 'none';
}

const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.05);
  ctx.time += dt;
  if (ctx.state.phase === 'playing') ctx.state.timeAlive += dt;
  for (const name of updateOrder) {
    try { systems[name].update(dt, ctx); }
    catch (err) { console.error(`[update:${name}]`, err); }
  }
  try {
    if (systems.postfx.render) systems.postfx.render(dt, ctx);
    else renderer.render(scene, camera);
  } catch (err) { console.error('[render]', err); }
  ctx.input.endFrame();
});
