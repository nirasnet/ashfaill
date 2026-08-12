// Sky layers for the atmosphere system — everything between the Preetham dome
// and the first building: two scrolling perlin-alpha cloud decks (the addon
// sky's re-scaled cirrus makes layer three), a dense haze band confined BELOW
// ~5 degrees of elevation (Tavorsk-style: the skyline sinks into it, the sky
// above stays clear), and a physically-sized sun: a crisp 0.5-degree disc
// whose corona falls off as exp(-3r) in disc radii, plus one faint horizontal
// lens streak — no vertical column, nothing wide enough for bloom to smear
// into a blob. Cloud decks take the shared blue-noise tile and dither their
// output 1/255 (same treatment as the sky dome) so their smooth alpha ramps
// never band; the haze band uses three's built-in dithering flag. All
// allocations happen in init(); update() only mutates pooled objects — zero
// per-frame garbage.
import * as THREE from 'three';
import { rng } from '../utils.js';
import { BLUE_NOISE_SIZE } from './blueNoise.js';

// Everything is pinned/scaled against these. Camera far is 900 and the arena is
// ~120 m across, so: cloud planes 1700 m wide fade out at 750 m radius (before
// the far-plane could clip them), the haze cylinder sits at 600 m, and the sun
// sprites are pinned 700 m out along the sun direction.
const CLOUD_PLANE_SIZE = 1700;
const CLOUD_FADE_START = 0.26; // uv-radius where the edge fade begins (~440 m)
const CLOUD_FADE_END = 0.44;   // uv-radius where alpha hits 0 (~750 m < far)
const HAZE_RADIUS = 600;
const HAZE_HEIGHT = 82;        // band top ~= +50 m above eye -> ~4.8 deg at 600 m:
const HAZE_CENTER_Y = 11;      // dense haze CONFINED below ~5 deg elevation
const HAZE_COLOR = '#c6cfda';  // between fog #b8c4d4 and the old lift — no white
const SUN_DISTANCE = 700;
// True angular size: 0.5 deg -> 700 m * 0.008727 rad = 6.11 m disc diameter.
// The disc fills 0.25 of its texture (corona needs the rest of the quad for
// the exp(-3r) tail), so the sprite quad is 6.11 / 0.25.
const SUN_DISC_SCALE = 24.4;
const SUN_GLARE_SCALE = 30;    // ~2.5 deg streak — was 56 (~4.6 deg white wash)

const _hpos = new THREE.Vector3();

// ---- tileable value-noise fbm (shared by both cloud decks) -----------------

