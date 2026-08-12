// ATMOSPHERE / LIGHTING — owns: sky, sun, IBL environment, fog, distant scenery mood.
//
// FIRST-LIGHT DAWN over a warzone. Time-of-day fiction is now consistent with
// the menu ("TASK FORCE EMBER — NIGHT OPERATION // 03:41 LOCAL", owned by hud):
// the op stepped off in the dark and gameplay is the tail end of it — sun just
// clear of the rooftops at ~15.5 deg, deep warm key, long hard shadows, cool
// blue-grey fill. No more noon-blue sky over a "night op".
//
// The rig, per the AAA art-director pass:
//  - SUN: 3-cascade CSM (three/addons CSM) fitted over the first 80 m of the
//    view frustum. Cascade 0 covers ~0-14 m at 2048px (~2 cm texels) so a 40 m
//    tower band across the plaza has a razor edge under PCF. All CSM lights
//    share the warm dawn key colour; materials from OTHER subsystems are
//    patched lazily at runtime (chain-preserving — see _setupCsmMaterial).
//  - SHADOW TINT: shadows must read blue-grey #30384a, never black. THREE has
//    no shadow-colour knob, so the tint IS the fill: hemisphere sky #a8c0dd /
//    ground #6b665f at an intensity chosen so dark asphalt (~#3a3a3e albedo)
//    in full shadow resolves to ~#30384a after ACES. Warm-grey ground bounce
//    (not pink-brown) kills the old mauve/magenta ambient bias.
//  - FOG: FogExp2 #b9c6d8 at 0.0045 — real aerial perspective now. ~5% mix at
//    55 m (arena stays crisp), ~37% at 150 m, and the 300 m skyline lifts
//    hard toward the horizon colour instead of reading as a crisp cardboard
//    cutout. The dense sub-5-deg haze band in skyLayers is the height-fog
//    component; FogExp2 is the distance component.
//  - SKY: Preetham dome (addon Sky), banding killed with a 64x64 blue-noise
//    1/255 dither injected after the colourspace conversion (blueNoise.js).
//    skyLayers.js stacks the CoD-reference decks on top — two scrolling
//    perlin-alpha cloud planes (the re-scaled addon cirrus is deck three, all
//    blue-noise dithered too), the horizon haze band, and a true 0.5-degree
//    sun disc with exp(-3r) corona. Addon disc off, mie tight and low.
//  - IBL: PMREM from a twin sky + warm-GREY ground plane so shaded facades
//    get sky blue from above and neutral bounce from below.
// src/atmosphere/ambientLife.js adds the cheap life: dust, smoke, birds.
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { CSM } from 'three/addons/csm/CSM.js';
import { AmbientLife } from './atmosphere/ambientLife.js';
import { SkyLayers } from './atmosphere/skyLayers.js';
import { makeBlueNoiseTexture, BLUE_NOISE_SIZE } from './atmosphere/blueNoise.js';

// ---- Tuning ---------------------------------------------------------------
const SKY_SETTINGS = {
  turbidity: 6.0,          // dawn haze in the dome without going milk-white
  rayleigh: 2.4,           // low sun + this rayleigh = warm horizon, cool zenith
  mieCoefficient: 0.002,   // LOW: the dome must not paint a wide white blob —
                           // the 0.5-deg disc + exp corona in skyLayers IS the sun
  mieDirectionalG: 0.90,   // tighter forward lobe: halo hugs the disc, not 15 deg
  // Addon cirrus = cloud deck three (skyLayers.js owns decks one and two).
  // NOTE: the shader multiplies cloudScale by 1000 — values much below ~0.001
  // sample under one noise period across the dome and render as NO clouds.
  cloudCoverage: 0.42,
  cloudDensity: 0.25,      // thin, high — the low daylight term keeps them moody
  cloudScale: 0.0032,
  cloudSpeed: 0.000022,    // slow drift, driven by ctx.time
  cloudElevation: 0.55,
};
const SUN_BASE = {
  // DAWN: 15.5 deg is just over the 16-18 m perimeter rooflines seen from the
  // plaza centre (they cut ~15 deg at 55 m), so direct sun rakes IN across the
  // arena instead of being fully walled out, while every tower shadow runs
  // 3.6x its height — a 40 m tower throws a ~145 m hard band across the plaza,
  // and the sun-side half of the arena sits in one giant perimeter shadow with
  // lit corridors streaming through the street gaps. Azimuth 55 keeps the key
  // pouring through the +x street gap onto the facades the street and upward
  // cameras actually frame.
  elevation: 15.5,         // degrees above horizon — first light
  azimuth: 55.0,           // degrees
};
const SUN_COLOR = 0xffb87c;      // dawn gold-orange — a full step warmer than the
                                 // old golden-hour 0xffcb96; the key must read
                                 // like sunrise against the blue-grey fill
