// Shared procedural-texture + material helpers. OWNED by the integrator.
// Subsystem agents may READ and CALL these; do not edit. If you need a variant,
// build it inside your own module file.
import * as THREE from 'three';

/** Deterministic PRNG (mulberry32) so visuals are reproducible between reloads. */
export function rng(seed = 1337) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Canvas helper: returns {canvas, ctx} at size x size. */
export function makeCanvas(size = 512) {
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  return { canvas, ctx: canvas.getContext('2d') };
}

/** Value-noise fill on a canvas ctx: layered blotches, good concrete/dirt base. */
export function noiseFill(ctx, size, { base = '#777', octaves = 4, alpha = 0.08, mono = true, seed = 7 } = {}) {
  const rand = rng(seed);
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, size, size);
  for (let o = 0; o < octaves; o++) {
    const n = 60 * (o + 1);
    const r = size / (6 * (o + 1));
    for (let i = 0; i < n; i++) {
      const g = Math.floor(rand() * 255);
      ctx.fillStyle = mono
        ? `rgba(${g},${g},${g},${alpha})`
        : `rgba(${Math.floor(rand() * 255)},${Math.floor(rand() * 255)},${Math.floor(rand() * 255)},${alpha})`;
      ctx.beginPath();
      ctx.arc(rand() * size, rand() * size, rand() * r + 1, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

/** Sobel height→normal map. Input: canvas whose luminance is height. Returns THREE.CanvasTexture. */
export function normalFromHeight(canvas, strength = 1.0) {
  const size = canvas.width;
  const src = canvas.getContext('2d').getImageData(0, 0, size, size);
  const { canvas: out, ctx } = makeCanvas(size);
  const dst = ctx.createImageData(size, size);
  const h = (x, y) => {
    x = (x + size) % size; y = (y + size) % size;
    const i = (y * size + x) * 4;
    return (src.data[i] * 0.299 + src.data[i + 1] * 0.587 + src.data[i + 2] * 0.114) / 255;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (h(x - 1, y) - h(x + 1, y)) * strength;
      const dy = (h(x, y - 1) - h(x, y + 1)) * strength;
      const dz = 1.0;
      const len = Math.hypot(dx, dy, dz);
      const i = (y * size + x) * 4;
      dst.data[i] = ((dx / len) * 0.5 + 0.5) * 255;
      dst.data[i + 1] = ((dy / len) * 0.5 + 0.5) * 255;
      dst.data[i + 2] = ((dz / len) * 0.5 + 0.5) * 255;
      dst.data[i + 3] = 255;
    }
  }
  ctx.putImageData(dst, 0, 0);
  const tex = new THREE.CanvasTexture(out);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

/** Wrap a canvas as a color texture (sRGB, repeating, anisotropy 8). */
export function canvasTexture(canvas, { srgb = true } = {}) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}
