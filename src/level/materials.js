// Procedural PBR material library for the ruined-city level.
// Built once at init from canvas textures (utils.js helpers). Owned by the level agent.
//
// Day-scene rules (art-director pass 2):
//  - Window glass is DIELECTRIC (tint #1a222c, roughness 0.08, metalness
//    0.25, envMapIntensity 1.6) so panes reflect the sky instead of reading
//    as flat black voids. ~25% of the window atlas cells are dim warm
//    interior cards (subtle emissive) so facades read inhabited; the skyline
//    carries a sparse lit-window grid + a faint emissive floor so distant
//    towers never render pure black at noon. All emissives stay DIM — no
//    clipped-white noon windows.
//  - Ground albedo band #2e2e30..#3a3a3c, neutral hue: all tonal variation is
//    BOUNDED noise around the base color (utils.noiseFill pulls toward
//    mid-gray, which made the asphalt read as light cardboard — do not use it
//    for dark albedos).
//  - Scatter tints are clamped to desaturated gray-browns in props.js.
import * as THREE from 'three';
import { rng, makeCanvas, noiseFill, normalFromHeight, canvasTexture } from '../utils.js';

/* ----------------------------- canvas helpers ----------------------------- */

function hexRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const c255 = (v) => Math.max(0, Math.min(255, Math.round(v)));

/**
 * Multi-octave value-noise blotches BOUNDED to +-amp around the base color.
 * Unlike utils.noiseFill (random 0-255 grays, which lightens dark bases toward
 * #808080), this keeps a #3a3a3e asphalt reading as #3a3a3e.
 * octaves: [{ r: blotch radius px, n: count, amp: max +-lightness, a?: alpha }]
 */
function boundedNoise(c2, size, baseHex, seed, octaves) {
  const rand = rng(seed);
  const [br, bg, bb] = hexRgb(baseHex);
  c2.fillStyle = baseHex;
  c2.fillRect(0, 0, size, size);
  for (const { r, n, amp, a = 0.5 } of octaves) {
    for (let i = 0; i < n; i++) {
      const d = (rand() * 2 - 1) * amp;
      c2.fillStyle = `rgba(${c255(br + d)},${c255(bg + d)},${c255(bb + d)},${a * (0.4 + rand() * 0.6)})`;
      c2.beginPath();
      c2.arc(rand() * size, rand() * size, r * (0.55 + rand() * 0.9), 0, Math.PI * 2);
      c2.fill();
    }
  }
}

function speckle(c2, size, rand, n, rMin, rMax, colors, alpha) {
  c2.globalAlpha = alpha;
  for (let i = 0; i < n; i++) {
    c2.fillStyle = colors[Math.floor(rand() * colors.length)];
    c2.beginPath();
    c2.arc(rand() * size, rand() * size, rMin + rand() * (rMax - rMin), 0, Math.PI * 2);
    c2.fill();
  }
  c2.globalAlpha = 1;
}

function drips(c2, size, rand, n, rgb, alphaMax) {
  for (let i = 0; i < n; i++) {
    const x = rand() * size, w = 2 + rand() * 9;
    const y0 = rand() * size * 0.4, h = size * (0.2 + rand() * 0.6);
    const g = c2.createLinearGradient(0, y0, 0, y0 + h);
    const a = alphaMax * (0.35 + rand() * 0.65);
    g.addColorStop(0, `rgba(${rgb},${a})`);
    g.addColorStop(1, `rgba(${rgb},0)`);
    c2.fillStyle = g;
    c2.fillRect(x, y0, w, h);
  }
}

function stains(c2, size, rand, n, rgb, alphaMax) {
  for (let i = 0; i < n; i++) {
    const x = rand() * size, y = rand() * size, r = size * (0.06 + rand() * 0.2);
    const g = c2.createRadialGradient(x, y, r * 0.15, x, y, r);
    g.addColorStop(0, `rgba(${rgb},${alphaMax * (0.4 + rand() * 0.6)})`);
    g.addColorStop(1, `rgba(${rgb},0)`);
    c2.fillStyle = g;
    c2.beginPath();
    c2.arc(x, y, r, 0, Math.PI * 2);
    c2.fill();
  }
}

function roughCanvas(size, base, seed, blobs, blobColor, blobAlpha) {
  const { canvas, ctx } = makeCanvas(size);
  noiseFill(ctx, size, { base, octaves: 3, alpha: 0.05, mono: true, seed });
  if (blobs) stains(ctx, size, rng(seed + 1), blobs, blobColor, blobAlpha);
  return canvas;
}

function std(mapCanvas, heightCanvas, opts = {}) {
  const {
    normalStrength = 1.2, roughness = 0.9, metalness = 0.0,
    roughCanvasIn = null, normalScale = 1.0, side = THREE.FrontSide,
  } = opts;
  const mat = new THREE.MeshStandardMaterial({
    map: canvasTexture(mapCanvas),
    roughness, metalness, side,
  });
  if (heightCanvas) {
    mat.normalMap = normalFromHeight(heightCanvas, normalStrength);
    mat.normalScale = new THREE.Vector2(normalScale, normalScale);
  }
  if (roughCanvasIn) mat.roughnessMap = canvasTexture(roughCanvasIn, { srgb: false });
  return mat;
}

/** Decal helper: clamp-wrapped transparent overlay material. */
function decalMat(canvas, { roughness = 1, offset = -2 } = {}) {
  const tex = canvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  return new THREE.MeshStandardMaterial({
    map: tex, transparent: true, depthWrite: false, roughness, metalness: 0,
    polygonOffset: true, polygonOffsetFactor: offset, polygonOffsetUnits: offset,
  });
}

/* ------------------------------- materials -------------------------------- */

// Dominant street/plaza surface. Albedo base #46464a (raised from the old
// #333335 band: building-shadow areas rendered as a featureless near-black
// field — the lift keeps shadowed tarmac readable while sunlit tarmac still
// reads dark). Neutral hue, bounded noise. The tile is 7 m and carries the
// 0.5 m and 2 m noise octaves; the 8 m / 32 m octaves live in
// groundMacroMat() (a whole-arena overlay).
function asphaltMat() {
  const S = 512; // 1 tile = 7 m  =>  1 m ~ 73 px
  const { canvas: c, ctx: c2 } = makeCanvas(S);
  const { canvas: h, ctx: h2 } = makeCanvas(S);
  const rand = rng(101);
  boundedNoise(c2, S, '#46464a', 101, [
    { r: 73, n: 34, amp: 13 },  // 2 m octave
    { r: 18, n: 300, amp: 16 }, // 0.5 m octave
  ]);
  noiseFill(h2, S, { base: '#7d7d7d', octaves: 4, alpha: 0.06, seed: 102 });
  // tar repair patches (kept: hard-edged, reads as roadwork, not camo);
  // stronger against the lifted base so they survive building shadow
  for (let i = 0; i < 4; i++) {
    const x = rand() * S, y = rand() * S, w = 40 + rand() * 110, ht = 30 + rand() * 80;
    c2.fillStyle = 'rgba(28,28,30,0.55)';
    c2.fillRect(x, y, w, ht);
    h2.fillStyle = 'rgba(140,140,140,0.5)';
    h2.fillRect(x, y, w, ht);
  }
  // aggregate speckle stays within +-12 of the base tone
  speckle(c2, S, rand, 2400, 0.5, 1.6, ['#525257', '#37373a', '#57575c', '#414144'], 0.32);
  speckle(h2, S, rand, 2400, 0.5, 1.6, ['#a8a8a8', '#5f5f5f', '#c2c2c2'], 0.35);
  // roughness: uniformly matte (the old glossy blobs made bright sheen patches)
  const { canvas: rc, ctx: r2 } = makeCanvas(S);
  boundedNoise(r2, S, '#f6f6f6', 103, [{ r: 40, n: 60, amp: 10, a: 0.4 }]);
  return std(c, h, { normalStrength: 1.2, roughness: 0.95, roughCanvasIn: rc });
}

// Charcoal patch-repair decal atlas (2x2): irregular squared-off tar patches
// (#232325) with aggregate speckle and a slight raised-edge normal ring, laid
// over the asphalt along the drive lanes and plaza.
function patchRepairMat() {
  const S = 256, C = 128;
  const { canvas: c, ctx: c2 } = makeCanvas(S);
  const { canvas: h, ctx: h2 } = makeCanvas(S);
  h2.fillStyle = '#808080'; h2.fillRect(0, 0, S, S);
  c2.clearRect(0, 0, S, S);
  const rand = rng(613);
  for (let cell = 0; cell < 4; cell++) {
    const x0 = (cell % 2) * C, y0 = Math.floor(cell / 2) * C;
    // blocky outline: rectangle with jittered edges (road crews cut squares)
    const nPts = 10;
    const pts = [];
    for (let i = 0; i < nPts; i++) {
      const a = (i / nPts) * Math.PI * 2;
      const sq = 1 / Math.max(Math.abs(Math.cos(a)), Math.abs(Math.sin(a))); // square-ify
      const r = C * 0.36 * sq * (0.82 + rand() * 0.18);
      pts.push([x0 + C / 2 + Math.cos(a) * r, y0 + C / 2 + Math.sin(a) * r]);
    }
    const trace = () => {
      c2.beginPath();
      c2.moveTo(pts[0][0], pts[0][1]);
      for (const [px, py] of pts.slice(1)) c2.lineTo(px, py);
      c2.closePath();
    };
    trace();
    c2.fillStyle = 'rgba(35,35,37,0.92)'; // #232325
    c2.fill();
    // aggregate speckle inside the patch
    c2.save();
    trace();
    c2.clip();
    for (let i = 0; i < 220; i++) {
      const g = 30 + Math.floor(rand() * 34);
      c2.fillStyle = `rgba(${g},${g},${g + 2},${0.35 + rand() * 0.4})`;
      c2.beginPath();
      c2.arc(x0 + rand() * C, y0 + rand() * C, 0.5 + rand() * 1.6, 0, Math.PI * 2);
      c2.fill();
    }
    // faded rolled-in center (older repair)
    const g = c2.createRadialGradient(x0 + C / 2, y0 + C / 2, 6, x0 + C / 2, y0 + C / 2, C * 0.4);
    g.addColorStop(0, 'rgba(52,52,55,0.25)');
    g.addColorStop(1, 'rgba(52,52,55,0)');
    c2.fillStyle = g;
    c2.fillRect(x0, y0, C, C);
    c2.restore();
    // raised tar edge bead in the height map
    h2.strokeStyle = '#a8a8a8';
    h2.lineWidth = 3;
    h2.beginPath();
    h2.moveTo(pts[0][0], pts[0][1]);
    for (const [px, py] of pts.slice(1)) h2.lineTo(px, py);
    h2.closePath();
    h2.stroke();
  }
  const mat = decalMat(c, { roughness: 0.92, offset: -2 });
  mat.normalMap = normalFromHeight(h, 1.4);
  mat.normalMap.wrapS = mat.normalMap.wrapT = THREE.ClampToEdgeWrapping;
  mat.normalScale = new THREE.Vector2(0.8, 0.8);
  return mat;
}