const SUN_INTENSITY = 15.0;      // ground direct = 15*sin(15.5deg) ~ 4.0 vs ~1.5
                                 // fill irradiance -> lit plaza streaks hold a
                                 // clear ~2.7:1 over the shadow floor; sun-facing
                                 // facades peak ~14 and ACES rolls the top off
const ENV_INTENSITY = 0.5;       // sky/ground IBL: directional ambient, kept well
                                 // below the key so shadow sides stay COOL not bright
// The VISIBLE dome keeps rayleigh 2.4 (deep believable blue), but using that
// same sky for the IBL made every ambient-lit surface saturated cobalt.
// Real dawn fill is a pale desaturated blue-grey: the env sky bakes with its
// own lower rayleigh + higher turbidity so the FILL is grey-blue while the
// dome overhead stays rich.
const ENV_SKY_OVERRIDES = { rayleigh: 1.4, turbidity: 8.0 };
// Critic-specified ambient: sky term #a8c0dd, ground bounce warm grey #6b665f.
// The old #a8b2c0/#6a6258 pair mixed with the pink-brown env bounce into the
// mauve cast on the ground; these two + the neutral env ground remove it.
const HEMI_SKY = 0xa8c0dd;
const HEMI_GROUND = 0x6b665f;
const HEMI_INTENSITY = 2.2;      // sized against SHADOW_TINT and MEASURED, not
                                 // just computed: postfx runs an S-curve grade +
                                 // vignette after ACES that eats ~40% of the
                                 // shadow floor, so the raw fill must land ABOVE
                                 // the target. Screenshot probe at 1.25 read
                                 // mid-frame shadow asphalt #14181f-#212933
                                 // (near-black); 2.2 lands it in the #30384a
                                 // blue-grey zone with detail intact
const SHADOW_TINT = 0x30384a;    // TARGET shadow colour on plaza asphalt
                                 // (documentation constant — realised via the
                                 // hemisphere/env fill above, three.js has no
                                 // direct shadow-tint input)
const FOG_COLOR = 0xb9c6d8;      // critic-specified, matched to the haze horizon
const FOG_DENSITY = 0.0045;      // exp2: ~5% @55m, ~37% @150m, ~85% @300m —
                                 // distant towers desaturate and lift into the
                                 // sky instead of reading as a crisp diorama
const GROUND_BOUNCE = 0x6b665f;  // env-bake ground plane: warm GREY (was pink-
                                 // brown #8f7358 — the other half of the mauve)
const CSM_CASCADES = 3;          // critic: 3-4 cascade CSM over ~80 m
const CSM_MAX_FAR = 80;          // cascades fit 0-80 m of view depth; beyond
                                 // that the last light applies unshadowed and
                                 // FOG owns the read
const CSM_MAP_SIZE = 2048;       // 3x2048 = LESS fill than the old 1x4096 over
                                 // a 176 m box, at far higher near-field density
const CSM_NORMAL_BIAS = [0.06, 0.12, 0.22]; // ~2 texels per cascade: no acne at
                                            // grazing dawn angles, no peter-pan
const SKY_DOME_SCALE = 850;      // box half-extent 425 -> corners stay inside far=900

/** Inject the 1/255 blue-noise dither into the addon Sky's fragment shader,
 *  AFTER tonemap + colourspace so it dithers exactly the 8-bit output values
 *  where the banding lives (menu.png / combat.png sky gradient). */
function ditherSkyMaterial(mat, noiseTex) {
  mat.fragmentShader = mat.fragmentShader
    .replace(
      'uniform float time;',
      'uniform float time;\n\t\tuniform sampler2D blueNoiseTex;'
    )
    .replace(
      '#include <colorspace_fragment>',
      '#include <colorspace_fragment>\n' +
      `\t\t\tgl_FragColor.rgb += ( texture2D( blueNoiseTex, gl_FragCoord.xy / ${BLUE_NOISE_SIZE.toFixed(1)} ).r - 0.5 ) * ( 2.0 / 255.0 );`
    );
  mat.uniforms.blueNoiseTex = { value: noiseTex };
}

