// Procedural PBR materials for the viewmodel. Everything is generated on
// canvases at init — no asset files. Built once and shared across all parts.
//
// Palette (art direction, round 3 — "three real material sets, no clay"):
//   - ANODIZED receiver/handguard/rails: #1c1c1e albedo, metalness 0.8,
//     effective roughness ~0.45 (material.roughness 0.62 x rough-map ~0.74).
//   - POLYMER furniture (grip/stock/foregrip/PEQ): #26262a, metalness 0,
//     roughness 0.7, moulded stipple normal.
//   - STEEL barrel/muzzle: #2e2e30, metalness 0.85, effective roughness ~0.35.
//   - Curvature-driven edge wear on all three: box/prism UVs put the canvas
//     border exactly on each part's machined edges, so border frames + corner
//     scuffs (corners = highest curvature) lighten worn edges toward #4a4a4c.
//   - FDE magazine: its own set — double-stack body colour with a lengthwise
//     rib normal map (see curved mag geometry in rifle.js).
//   - Picatinny rails are BAKED: albedo/normal/roughness slot maps applied to
//     simple prisms (no more instanced piano-key teeth).
//   - Optic: near-black #141416 inner housing, neutral true glass with a
//     fresnel blue-violet AR-coat (ShaderMaterial) at grazing angles only,
//     and a crisp 2-3 px emissive dot with a tight bloom halo.
//   - Gloves/sleeves: DARK OLIVE fabric (the old coyote washed to bare tan
//     under the warm sun), knuckle-wrinkle normal map on the hand backs.
import * as THREE from 'three';
import { rng, makeCanvas, normalFromHeight, canvasTexture } from '../utils.js';

// ---- palette (shared by the canvas painters) -------------------------------
const ANOD = [28, 28, 30];      // #1c1c1e anodized aluminium
const STEEL = [46, 46, 48];     // #2e2e30 barrel steel
const POLY = [38, 38, 42];      // #26262a polymer furniture
const WEAR = [74, 74, 76];      // #4a4a4c worn-through edge highlight
const FDE = [90, 80, 62];       // #5a503e flat dark earth (magazine)
const FDE_WEAR = [112, 102, 80];