// Manhole cover decal: raised iron disc, concentric grooves + pick holes,
// normal-mapped so it catches the sun as real relief.
function manholeMat() {
  const S = 128;
  const { canvas: c, ctx: c2 } = makeCanvas(S);
  const { canvas: h, ctx: h2 } = makeCanvas(S);
  c2.clearRect(0, 0, S, S);
  h2.fillStyle = '#787878'; h2.fillRect(0, 0, S, S);
  const rand = rng(617);
  const cx = S / 2, R = S / 2 - 6;
  // seating ring (slightly darker asphalt collar)
  c2.fillStyle = 'rgba(24,24,26,0.65)';
  c2.beginPath(); c2.arc(cx, cx, R + 5, 0, Math.PI * 2); c2.fill();
  // iron disc
  c2.fillStyle = 'rgb(58,56,54)';
  c2.beginPath(); c2.arc(cx, cx, R, 0, Math.PI * 2); c2.fill();
  h2.fillStyle = '#9c9c9c';
  h2.beginPath(); h2.arc(cx, cx, R, 0, Math.PI * 2); h2.fill();
  // concentric grooves
  for (let r = R - 6; r > 10; r -= 9) {
    c2.strokeStyle = 'rgba(28,27,26,0.8)';
    c2.lineWidth = 3;
    c2.beginPath(); c2.arc(cx, cx, r, 0, Math.PI * 2); c2.stroke();
    h2.strokeStyle = '#5a5a5a';
    h2.lineWidth = 3;
    h2.beginPath(); h2.arc(cx, cx, r, 0, Math.PI * 2); h2.stroke();
  }
  // pick holes + wear glints
  for (const a of [0.6, 0.6 + Math.PI]) {
    c2.fillStyle = 'rgb(12,12,12)';
    c2.beginPath(); c2.arc(cx + Math.cos(a) * R * 0.55, cx + Math.sin(a) * R * 0.55, 4, 0, Math.PI * 2); c2.fill();
    h2.fillStyle = '#2a2a2a';
    h2.beginPath(); h2.arc(cx + Math.cos(a) * R * 0.55, cx + Math.sin(a) * R * 0.55, 4, 0, Math.PI * 2); h2.fill();
  }
  for (let i = 0; i < 60; i++) {
    const a = rand() * Math.PI * 2, r = rand() * R * 0.9;
    const g = 40 + Math.floor(rand() * 46);
    c2.fillStyle = `rgba(${g},${g - 2},${g - 4},0.5)`;
    c2.fillRect(cx + Math.cos(a) * r, cx + Math.sin(a) * r, 2, 2);
  }
  const mat = decalMat(c, { roughness: 0.55, offset: -2 });
  mat.metalness = 0.45;
  mat.normalMap = normalFromHeight(h, 2.0);
  mat.normalMap.wrapS = mat.normalMap.wrapT = THREE.ClampToEdgeWrapping;
  return mat;
}

// Storm-drain grate decal: dark rectangular grate with slotted bars,
// normal-mapped, placed in the gutter line against curbs.
function drainMat() {
  const S = 128;
  const { canvas: c, ctx: c2 } = makeCanvas(S);
  const { canvas: h, ctx: h2 } = makeCanvas(S);
  c2.clearRect(0, 0, S, S);
  h2.fillStyle = '#787878'; h2.fillRect(0, 0, S, S);
  // frame
  c2.fillStyle = 'rgb(48,47,45)';
  c2.fillRect(6, 26, S - 12, S - 52);
  h2.fillStyle = '#9a9a9a';
  h2.fillRect(6, 26, S - 12, S - 52);
  // slots (dark voids between bars)
  for (let x = 16; x < S - 18; x += 14) {
    c2.fillStyle = 'rgb(8,8,9)';
    c2.fillRect(x, 34, 8, S - 68);
    h2.fillStyle = '#1e1e1e';
    h2.fillRect(x, 34, 8, S - 68);
  }
  // silt stain washing into the grate
  const g = c2.createLinearGradient(0, 20, 0, 40);
  g.addColorStop(0, 'rgba(40,36,30,0.4)');
  g.addColorStop(1, 'rgba(40,36,30,0)');
  c2.fillStyle = g;
  c2.fillRect(0, 20, S, 20);
  const mat = decalMat(c, { roughness: 0.7, offset: -2 });
  mat.metalness = 0.35;
  mat.normalMap = normalFromHeight(h, 1.8);
  mat.normalMap.wrapS = mat.normalMap.wrapT = THREE.ClampToEdgeWrapping;
  return mat;
}

// Whole-arena macro overlay: the 8 m and 32 m noise octaves that can't fit in
// the 7 m asphalt tile, PLUS the large-scale wear features (repave strips,
// faded worn patches, big oil blooms) that keep shadowed ground from reading
// as a featureless field. One transparent 130x130 m plane, tile = 64 m.
function groundMacroMat() {
  const S = 512; // 1 tile = 64 m  =>  1 m = 8 px
  const { canvas: c, ctx: c2 } = makeCanvas(S);
  c2.clearRect(0, 0, S, S);
  const rand = rng(105);
  const blot = (n, r, aMax) => {
    for (let i = 0; i < n; i++) {
      const dark = rand() < 0.62;
      const a = aMax * (0.4 + rand() * 0.6) * (dark ? 1 : 0.55);
      const x = rand() * S, y = rand() * S, rr = r * (0.55 + rand() * 0.9);
      const g = c2.createRadialGradient(x, y, rr * 0.2, x, y, rr);
      const rgb = dark ? '14,14,16' : '200,200,204';
      g.addColorStop(0, `rgba(${rgb},${a})`);
      g.addColorStop(1, `rgba(${rgb},0)`);
      c2.fillStyle = g;
      c2.beginPath();
      c2.arc(x, y, rr, 0, Math.PI * 2);
      c2.fill();
    }
  };
  blot(110, 32, 0.2);  // 8 m octave
  blot(16, 128, 0.17); // 32 m octave
  // large repave strips: hard-edged axis-aligned rectangles, 4-11 m — fresh
  // (darker) or sun-bleached (lighter) lanes of tarmac crossing the blotches
  for (let i = 0; i < 9; i++) {
    const dark = rand() < 0.5;
    const w = 32 + rand() * 56, ht = 14 + rand() * 26;
    const x = rand() * S, y = rand() * S;
    const flip = rand() < 0.5;
    c2.fillStyle = dark
      ? `rgba(16,16,18,${0.16 + rand() * 0.1})`
      : `rgba(190,190,194,${0.1 + rand() * 0.08})`;
    c2.fillRect(x, y, flip ? w : ht, flip ? ht : w);
  }
  // big oil blooms: elongated dark stains 2-5 m across
  for (let i = 0; i < 12; i++) {
    const x = rand() * S, y = rand() * S, rr = 9 + rand() * 12;
    const g = c2.createRadialGradient(x, y, rr * 0.15, x, y, rr);
    g.addColorStop(0, `rgba(10,10,12,${0.22 + rand() * 0.14})`);
    g.addColorStop(1, 'rgba(10,10,12,0)');
    c2.fillStyle = g;
    c2.save();
    c2.translate(x, y);
    c2.rotate(rand() * Math.PI);
    c2.scale(1, 0.55 + rand() * 0.4);
    c2.translate(-x, -y);
    c2.beginPath();
    c2.arc(x, y, rr, 0, Math.PI * 2);
    c2.fill();
    c2.restore();
  }
  const tex = canvasTexture(c);
  return new THREE.MeshStandardMaterial({
    map: tex, transparent: true, depthWrite: false, roughness: 1, metalness: 0,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
  });
}