export class AtmosphereSystem {
  constructor() {
    this.sunDirection = new THREE.Vector3(0, 1, 0); // unit, scene -> sun (postfx may read)
    this.sunColor = new THREE.Color(SUN_COLOR);
    this.sunLight = null;   // brightest CSM cascade light after init
    this.hemiLight = null;
    this.sky = null;
    this.envMap = null;
    this._ready = false;
    this._t = 0;
    this._elev = SUN_BASE.elevation;
    this._azim = SUN_BASE.azimuth;
    this._fog = null;
    this._life = null;
    this._skyLayers = null;
    this._envRT = null;
    this._scene = null;
    this._csm = null;
    this._csmDir = new THREE.Vector3(0, -1, 0); // scene -> away from sun (CSM convention)
    this._csmSeen = new WeakSet(); // materials already inspected for CSM patching
    this._camAspect = 0;
    this._camFov = 0;
    this._blueNoise = null;
    this._applySunDirection();
  }

  async init(ctx) {
    const renderer = ctx?.renderer;
    const scene = ctx?.scene;
    const camera = ctx?.camera;
    if (!renderer || !scene) return; // engine failed upstream; stay inert, never throw
    if (ctx) ctx.atmosphere = this;  // let other systems (postfx god rays) find us
    this._scene = scene;

    this._applySunDirection();
    this._blueNoise = makeBlueNoiseTexture(BLUE_NOISE_SIZE, 20260811);

    // ---- Sky dome (visible backdrop, follows the camera) -------------------
    // The addon's own sun disc stays OFF: skyLayers draws the real 0.5-degree
    // disc + exp(-3r) corona, so the sun is an object, not a bloom source.
    // Blue-noise dither injected post-colourspace kills the gradient banding.
    this.sky = new Sky();
    this.sky.scale.setScalar(SKY_DOME_SCALE);
    this.sky.frustumCulled = false;
    this.sky.userData.noHit = true;
    this._applySkySettings(this.sky.material.uniforms, /*showSunDisc*/ 0);
    ditherSkyMaterial(this.sky.material, this._blueNoise);
    scene.add(this.sky);

    // ---- PMREM environment: twin sky + warm-grey ground bounce -------------
    // The Preetham model returns the horizon colour for every below-horizon
    // direction, so a sky-only env gives flat constant ambient underneath.
    // Baking a ground disc into the env scene means upward-facing IBL lobes
    // read sky blue while downward lobes pick up NEUTRAL street bounce (a warm
    // pink-brown here was half of the old mauve ground cast).
    const pmrem = new THREE.PMREMGenerator(renderer);
    const envScene = new THREE.Scene();
    const envSky = new Sky();
    envSky.scale.setScalar(80); // fits inside PMREM cube camera's default far=100
    this._applySkySettings(envSky.material.uniforms, /*showSunDisc*/ 0);
    envSky.material.uniforms.cloudCoverage.value = 0; // clean IBL, no cloud blotches
    // Desaturated dawn fill (see ENV_SKY_OVERRIDES note above).
    envSky.material.uniforms.rayleigh.value = ENV_SKY_OVERRIDES.rayleigh;
    envSky.material.uniforms.turbidity.value = ENV_SKY_OVERRIDES.turbidity;
    envScene.add(envSky);
    envScene.add(this._makeEnvGround());
    this._envRT = pmrem.fromScene(envScene, 0.035); // touch of blur kills fireflies
    pmrem.dispose(); // generator only — the render target lives for the whole game
    this.envMap = this._envRT.texture;
    scene.environment = this.envMap;
    scene.environmentIntensity = ENV_INTENSITY;

    // ---- Fog: the distance half of the aerial perspective ------------------
    // Exp2 at 0.0045 in horizon blue-grey: the arena (<60 m) keeps its
    // contrast, the mid ring softens, the 300 m skyline melts toward the sky.
    // The HEIGHT half is the skyLayers haze band confined below ~5 deg.
    this._fogColor = new THREE.Color(FOG_COLOR);
    scene.fog = new THREE.FogExp2(this._fogColor, FOG_DENSITY);
    this._fog = scene.fog;
    scene.background = this._fogColor.clone(); // painted over by the sky dome

    // ---- Sun: 3-cascade CSM, fitted to the near 80 m of frustum ------------
    // Replaces the old single 4096 ortho light whose 176 m box spread its
    // texels so thin (and its normalBias so fat) that no building threw a
    // readable band on the plaza. Cascade texels: ~2 cm / ~4 cm / ~7 cm.
    if (camera) {
      const csm = new CSM({
        camera,
        parent: scene,
        cascades: CSM_CASCADES,
        maxFar: CSM_MAX_FAR,
        mode: 'practical',
        shadowMapSize: CSM_MAP_SIZE,
        shadowBias: -0.00005,
        lightDirection: this._csmDir.copy(this.sunDirection).negate(),
        lightIntensity: SUN_INTENSITY,
        lightMargin: 300, // dawn shadows are LONG: catch 40 m towers ~200+ m up-sun
      });
      csm.fade = true; // soften the cascade handoffs (not the shadow edges)
      csm.updateFrustums();
      for (let i = 0; i < csm.lights.length; i++) {
        const l = csm.lights[i];
        l.color.set(SUN_COLOR);
        l.shadow.normalBias = CSM_NORMAL_BIAS[i] ?? 0.2;
      }
      this._csm = csm;
      this.sunLight = csm.lights[0];
      this._camAspect = camera.aspect;
      this._camFov = camera.fov;
      // Whatever already exists gets patched now; everything spawned later is
      // caught by the per-frame sweep in update() before it first renders.
      this._patchWorldMaterials();
    }

    // ---- Hemisphere fill: THE shadow tint ----------------------------------
    // sky #a8c0dd / ground #6b665f (critic-specified) at an intensity sized so
    // full-shadow asphalt reads ~SHADOW_TINT (#30384a): blue-grey, never black,
    // never mauve. This is deliberately the strongest fill in the rig — the
    // CSM key is ~3.5x it on lit horizontals, so modeling survives.
    this.hemiLight = new THREE.HemisphereLight(HEMI_SKY, HEMI_GROUND, HEMI_INTENSITY);
    scene.add(this.hemiLight);

    // ---- Sky layers: cloud decks, horizon haze band, sun disc + glare ------
    this._skyLayers = new SkyLayers();
    this._skyLayers.init(scene, {
      sunDirection: this.sunDirection,
      seed: 20260811,
      blueNoise: this._blueNoise,
    });

    // ---- Cheap life: dust, smoke columns, birds, sun glow cards ------------
    this._life = new AmbientLife();
    this._life.init(scene, renderer, { sunDirection: this.sunDirection, seed: 20260811 });

    this._ready = true;
  }

