// Procedural textures for the effects system. Built once at init, never per-shot.
import * as THREE from 'three';
import { makeCanvas, rng, normalFromHeight } from '../utils.js';

function toTexture(canvas, { srgb = true } = {}) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** Soft radial glow: white core fading to transparent. Sparks, glows, light bloom sprites. */
export function makeGlowTexture(size = 128) {
  const { canvas, ctx } = makeCanvas(size);
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0.0, 'rgba(255,255,255,1)');
  g.addColorStop(0.25, 'rgba(255,255,255,0.85)');
  g.addColorStop(0.55, 'rgba(255,255,255,0.28)');
  g.addColorStop(1.0, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return toTexture(canvas);
}

/**
 * Muzzle-flash sprite: a compact CoD-style pop — a hot white core with FAST
 * falloff plus 2-3 short, stubby, irregular spikes. Alpha is dead well before
 * the spike tips so the spawner's HDR color boost can't resurrect a hard
 * cartoon-star edge. Several seeded variants are baked at init; the spawner
 * picks a random variant + rotation + scale per shot.
 */
export function makeFlashTexture({ size = 192, spikes = 3, seed = 11 } = {}) {
  const { canvas, ctx } = makeCanvas(size);
  const rand = rng(seed);
  const c = size / 2;
  ctx.clearRect(0, 0, size, size);
  ctx.globalCompositeOperation = 'lighter';
  // Spikes: short tapered tongues at uneven angles, each slightly bent (tip
  // pulled off-axis) so no two variants read as the same star.
  const a0 = rand() * Math.PI * 2;
  for (let i = 0; i < spikes; i++) {
    const a = a0 + (i / spikes) * Math.PI * 2 + (rand() - 0.5) * 1.4;
    const len = c * (0.5 + rand() * 0.35);      // SHORT: 50-85% of half-size
    const wid = size * (0.05 + rand() * 0.045); // stubby gas tongue, not a needle
    const tipY = (rand() - 0.5) * wid * 1.6;
    ctx.save();
    ctx.translate(c, c);
    ctx.rotate(a);
    const g = ctx.createLinearGradient(0, 0, len, 0);
    g.addColorStop(0.0, 'rgba(255,240,205,0.9)');
    g.addColorStop(0.3, 'rgba(255,190,110,0.42)');
    g.addColorStop(0.7, 'rgba(255,140,60,0.1)');
    g.addColorStop(1.0, 'rgba(255,120,40,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(0, -wid);
    ctx.quadraticCurveTo(len * 0.45, -wid * 0.5, len, tipY);
    ctx.quadraticCurveTo(len * 0.45, wid * 0.5, 0, wid);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
  // Hot white core, fast falloff: pure white pinpoint, warm by 60%, gone at
  // 30% of the sprite — the flash reads as a point of burning gas, not a disc.
  let g = ctx.createRadialGradient(c, c, 0, c, c, c * 0.3);
  g.addColorStop(0.0, 'rgba(255,255,255,1)');
  g.addColorStop(0.3, 'rgba(255,246,220,0.95)');
  g.addColorStop(0.6, 'rgba(255,200,120,0.4)');
  g.addColorStop(1.0, 'rgba(255,150,60,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  // Faint gas haze so the spikes root into the core instead of floating.
  g = ctx.createRadialGradient(c, c, 0, c, c, c * 0.5);
  g.addColorStop(0.0, 'rgba(255,180,100,0.22)');
  g.addColorStop(1.0, 'rgba(255,150,70,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  ctx.globalCompositeOperation = 'source-over';
  return toTexture(canvas);
}

/** Soft blotchy smoke/dust puff (white; tint via particle color). */
export function makeSmokeTexture({ size = 128, blobs = 26, seed = 5 } = {}) {
  const { canvas, ctx } = makeCanvas(size);
  const rand = rng(seed);
  const c = size / 2;
  ctx.clearRect(0, 0, size, size);
  for (let i = 0; i < blobs; i++) {
    const ang = rand() * Math.PI * 2;
    const dist = rand() * rand() * c * 0.55;
    const x = c + Math.cos(ang) * dist;
    const y = c + Math.sin(ang) * dist;
    const r = size * (0.08 + rand() * 0.16);
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    const a = 0.10 + rand() * 0.14;
    g.addColorStop(0, `rgba(255,255,255,${a})`);
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  }
  // Enforce a fully transparent border so point-sprite UV rotation never clamps a hard edge.
  const mask = ctx.createRadialGradient(c, c, size * 0.28, c, c, c * 0.98);
  mask.addColorStop(0, 'rgba(0,0,0,1)');
  mask.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.globalCompositeOperation = 'destination-in';
  ctx.fillStyle = mask;
  ctx.fillRect(0, 0, size, size);
  ctx.globalCompositeOperation = 'source-over';
  return toTexture(canvas);
}

/**
 * Muzzle-smoke billboard: radial-gradient alpha with erosion noise so the rim
 * dissolves like real powder smoke instead of reading as a solid gray sphere.
 */
export function makeMuzzleSmokeTexture({ size = 128, seed = 9 } = {}) {
  const { canvas, ctx } = makeCanvas(size);
  const rand = rng(seed);
  const c = size / 2;
  ctx.clearRect(0, 0, size, size);
  // Base radial gradient: translucent core easing to a transparent rim.
  let g = ctx.createRadialGradient(c, c, 0, c, c, c);
  g.addColorStop(0.0, 'rgba(255,255,255,0.85)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.55)');
  g.addColorStop(0.7, 'rgba(255,255,255,0.2)');
  g.addColorStop(1.0, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  // Internal lobes so the puff is not a perfect sphere.
  for (let i = 0; i < 9; i++) {
    const a = rand() * Math.PI * 2;
    const d = rand() * rand() * c * 0.5;
    const x = c + Math.cos(a) * d, y = c + Math.sin(a) * d;
    const r = size * (0.1 + rand() * 0.14);
    const gg = ctx.createRadialGradient(x, y, 0, x, y, r);
    gg.addColorStop(0, `rgba(255,255,255,${0.12 + rand() * 0.14})`);
    gg.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = gg;
    ctx.fillRect(0, 0, size, size);
  }
  // Erosion noise: punch soft holes, denser toward the rim, so edges break up.
  ctx.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 30; i++) {
    const a = rand() * Math.PI * 2;
    const d = c * (0.2 + Math.sqrt(rand()) * 0.78);
    const x = c + Math.cos(a) * d, y = c + Math.sin(a) * d;
    const r = size * (0.025 + rand() * 0.085);
    const gg = ctx.createRadialGradient(x, y, 0, x, y, r);
    gg.addColorStop(0, `rgba(0,0,0,${0.2 + rand() * 0.45})`);
    gg.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = gg;
    ctx.fillRect(0, 0, size, size);
  }
  // Guarantee a fully transparent border so sprite rotation never clamps an edge.
  ctx.globalCompositeOperation = 'destination-in';
  const mask = ctx.createRadialGradient(c, c, size * 0.3, c, c, c * 0.98);
  mask.addColorStop(0, 'rgba(0,0,0,1)');
  mask.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = mask;
  ctx.fillRect(0, 0, size, size);
  ctx.globalCompositeOperation = 'source-over';
  return toTexture(canvas);
}

/** Tracer streak: bright head (u=1) with a hot core line fading to the tail (u=0).
 *  The tail ramp is long and gradual — streaks carry ~12m tails, so the alpha
 *  must decay over most of the length or the tracer reads as a solid ribbon. */
export function makeTracerTexture({ w = 256, h = 64 } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  // Along-length gradient: transparent tail -> hot head.
  const g = ctx.createLinearGradient(0, 0, w, 0);
  g.addColorStop(0.0, 'rgba(255,255,255,0)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.05)');
  g.addColorStop(0.7, 'rgba(255,255,255,0.28)');
  g.addColorStop(0.9, 'rgba(255,255,255,0.75)');
  g.addColorStop(0.97, 'rgba(255,255,255,1)');
  g.addColorStop(1.0, 'rgba(255,255,255,0.6)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  // Cross-section falloff: opaque center line, transparent edges.
  const v = ctx.createLinearGradient(0, 0, 0, h);
  v.addColorStop(0.0, 'rgba(0,0,0,0)');
  v.addColorStop(0.35, 'rgba(0,0,0,0.55)');
  v.addColorStop(0.5, 'rgba(0,0,0,1)');
  v.addColorStop(0.65, 'rgba(0,0,0,0.55)');
  v.addColorStop(1.0, 'rgba(0,0,0,0)');
  ctx.globalCompositeOperation = 'destination-in';
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, w, h);
  ctx.globalCompositeOperation = 'source-over';
  return toTexture(canvas);
}

/**
 * Bullet-hole decal maps: { map, normalMap }.
 * Color: near-black ragged pit, scorched halo, soft alpha edge.
 * Normal: built from a matching height canvas (deep pit, raised rim lip,
 * chipped dents at the SAME positions as the color chips) via Sobel — the
 * decal material is lit, so the crater actually catches sun/muzzle light
 * instead of reading as a flat dark sticker.
 */
export function makeBulletHoleMaps({ size = 128, seed = 23, normalStrength = 2.4 } = {}) {
  const { canvas, ctx } = makeCanvas(size);
  const { canvas: hCanvas, ctx: hctx } = makeCanvas(size);
  const rand = rng(seed);
  const c = size / 2;
  ctx.clearRect(0, 0, size, size);
  // Height base: mid gray = surface plane.
  hctx.fillStyle = 'rgb(128,128,128)';
  hctx.fillRect(0, 0, size, size);
  // Scorch/dust halo (color only — soot has no height).
  let g = ctx.createRadialGradient(c, c, 0, c, c, c * 0.95);
  g.addColorStop(0.0, 'rgba(20,16,12,0.9)');
  g.addColorStop(0.35, 'rgba(30,26,22,0.55)');
  g.addColorStop(0.7, 'rgba(40,36,32,0.22)');
  g.addColorStop(1.0, 'rgba(45,40,36,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  // Raised rim lip where the surface bulged outward around the pit.
  g = hctx.createRadialGradient(c, c, c * 0.18, c, c, c * 0.55);
  g.addColorStop(0.0, 'rgba(200,200,200,0)');
  g.addColorStop(0.35, 'rgba(215,215,215,0.85)');
  g.addColorStop(1.0, 'rgba(128,128,128,0)');
  hctx.fillStyle = g;
  hctx.fillRect(0, 0, size, size);
  // Deep center pit (color + height in lockstep).
  g = ctx.createRadialGradient(c, c, 0, c, c, c * 0.34);
  g.addColorStop(0, 'rgba(0,0,0,1)');
  g.addColorStop(0.7, 'rgba(5,4,3,0.95)');
  g.addColorStop(1, 'rgba(10,8,6,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  g = hctx.createRadialGradient(c, c, 0, c, c, c * 0.34);
  g.addColorStop(0, 'rgba(0,0,0,1)');
  g.addColorStop(0.7, 'rgba(20,20,20,0.9)');
  g.addColorStop(1, 'rgba(128,128,128,0)');
  hctx.fillStyle = g;
  hctx.fillRect(0, 0, size, size);
  // Ragged chips around the pit — same rand() sequence drives both canvases so
  // every color chip has a matching dent in the normal map.
  for (let i = 0; i < 14; i++) {
    const a = rand() * Math.PI * 2;
    const d = c * (0.2 + rand() * 0.24);
    const r = size * (0.02 + rand() * 0.05);
    const x = c + Math.cos(a) * d, y = c + Math.sin(a) * d;
    let gg = ctx.createRadialGradient(x, y, 0, x, y, r);
    gg.addColorStop(0, 'rgba(8,6,5,0.85)');
    gg.addColorStop(1, 'rgba(8,6,5,0)');
    ctx.fillStyle = gg;
    ctx.fillRect(0, 0, size, size);
    gg = hctx.createRadialGradient(x, y, 0, x, y, r);
    gg.addColorStop(0, 'rgba(50,50,50,0.8)');
    gg.addColorStop(1, 'rgba(128,128,128,0)');
    hctx.fillStyle = gg;
    hctx.fillRect(0, 0, size, size);
  }
  // Nibble the outer edge for irregularity (alpha only).
  ctx.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 10; i++) {
    const a = rand() * Math.PI * 2;
    const d = c * (0.75 + rand() * 0.22);
    const r = size * (0.04 + rand() * 0.07);
    const x = c + Math.cos(a) * d, y = c + Math.sin(a) * d;
    const gg = ctx.createRadialGradient(x, y, 0, x, y, r);
    gg.addColorStop(0, 'rgba(0,0,0,0.9)');
    gg.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = gg;
    ctx.fillRect(0, 0, size, size);
  }
  ctx.globalCompositeOperation = 'source-over';
  const normalMap = normalFromHeight(hCanvas, normalStrength);
  normalMap.wrapS = normalMap.wrapT = THREE.ClampToEdgeWrapping;
  return { map: toTexture(canvas), normalMap };
}