// Wheel-rut darkening strip: tire-track grime along the vehicle drive lanes.
// U spans the 2.3 m strip (two soft wheel bands at car track width); V repeats
// along the direction of travel.
function wheelPathMat() {
  const S = 256;
  const { canvas: c, ctx: c2 } = makeCanvas(S);
  c2.clearRect(0, 0, S, S);
  const rand = rng(107);
  for (const bandC of [S * 0.30, S * 0.70]) {
    const g = c2.createLinearGradient(bandC - 34, 0, bandC + 34, 0);
    g.addColorStop(0, 'rgba(16,15,14,0)');
    g.addColorStop(0.5, 'rgba(16,15,14,0.44)');
    g.addColorStop(1, 'rgba(16,15,14,0)');
    c2.fillStyle = g;
    c2.fillRect(bandC - 34, 0, 68, S);
  }
  // break the bands up so they read as accumulated grime, not painted stripes
  c2.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 260; i++) {
    c2.globalAlpha = 0.1 + rand() * 0.25;
    c2.beginPath();
    c2.arc(rand() * S, rand() * S, 2 + rand() * 9, 0, Math.PI * 2);
    c2.fill();
  }
  c2.globalCompositeOperation = 'source-over';
  c2.globalAlpha = 1;
  const tex = canvasTexture(c);
  tex.wrapS = THREE.ClampToEdgeWrapping; // wrapT repeats along the lane
  return new THREE.MeshStandardMaterial({
    map: tex, transparent: true, depthWrite: false, roughness: 0.98, metalness: 0,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
  });
}

function dirtMat() {
  const S = 512;
  const { canvas: c, ctx: c2 } = makeCanvas(S);
  const { canvas: h, ctx: h2 } = makeCanvas(S);
  const rand = rng(202);
  noiseFill(c2, S, { base: '#5b5145', octaves: 5, alpha: 0.09, seed: 202 });
  noiseFill(h2, S, { base: '#787878', octaves: 5, alpha: 0.1, seed: 203 });
  speckle(c2, S, rand, 900, 1, 3.2, ['#8a8172', '#6e6455', '#3a332c', '#98917f'], 0.45);
  speckle(h2, S, rand, 900, 1, 3.2, ['#c0c0c0', '#4a4a4a', '#d8d8d8'], 0.5);
  stains(c2, S, rand, 7, '35,30,25', 0.4);
  return std(c, h, { normalStrength: 1.3, roughness: 0.97 });
}

function concreteMat(seed = 303, base = '#8f8a7f') {
  const S = 512;
  const { canvas: c, ctx: c2 } = makeCanvas(S);
  const { canvas: h, ctx: h2 } = makeCanvas(S);
  const rand = rng(seed);
  boundedNoise(c2, S, base, seed, [
    { r: 60, n: 40, amp: 9 },
    { r: 14, n: 260, amp: 10 },
  ]);
  noiseFill(h2, S, { base: '#8a8a8a', octaves: 4, alpha: 0.05, seed: seed + 1 });
  drips(c2, S, rand, 10, '45,42,38', 0.35);
  stains(c2, S, rand, 6, '60,55,48', 0.35);
  speckle(c2, S, rand, 700, 0.6, 2.2, ['#6e6a60', '#a09a8e', '#4a463f'], 0.4);
  speckle(h2, S, rand, 700, 0.6, 2.2, ['#5a5a5a', '#b8b8b8'], 0.5);
  const rc = roughCanvas(S, '#e9e9e9', seed + 2, 4, '185,185,185', 0.35);
  return std(c, h, { normalStrength: 1.15, roughness: 0.95, roughCanvasIn: rc });
}

// Weathered fountain/planter/bench concrete. Base #88766e (warm pinkish
// grey, r>g>b): the scene's sky ambient/env light is measurably green-cyan
// on these surfaces (rendered-vs-albedo per-channel ratio ~(1.0,1.08,1.06)
// lit and ~(1.0,1.20,1.24) in shade), so a near-neutral albedo — the old
// #6b6862, and even the mildly warm #7e7769 — always rendered with a minty
// green cast. The pink-leaning bias is sized to cancel that and land the
// RENDERED wall in the weathered warm-grey #8a877e family. The near-white
// roughness map + envMapIntensity cut kill the sky-colored specular that
// carried the rest of the green (old rc #d6d6d6 at roughness 0.85 left
// ~0.7 effective roughness — real sky gloss). Value stays below the
// clipped-styrofoam range measured on the original #8a877e flat base.
// Heavy vertical grime streaking baked in (the standalone rim-streak and
// waterline decals are separate materials below).
function fountainConcMat() {
  const S = 512;
  const { canvas: c, ctx: c2 } = makeCanvas(S);
  const { canvas: h, ctx: h2 } = makeCanvas(S);
  const rand = rng(353);
  boundedNoise(c2, S, '#88766e', 353, [
    { r: 70, n: 36, amp: 8 },
    { r: 16, n: 240, amp: 9 },
  ]);
  noiseFill(h2, S, { base: '#8a8a8a', octaves: 4, alpha: 0.05, seed: 354 });
  drips(c2, S, rand, 24, '48,42,37', 0.5);
  stains(c2, S, rand, 6, '56,49,43', 0.32);
  speckle(c2, S, rand, 650, 0.6, 2.2, ['#706057', '#9c8880', '#5c4c44'], 0.4);
  speckle(h2, S, rand, 650, 0.6, 2.2, ['#5a5a5a', '#b8b8b8'], 0.5);
  const rc = roughCanvas(S, '#f2f2f2', 355, 3, '200,200,200', 0.25);
  const mat = std(c, h, { normalStrength: 1.15, roughness: 0.96, roughCanvasIn: rc });
  mat.envMapIntensity = 0.45;
  return mat;
}

/** Vertical grime-streak decal (under rims / sills). Strong at top, fades down. */
function grimeStreakMat() {
  const S = 256;
  const { canvas: c, ctx: c2 } = makeCanvas(S);
  c2.clearRect(0, 0, S, S);
  const rand = rng(357);
  for (let i = 0; i < 30; i++) {
    const x = rand() * S, w = 3 + rand() * 10, hh = S * (0.35 + rand() * 0.6);
    const g = c2.createLinearGradient(0, 0, 0, hh);
    g.addColorStop(0, `rgba(52,49,43,${0.3 + rand() * 0.28})`);
    g.addColorStop(1, 'rgba(52,49,43,0)');
    c2.fillStyle = g;
    c2.fillRect(x, 0, w, hh);
  }
  // continuous seep line right under the rim
  const g = c2.createLinearGradient(0, 0, 0, 26);
  g.addColorStop(0, 'rgba(48,45,40,0.4)');
  g.addColorStop(1, 'rgba(48,45,40,0)');
  c2.fillStyle = g;
  c2.fillRect(0, 0, S, 26);
  return decalMat(c, { roughness: 0.98, offset: -2 });
}

/** Waterline stain band for the fountain basin interior: pale mineral scale
 *  line at the old water level, dark damp stain fading below it. */
function waterlineMat() {
  const S = 128;
  const { canvas: c, ctx: c2 } = makeCanvas(S);
  c2.clearRect(0, 0, S, S);
  const rand = rng(359);
  c2.fillStyle = 'rgba(186,182,168,0.4)'; // mineral scale line
  c2.fillRect(0, 8, S, 4);
  const g = c2.createLinearGradient(0, 12, 0, 96);
  g.addColorStop(0, 'rgba(40,42,37,0.5)');
  g.addColorStop(1, 'rgba(40,42,37,0)');
  c2.fillStyle = g;
  c2.fillRect(0, 12, S, 84);
  // algae blotches in the damp zone
  for (let i = 0; i < 26; i++) {
    c2.fillStyle = `rgba(44,52,38,${0.12 + rand() * 0.2})`;
    c2.beginPath();
    c2.arc(rand() * S, 16 + rand() * 60, 3 + rand() * 9, 0, Math.PI * 2);
    c2.fill();
  }
  return decalMat(c, { roughness: 0.85, offset: -2 });
}

// Sidewalk concrete: albedo #9a978f, tile = 3 m so the 256 px cells are
// 1.5 m expansion-joint bays (per art direction). Joints are dark saw cuts
// with a real groove in the height map; slab value jitters per bay.
function sidewalkMat() {
  const S = 512, cell = 256;
  const { canvas: c, ctx: c2 } = makeCanvas(S);
  const { canvas: h, ctx: h2 } = makeCanvas(S);
  const rand = rng(404);
  c2.fillStyle = '#75726b'; c2.fillRect(0, 0, S, S); // joint shadow line
  h2.fillStyle = '#565656'; h2.fillRect(0, 0, S, S); // joint groove
  for (let y = 0; y < S; y += cell) {
    for (let x = 0; x < S; x += cell) {
      const t = -7 + Math.floor(rand() * 15);
      c2.fillStyle = `rgb(${154 + t},${151 + t},${143 + t})`; // #9a978f +- jitter
      c2.fillRect(x + 3, y + 3, cell - 6, cell - 6);
      const l = 148 + Math.floor(rand() * 14);
      h2.fillStyle = `rgb(${l},${l},${l})`;
      h2.fillRect(x + 3, y + 3, cell - 6, cell - 6);
    }
  }
  speckle(c2, S, rand, 800, 0.5, 1.8, ['#8b8880', '#a5a29a', '#807d75'], 0.3);
  stains(c2, S, rand, 5, '70,66,60', 0.24);
  return std(c, h, { normalStrength: 1.1, roughness: 0.9 });
}