  update(dt, ctx) {
    if (!this._ready) return;
    this._t += dt;
    const t = ctx?.time ?? this._t;
    const cam = ctx?.camera;

    // Ultra-slow sun drift — imperceptible per-frame, alive over minutes.
    // Small enough that the baked environment map stays visually correct.
    this._elev = SUN_BASE.elevation + 0.45 * Math.sin(t * 0.0055);
    this._azim = SUN_BASE.azimuth + 0.9 * Math.sin(t * 0.0034);
    this._applySunDirection();

    // Sky dome follows the camera (horizon stays at eye level, never clips far).
    if (cam) this.sky.position.copy(cam.position);
    const u = this.sky.material.uniforms;
    u.time.value = t; // drives the addon's procedural cloud drift
    u.sunPosition.value.copy(this.sunDirection);

    // CSM: track the sun drift and the camera, refit the cascades on FOV /
    // aspect changes (ADS zoom, window resize), then sweep for materials other
    // systems spawned this frame — they must be patched BEFORE first render or
    // they'd be lit once per cascade light.
    if (this._csm && cam) {
      this._csmDir.copy(this.sunDirection).negate(); // same Vector3 the CSM holds
      if (cam.aspect !== this._camAspect || cam.fov !== this._camFov) {
        this._camAspect = cam.aspect;
        this._camFov = cam.fov;
        this._csm.updateFrustums();
      }
      cam.updateMatrixWorld();
      this._csm.update();
      this._patchWorldMaterials();
    }

    // Haze breathing: two slow sines so it never reads as a loop. Kept small —
    // the aerial perspective must stay reliably present in gameplay frames.
    if (this._fog) {
      this._fog.density =
        FOG_DENSITY * (1 + 0.04 * Math.sin(t * 0.043) + 0.02 * Math.sin(t * 0.011));
    }

    this._skyLayers?.update(dt, cam, t, this.sunDirection);
    this._life?.update(dt, cam, t, this.sunDirection);
  }

  // ---- internals -----------------------------------------------------------

