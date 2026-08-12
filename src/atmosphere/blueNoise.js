// Blue-noise dither tile for the atmosphere system.
//
// A 64x64 toroidal blue-noise rank texture generated with greedy min-energy
// insertion (the void-and-cluster ranking phase): each new sample lands at the
// global minimum of a wrapped-gaussian energy field accumulated from all
// previous samples, so consecutive ranks repel each other and the threshold
// pattern at ANY level is spatially even — exactly the property that turns
// 8-bit gradient banding into invisible grain instead of visible worms
// (white-noise dither) or fixed crosshatch (bayer). Generated once at init
// (~17M trivial ops, tens of ms), uploaded as a single-channel DataTexture,
// sampled with gl_FragCoord so it tiles seamlessly across the frame.
import * as THREE from 'three';
import { rng } from '../utils.js';

export const BLUE_NOISE_SIZE = 64;

export function makeBlueNoiseTexture(size = BLUE_NOISE_SIZE, seed = 1) {
  const N = size * size;
  const rand = rng(seed);
  const energy = new Float32Array(N);
  // Tiny random bias breaks argmin ties so the first ranks don't fall into
  // raster order (which would print a visible sweep in the lowest levels).
  for (let i = 0; i < N; i++) energy[i] = rand() * 1e-4;
  const taken = new Uint8Array(N);
  const rank = new Uint16Array(N);

  // Wrapped gaussian kernel, sigma 1.9 (the classic void-and-cluster choice),
  // truncated at 3 sigma — precomputed offsets + weights, zero allocation in
  // the hot loop.
  const sigma = 1.9;
  const R = 6;
  const kdx = [], kdy = [], kw = [];
  for (let dy = -R; dy <= R; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      kdx.push(dx);
      kdy.push(dy);
      kw.push(Math.exp(-(dx * dx + dy * dy) / (2 * sigma * sigma)));
    }
  }

  let idx = (rand() * N) | 0;
  for (let i = 0; i < N; i++) {
    taken[idx] = 1;
    rank[idx] = i;
    const x = idx % size;
    const y = (idx - x) / size;
    for (let k = 0; k < kw.length; k++) {
      const xx = (x + kdx[k] + size) % size;
      const yy = (y + kdy[k] + size) % size;
      energy[yy * size + xx] += kw[k];
    }
    if (i === N - 1) break;
    let best = -1;
    let bestE = Infinity;
    for (let j = 0; j < N; j++) {
      if (!taken[j] && energy[j] < bestE) { bestE = energy[j]; best = j; }
    }
    idx = best;
  }

  const data = new Uint8Array(N);
  for (let i = 0; i < N; i++) data[i] = Math.round((rank[i] * 255) / (N - 1));
  const tex = new THREE.DataTexture(data, size, size, THREE.RedFormat, THREE.UnsignedByteType);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}