// Brick: 512 px tile = 1.28 m, so 4 px = 1 cm. Course = 25.6 px = 6.5 cm
// (15.4 courses/m), brick face ~81x21.6 px = ~20x5.5 cm + 1 cm mortar joint
// => one brick reads ~21x6.5 cm (standard modular, per art direction — the
// old 8 cm course made bricks read as cinder blocks). Exact-fit grid: 6
// bricks x 20 courses per tile, so the pattern wraps seam-free. Per-brick hue
// jitter +-6% on the 6-tone palette, 10% randomly darkened bricks,
// recessed-mortar normal map with rough mortar texture.
function brickMat() {
  const S = 512, bw = S / 6, bh = S / 20, m = 4;
  const { canvas: c, ctx: c2 } = makeCanvas(S);
  const { canvas: h, ctx: h2 } = makeCanvas(S);
  const rand = rng(606);
  c2.fillStyle = '#6a6259'; c2.fillRect(0, 0, S, S); // mortar
  h2.fillStyle = '#2e2e2e'; h2.fillRect(0, 0, S, S); // deep mortar joints
  // rough mortar surface (fine noise inside the joints)
  const mr = rng(608);
  for (let i = 0; i < 2600; i++) {
    const l = 30 + Math.floor(mr() * 40);
    h2.fillStyle = `rgba(${l},${l},${l},0.6)`;
    h2.fillRect(mr() * S, mr() * S, 2, 2);
  }
  const tones = ['#8d4c3a', '#a05a42', '#96513c', '#7d4434', '#a86449', '#874838'];
  for (let row = 0; row * bh < S + bh; row++) {
    const off = (row % 2) ? -bw / 2 : 0;
    for (let col = 0; col * bw < S + bw; col++) {
      const bx = col * bw + off + m / 2, by = row * bh + m / 2;
      const bwi = bw - m, bhi = bh - m;
      // +-6% hue jitter (r/b counter-rotate) + small lightness jitter per brick
      const [tr, tg, tb] = hexRgb(tones[Math.floor(rand() * tones.length)]);
      const hj = (rand() - 0.5) * 0.12;
      const lj = 1 + (rand() - 0.5) * 0.14;
      c2.fillStyle = `rgb(${c255(tr * (1 + hj) * lj)},${c255(tg * lj)},${c255(tb * (1 - hj) * lj)})`;
      c2.fillRect(bx, by, bwi, bhi);
      if (rand() < 0.10) { // 10% darkened bricks
        c2.fillStyle = 'rgba(24,19,17,0.5)';
        c2.fillRect(bx, by, bwi, bhi);
      }
      const l = 176 + Math.floor(rand() * 22); // proud faces => crisp joint normals
      h2.fillStyle = `rgb(${l},${l},${l})`;
      h2.fillRect(bx, by, bwi, bhi);
      // slight per-brick surface undulation
      h2.fillStyle = `rgba(${140 + Math.floor(rand() * 60)},${140 + Math.floor(rand() * 60)},${140 + Math.floor(rand() * 60)},0.25)`;
      h2.fillRect(bx + 2 + rand() * Math.max(2, bwi - 20), by + 2, 12 + rand() * 20, Math.max(2, bhi - 4));
      // per-brick AO: shadowed bottom + left edge, lit top edge
      c2.fillStyle = 'rgba(0,0,0,0.20)';
      c2.fillRect(bx, by + bhi - 1.5, bwi, 1.5);
      c2.fillRect(bx, by, 1.5, bhi);
      c2.fillStyle = 'rgba(255,255,255,0.06)';
      c2.fillRect(bx, by, bwi, 1);
    }
  }
  // mortar-line AO along every course
  c2.globalAlpha = 0.3;
  c2.fillStyle = '#3c3630';
  for (let row = 0; row * bh < S + bh; row++) c2.fillRect(0, row * bh - 1, S, 2);
  c2.globalAlpha = 1;
  const nf = rng(607);
  speckle(c2, S, nf, 500, 0.5, 1.4, ['#3a2c26', '#a8705c'], 0.2);
  drips(c2, S, nf, 6, '35,28,24', 0.25);
  stains(c2, S, nf, 4, '25,20,18', 0.25);
  return std(c, h, { normalStrength: 1.6, roughness: 0.94 });
}

/** Corner-chip decal atlas (2x2): spalled render/paint revealing substrate,
 *  with a shadowed break edge. Placed near building corners. */
function chipDecalMat() {
  const S = 256, C = 128;
  const { canvas: c, ctx: c2 } = makeCanvas(S);
  c2.clearRect(0, 0, S, S);
  const rand = rng(611);
  for (let cell = 0; cell < 4; cell++) {
    const x0 = (cell % 2) * C + C / 2, y0 = Math.floor(cell / 2) * C + C / 2;
    const nPts = 7 + Math.floor(rand() * 4);
    const pts = [];
    for (let i = 0; i < nPts; i++) {
      const a = (i / nPts) * Math.PI * 2;
      const r = C * (0.18 + rand() * 0.22);
      pts.push([x0 + Math.cos(a) * r, y0 + Math.sin(a) * r * (0.7 + rand() * 0.5)]);
    }
    // exposed substrate
    c2.beginPath();
    c2.moveTo(pts[0][0], pts[0][1]);
    for (const [px, py] of pts.slice(1)) c2.lineTo(px, py);
    c2.closePath();
    c2.fillStyle = `rgba(${150 + Math.floor(rand() * 20)},${144 + Math.floor(rand() * 18)},${132 + Math.floor(rand() * 16)},0.9)`;
    c2.fill();
    // shadowed break edge (bottom-left half of the outline)
    c2.strokeStyle = 'rgba(30,27,23,0.75)';
    c2.lineWidth = 3;
    c2.beginPath();
    const half = Math.floor(nPts / 2);
    c2.moveTo(pts[half][0], pts[half][1]);
    for (let i = half + 1; i <= nPts; i++) {
      const [px, py] = pts[i % nPts];
      c2.lineTo(px, py);
    }
    c2.stroke();
    // pitting inside the chip
    for (let i = 0; i < 10; i++) {
      c2.fillStyle = `rgba(70,64,56,${0.2 + rand() * 0.3})`;
      c2.beginPath();
      c2.arc(x0 + (rand() - 0.5) * C * 0.4, y0 + (rand() - 0.5) * C * 0.4, 1 + rand() * 4, 0, Math.PI * 2);
      c2.fill();
    }
  }
  return decalMat(c, { roughness: 0.95, offset: -2 });
}

function corrugatedMat() {
  const S = 512, ridges = 16;
  const { canvas: c, ctx: c2 } = makeCanvas(S);
  const { canvas: h, ctx: h2 } = makeCanvas(S);
  const rand = rng(707);
  for (let x = 0; x < S; x++) {
    const t = Math.sin((x / S) * Math.PI * 2 * ridges);
    const lc = 148 + t * 26;
    c2.fillStyle = `rgb(${lc},${lc + 2},${lc + 4})`;
    c2.fillRect(x, 0, 1, S);
    const lh = 128 + t * 78;
    h2.fillStyle = `rgb(${lh},${lh},${lh})`;
    h2.fillRect(x, 0, 1, S);
  }
  drips(c2, S, rand, 14, '120,62,30', 0.5); // rust streaks
  stains(c2, S, rand, 6, '110,58,28', 0.4);
  speckle(c2, S, rand, 350, 0.5, 1.6, ['#5a4a40', '#c8ccce', '#7c5030'], 0.35);
  const rc = roughCanvas(S, '#b4b4b4', 708, 6, '230,230,230', 0.5);
  return std(c, h, { normalStrength: 2.1, roughness: 0.62, metalness: 0.55, roughCanvasIn: rc });
}

function rustMat() {
  const S = 512;
  const { canvas: c, ctx: c2 } = makeCanvas(S);
  const { canvas: h, ctx: h2 } = makeCanvas(S);
  const rand = rng(808);
  noiseFill(c2, S, { base: '#6e4126', octaves: 5, alpha: 0.1, seed: 808 });
  noiseFill(h2, S, { base: '#828282', octaves: 4, alpha: 0.08, seed: 809 });
  stains(c2, S, rand, 10, '138,90,46', 0.5);
  stains(c2, S, rand, 8, '52,32,20', 0.5);
  speckle(c2, S, rand, 900, 0.6, 2.4, ['#4a2c18', '#8a5a2e', '#2e1c10', '#9c6a38'], 0.4);
  speckle(h2, S, rand, 900, 0.6, 2.4, ['#4a4a4a', '#b0b0b0'], 0.45);
  drips(c2, S, rand, 10, '40,26,16', 0.4);
  const rc = roughCanvas(S, '#dedede', 810, 5, '180,180,180', 0.4);
  return std(c, h, { normalStrength: 1.1, roughness: 0.88, metalness: 0.3, roughCanvasIn: rc });
}