function makeTileableFbmTexture(size, seed, { octaves = 5, baseFreq = 4 } = {}) {
  const rand = rng(seed);
  const total = new Float32Array(size * size);
  let amp = 1.0, freq = baseFreq, norm = 0;
  for (let o = 0; o < octaves; o++) {
    // Random value lattice that wraps at `freq` — every octave tiles, so the
    // summed fbm tiles, so RepeatWrapping never shows a seam.
    const lat = new Float32Array(freq * freq);
    for (let i = 0; i < lat.length; i++) lat[i] = rand();
    for (let y = 0; y < size; y++) {
      const fy = (y / size) * freq;
      const y0 = Math.floor(fy);
      let ty = fy - y0;
      ty = ty * ty * (3 - 2 * ty);
      const ra = (y0 % freq) * freq;
      const rb = ((y0 + 1) % freq) * freq;
      for (let x = 0; x < size; x++) {
        const fx = (x / size) * freq;
        const x0 = Math.floor(fx);
        let tx = fx - x0;
        tx = tx * tx * (3 - 2 * tx);
        const xa = x0 % freq;
        const xb = (x0 + 1) % freq;
        const v =
          (lat[ra + xa] * (1 - tx) + lat[ra + xb] * tx) * (1 - ty) +
          (lat[rb + xa] * (1 - tx) + lat[rb + xb] * tx) * ty;
        total[y * size + x] += v * amp;
      }
    }
    norm += amp;
    amp *= 0.55;
    freq *= 2;
  }
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const img = g.createImageData(size, size);
  for (let i = 0; i < total.length; i++) {
    const v = Math.max(0, Math.min(255, Math.round((total[i] / norm) * 255)));
    img.data[i * 4] = v;
    img.data[i * 4 + 1] = v;
    img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  // Data texture (coverage field), NOT colour — stays in linear space.
  return tex;
}

// ---- cloud deck shader -----------------------------------------------------
// A horizontal alpha plane: two fbm samples (base + drifting detail) are
// thresholded into a coverage mask, tinted between a shaded underside and a
// sun-warmed lit colour by the view.sun angle, and faded radially so neither
// the plane edge nor the far-plane clip is ever visible. Fog is deliberately
// off — the radial fade plus the haze band do the aerial-perspective work.

const CLOUD_VERT = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vWorldPos;
  void main() {
    vUv = uv;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const CLOUD_FRAG = /* glsl */ `
  uniform sampler2D uNoise;
  uniform sampler2D uBlueNoise;
  uniform float uTime;
  uniform vec2 uWind;      // uv units / second
  uniform float uRepeat;   // noise tiles across the plane
  uniform float uCoverage; // 0..1 — how much of the deck is cloud
  uniform float uOpacity;
  uniform vec3 uSunDir;
  uniform vec3 uLitColor;
  uniform vec3 uBaseColor;
  varying vec2 vUv;
  varying vec3 vWorldPos;
  void main() {
    vec2 cuv = vUv * uRepeat + uWind * uTime;
    float a = texture2D(uNoise, cuv).r;
    float b = texture2D(uNoise, cuv * 2.63 + vec2(0.41, 0.17) + uWind * uTime * 0.6).r;
    float d = a * 0.72 + b * 0.28;
    float cut = 1.0 - uCoverage;
    float mask = smoothstep(cut, cut + 0.30, d);
    // Radial edge fade: alpha is 0 well before the far plane can clip the quad.
    float edge = 1.0 - smoothstep(${CLOUD_FADE_START.toFixed(3)}, ${CLOUD_FADE_END.toFixed(3)}, length(vUv - 0.5));
    // Sun-facing warmth vs shaded underside.
    vec3 vdir = normalize(vWorldPos - cameraPosition);
    float s = clamp(dot(vdir, uSunDir) * 0.5 + 0.5, 0.0, 1.0);
    vec3 col = mix(uBaseColor, uLitColor, s * s);
    // Denser cores read darker — cheap self-shadowing.
    float core = smoothstep(cut + 0.22, cut + 0.55, d);
    col *= mix(1.0, 0.80, core);
    float alpha = mask * edge * uOpacity;
    if (alpha < 0.004) discard;
    gl_FragColor = vec4(col, alpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    // 1/255 blue-noise dither in output space: the coverage smoothsteps are
    // silky-smooth ramps and band visibly at 8 bits without it.
    gl_FragColor.rgb += (texture2D(uBlueNoise, gl_FragCoord.xy / ${BLUE_NOISE_SIZE.toFixed(1)}).r - 0.5) * (2.0 / 255.0);
  }
`;

// ---- sprite textures -------------------------------------------------------

// 0.5-degree disc + physically-plausible corona: past the limb the intensity
// falls off as exp(-3r) with r measured in disc radii, so the glow is gone
// within ~1 degree of the centre instead of washing 15 degrees of horizon.
// Disc edge sits at 25% of the texture radius; the outer 75% carries the tail.
const DISC_EDGE = 0.25; // fraction of texture radius where the limb ends
function makeSunDiscTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  // Crisp limb-darkened disc core.
  grad.addColorStop(0.0, 'rgba(255,247,231,1.0)');
  grad.addColorStop(DISC_EDGE * 0.8, 'rgba(255,243,220,1.0)');
  grad.addColorStop(DISC_EDGE * 0.98, 'rgba(255,233,199,0.95)');
  // Corona: alpha = 0.55 * exp(-3r), r = disc radii beyond the limb. Canvas
  // gradients lerp between stops, so sample the exponential densely.
  for (let p = DISC_EDGE; p <= 1.001; p += 0.075) {
    const r = p / DISC_EDGE - 1; // 0 at the limb, 3 at the texture edge
    const a = 0.55 * Math.exp(-3 * r);
    const w = Math.min(1, r / 3); // warm slightly toward the tail
    const cr = 255, cg = Math.round(236 - 22 * w), cb = Math.round(205 - 45 * w);
    grad.addColorStop(Math.min(p, 1), `rgba(${cr},${cg},${cb},${a.toFixed(4)})`);
  }
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Lens glare: ONE faint warm horizontal streak plus a whisper of round halo.
// Deliberately no vertical streak and no bright core — the vertical column and
// wide white wash the critic flagged came from stacking additive glow here;
// the disc texture's exp(-3r) corona now owns the brightness falloff.
function makeSunGlareTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  // Whisper of round halo — warm, never white.
  let grad = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  grad.addColorStop(0.0, 'rgba(255,228,190,0.30)');
  grad.addColorStop(0.30, 'rgba(255,216,168,0.10)');
  grad.addColorStop(0.60, 'rgba(255,208,155,0.03)');
  grad.addColorStop(1.0, 'rgba(255,205,150,0.0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 256);
  // Single horizontal streak — anisotropic lens response, not bloom.
  g.globalCompositeOperation = 'lighter';
  g.save();
  g.translate(128, 128);
  g.scale(1.0, 0.06);
  grad = g.createRadialGradient(0, 0, 0, 0, 0, 128);
  grad.addColorStop(0.0, 'rgba(255,232,192,0.50)');
  grad.addColorStop(0.5, 'rgba(255,220,168,0.14)');
  grad.addColorStop(1.0, 'rgba(255,210,150,0.0)');
  g.fillStyle = grad;
  g.fillRect(-128, -128 / 0.06, 256, 256 / 0.06);
  g.restore();
  g.globalCompositeOperation = 'source-over';
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeHazeGradientTexture() {
  const c = document.createElement('canvas');
  c.width = 8;
  c.height = 256;
  const g = c.getContext('2d');
  // Canvas y=0 is texture v=1 (flipY) = the TOP of the cylinder.
  // Height-fog profile: density ~ exp(-3h), h = 0 at the horizon line, 1 at
  // the band top (~5 deg). Dense right at the skyline, gone by the band top —
  // the sky above stays clear instead of milky. Tint matches HAZE_COLOR family.
  const grad = g.createLinearGradient(0, 0, 0, 256);
  const floor = Math.exp(-3); // subtract so the band top hits EXACTLY alpha 0
  for (let i = 0; i <= 10; i++) {
    const h = 1 - i / 10;             // stop 0 = top (h=1), stop 1 = horizon (h=0)
    const a = 0.85 * (Math.exp(-3 * h) - floor) / (1 - floor);
    grad.addColorStop(i / 10, `rgba(198,207,218,${a.toFixed(4)})`);
  }
  g.fillStyle = grad;
  g.fillRect(0, 0, 8, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

// ---- the system ------------------------------------------------------------

export class SkyLayers {
  constructor() {
    this._group = null;
    this._decks = [];     // { mesh, uniforms }
    this._haze = null;
    this._sunDisc = null;
    this._sunGlare = null;
    this._blueNoise = null;
  }

  init(scene, { sunDirection, seed = 7, blueNoise = null } = {}) {
    if (!scene) return;
    this._group = new THREE.Group();
    this._group.name = 'atmosphere:skyLayers';
    scene.add(this._group);

    // Shared dither tile from atmosphere.js; a flat mid-grey 1x1 fallback
    // degrades to "no dither" instead of crashing if the caller omits it.
    this._blueNoise = blueNoise || new THREE.DataTexture(
      new Uint8Array([128]), 1, 1, THREE.RedFormat, THREE.UnsignedByteType
    );
    this._blueNoise.needsUpdate = true;

    this._buildCloudDecks(seed, sunDirection);
    this._buildHazeBand();
    this._buildSun(sunDirection);
  }

  update(dt, camera, time, sunDirection) {
    if (!this._group) return;

    for (let i = 0; i < this._decks.length; i++) {
      const u = this._decks[i].uniforms;
      u.uTime.value = time;
      if (sunDirection) u.uSunDir.value.copy(sunDirection);
    }

    // Sun disc + glare pinned at "infinity" along the (slowly drifting) sun
    // direction. Depth-tested, so the skyline occludes them correctly.
    if (camera && sunDirection) {
      _hpos.copy(camera.position).addScaledVector(sunDirection, SUN_DISTANCE);
      this._sunDisc.position.copy(_hpos);
      this._sunGlare.position.copy(_hpos);
      this._sunGlare.material.opacity = 0.14 + 0.03 * Math.sin(time * 0.9);
      // The haze band follows eye height so the horizon line stays put.
      this._haze.position.set(camera.position.x, camera.position.y + HAZE_CENTER_Y - 1.7, camera.position.z);
    }
  }

  // ---- builders ------------------------------------------------------------

  _buildCloudDecks(seed, sunDirection) {
    const noiseA = makeTileableFbmTexture(256, seed + 11);
    const noiseB = makeTileableFbmTexture(256, seed + 47);
    // Two decks with distinct height / scale / wind heading: real parallax and
    // no synchronized drift. (Deck three is the addon sky's re-scaled cirrus.)
    // Lit colours run a step warmer than the old golden-hour pass: with the
    // dawn sun at ~15 deg the sun-facing cloud edges catch sunrise amber while
    // the shaded undersides stay haze blue-grey.
    const specs = [
      {
        y: 330, noise: noiseA, repeat: 3.0, coverage: 0.50, opacity: 0.62,
        wind: new THREE.Vector2(0.0022, 0.0007),
        base: new THREE.Color(0xdfe6ec), lit: new THREE.Color(0xffe6bb),
      },
      {
        y: 245, noise: noiseB, repeat: 4.4, coverage: 0.34, opacity: 0.42,
        wind: new THREE.Vector2(0.0031, -0.0013),
        base: new THREE.Color(0xd2dae2), lit: new THREE.Color(0xffdca8),
      },
    ];
    for (const s of specs) {
      const geo = new THREE.PlaneGeometry(CLOUD_PLANE_SIZE, CLOUD_PLANE_SIZE);
      geo.rotateX(Math.PI / 2); // face down toward the arena
      const uniforms = {
        uNoise: { value: s.noise },
        uBlueNoise: { value: this._blueNoise },
        uTime: { value: 0 },
        uWind: { value: s.wind },
        uRepeat: { value: s.repeat },
        uCoverage: { value: s.coverage },
        uOpacity: { value: s.opacity },
        uSunDir: { value: sunDirection ? sunDirection.clone() : new THREE.Vector3(0, 1, 0) },
        uLitColor: { value: s.lit },
        uBaseColor: { value: s.base },
      };
      const mat = new THREE.ShaderMaterial({
        uniforms,
        vertexShader: CLOUD_VERT,
        fragmentShader: CLOUD_FRAG,
        transparent: true,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.y = s.y;
      mesh.renderOrder = 2;
      mesh.frustumCulled = false; // huge quad, always partially in view
      mesh.userData.noHit = true;
      this._group.add(mesh);
      this._decks.push({ mesh, uniforms });
    }
  }

  _buildHazeBand() {
    const geo = new THREE.CylinderGeometry(HAZE_RADIUS, HAZE_RADIUS, HAZE_HEIGHT, 48, 1, true);
    const mat = new THREE.MeshBasicMaterial({
      map: makeHazeGradientTexture(),
      color: HAZE_COLOR,
      transparent: true,
      depthWrite: false,
      side: THREE.BackSide, // seen from inside
      fog: false,           // it IS the fog's far end — fogging it would double up
      dithering: true,      // its exp alpha ramp bands at 8 bits without this
    });
    this._haze = new THREE.Mesh(geo, mat);
    this._haze.position.y = HAZE_CENTER_Y;
    this._haze.renderOrder = 1;
    this._haze.frustumCulled = false;
    this._haze.userData.noHit = true;
    this._group.add(this._haze);
  }

  _buildSun(sunDirection) {
    // Crisp photometric disc — normal blending so it stays a disc over any sky.
    this._sunDisc = new THREE.Sprite(new THREE.SpriteMaterial({
      map: makeSunDiscTexture(),
      transparent: true,
      depthWrite: false,
      fog: false,
    }));
    this._sunDisc.scale.set(SUN_DISC_SCALE, SUN_DISC_SCALE, 1);
    this._sunDisc.renderOrder = 1;
    this._group.add(this._sunDisc);

    // Faint horizontal lens streak — additive but small and dim, tuned to sit
    // BELOW the bloom threshold so postfx cannot smear it into a blob.
    this._sunGlare = new THREE.Sprite(new THREE.SpriteMaterial({
      map: makeSunGlareTexture(),
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      opacity: 0.14,
      fog: false,
    }));
    this._sunGlare.scale.set(SUN_GLARE_SCALE, SUN_GLARE_SCALE, 1);
    this._sunGlare.renderOrder = 1;
    this._group.add(this._sunGlare);

    if (sunDirection) {
      _hpos.copy(sunDirection).multiplyScalar(SUN_DISTANCE).add(new THREE.Vector3(0, 1.7, 0));
      this._sunDisc.position.copy(_hpos);
      this._sunGlare.position.copy(_hpos);
    }
  }
}