  /** Sweep the scene for lit materials that CSM hasn't patched yet. Runs every
   *  frame (WeakSet-guarded, no allocation, a few thousand flag checks) because
   *  enemies/effects/weapons create materials at arbitrary times and an
   *  unpatched lit material would receive all three cascade lights at once. */
  _patchWorldMaterials() {
    const seen = this._csmSeen;
    this._scene.traverse((o) => {
      const m = o.material;
      if (!m) return;
      if (Array.isArray(m)) {
        for (let i = 0; i < m.length; i++) {
          if (!seen.has(m[i])) this._setupCsmMaterial(m[i]);
        }
      } else if (!seen.has(m)) {
        this._setupCsmMaterial(m);
      }
    });
  }

  /** csm.setupMaterial, but CHAIN-PRESERVING: other subsystems hang their own
   *  onBeforeCompile on their materials (e.g. the enemy silhouette rim), and
   *  the stock CSM helper would clobber it. Compose both, and extend the
   *  program cache key so patched variants never collide in the program cache. */
  _setupCsmMaterial(m) {
    this._csmSeen.add(m);
    // Only lit built-in materials understand the CSM light loop. Unlit ones
    // (basic/sprite/points/our sky shaders) ignore directional lights entirely.
    if (!(m.isMeshStandardMaterial || m.isMeshPhysicalMaterial ||
          m.isMeshLambertMaterial || m.isMeshPhongMaterial || m.isMeshToonMaterial)) {
      return;
    }
    const hadOwnCompile = Object.prototype.hasOwnProperty.call(m, 'onBeforeCompile');
    const prevCompile = m.onBeforeCompile;
    const hadOwnKey = Object.prototype.hasOwnProperty.call(m, 'customProgramCacheKey');
    const prevKey = m.customProgramCacheKey;
    this._csm.setupMaterial(m); // sets defines + its own onBeforeCompile
    if (hadOwnCompile) {
      const csmCompile = m.onBeforeCompile;
      m.onBeforeCompile = function (shader, renderer) {
        prevCompile.call(this, shader, renderer);
        csmCompile.call(this, shader, renderer);
      };
      m.customProgramCacheKey = hadOwnKey
        ? function () { return prevKey.call(this) + '|csm'; }
        : function () { return prevCompile.toString() + '|csm'; };
    }
    m.needsUpdate = true;
  }

  /** Ground disc for the PMREM env scene: warm-GREY street tone in the middle
   *  blending to the haze grey at the rim, so the lower IBL hemisphere is a
   *  smooth bounce-to-horizon gradient instead of a constant colour. Neutral
   *  by design — a saturated warm here reads as magenta once it mixes with the
   *  blue sky term on horizontal surfaces. */
  _makeEnvGround() {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    const warm = new THREE.Color(GROUND_BOUNCE);
    const haze = new THREE.Color(FOG_COLOR);
    const mid = warm.clone().lerp(haze, 0.45);
    // getStyle() emits sRGB — Color channels are linear working space.
    grad.addColorStop(0.0, warm.getStyle());
    grad.addColorStop(0.55, mid.getStyle());
    grad.addColorStop(1.0, haze.getStyle());
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const geo = new THREE.CircleGeometry(60, 40); // well inside PMREM far=100
    geo.rotateX(-Math.PI / 2);
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: tex }));
    mesh.position.y = -2;
    return mesh;
  }

  _applySunDirection() {
    const phi = THREE.MathUtils.degToRad(90 - this._elev);
    const theta = THREE.MathUtils.degToRad(this._azim);
    this.sunDirection.setFromSphericalCoords(1, phi, theta);
  }

  _applySkySettings(u, showSunDisc) {
    u.turbidity.value = SKY_SETTINGS.turbidity;
    u.rayleigh.value = SKY_SETTINGS.rayleigh;
    u.mieCoefficient.value = SKY_SETTINGS.mieCoefficient;
    u.mieDirectionalG.value = SKY_SETTINGS.mieDirectionalG;
    u.cloudCoverage.value = SKY_SETTINGS.cloudCoverage;
    u.cloudDensity.value = SKY_SETTINGS.cloudDensity;
    u.cloudScale.value = SKY_SETTINGS.cloudScale;
    u.cloudSpeed.value = SKY_SETTINGS.cloudSpeed;
    u.cloudElevation.value = SKY_SETTINGS.cloudElevation;
    u.showSunDisc.value = showSunDisc;
    u.sunPosition.value.copy(this.sunDirection);
  }
}