// Burned vehicle sheet metal: charred base + deep door/panel seams + grime.
function charredMat() {
  const S = 512;
  const { canvas: c, ctx: c2 } = makeCanvas(S);
  const { canvas: h, ctx: h2 } = makeCanvas(S);
  const rand = rng(909);
  noiseFill(c2, S, { base: '#1e1b19', octaves: 5, alpha: 0.07, seed: 909 });
  noiseFill(h2, S, { base: '#808080', octaves: 3, alpha: 0.16, seed: 910 }); // beaten metal
  stains(c2, S, rand, 8, '90,58,34', 0.3);  // scorch-edge rust
  stains(c2, S, rand, 6, '8,7,6', 0.55);
  // door/panel seams (tile = 2.2 m => seams every ~0.6-0.8 m): strong dark
  // groove in the normal map + a lit lip beside it so seams catch light
  c2.strokeStyle = 'rgba(8,8,9,0.75)';
  c2.lineWidth = 3;
  h2.lineWidth = 5;
  for (const fx of [0.24, 0.52, 0.78]) {
    const x = fx * S + (rand() - 0.5) * 14;
    c2.beginPath(); c2.moveTo(x, 0); c2.lineTo(x, S); c2.stroke();
    h2.strokeStyle = '#1c1c1c';
    h2.beginPath(); h2.moveTo(x, 0); h2.lineTo(x, S); h2.stroke();
    h2.strokeStyle = '#b8b8b8';
    h2.lineWidth = 2;
    h2.beginPath(); h2.moveTo(x + 4, 0); h2.lineTo(x + 4, S); h2.stroke();
    h2.lineWidth = 5;
  }
  const sy = 0.58 * S;
  c2.beginPath(); c2.moveTo(0, sy); c2.lineTo(S, sy); c2.stroke();
  h2.strokeStyle = '#1c1c1c';
  h2.beginPath(); h2.moveTo(0, sy); h2.lineTo(S, sy); h2.stroke();
  // door handles beside the middle seam
  c2.fillStyle = 'rgba(60,58,55,0.85)';
  c2.fillRect(0.52 * S + 10, 0.42 * S, 26, 7);
  h2.fillStyle = '#d0d0d0';
  h2.fillRect(0.52 * S + 10, 0.42 * S, 26, 7);
  // grime pass
  stains(c2, S, rand, 6, '14,12,10', 0.4);
  speckle(c2, S, rand, 500, 0.5, 2, ['#3a3430', '#0c0b0a', '#57443a'], 0.4);
  const rc = roughCanvas(S, '#d2d2d2', 911, 6, '120,120,120', 0.5);
  return std(c, h, { normalStrength: 2.5, roughness: 0.82, metalness: 0.35, roughCanvasIn: rc });
}

// Sandbag burlap with cloth-fold normals: weave + diagonal wrinkles and
// cinched-top creases baked into the height map.
function sandbagMat() {
  const S = 256;
  const { canvas: c, ctx: c2 } = makeCanvas(S);
  const { canvas: h, ctx: h2 } = makeCanvas(S);
  const rand = rng(111);
  noiseFill(c2, S, { base: '#877a58', octaves: 4, alpha: 0.07, seed: 111 });
  noiseFill(h2, S, { base: '#888888', octaves: 3, alpha: 0.05, seed: 112 });
  c2.globalAlpha = 0.14; h2.globalAlpha = 0.55;
  for (let y = 0; y < S; y += 5) { // weave
    c2.fillStyle = (y % 10 === 0) ? '#5d5340' : '#9a8c66';
    c2.fillRect(0, y, S, 2);
    h2.fillStyle = (y % 10 === 0) ? '#4a4a4a' : '#b8b8b8';
    h2.fillRect(0, y, S, 2);
  }
  c2.globalAlpha = 1; h2.globalAlpha = 1;
  // cloth folds: curved wrinkle strokes (dark crease + light ridge pairs)
  h2.lineCap = 'round';
  for (let i = 0; i < 16; i++) {
    const x = rand() * S, y = rand() * S;
    const a = rand() * Math.PI, len = 40 + rand() * 90;
    const bend = (rand() - 0.5) * 60;
    const ex = x + Math.cos(a) * len, ey = y + Math.sin(a) * len;
    const mx = (x + ex) / 2 - Math.sin(a) * bend, my = (y + ey) / 2 + Math.cos(a) * bend;
    h2.strokeStyle = 'rgba(58,58,58,0.6)';
    h2.lineWidth = 4 + rand() * 4;
    h2.beginPath(); h2.moveTo(x, y); h2.quadraticCurveTo(mx, my, ex, ey); h2.stroke();
    h2.strokeStyle = 'rgba(200,200,200,0.5)';
    h2.lineWidth = 2 + rand() * 2;
    h2.beginPath(); h2.moveTo(x + 3, y + 3); h2.quadraticCurveTo(mx + 3, my + 3, ex + 3, ey + 3); h2.stroke();
    // faint albedo shading along the crease
    c2.strokeStyle = 'rgba(70,62,44,0.18)';
    c2.lineWidth = 5;
    c2.beginPath(); c2.moveTo(x, y); c2.quadraticCurveTo(mx, my, ex, ey); c2.stroke();
  }
  stains(c2, S, rand, 4, '50,44,32', 0.35);
  return std(c, h, { normalStrength: 2.2, roughness: 0.98 });
}

function woodMat() {
  const S = 512, plank = 128;
  const { canvas: c, ctx: c2 } = makeCanvas(S);
  const { canvas: h, ctx: h2 } = makeCanvas(S);
  const rand = rng(121);
  for (let x = 0; x < S; x += plank) {
    const t = 128 + Math.floor(rand() * 46);
    c2.fillStyle = `rgb(${t},${Math.floor(t * 0.78)},${Math.floor(t * 0.52)})`;
    c2.fillRect(x, 0, plank, S);
    const l = 150 + Math.floor(rand() * 40);
    h2.fillStyle = `rgb(${l},${l},${l})`;
    h2.fillRect(x, 0, plank, S);
    c2.fillStyle = 'rgba(40,30,20,0.9)'; c2.fillRect(x, 0, 3, S);
    h2.fillStyle = '#252525'; h2.fillRect(x, 0, 4, S);
    // grain
    c2.strokeStyle = 'rgba(70,50,30,0.35)'; c2.lineWidth = 1.5;
    h2.strokeStyle = 'rgba(90,90,90,0.6)'; h2.lineWidth = 2;
    for (let gLine = 0; gLine < 7; gLine++) {
      const gx = x + 8 + rand() * (plank - 16);
      c2.beginPath(); h2.beginPath();
      c2.moveTo(gx, 0); h2.moveTo(gx, 0);
      for (let y = 0; y <= S; y += 64) {
        const wob = gx + Math.sin(y * 0.02 + rand() * 6) * 5;
        c2.lineTo(wob, y); h2.lineTo(wob, y);
      }
      c2.stroke(); h2.stroke();
    }
  }
  speckle(c2, S, rand, 90, 1, 2.4, ['#2e2118', '#6a4c30'], 0.6); // nails/knots
  stains(c2, S, rand, 5, '40,30,22', 0.4);
  return std(c, h, { normalStrength: 1.2, roughness: 0.95 });
}