const css = (c, a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

// ---- local canvas helpers (utils.js is read-only; variants live here) ------
function rectCanvas(w, h) {
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  return { canvas, ctx: canvas.getContext('2d') };
}

/** Sobel height->normal for NON-square canvases (utils' assumes square). */
function normalFromHeightRect(canvas, strength = 1.0) {
  const w = canvas.width, hgt = canvas.height;
  const src = canvas.getContext('2d').getImageData(0, 0, w, hgt);
  const { canvas: out, ctx } = rectCanvas(w, hgt);
  const dst = ctx.createImageData(w, hgt);
  const h = (x, y) => {
    x = (x + w) % w; y = (y + hgt) % hgt;
    const i = (y * w + x) * 4;
    return (src.data[i] * 0.299 + src.data[i + 1] * 0.587 + src.data[i + 2] * 0.114) / 255;
  };
  for (let y = 0; y < hgt; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (h(x - 1, y) - h(x + 1, y)) * strength;
      const dy = (h(x, y - 1) - h(x, y + 1)) * strength;
      const len = Math.hypot(dx, dy, 1);
      const i = (y * w + x) * 4;
      dst.data[i] = ((dx / len) * 0.5 + 0.5) * 255;
      dst.data[i + 1] = ((dy / len) * 0.5 + 0.5) * 255;
      dst.data[i + 2] = ((1 / len) * 0.5 + 0.5) * 255;
      dst.data[i + 3] = 255;
    }
  }
  ctx.putImageData(dst, 0, 0);
  const tex = new THREE.CanvasTexture(out);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

/** Rotate a canvas 90° CW (slot bands along y -> bands along x). */
function rot90(src) {
  const { canvas, ctx } = rectCanvas(src.height, src.width);
  ctx.translate(src.height, 0);
  ctx.rotate(Math.PI / 2);
  ctx.drawImage(src, 0, 0);
  return canvas;
}

/** Worn metal albedo: `base` colour with curvature-driven wear to `wear`.
 *  Box/prism UVs map each face across full 0..1, so the border frames land
 *  exactly on machined edges and the corner scuffs on corners (the highest-
 *  curvature spots) — a cheap curvature proxy that reads like real edge wear. */
function wornMetalAlbedoCanvas(size, seed, base, wear) {
  const { canvas, ctx } = makeCanvas(size);
  const rand = rng(seed);
  ctx.fillStyle = css(base);
  ctx.fillRect(0, 0, size, size);
  // In-family finish blotches.
  ctx.globalAlpha = 0.06;
  for (let i = 0; i < 150; i++) {
    const f = 0.75 + rand() * 0.6;
    ctx.fillStyle = css([base[0] * f, base[1] * f, base[2] * f].map(Math.round));
    ctx.beginPath();
    ctx.arc(rand() * size, rand() * size, 2 + rand() * 18, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  // Edge wear frames: anodizing/bluing rubbed through toward every part edge.
  const frames = [[1, 1.5, 0.30], [3.5, 2.5, 0.18], [7, 4, 0.09]];
  for (const [inset, lw, a] of frames) {
    ctx.strokeStyle = css(WEAR, a);
    ctx.lineWidth = lw;
    ctx.strokeRect(inset, inset, size - inset * 2, size - inset * 2);
  }
  // Corner scuffs — corners are the highest-curvature points, so they wear
  // brightest (radial falloff back into the base finish).
  for (const [cx, cy] of [[0, 0], [size, 0], [0, size], [size, size]]) {
    const r = size * 0.10;
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, css(wear, 0.4));
    g.addColorStop(1, css(wear, 0));
    ctx.fillStyle = g;
    ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
  }
  // Nicks + scratches, biased toward the borders, in the wear colour.
  for (let i = 0; i < 70; i++) {
    let x = rand() * size, y = rand() * size;
    if (rand() < 0.65) {
      if (rand() < 0.5) x = rand() < 0.5 ? rand() * 10 : size - rand() * 10;
      else y = rand() < 0.5 ? rand() * 10 : size - rand() * 10;
    }
    ctx.strokeStyle = css(wear, 0.18 + rand() * 0.3);
    ctx.lineWidth = 0.5 + rand();
    const a = rand() * Math.PI, len = 2 + rand() * 12;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
    ctx.stroke();
  }
  return canvas;
}

/** Wear/roughness map (lighter = rougher). `base` sets the effective
 *  roughness multiplier; edges go toward `edge` (rougher) so worn corners
 *  diffuse instead of pinging. */
function wornRoughCanvas(size, seed, base, edge) {
  const { canvas, ctx } = makeCanvas(size);
  const rand = rng(seed);
  ctx.fillStyle = `rgb(${base},${base},${base})`;
  ctx.fillRect(0, 0, size, size);
  ctx.globalAlpha = 0.08;
  for (let i = 0; i < 140; i++) {
    const g = base - 25 + Math.floor(rand() * 50);
    ctx.fillStyle = `rgb(${g},${g},${g})`;
    ctx.beginPath();
    ctx.arc(rand() * size, rand() * size, 3 + rand() * 22, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  for (let k = 0; k < 3; k++) {
    const inset = 1 + k * 3;
    ctx.strokeStyle = `rgba(${edge},${edge},${edge},${0.4 - k * 0.11})`;
    ctx.lineWidth = 2 + k * 1.5;
    ctx.strokeRect(inset, inset, size - inset * 2, size - inset * 2);
  }
  ctx.globalAlpha = 0.45;
  for (let i = 0; i < 80; i++) {
    const g = edge - 10 + Math.floor(rand() * 25);
    ctx.strokeStyle = `rgb(${g},${g},${g})`;
    ctx.lineWidth = 0.5 + rand() * 1.2;
    const x = rand() * size, y = rand() * size;
    const len = 6 + rand() * 50;
    const a = rand() < 0.7 ? (rand() - 0.5) * 0.35 : rand() * Math.PI;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  return canvas;
}

/** Polymer furniture albedo: #26262a with mould lines + subtle edge sheen. */
function polymerAlbedoCanvas(size, seed) {
  const { canvas, ctx } = makeCanvas(size);
  const rand = rng(seed);
  ctx.fillStyle = css(POLY);
  ctx.fillRect(0, 0, size, size);
  ctx.globalAlpha = 0.05;
  for (let i = 0; i < 120; i++) {
    const f = 0.8 + rand() * 0.45;
    ctx.fillStyle = css([POLY[0] * f, POLY[1] * f, POLY[2] * f].map(Math.round));
    ctx.beginPath();
    ctx.arc(rand() * size, rand() * size, 3 + rand() * 20, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  // Faint vertical mould-parting lines.
  ctx.globalAlpha = 0.06;
  for (let i = 0; i < 3; i++) {
    const x = (0.2 + 0.3 * i) * size + rand() * 12;
    ctx.fillStyle = css(WEAR);
    ctx.fillRect(x, 0, 1.5, size);
  }
  ctx.globalAlpha = 1;
  // Polymer wears shiny-smooth at edges — lighten toward #4a4a4c, gently.
  for (const [inset, lw, a] of [[1, 1.5, 0.16], [3.5, 3, 0.08]]) {
    ctx.strokeStyle = css(WEAR, a);
    ctx.lineWidth = lw;
    ctx.strokeRect(inset, inset, size - inset * 2, size - inset * 2);
  }
  return canvas;
}

/** Fine machining-line height map -> subtle normal detail for metal. */
function metalHeightCanvas(size, seed) {
  const { canvas, ctx } = makeCanvas(size);
  const rand = rng(seed);
  ctx.fillStyle = '#808080';
  ctx.fillRect(0, 0, size, size);
  ctx.globalAlpha = 0.16;
  for (let y = 0; y < size; y += 2) {
    const g = 118 + Math.floor(rand() * 20);
    ctx.fillStyle = `rgb(${g},${g},${g})`;
    ctx.fillRect(0, y, size, 1);
  }
  ctx.globalAlpha = 0.25;
  for (let i = 0; i < 40; i++) {
    const g = rand() < 0.5 ? 96 : 168;
    ctx.fillStyle = `rgb(${g},${g},${g})`;
    ctx.fillRect(rand() * size, rand() * size, 2 + rand() * 10, 2 + rand() * 10);
  }
  ctx.globalAlpha = 1;
  return canvas;
}

/** Polymer stipple height map (grip/stock texture). */
function polymerHeightCanvas(size, seed) {
  const { canvas, ctx } = makeCanvas(size);
  const rand = rng(seed);
  ctx.fillStyle = '#808080';
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 5200; i++) {
    const g = rand() < 0.5 ? 100 : 155;
    ctx.fillStyle = `rgba(${g},${g},${g},0.55)`;
    ctx.beginPath();
    ctx.arc(rand() * size, rand() * size, 0.6 + rand() * 1.6, 0, Math.PI * 2);
    ctx.fill();
  }
  return canvas;
}

/** Woven glove-fabric height map (tiles — palms, fingers, forearms). */
function fabricHeightCanvas(size, seed) {
  const { canvas, ctx } = makeCanvas(size);
  const rand = rng(seed);
  ctx.fillStyle = '#808080';
  ctx.fillRect(0, 0, size, size);
  ctx.globalAlpha = 0.3;
  const cell = 6;
  for (let y = 0; y < size; y += cell) {
    for (let x = 0; x < size; x += cell) {
      const g = ((x / cell + y / cell) % 2 === 0) ? 108 : 148;
      ctx.fillStyle = `rgb(${g},${g},${g})`;
      ctx.fillRect(x, y, cell - 1, cell - 1);
    }
  }
  ctx.globalAlpha = 0.2;
  for (let i = 0; i < 500; i++) {
    const g = Math.floor(90 + rand() * 90);
    ctx.fillStyle = `rgb(${g},${g},${g})`;
    ctx.fillRect(rand() * size, rand() * size, 1, 2 + rand() * 3);
  }
  ctx.globalAlpha = 1;
  return canvas;
}

/** Back-of-hand height map (NOT tiled): knuckle ridges, knuckle WRINKLES and
 *  stitched seams over the weave — drives the glove's normal map. */
function gloveBackHeightCanvas(size, seed) {
  const { canvas, ctx } = makeCanvas(size);
  const rand = rng(seed);
  ctx.fillStyle = '#808080';
  ctx.fillRect(0, 0, size, size);
  // Base weave.
  ctx.globalAlpha = 0.22;
  const cell = 5;
  for (let y = 0; y < size; y += cell) {
    for (let x = 0; x < size; x += cell) {
      const g = ((x / cell + y / cell) % 2 === 0) ? 112 : 146;
      ctx.fillStyle = `rgb(${g},${g},${g})`;
      ctx.fillRect(x, y, cell - 1, cell - 1);
    }
  }
  ctx.globalAlpha = 1;
  // Four knuckle ridge bumps across the upper third.
  for (let i = 0; i < 4; i++) {
    const cx = (0.2 + 0.2 * i) * size;
    const cy = 0.3 * size;
    const r = 0.085 * size;
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    grad.addColorStop(0, 'rgba(232,232,232,0.85)');
    grad.addColorStop(0.6, 'rgba(180,180,180,0.4)');
    grad.addColorStop(1, 'rgba(128,128,128,0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
  }
  // Knuckle wrinkles: short wavy fold grooves between/below the knuckles —
  // the fabric bunches when the fist closes around a grip.
  ctx.strokeStyle = 'rgba(88,88,88,0.65)';
  ctx.lineWidth = 1.6;
  for (let i = 0; i < 9; i++) {
    const x0 = (0.1 + rand() * 0.7) * size;
    const y0 = (0.16 + rand() * 0.3) * size;
    const w = (0.08 + rand() * 0.1) * size;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.quadraticCurveTo(x0 + w * 0.5, y0 + (rand() - 0.3) * 8, x0 + w, y0 + (rand() - 0.5) * 5);
    ctx.stroke();
  }
  // Stitched seams: dashed darker grooves — cuff hem + two panel seams.
  ctx.strokeStyle = 'rgba(66,66,66,0.85)';
  ctx.lineWidth = 2;
  ctx.setLineDash([5, 4]);
  ctx.strokeRect(6, 6, size - 12, size - 12);
  ctx.beginPath();
  ctx.moveTo(0.1 * size, 0.52 * size);
  ctx.quadraticCurveTo(0.5 * size, 0.46 * size, 0.9 * size, 0.52 * size);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(0.1 * size, 0.8 * size);
  ctx.quadraticCurveTo(0.5 * size, 0.74 * size, 0.9 * size, 0.8 * size);
  ctx.stroke();
  ctx.setLineDash([]);
  // Scuffing.
  ctx.globalAlpha = 0.18;
  for (let i = 0; i < 120; i++) {
    const g = Math.floor(96 + rand() * 80);
    ctx.fillStyle = `rgb(${g},${g},${g})`;
    ctx.fillRect(rand() * size, rand() * size, 1 + rand() * 2, 1 + rand() * 3);
  }
  ctx.globalAlpha = 1;
  return canvas;
}

// ---- picatinny rail bake ---------------------------------------------------
// The rail slot rows are BAKED into albedo/normal/roughness maps applied to a
// simple dovetail prism: chamfered grooves at true 10 mm pitch in the height
// map, worn chamfer lines in the albedo, rougher groove floors. `axis` picks
// which canvas axis the slots run along, matching BoxGeometry's per-face UVs
// (top/bottom faces: slots along v; side-rail outward faces: slots along u).
function picatinnySet(slots, axis) {
  const across = 64;
  const along = slots * 22;
  const alb = rectCanvas(across, along);
  const hgt = rectCanvas(across, along);
  const rough = rectCanvas(across, along);
  const rand = rng(4200 + slots);

  // Height: chamfered grooves.
  hgt.ctx.fillStyle = '#828282';
  hgt.ctx.fillRect(0, 0, across, along);
  // Albedo: anodized base + mottle.
  alb.ctx.fillStyle = css(ANOD);
  alb.ctx.fillRect(0, 0, across, along);
  alb.ctx.globalAlpha = 0.05;
  for (let i = 0; i < slots * 4; i++) {
    const f = 0.8 + rand() * 0.5;
    alb.ctx.fillStyle = css([ANOD[0] * f, ANOD[1] * f, ANOD[2] * f].map(Math.round));
    alb.ctx.beginPath();
    alb.ctx.arc(rand() * across, rand() * along, 3 + rand() * 10, 0, Math.PI * 2);
    alb.ctx.fill();
  }
  alb.ctx.globalAlpha = 1;
  // Roughness base.
  rough.ctx.fillStyle = '#c4c4c4';
  rough.ctx.fillRect(0, 0, across, along);

  const pitch = along / slots;
  const g = pitch * 0.27;    // groove half-width
  const ch = pitch * 0.17;   // chamfer width
  for (let i = 0; i < slots; i++) {
    const yc = (i + 0.5) * pitch;
    // Height groove with chamfer ramps (reads as beveled teeth in lighting).
    const grad = hgt.ctx.createLinearGradient(0, yc - g - ch, 0, yc + g + ch);
    const cFrac = ch / (2 * (g + ch));
    grad.addColorStop(0, '#828282');
    grad.addColorStop(cFrac, '#2f2f2f');
    grad.addColorStop(1 - cFrac, '#2f2f2f');
    grad.addColorStop(1, '#828282');
    hgt.ctx.fillStyle = grad;
    hgt.ctx.fillRect(0, yc - g - ch, across, 2 * (g + ch));
    // Albedo: darker groove floor + worn chamfer edge lines.
    alb.ctx.fillStyle = css([20, 20, 22]);
    alb.ctx.fillRect(0, yc - g, across, 2 * g);
    alb.ctx.fillStyle = css(WEAR, 0.55);
    alb.ctx.fillRect(0, yc - g - 1.2, across, 1.6);
    alb.ctx.fillRect(0, yc + g - 0.4, across, 1.6);
    // Roughness: groove floors a touch smoother, chamfer edges rougher/worn.
    rough.ctx.fillStyle = '#b2b2b2';
    rough.ctx.fillRect(0, yc - g, across, 2 * g);
    rough.ctx.fillStyle = 'rgba(230,230,230,0.8)';
    rough.ctx.fillRect(0, yc - g - 1.2, across, 1.4);
    rough.ctx.fillRect(0, yc + g - 0.2, across, 1.4);
  }
  // Long-edge wear on the rail's beveled flanks (canvas x borders).
  alb.ctx.fillStyle = css(WEAR, 0.4);
  alb.ctx.fillRect(0, 0, 2.5, along);
  alb.ctx.fillRect(across - 2.5, 0, 2.5, along);
  rough.ctx.fillStyle = 'rgba(226,226,226,0.6)';
  rough.ctx.fillRect(0, 0, 2.5, along);
  rough.ctx.fillRect(across - 2.5, 0, 2.5, along);

  const flip = axis === 'x';
  const albC = flip ? rot90(alb.canvas) : alb.canvas;
  const hgtC = flip ? rot90(hgt.canvas) : hgt.canvas;
  const roughC = flip ? rot90(rough.canvas) : rough.canvas;
  const map = new THREE.CanvasTexture(albC);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 8;
  const roughnessMap = new THREE.CanvasTexture(roughC);
  roughnessMap.anisotropy = 8;
  const normalMap = normalFromHeightRect(hgtC, 1.5);
  normalMap.anisotropy = 8;
  return { map, roughnessMap, normalMap };
}

// ---- FDE magazine maps -----------------------------------------------------
// UVs on the curved mag body: u = around the perimeter, v = along the length.
// Lengthwise ribs are constant-u bands (vertical canvas lines).
const MAG_RIBS = [0.09, 0.2, 0.31, 0.42, 0.56, 0.67, 0.78, 0.89];

function magHeightCanvas(size) {
  const { canvas, ctx } = makeCanvas(size);
  const rand = rng(4141);
  ctx.fillStyle = '#808080';
  ctx.fillRect(0, 0, size, size);
  // Light stipple so the polymer isn't dead-flat between the ribs.
  ctx.globalAlpha = 0.12;
  for (let i = 0; i < 1600; i++) {
    const g = rand() < 0.5 ? 108 : 150;
    ctx.fillStyle = `rgb(${g},${g},${g})`;
    ctx.beginPath();
    ctx.arc(rand() * size, rand() * size, 0.6 + rand() * 1.4, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  // Lengthwise ribs: raised shoulder lines flanking a recessed core.
  for (const f of MAG_RIBS) {
    const x = f * size;
    ctx.fillStyle = '#a8a8a8';
    ctx.fillRect(x - 5, 0, 3, size);
    ctx.fillRect(x + 2, 0, 3, size);
    ctx.fillStyle = '#565656';
    ctx.fillRect(x - 2, 0, 4, size);
  }
  // Horizontal witness/weld line near the base.
  ctx.fillStyle = '#5e5e5e';
  ctx.fillRect(0, size * 0.84, size, 4);
  ctx.fillStyle = '#a2a2a2';
  ctx.fillRect(0, size * 0.84 + 4, size, 2);
  return canvas;
}

function magAlbedoCanvas(size) {
  const { canvas, ctx } = makeCanvas(size);
  const rand = rng(4140);
  ctx.fillStyle = css(FDE);
  ctx.fillRect(0, 0, size, size);
  ctx.globalAlpha = 0.07;
  for (let i = 0; i < 160; i++) {
    const f = 0.78 + rand() * 0.5;
    ctx.fillStyle = css([FDE[0] * f, FDE[1] * f, FDE[2] * f].map(Math.round));
    ctx.beginPath();
    ctx.arc(rand() * size, rand() * size, 3 + rand() * 16, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  // Rib grooves read slightly darker (dirt collects in the recesses).
  ctx.globalAlpha = 0.2;
  for (const f of MAG_RIBS) {
    ctx.fillStyle = css([70, 62, 48]);
    ctx.fillRect(f * size - 2, 0, 4, size);
  }
  ctx.globalAlpha = 1;
  // Wear: bottom band (mag gets dropped) + scuffs.
  const g = ctx.createLinearGradient(0, size * 0.86, 0, size);
  g.addColorStop(0, css(FDE_WEAR, 0));
  g.addColorStop(1, css(FDE_WEAR, 0.35));
  ctx.fillStyle = g;
  ctx.fillRect(0, size * 0.86, size, size * 0.14);
  for (let i = 0; i < 60; i++) {
    ctx.strokeStyle = css(FDE_WEAR, 0.15 + rand() * 0.3);
    ctx.lineWidth = 0.5 + rand();
    const x = rand() * size, y = (0.3 + rand() * 0.7) * size;
    const a = (rand() - 0.5) * 0.8, len = 3 + rand() * 14;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
    ctx.stroke();
  }
  return canvas;
}

export function buildWeaponMaterials() {
  const size = 256;

  // Albedo + wear stay at repeat 1,1 so the border wear lands on part edges;
  // the machining normal tiles 2x2 (three r152+ gives each map its own
  // uv transform, so mixed repeats on one material are fine).
  const anodAlbedo = canvasTexture(wornMetalAlbedoCanvas(size, 4100, ANOD, WEAR));
  // 188/255 = 0.74 base multiplier -> 0.62 * 0.74 ≈ 0.46 effective roughness.
  const anodRough = canvasTexture(wornRoughCanvas(size, 4101, 188, 228), { srgb: false });
  const steelAlbedo = canvasTexture(wornMetalAlbedoCanvas(size, 4120, STEEL, WEAR));
  // 178/255 = 0.70 -> 0.5 * 0.70 ≈ 0.35 effective roughness on the barrel.
  const steelRough = canvasTexture(wornRoughCanvas(size, 4121, 178, 214), { srgb: false });
  const polyAlbedo = canvasTexture(polymerAlbedoCanvas(size, 4130));
  const magAlbedo = canvasTexture(magAlbedoCanvas(size));
  const magRough = canvasTexture(wornRoughCanvas(size, 4142, 200, 224), { srgb: false });

  const metalNormal = normalFromHeight(metalHeightCanvas(size, 4102), 0.45);
  metalNormal.repeat.set(2, 2);
  const polymerNormal = normalFromHeight(polymerHeightCanvas(size, 4103), 0.8);
  polymerNormal.repeat.set(3, 3);
  const fabricNormal = normalFromHeight(fabricHeightCanvas(size, 4104), 1.0);
  fabricNormal.repeat.set(4, 4);
  const gloveBackNormal = normalFromHeight(gloveBackHeightCanvas(size, 4105), 1.25);
  gloveBackNormal.repeat.set(1, 1);
  const magNormal = normalFromHeight(magHeightCanvas(size), 1.1);

  // ---- SET 1: anodized receiver/handguard (#1c1c1e, m 0.8, eff r ~0.45) ----
  const metal = new THREE.MeshStandardMaterial({
    color: 0xffffff, map: anodAlbedo, metalness: 0.8, roughness: 0.62,
    roughnessMap: anodRough, normalMap: metalNormal,
    normalScale: new THREE.Vector2(0.35, 0.35),
  });
  // Accent anodized (sight body, riser, small hardware) — same family.
  const alu = new THREE.MeshStandardMaterial({
    color: 0x232327, metalness: 0.8, roughness: 0.6,
    roughnessMap: anodRough, normalMap: metalNormal,
    normalScale: new THREE.Vector2(0.3, 0.3),
  });
  // Baked picatinny sets (per-orientation UV variants — see picatinnySet).
  const picTop = picatinnySet(47, 'y');    // continuous top rail, 10 mm pitch
  const picBottom = picatinnySet(13, 'y'); // handguard bottom rail
  const picSide = picatinnySet(11, 'x');   // handguard side rails
  const railMat = (pic) => new THREE.MeshStandardMaterial({
    color: 0xffffff, map: pic.map, metalness: 0.78, roughness: 0.62,
    roughnessMap: pic.roughnessMap, normalMap: pic.normalMap,
    normalScale: new THREE.Vector2(1.0, 1.0),
  });
  const railTop = railMat(picTop);
  const railBottom = railMat(picBottom);
  const railSide = railMat(picSide);

  // ---- SET 3: steel barrel/muzzle (#2e2e30, eff r ~0.35) -------------------
  const steelDark = new THREE.MeshStandardMaterial({
    color: 0xffffff, map: steelAlbedo, metalness: 0.85, roughness: 0.5,
    roughnessMap: steelRough, normalMap: metalNormal,
    normalScale: new THREE.Vector2(0.25, 0.25),
  });
  // Bolt-carrier steel seen through the ejection port — worn, NOT mirror.
  const steelBright = new THREE.MeshStandardMaterial({
    color: 0x3a3f45, metalness: 0.85, roughness: 0.6,
    roughnessMap: steelRough,
  });

  // NOTE on dielectrics: the scene's environment map carries a huge diffuse
  // irradiance, and with `scene.environment` three r18x IGNORES the per-material
  // envMapIntensity (the shader uniform comes from scene.environmentIntensity —
  // see WebGLRenderer). Full-strength env diffuse washed all matte gear to
  // beige. Each dielectric therefore carries `userData.envFactor`; the
  // WeaponSystem assigns the scene env as the material's OWN envMap every frame
  // (own envMap -> envMapIntensity respected) and sets
  // envMapIntensity = envFactor * scene.environmentIntensity.

  // ---- SET 2: polymer furniture (#26262a, m 0, r 0.7) ----------------------
  const polymer = new THREE.MeshPhysicalMaterial({
    color: 0xffffff, map: polyAlbedo, metalness: 0.0, roughness: 0.7,
    specularIntensity: 0.35,
    normalMap: polymerNormal, normalScale: new THREE.Vector2(0.5, 0.5),
  });
  polymer.userData.envFactor = 0.2;
  // Darker variant (PEQ, BUIS) — same albedo, tinted down (variation, not two-tone).
  const polymerDark = new THREE.MeshPhysicalMaterial({
    color: 0xb8b8bc, map: polyAlbedo, metalness: 0.0, roughness: 0.72,
    specularIntensity: 0.35,
    normalMap: polymerNormal, normalScale: new THREE.Vector2(0.6, 0.6),
  });
  polymerDark.userData.envFactor = 0.2;
  // FDE magazine — double-stack body with lengthwise rib normal map.
  const magFde = new THREE.MeshPhysicalMaterial({
    color: 0xffffff, map: magAlbedo, metalness: 0.0, roughness: 0.75,
    roughnessMap: magRough, specularIntensity: 0.4,
    normalMap: magNormal, normalScale: new THREE.Vector2(0.8, 0.8),
  });
  magFde.userData.envFactor = 0.2;
  // Rubber (butt pad, grip backstrap, rail covers, pull tab).
  const rubber = new THREE.MeshPhysicalMaterial({
    color: 0x121213, metalness: 0.0, roughness: 0.96,
    specularIntensity: 0.25,
    normalMap: polymerNormal, normalScale: new THREE.Vector2(0.8, 0.8),
  });
  rubber.userData.envFactor = 0.22;

  // ---- optic ---------------------------------------------------------------
  // Neutral true glass (no mint tint) — the coat tint comes from the fresnel
  // shader below, only at grazing angles.
  const glass = new THREE.MeshStandardMaterial({
    color: 0xf4f6f9, metalness: 0.0, roughness: 0.06,
    transparent: true, opacity: 0.07, depthWrite: false,
  });
  const glassRear = new THREE.MeshStandardMaterial({
    color: 0xe8ecf0, metalness: 0.0, roughness: 0.06,
    transparent: true, opacity: 0.05, depthWrite: false,
  });
  // Near-black optic housing rings + retainer (#141416, per art direction).
  const sightRing = new THREE.MeshStandardMaterial({
    color: 0x141416, metalness: 0.6, roughness: 0.5,
  });
  // Matte near-black tube interior (BackSide so it's seen looking through).
  const sightInner = new THREE.MeshStandardMaterial({
    color: 0x141416, metalness: 0.3, roughness: 0.85, side: THREE.BackSide,
  });
  // AR-coat: blue-violet fresnel tint that only appears at grazing angles —
  // dead-on through the optic the glass stays clear. Additive, not tone-mapped
  // (ShaderMaterial skips the tonemap chunk), so the tint stays saturated.
  const fresnelCoat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: {
      uColor: { value: new THREE.Color(0x5a48e0) },
      uStrength: { value: 0.5 },
    },
    vertexShader: /* glsl */`
      varying vec3 vN;
      varying vec3 vV;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal);
        vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uColor;
      uniform float uStrength;
      varying vec3 vN;
      varying vec3 vV;
      void main() {
        float f = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.2);
        gl_FragColor = vec4(uColor * f * uStrength, f * uStrength);
      }`,
  });
  // Emissive reticle dot: #ff2318 pushed to ~4x HDR so the bloom pass gives it
  // a slight halo; toneMapped:false keeps it saturated. Opacity is driven
  // per-frame by the WeaponSystem (dim over the lens in hipfire, full in ADS).
  const redDot = new THREE.MeshBasicMaterial({
    color: new THREE.Color(0xff2318).multiplyScalar(5),
    toneMapped: false, transparent: true, opacity: 0, depthWrite: false,
  });
  // Laser-box lens.
  const irLens = new THREE.MeshStandardMaterial({
    color: 0x0a0d10, metalness: 0.6, roughness: 0.1,
    emissive: 0x330b06, emissiveIntensity: 0.6,
  });

  // ---- gloves + sleeves ----------------------------------------------------
  // DARK OLIVE, tuned against the stacked warm sun (~45 intensity): these
  // albedos land on dark olive when sunlit and near-black in shade (the fabric
  // meshes receive world shadows — see the traverse in rifle.js — so they no
  // longer glow bare-tan while the player stands in building shade).
  const glove = new THREE.MeshPhysicalMaterial({
    color: 0x2a2e1c, metalness: 0.0, roughness: 0.9,
    specularIntensity: 0.25,
    normalMap: fabricNormal, normalScale: new THREE.Vector2(0.7, 0.7),
  });
  glove.userData.envFactor = 0.14;
  // Back-of-hand plates + knuckle bumps: dedicated non-tiled knuckle-wrinkle
  // normal map.
  const gloveBack = new THREE.MeshPhysicalMaterial({
    color: 0x2e3220, metalness: 0.0, roughness: 0.88,
    specularIntensity: 0.25,
    normalMap: gloveBackNormal, normalScale: new THREE.Vector2(0.9, 0.9),
  });
  gloveBack.userData.envFactor = 0.14;
  // Cuff straps / velcro tabs — lighter olive accent.
  const strap = new THREE.MeshPhysicalMaterial({
    color: 0x383c28, metalness: 0.0, roughness: 0.92,
    specularIntensity: 0.22,
    normalMap: fabricNormal, normalScale: new THREE.Vector2(0.6, 0.6),
  });
  strap.userData.envFactor = 0.15;
  const sleeve = new THREE.MeshPhysicalMaterial({
    color: 0x252a1c, metalness: 0.0, roughness: 0.9,
    specularIntensity: 0.22,
    normalMap: fabricNormal, normalScale: new THREE.Vector2(0.8, 0.8),
  });
  sleeve.userData.envFactor = 0.13;

  return {
    metal, alu, railTop, railBottom, railSide, steelDark, steelBright,
    polymer, polymerDark, magFde, rubber,
    glass, glassRear, sightRing, sightInner, fresnelCoat, redDot, irLens,
    glove, gloveBack, strap, sleeve,
  };
}

/** Receiver rollmark stamp: model / calibre / serial + selector markings, like
 *  the Warzone ref's "P 024290" stamps. Light engraving on transparent ground. */
export function buildStampTexture() {
  const w = 256, h = 128;
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  const line = (txt, x, y, px, alpha = 0.9) => {
    ctx.font = `700 ${px}px "Arial Narrow", Arial, sans-serif`;
    // Engrave shadow first, then the lit face of the stamp.
    ctx.fillStyle = 'rgba(6,7,8,0.85)';
    ctx.fillText(txt, x, y + 1.5);
    ctx.fillStyle = `rgba(188,196,204,${alpha})`;
    ctx.fillText(txt, x, y);
  };
  line('M4A1 CARBINE', 12, 32, 23);
  line('CAL. 5.56 MM NATO', 12, 62, 19);
  line('P 024290', 12, 100, 26, 0.75);
  // Selector markings: SAFE label + rotary pointer glyph.
  line('SAFE', 178, 34, 14, 0.7);
  ctx.strokeStyle = 'rgba(188,196,204,0.7)';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.arc(200, 84, 15, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(200, 84);
  ctx.lineTo(219, 66);
  ctx.stroke();
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/** Radial starburst texture for the muzzle flash (additive quads). */
export function buildFlashTexture() {
  const size = 128;
  const { canvas, ctx } = makeCanvas(size);
  const c = size / 2;
  ctx.clearRect(0, 0, size, size);
  const grad = ctx.createRadialGradient(c, c, 0, c, c, c);
  grad.addColorStop(0.0, 'rgba(255,244,214,1)');
  grad.addColorStop(0.25, 'rgba(255,196,110,0.85)');
  grad.addColorStop(0.55, 'rgba(255,132,40,0.32)');
  grad.addColorStop(1.0, 'rgba(255,90,20,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  // Spikes.
  const rand = rng(913);
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2 + rand() * 0.6;
    const len = c * (0.7 + rand() * 0.3);
    const g = ctx.createLinearGradient(c, c, c + Math.cos(a) * len, c + Math.sin(a) * len);
    g.addColorStop(0, 'rgba(255,225,160,0.9)');
    g.addColorStop(1, 'rgba(255,120,30,0)');
    ctx.strokeStyle = g;
    ctx.lineWidth = 2.5 + rand() * 3;
    ctx.beginPath();
    ctx.moveTo(c, c);
    ctx.lineTo(c + Math.cos(a) * len, c + Math.sin(a) * len);
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Tight round halo for the red-dot — a slight corona around a crisp 2-3 px
 *  point, NOT the old wide fuzzy blob (falloff pulled way in). */
export function buildGlowTexture() {
  const size = 64;
  const { canvas, ctx } = makeCanvas(size);
  const c = size / 2;
  ctx.clearRect(0, 0, size, size);
  const grad = ctx.createRadialGradient(c, c, 0, c, c, c);
  grad.addColorStop(0, 'rgba(255,64,44,0.85)');
  grad.addColorStop(0.3, 'rgba(255,42,26,0.28)');
  grad.addColorStop(0.65, 'rgba(255,30,16,0.05)');
  grad.addColorStop(1, 'rgba(255,30,15,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