function paperMat() {
  const S = 128;
  const { canvas: c, ctx: c2 } = makeCanvas(S);
  // desaturated street paper (#b8b4a8): white litter quads bloomed into
  // confetti at midday — this must never read brighter than the sidewalk
  c2.fillStyle = '#b8b4a8'; c2.fillRect(0, 0, S, S);
  const rand = rng(131);
  c2.fillStyle = 'rgba(60,60,72,0.55)';
  for (let y = 18; y < 116; y += 9) c2.fillRect(12, y, 70 + rand() * 34, 2);
  const g = c2.createLinearGradient(0, 0, S, S);
  g.addColorStop(0, 'rgba(120,110,95,0.26)');
  g.addColorStop(0.5, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(110,100,88,0.34)');
  c2.fillStyle = g; c2.fillRect(0, 0, S, S);
  return new THREE.MeshStandardMaterial({
    map: canvasTexture(c), roughness: 0.95, metalness: 0, side: THREE.DoubleSide,
  });
}

/** Flattened trash / cardboard card, tinted per instance. */
function trashMat() {
  const S = 128;
  const { canvas: c, ctx: c2 } = makeCanvas(S);
  const rand = rng(133);
  c2.fillStyle = '#b4aea0'; c2.fillRect(0, 0, S, S);
  const g = c2.createLinearGradient(0, 0, S, S);
  g.addColorStop(0, 'rgba(90,82,70,0.28)');
  g.addColorStop(0.5, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(80,74,62,0.34)');
  c2.fillStyle = g; c2.fillRect(0, 0, S, S);
  c2.strokeStyle = 'rgba(95,88,76,0.45)';
  c2.lineWidth = 2;
  for (let i = 0; i < 9; i++) { // crease lines
    c2.beginPath();
    c2.moveTo(rand() * S, rand() * S);
    c2.lineTo(rand() * S, rand() * S);
    c2.stroke();
  }
  stains(c2, S, rand, 3, '60,54,44', 0.35);
  c2.strokeStyle = 'rgba(70,64,55,0.4)';
  c2.lineWidth = 5;
  c2.strokeRect(2, 2, S - 4, S - 4);
  return new THREE.MeshStandardMaterial({
    map: canvasTexture(c), roughness: 0.92, metalness: 0, side: THREE.DoubleSide,
  });
}

// Jersey-barrier concrete with chipped hazard paint: faded orange/white paint
// remnants eroded on their own layer (so chips reveal concrete, not holes).
// Base #605d56 (rendered ~#a3a09a target), roughness 0.85, vertexColors ON:
// buildBarriers bakes a top-down grime gradient into the instanced geometry.
function barrierMat() {
  const S = 512;
  const { canvas: c, ctx: c2 } = makeCanvas(S);
  const { canvas: h, ctx: h2 } = makeCanvas(S);
  const rand = rng(363);
  // warm-grey base (r>g>b) — near-neutral concrete picked up a green-cyan
  // cast from the cool sky ambient/env on upward faces (see fountainConcMat)
  boundedNoise(c2, S, '#75635a', 363, [
    { r: 60, n: 36, amp: 9 },
    { r: 14, n: 220, amp: 10 },
  ]);
  noiseFill(h2, S, { base: '#8a8a8a', octaves: 4, alpha: 0.05, seed: 364 });
  // paint remnants on an offscreen layer, then heavily chipped
  const { canvas: p, ctx: p2 } = makeCanvas(S);
  p2.clearRect(0, 0, S, S);
  for (let i = 0; i < 9; i++) {
    const orange = rand() < 0.65;
    p2.fillStyle = orange ? 'rgba(138,76,28,0.8)' : 'rgba(158,152,138,0.8)';
    const x = rand() * S, y = rand() * S, w = 60 + rand() * 150, ht = 30 + rand() * 60;
    p2.beginPath();
    if (p2.roundRect) p2.roundRect(x, y, w, ht, 10);
    else p2.rect(x, y, w, ht);
    p2.fill();
  }
  p2.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 700; i++) { // chip the paint down to ~40% coverage
    p2.globalAlpha = 0.4 + rand() * 0.6;
    p2.beginPath();
    p2.arc(rand() * S, rand() * S, 2 + rand() * 12, 0, Math.PI * 2);
    p2.fill();
  }
  p2.globalCompositeOperation = 'source-over';
  p2.globalAlpha = 1;
  c2.drawImage(p, 0, 0);
  // grime settles into the recesses + tire scuffs near the base
  drips(c2, S, rand, 8, '40,37,33', 0.35);
  stains(c2, S, rand, 5, '28,26,23', 0.3);
  speckle(c2, S, rand, 500, 0.6, 2.0, ['#504d46', '#726f66', '#3f3c35'], 0.4);
  speckle(h2, S, rand, 500, 0.6, 2.0, ['#5a5a5a', '#b8b8b8'], 0.5);
  const rc = roughCanvas(S, '#eeeeee', 365, 4, '195,195,195', 0.3);
  const mat = std(c, h, { normalStrength: 1.2, roughness: 0.95, roughCanvasIn: rc });
  mat.envMapIntensity = 0.5;
  mat.vertexColors = true;
  return mat;
}

// Municipal dumpster: chipped green paint over steel, rust drips from seams.
function dumpsterMat() {
  const S = 256;
  const { canvas: c, ctx: c2 } = makeCanvas(S);
  const { canvas: h, ctx: h2 } = makeCanvas(S);
  const rand = rng(367);
  boundedNoise(c2, S, '#3d5040', 367, [
    { r: 40, n: 24, amp: 10 },
    { r: 9, n: 140, amp: 12 },
  ]);
  noiseFill(h2, S, { base: '#828282', octaves: 3, alpha: 0.12, seed: 368 }); // dents
  // horizontal stiffener ribs
  for (const fy of [0.3, 0.62]) {
    const y = fy * S;
    c2.fillStyle = 'rgba(20,26,21,0.45)';
    c2.fillRect(0, y, S, 4);
    h2.fillStyle = '#c8c8c8';
    h2.fillRect(0, y - 5, S, 5);
    h2.fillStyle = '#3a3a3a';
    h2.fillRect(0, y, S, 4);
  }
  // paint chips down to bare/rusty steel
  for (let i = 0; i < 70; i++) {
    const bare = rand() < 0.5;
    c2.fillStyle = bare
      ? `rgba(${118 + Math.floor(rand() * 26)},${112 + Math.floor(rand() * 22)},${102 + Math.floor(rand() * 20)},0.85)`
      : `rgba(${96 + Math.floor(rand() * 30)},${58 + Math.floor(rand() * 18)},${28 + Math.floor(rand() * 12)},0.85)`;
    c2.beginPath();
    c2.arc(rand() * S, rand() * S, 1.5 + rand() * 5, 0, Math.PI * 2);
    c2.fill();
  }
  drips(c2, S, rand, 12, '104,60,28', 0.5); // rust streaks
  stains(c2, S, rand, 4, '18,20,17', 0.4);
  const rc = roughCanvas(S, '#c4c4c4', 369, 4, '190,190,190', 0.4);
  return std(c, h, { normalStrength: 1.6, roughness: 0.68, metalness: 0.35, roughCanvasIn: rc });
}

// Worn lane paint: albedo per directive, ~60% of the stripe eroded away.
function paintMat(color) {
  const S = 256;
  const { canvas: c, ctx: c2 } = makeCanvas(S);
  const rand = rng(141);
  c2.fillStyle = color; c2.fillRect(0, 0, S, S);
  c2.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 900; i++) { // heavy erosion (~60% of area drops below cutout)
    c2.globalAlpha = 0.35 + rand() * 0.6;
    c2.beginPath();
    c2.arc(rand() * S, rand() * S, 1 + rand() * 8, 0, Math.PI * 2);
    c2.fill();
  }
  c2.globalCompositeOperation = 'source-over';
  c2.globalAlpha = 1;
  const tex = canvasTexture(c);
  return new THREE.MeshStandardMaterial({
    map: tex, transparent: true, alphaTest: 0.45, roughness: 0.85, metalness: 0,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
  });
}

function craterMat() {
  const S = 256;
  const { canvas: c, ctx: c2 } = makeCanvas(S);
  const rand = rng(151);
  c2.clearRect(0, 0, S, S);
  const g = c2.createRadialGradient(S / 2, S / 2, 8, S / 2, S / 2, S / 2 - 4);
  g.addColorStop(0, 'rgba(10,8,6,0.92)');
  g.addColorStop(0.55, 'rgba(16,13,10,0.6)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  c2.fillStyle = g;
  c2.beginPath(); c2.arc(S / 2, S / 2, S / 2 - 4, 0, Math.PI * 2); c2.fill();
  c2.fillStyle = 'rgba(5,4,3,0.5)';
  for (let i = 0; i < 60; i++) { // debris shadow blobs
    const a = rand() * Math.PI * 2, r = rand() * S * 0.42;
    c2.beginPath();
    c2.arc(S / 2 + Math.cos(a) * r, S / 2 + Math.sin(a) * r, 2 + rand() * 8, 0, Math.PI * 2);
    c2.fill();
  }
  const tex = canvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  return new THREE.MeshStandardMaterial({
    map: tex, transparent: true, depthWrite: false, roughness: 1, metalness: 0,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
}

/** Sparse branching crack decal atlas: 2x2 variants on one 512 canvas. */
function crackDecalMat() {
  const S = 512, C = 256;
  const { canvas: c, ctx: c2 } = makeCanvas(S);
  const rand = rng(191);
  c2.lineCap = 'round';
  c2.lineJoin = 'round';
  for (let cell = 0; cell < 4; cell++) {
    const x0 = (cell % 2) * C, y0 = Math.floor(cell / 2) * C;
    const stack = [[x0 + C * (0.2 + rand() * 0.25), y0 + C * (0.2 + rand() * 0.25), rand() * Math.PI * 2, 3.4]];
    while (stack.length) {
      let [px, py, ang, w] = stack.pop();
      const n = 6 + Math.floor(rand() * 6);
      for (let i = 0; i < n && w > 0.5; i++) {
        ang += (rand() - 0.5) * 0.9;
        const len = 8 + rand() * 20;
        const nx = px + Math.cos(ang) * len;
        const ny = py + Math.sin(ang) * len;
        if (nx < x0 + 8 || nx > x0 + C - 8 || ny < y0 + 8 || ny > y0 + C - 8) break;
        c2.strokeStyle = `rgba(16,15,13,${0.35 + w * 0.12})`;
        c2.lineWidth = w;
        c2.beginPath();
        c2.moveTo(px, py);
        c2.lineTo(nx, ny);
        c2.stroke();
        if (rand() < 0.28 && w > 1.2) {
          stack.push([nx, ny, ang + (rand() < 0.5 ? 1 : -1) * (0.6 + rand() * 0.7), w * 0.5]);
        }
        px = nx; py = ny; w *= 0.88;
      }
    }
  }
  return decalMat(c, { roughness: 1, offset: -2 });
}

/** Oil-stain ellipse decal (scaled anisotropically per placement). */
function oilDecalMat() {
  const S = 128;
  const { canvas: c, ctx: c2 } = makeCanvas(S);
  const rand = rng(193);
  const g = c2.createRadialGradient(S / 2, S / 2, 5, S / 2, S / 2, S / 2 - 4);
  g.addColorStop(0, 'rgba(10,9,8,0.8)');
  g.addColorStop(0.55, 'rgba(15,13,11,0.42)');
  g.addColorStop(1, 'rgba(18,16,12,0)');
  c2.fillStyle = g;
  c2.beginPath(); c2.arc(S / 2, S / 2, S / 2 - 4, 0, Math.PI * 2); c2.fill();
  c2.fillStyle = 'rgba(12,11,9,0.5)';
  for (let i = 0; i < 9; i++) { // satellite droplets
    const a = rand() * Math.PI * 2, r = S * (0.28 + rand() * 0.2);
    c2.beginPath();
    c2.arc(S / 2 + Math.cos(a) * r, S / 2 + Math.sin(a) * r, 1.5 + rand() * 4, 0, Math.PI * 2);
    c2.fill();
  }
  return decalMat(c, { roughness: 0.35, offset: -2 }); // oily sheen
}

/** Twin tire-track arc decal: tracks run along texture V, faded ends. */
function tireDecalMat() {
  const S = 256;
  const { canvas: c, ctx: c2 } = makeCanvas(S);
  c2.lineCap = 'round';
  const grad = c2.createLinearGradient(0, 0, 0, S);
  grad.addColorStop(0, 'rgba(16,15,14,0)');
  grad.addColorStop(0.22, 'rgba(16,15,14,0.42)');
  grad.addColorStop(0.78, 'rgba(16,15,14,0.42)');
  grad.addColorStop(1, 'rgba(16,15,14,0)');
  for (const xc of [88, 168]) {
    c2.strokeStyle = grad;
    c2.lineWidth = 16;
    c2.beginPath();
    c2.moveTo(xc - 16, -8);
    c2.quadraticCurveTo(xc + 22, S * 0.5, xc - 16, S + 8);
    c2.stroke();
    c2.setLineDash([5, 5]); // tread breakup
    c2.strokeStyle = 'rgba(30,29,27,0.3)';
    c2.lineWidth = 9;
    c2.stroke();
    c2.setLineDash([]);
  }
  return decalMat(c, { roughness: 0.95, offset: -2 });
}

/** Soft dust/dirt contact splat under debris. */
function dustDecalMat() {
  const S = 128;
  const { canvas: c, ctx: c2 } = makeCanvas(S);
  const rand = rng(197);
  const g = c2.createRadialGradient(S / 2, S / 2, 4, S / 2, S / 2, S / 2 - 2);
  g.addColorStop(0, 'rgba(128,122,110,0.5)');
  g.addColorStop(0.55, 'rgba(120,114,102,0.26)');
  g.addColorStop(1, 'rgba(115,110,98,0)');
  c2.fillStyle = g;
  c2.beginPath(); c2.arc(S / 2, S / 2, S / 2 - 2, 0, Math.PI * 2); c2.fill();
  c2.globalCompositeOperation = 'destination-out'; // break up the disc
  for (let i = 0; i < 40; i++) {
    c2.globalAlpha = 0.2 + rand() * 0.3;
    c2.beginPath();
    c2.arc(rand() * S, rand() * S, 2 + rand() * 6, 0, Math.PI * 2);
    c2.fill();
  }
  c2.globalCompositeOperation = 'source-over';
  c2.globalAlpha = 1;
  return decalMat(c, { roughness: 1, offset: -2 });
}

// Per-window variation atlas: 4x4 cells. Glass tint #1a222c with a baked sky
// gradient so panes never read as flat black voids; blind/curtain variants;
// FOUR cells (25% of windows) are dim interior cards — a warm, faintly
// emissive room read (ceiling line, back wall, furniture silhouettes) so
// facades read inhabited without turning into a night scene. The material is
// DIELECTRIC glass (metalness 0.25, roughness 0.08, envMapIntensity 1.6):
// the env/sun specular stays sky-colored instead of being multiplied to
// black by a metal albedo — that multiplication was the flat-black-void bug.
// Emissive is driven by a separate map that is black everywhere except the
// interior cells, kept dim for the midday scene.
function windowMat() {
  const S = 256, C = 64;
  const { canvas: c, ctx: c2 } = makeCanvas(S);
  const { canvas: e, ctx: e2 } = makeCanvas(S);
  e2.fillStyle = '#000000'; e2.fillRect(0, 0, S, S);
  const rand = rng(181);
  // g: glass, b: full blinds, h: half blinds, u: side curtains, i: interior card
  const kinds = ['g', 'i', 'b', 'g', 'u', 'g', 'h', 'i', 'g', 'i', 'g', 'b', 'h', 'g', 'i', 'g'];
  const slats = (gx, gy, gw, hgt, tint) => {
    for (let yy = gy; yy < gy + hgt - 2; yy += 5) {
      const b = (Math.floor(yy / 5) % 2) ? [52, 50, 46] : [66, 62, 56];
      c2.fillStyle = `rgb(${c255(b[0] * tint)},${c255(b[1] * tint)},${c255(b[2] * tint)})`;
      c2.fillRect(gx, yy, gw, 3);
    }
  };
  kinds.forEach((k, n) => {
    const x0 = (n % 4) * C, y0 = Math.floor(n / 4) * C;
    c2.fillStyle = '#1c1b1e'; c2.fillRect(x0, y0, C, C); // sash border
    const gx = x0 + 4, gy = y0 + 4, gw = C - 8, gh = C - 8;
    const gr = c2.createLinearGradient(0, gy, 0, gy + gh); // sky-reflection gradient
    gr.addColorStop(0, '#33404e');
    gr.addColorStop(0.45, '#1a222c');
    gr.addColorStop(1, '#121820');
    c2.fillStyle = gr; c2.fillRect(gx, gy, gw, gh);
    c2.globalAlpha = 0.10 + rand() * 0.08; // diagonal skyline reflection streak
    c2.fillStyle = '#c9d6df';
    c2.beginPath();
    const rx = gx + gw * (0.15 + rand() * 0.3);
    c2.moveTo(rx, gy + gh); c2.lineTo(rx + gw * 0.3, gy);
    c2.lineTo(rx + gw * 0.48, gy); c2.lineTo(rx + gw * 0.18, gy + gh);
    c2.closePath(); c2.fill();
    c2.globalAlpha = 1;
    const tint = 0.9 + rand() * 0.2; // +-10% blind/curtain albedo variation
    if (k === 'b' || k === 'h') {
      const hgt = k === 'b' ? gh : gh * (0.35 + rand() * 0.3);
      slats(gx, gy, gw, hgt, tint);
      c2.fillStyle = `rgb(${c255(48 * tint)},${c255(44 * tint)},${c255(40 * tint)})`;
      c2.fillRect(gx, gy + hgt - 3, gw, 3); // bottom rail
    } else if (k === 'u') {
      const dw = gw * 0.3;
      c2.fillStyle = `rgb(${c255(46 * tint)},${c255(40 * tint)},${c255(33 * tint)})`;
      c2.fillRect(gx, gy, dw, gh);
      c2.fillRect(gx + gw - dw, gy, dw, gh);
      c2.strokeStyle = 'rgba(22,18,14,0.5)'; // fold lines
      c2.lineWidth = 2;
      for (let fx = 5; fx < gw; fx += 7) {
        if (fx > dw && fx < gw - dw) continue;
        c2.beginPath(); c2.moveTo(gx + fx, gy); c2.lineTo(gx + fx, gy + gh); c2.stroke();
      }
    } else if (k === 'i') {
      // dim interior card: warm room seen through glass — ceiling shadow line,
      // back wall gradient, a couple of furniture silhouettes
      const ig = c2.createLinearGradient(0, gy, 0, gy + gh);
      ig.addColorStop(0, '#241d15');
      ig.addColorStop(0.25, '#4a3b28');
      ig.addColorStop(1, '#2c241a');
      c2.fillStyle = ig; c2.fillRect(gx, gy, gw, gh);
      c2.fillStyle = 'rgba(14,11,8,0.85)'; // ceiling line
      c2.fillRect(gx, gy, gw, 6);
      for (let f = 0; f < 2; f++) { // furniture silhouettes
        const fw = 10 + rand() * 16, fh = 12 + rand() * 18;
        c2.fillStyle = `rgba(16,13,10,${0.5 + rand() * 0.3})`;
        c2.fillRect(gx + rand() * (gw - fw), gy + gh - fh, fw, fh);
      }
      // matching dim emissive so the room reads faintly in daylight
      const eg = e2.createLinearGradient(0, gy, 0, gy + gh);
      eg.addColorStop(0, 'rgb(26,20,12)');
      eg.addColorStop(0.3, `rgb(${58 + Math.floor(rand() * 18)},${44 + Math.floor(rand() * 12)},26)`);
      eg.addColorStop(1, 'rgb(30,23,14)');
      e2.fillStyle = eg; e2.fillRect(gx, gy, gw, gh);
      e2.fillStyle = 'rgb(6,5,3)';
      e2.fillRect(gx, gy, gw, 6);
    }
    // mullions (on both albedo and emissive so lit cells stay divided)
    c2.fillStyle = '#191a1d';
    c2.fillRect(x0 + C / 2 - 1, gy, 2, gh);
    c2.fillRect(gx, y0 + C / 2 - 1, gw, 2);
    e2.fillStyle = '#000000';
    e2.fillRect(x0 + C / 2 - 1, gy, 2, gh);
    e2.fillRect(gx, y0 + C / 2 - 1, gw, 2);
  });
  speckle(c2, S, rand, 260, 0.4, 1.2, ['#20201e', '#3a3835'], 0.14); // grime
  return new THREE.MeshStandardMaterial({
    map: canvasTexture(c),
    emissive: new THREE.Color(0xffffff),
    emissiveMap: canvasTexture(e),
    emissiveIntensity: 0.55,
    roughness: 0.08, metalness: 0.25, envMapIntensity: 1.6,
  });
}

function signMat() {
  const S = 1024, ROW = 128;
  const { canvas: c, ctx: c2 } = makeCanvas(S);
  // makeCanvas is square; use top 512 rows of a 1024 canvas as a 1024x512 atlas
  const rand = rng(161);
  const rows = [
    ['HOTEL', '#1d3a5f', '#e8e4d8'],
    ['MARKET', '#7a1f1f', '#f0e6d2'],
    ['AUTO REPAIR', '#c9a227', '#1a1a1a'],
    ['CAFE ROYAL', '#2f5d3a', '#f0ead8'],
  ];
  c2.fillStyle = '#0c0c0c'; c2.fillRect(0, 0, S, S);
  rows.forEach((r, i) => {
    const y = i * ROW;
    c2.fillStyle = r[1]; c2.fillRect(0, y, S, ROW);
    c2.strokeStyle = r[2]; c2.lineWidth = 6;
    c2.strokeRect(12, y + 10, S - 24, ROW - 20);
    c2.fillStyle = r[2];
    c2.font = 'bold 82px Arial, sans-serif';
    c2.textAlign = 'center'; c2.textBaseline = 'middle';
    c2.fillText(r[0], S / 2, y + ROW / 2 + 4);
  });
  // weathering
  speckle(c2, S, rand, 700, 0.6, 2.4, ['#2a2a2a', '#8a8a8a'], 0.2);
  c2.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 260; i++) {
    c2.globalAlpha = 0.5 + rand() * 0.5;
    c2.beginPath();
    c2.arc(rand() * S, rand() * 512, 1 + rand() * 6, 0, Math.PI * 2);
    c2.fill();
  }
  c2.globalCompositeOperation = 'source-over';
  c2.globalAlpha = 1;
  const tex = canvasTexture(c);
  return new THREE.MeshStandardMaterial({
    map: tex, transparent: true, alphaTest: 0.35, roughness: 0.75, metalness: 0.1,
    side: THREE.DoubleSide,
  });
}

// Skyline tower facade: ONE tile = a 4x4-floor block (12.8 m) of 3.2 m floor
// cells: 0.4 m dark spandrel band at each cell bottom + two inset-shaded
// windows per cell (the parallax stand-in for the far rings; the near ring
// gets REAL protruding band geometry in buildSkyline). The per-tower albedo
// (vertex colors) multiplies this near-white map — and is clamped so towers
// NEVER read pure black in daylight (art-direction floor #2c3038). A sparse
// (~12%) emissive window grid + a faint uniform emissive floor keep unlit
// faces readable; the 4-floor tile period keeps lit windows from repeating
// as perfect columns.
function skylineMat() {
  const S = 512, F = 128; // 4x4 floor cells, 3.2 m => 40 px per meter
  const { canvas: c, ctx: c2 } = makeCanvas(S);
  const { canvas: e, ctx: e2 } = makeCanvas(S);
  const rand = rng(171);
  c2.fillStyle = '#eeeef0'; c2.fillRect(0, 0, S, S);
  // faint uniform emissive floor: lifts shadowed facades off pure black
  e2.fillStyle = '#101318'; e2.fillRect(0, 0, S, S);
  for (let cy = 0; cy < 4; cy++) {
    for (let cxi = 0; cxi < 4; cxi++) {
      const ox = cxi * F, oy = cy * F;
      // 0.4 m spandrel band at the cell bottom (canvas-down = world-down, flipY)
      c2.fillStyle = '#33363c';
      c2.fillRect(ox, oy + F - 16, F, 16);
      c2.fillStyle = 'rgba(255,255,255,0.10)'; // top lip catch-light
      c2.fillRect(ox, oy + F - 16, F, 2);
      e2.fillStyle = '#07080a';
      e2.fillRect(ox, oy + F - 16, F, 16);
      // two windows per cell: 2 m tall, piers between
      const winY = oy + 17, winH = 80;
      for (const wxr of [13, 71]) {
        const wx = ox + wxr, wW = 44;
        const g = c2.createLinearGradient(0, winY, 0, winY + winH);
        g.addColorStop(0, '#414a55');
        g.addColorStop(0.5, '#2c333b');
        g.addColorStop(1, '#20252c');
        c2.fillStyle = g;
        c2.fillRect(wx, winY, wW, winH);
        // inset shading: deep head shadow, dark jambs, lit sill
        c2.fillStyle = 'rgba(10,12,14,0.85)';
        c2.fillRect(wx, winY, wW, 5);
        c2.fillStyle = 'rgba(12,14,16,0.5)';
        c2.fillRect(wx, winY, 3, winH);
        c2.fillRect(wx + wW - 3, winY, 3, winH);
        c2.fillStyle = 'rgba(235,235,238,0.8)';
        c2.fillRect(wx, winY + winH - 2, wW, 2);
        // center mullion
        c2.fillStyle = 'rgba(14,15,18,0.8)';
        c2.fillRect(wx + wW / 2 - 1, winY, 2, winH);
        // random per-window shade variation (blinds partially down)
        if (rand() < 0.4) {
          c2.fillStyle = `rgba(150,146,138,${0.35 + rand() * 0.3})`;
          c2.fillRect(wx + 3, winY + 5, wW - 6, winH * (0.2 + rand() * 0.4));
        }
        // sparse lit-window grid: ~12% of cells carry a dim warm interior
        if (rand() < 0.12) {
          const eg = e2.createLinearGradient(0, winY, 0, winY + winH);
          const warm = 0.75 + rand() * 0.5;
          eg.addColorStop(0, `rgb(${c255(96 * warm)},${c255(74 * warm)},${c255(42 * warm)})`);
          eg.addColorStop(1, `rgb(${c255(52 * warm)},${c255(40 * warm)},${c255(24 * warm)})`);
          e2.fillStyle = eg;
          e2.fillRect(wx + 2, winY + 5, wW - 4, winH - 7);
          e2.fillStyle = '#0c0e10';
          e2.fillRect(wx + wW / 2 - 1, winY, 2, winH); // keep the mullion dark
        }
      }
      // faint panel joints on the piers
      c2.fillStyle = 'rgba(0,0,0,0.08)';
      c2.fillRect(ox, oy, 2, F - 16);
      c2.fillRect(ox + 63, oy, 2, F - 16);
    }
  }
  const tex = canvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return new THREE.MeshStandardMaterial({
    map: tex, roughness: 0.7, metalness: 0.05, vertexColors: true,
    emissive: new THREE.Color(0xffffff),
    emissiveMap: canvasTexture(e),
    emissiveIntensity: 0.5,
  });
}

function neonMat() {
  const { canvas: c, ctx: c2 } = makeCanvas(256);
  c2.fillStyle = '#050608'; c2.fillRect(0, 0, 256, 256);
  c2.font = 'bold 92px Arial, sans-serif';
  c2.textAlign = 'center'; c2.textBaseline = 'middle';
  c2.shadowColor = '#4ee9f0'; c2.shadowBlur = 26;
  c2.fillStyle = '#bff9fc';
  c2.fillText('OPEN', 128, 118);
  c2.fillText('OPEN', 128, 118);
  c2.shadowBlur = 0;
  c2.strokeStyle = '#2a8f96'; c2.lineWidth = 5;
  c2.strokeRect(14, 40, 228, 156);
  const tex = canvasTexture(c);
  return new THREE.MeshStandardMaterial({
    map: tex, roughness: 0.6, metalness: 0.2,
    // The ONE permitted emissive in the level: the neon sign — kept subtle
    // for the midday scene (level.js flickers intensity around ~1).
    emissive: new THREE.Color(0xffffff), emissiveMap: tex, emissiveIntensity: 1.05,
  });
}

/* -------------------------------- assembly -------------------------------- */

/** Build every material + the per-material UV scale table (repeats per meter). */
export function buildMaterials() {
  const m = {
    asphalt: asphaltMat(),
    groundMacro: groundMacroMat(),
    wheelPath: wheelPathMat(),
    patchRepair: patchRepairMat(),
    manhole: manholeMat(),
    drain: drainMat(),
    dirt: dirtMat(),
    concrete: concreteMat(303, '#847f74'),
    concreteDark: concreteMat(313, '#6d675d'),
    fountainConc: fountainConcMat(),
    grimeStreak: grimeStreakMat(),
    waterline: waterlineMat(),
    sidewalk: sidewalkMat(),
    brick: brickMat(),
    chipDecal: chipDecalMat(),
    corrugated: corrugatedMat(),
    rust: rustMat(),
    charred: charredMat(),
    sandbag: sandbagMat(),
    wood: woodMat(),
    paper: paperMat(),
    trash: trashMat(),
    barrier: barrierMat(),
    dumpster: dumpsterMat(),
    paintWhite: paintMat('#b7b09a'),
    paintYellow: paintMat('#ad9752'),
    crater: craterMat(),
    crackDecal: crackDecalMat(),
    oilDecal: oilDecalMat(),
    tireDecal: tireDecalMat(),
    dustDecal: dustDecalMat(),
    window: windowMat(),
    sign: signMat(),
    skyline: skylineMat(),
    // spandrel floor #2c3038: skyline banding must never read pure black at noon
    spandrel: new THREE.MeshStandardMaterial({ color: 0x2c3038, roughness: 0.92, metalness: 0.05 }),
    neon: neonMat(),
    // painted window frame / sash members (real 10 cm geometry, buildings.js)
    winFrame: new THREE.MeshStandardMaterial({ color: 0x2e2c29, roughness: 0.7, metalness: 0.15 }),
    // vehicle/bus glazing: dielectric glass tint #1a222c — env + sun specular
    // stay sky-colored (metal glass multiplied reflections to near-black)
    glass: new THREE.MeshStandardMaterial({
      color: 0x1a222c, roughness: 0.12, metalness: 0.2, envMapIntensity: 1.6,
    }),
    rubber: new THREE.MeshStandardMaterial({ color: 0x151517, roughness: 0.95, metalness: 0.0 }),
    rim: new THREE.MeshStandardMaterial({ color: 0x50545a, roughness: 0.45, metalness: 0.85 }),
    darkMetal: new THREE.MeshStandardMaterial({ color: 0x1c1d1f, roughness: 0.85, metalness: 0.45 }),
    darkVoid: new THREE.MeshStandardMaterial({ color: 0x080807, roughness: 1, metalness: 0 }),
  };
  // Wall variants with vertex colors enabled: buildings bake a bottom-1.5 m
  // grime gradient (vertex-color AO) into every wall. Clones share texture
  // maps; the base materials stay vertex-color-free for props whose merged
  // geometry has no color attribute.
  m.brickWall = m.brick.clone();
  m.brickWall.vertexColors = true;
  m.concreteWall = m.concrete.clone();
  m.concreteWall.vertexColors = true;
  m.concreteDarkWall = m.concreteDark.clone();
  m.concreteDarkWall.vertexColors = true;
  m.scale = {
    asphalt: 1 / 7, dirt: 1 / 9, concrete: 1 / 3, sidewalk: 1 / 3,
    brick: 1 / 1.28, corrugated: 1 / 1.2, rust: 1 / 1.6, charred: 1 / 2.2,
    wood: 1 / 0.9, dark: 1 / 2,
  };
  return m;
}
