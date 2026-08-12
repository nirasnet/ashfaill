// POST-PROCESSING — owns: the composer chain + final image grading.
//
// Pipeline (pmndrs postprocessing + n8ao, all LINEAR HDR half-float until the
// ACES tone map — nothing in the chain is allowed to gamma-encode early):
//   RenderPass (scene -> HDR buffer)
//   N8AOPostPass (contact-shadow AO; gammaCorrection FORCED OFF — its default
//                 `true` was sRGB-encoding the buffer mid-chain, which blew the
//                 mids into ACES clip range and crushed the AO term invisible)
//   EffectPass [SMAA HIGH]                       (convolution, own pass)
//   EffectPass [Bloom -> ACES tone map -> grade (teal/orange + S-curve +
//               midtone magenta pull + filmic shadow toe) -> hue/sat
//               (90% global saturation)]
//   EffectPass [radial CA (px-capped, corner-only) -> vignette -> film grain]
//
// The renderer's built-in tone mapping is disabled here (the composer's ACES
// effect does it); renderer.toneMappingExposure still feeds the ACES curve, so
// it doubles as the per-frame exposure lever (muzzle-flash kick, death dim).
//
// Gameplay hooks (all EventBus events, all ctx reads guarded):
//   'weapon:fire'   -> tiny exposure/flash kick
//   'player:damage' -> quick vignette pulse + chromatic aberration spike
//   ctx.player.health < 35 -> red tinge + partial desaturation (smoothed)
//   'game:over'     -> slow death desaturation + slight exposure fade
//   'game:start'    -> reset all dynamic state
import * as THREE from 'three';
import {
  EffectComposer,
  RenderPass,
  EffectPass,
  SMAAEffect,
  SMAAPreset,
  EdgeDetectionMode,
  BloomEffect,
  ToneMappingEffect,
  ToneMappingMode,
  VignetteEffect,
  HueSaturationEffect,
} from 'postprocessing';
import { N8AOPostPass } from 'n8ao';
import { CinematicGradeEffect } from './postfx/gradeEffect.js';
import { LensChromaticAberrationEffect } from './postfx/caEffect.js';
import { FilmGrainEffect } from './postfx/grainEffect.js';

// --- Grade tuning (the "cinematic shooter" look) ---------------------------
// ACES filmic at 0.85: with the chain kept linear (see the n8ao gamma note
// below) this holds the sun's mid-ground bounce below clip instead of letting
// the sky eat the center of the frame.
//
// AAA art-director pass (tonal directives, applied together):
//   - Exposure pulled -0.5 EV (1.0 -> 0.71): white concrete barrier tops and
//     sunlit facade tops were clipping to pure white in street/combat frames.
//     ACES mid gray moves 0.267 -> 0.176 tonemapped-linear (~0.55 -> ~0.46
//     display), and the concrete tops drop back onto the ACES shoulder.
//     (Verified: three's WebGLRenderer uploads toneMappingExposure to any
//     program declaring it, and postprocessing's ACES_FILMIC mode uses three's
//     ACESFilmicToneMapping chunk — so the renderer exposure genuinely feeds
//     the composer's tone map.)
//   - Midtone contrast is restored by a gentle S-curve INSIDE the grade
//     (gradeEffect.js `sCurve` 0.35, pivot at perceptual mid gray via a
//     gamma-2 domain) — the old linear BrightnessContrastEffect pass is
//     DELETED; a linear contrast op on tonemapped-linear data pivots around
//     display ~0.74 and mostly crushed shadows, which is not "midtone
//     contrast". The grade's midGamma also drops 1.2 -> 1.05: its old job
//     (fighting the ACES mid lift) is done by the exposure cut now, and
//     stacking both landed mids at a muddy ~0.39 display.
//   - Magenta cast in the mids (the purple-gray asphalt in street.png) is
//     pulled by a luma-neutral green tilt, LGG gamma "magenta -6"
//     (gradeEffect.js `midGreen` 0.06, weighted to midtones only).
//   - Global saturation to ~90%: BASE_SATURATION -0.10. The old +0.13 boost
//     was AMPLIFYING chroma noise — distant window texels alias into
//     magenta/green speckle along facade edges, and a saturation boost turns
//     that speckle into the "stray magenta dashes" called out in review.
const BASE_EXPOSURE = 0.71;      // -0.5 EV from 1.0 (2^-0.5)
const BASE_VIGNETTE_DARKNESS = 0.32;
const VIGNETTE_OFFSET = 0.3;
const BASE_SATURATION = -0.10;   // ~90% global saturation (was +0.13 boost)

// Bloom: threshold in LINEAR luminance. Scene luminance ladder (level/
// materials.js, atmosphere/skyLayers.js, effects.js):
//   window emissive stickers  <= ~1.25
//   sun-lit smoke / bright sky ~ 1.0-1.3
//   sun disc core (+ glare)    ~ 1.7
//   muzzle star                ~ 6
// Art-review fix for the firefly speckles on bright building edges
// (combat.png): the old 1.5 threshold with a razor knee (0.1) made single
// aliased edge texels flip fully in/out of bloom frame to frame — that
// binary gate IS the sparkle. Threshold 1.1 with a 0.6 soft knee ramps
// contribution over 1.1-1.7 luminance, so subpixel speckle gets a whisper
// of bloom instead of a popping star, while the sun (1.7) and muzzle
// flashes (6) still bloom fully. Intensity stays capped at 0.3.
const BLOOM_THRESHOLD = 1.1;
const BLOOM_SMOOTHING = 0.6;       // soft knee: ramp spans 1.1 -> 1.7
const BLOOM_INTENSITY = 0.3;
const BLOOM_RADIUS = 0.8;

// Chromatic aberration in OUTPUT PIXELS (the effect converts via texelSize).
// Art-review cut (~80%): rest state 0.6 px -> 0.12 px — genuinely sub-pixel,
// so facades and window edges carry ZERO visible fringe at rest. The profile
// is fully radial: exactly zero at screen center, dead inside the inner 30%
// of the corner radius, squared-smoothstep (quadratic-onset) growth, full
// strength only at the exact frame corners (see postfx/caEffect.js — the mask
// is normalized to CORNER distance, not edge midpoints). Damage pulses are
// hard-capped at 0.9 px at the corners — ~0.06% of a 1600 px frame, well
// under the 0.3% art-direction ceiling; the 0.12 px rest state is ~0.008%.
const BASE_CA_PX = 0.12;
const CA_MAX_PX = 0.9;
const CA_MASK_INNER = 0.3;         // dead zone: inner 30% of corner distance

// Film grain: signed, luminance-weighted, hashed at output resolution and
// re-seeded per frame (see postfx/grainEffect.js).
const GRAIN_AMOUNT = 0.03;

// Ambient occlusion (N8AO). Radius in meters — 0.5 m contact grounding for
// building bases, barriers, sandbags, enemies (art-director spec: "radius
// 0.5 m, intensity ~0.35"); falloff ~radius/5. NOTE on intensity semantics:
// n8ao applies `pow(ao, intensity)` (an exponent — verified at
// n8ao/dist/N8AO.js:669 `float finalAo = pow(texel.r, intensity);`), not a
// blend weight — a literal 0.35 there would LIFT the AO toward white and
// erase it. The directive's "intensity 0.35" is a GTAO-style blend weight,
// i.e. ~35% darkening at a typical wall-ground junction where the raw
// hemisphere occlusion is ~0.8: pow(0.8, 2.0) = 0.64 — so 2.0 is the
// equivalent exponent here.
// Why AO read as ABSENT before despite intensity 1.8: the grade's +0.035
// additive floor lift was re-brightening exactly the near-black crease pixels
// AO produced (0.02 -> 0.055 linear is ~2.7x), and denoiseRadius 12 smeared a
// 0.5 m contact gradient into its unoccluded neighborhood. The tint lift is
// now floor-preserving and the denoise radius is 8. The grade DOES carry a
// small filmic shadow toe again (+0.02, falls to zero by luma ~0.22 —
// gradeEffect.js `shadowToe`) because the floor-preserving-only setup crushed
// shadowed asphalt to an unreadable slab; at 0.02 an AO crease still sits
// visibly below its lifted surroundings (0.02+toe vs 0.06+toe keeps ~1.5x
// display separation), so contact shadows keep reading.
const AO_RADIUS = 0.5;
const AO_DISTANCE_FALLOFF = 0.1;
const AO_INTENSITY = 2.0;

// --- Dynamics tuning --------------------------------------------------------
const FLASH_KICK_ADD = 0.05;       // exposure kick per shot (multiplier delta)
const FLASH_KICK_MAX = 0.14;
const FLASH_DECAY = 1.4;           // /s — a shot flash lives ~0.1 s
const DAMAGE_PULSE_DECAY = 2.4;    // /s
const CHROMA_PULSE_DECAY = 3.2;    // /s
const LOW_HEALTH_THRESHOLD = 35;   // ctx.player.health scale 0..100
const DEATH_FADE_RATE = 1.6;       // /s exponential approach
const LOW_HEALTH_SMOOTH = 6.0;     // /s exponential approach

export class PostFxSystem {
  constructor() {
    this._composer = null;
    this._renderer = null;
    // Dynamic grade state (all scalars, zero per-frame allocation).
    this._flashKick = 0;      // additive exposure multiplier from weapon fire
    this._damagePulse = 0;    // vignette pulse 0..1
    this._chromaPulse = 0;    // chromatic aberration pulse 0..1
    this._lowHealth = 0;      // smoothed 0..1 "how hurt are we"
    this._dead = false;
    this._deathFade = 0;      // 0..1 eased after game:over
    this._lastTickTime = -1;  // dedup guard: update() may run from render()
    // Effects (assigned in init).
    this._grade = null;
    this._vignette = null;
    this._chroma = null;
    // Stays null unless init succeeds — main.js falls back to a plain
    // renderer.render() whenever this is falsy.
    this.render = null;
  }

  async init(ctx) {
    const renderer = ctx?.renderer;
    const scene = ctx?.scene;
    const camera = ctx?.camera;
    if (!renderer || !scene || !camera) return;

    try {
      // The composer owns tone mapping from here on.
      renderer.toneMapping = THREE.NoToneMapping;
      renderer.toneMappingExposure = BASE_EXPOSURE;
      this._renderer = renderer;

      const composer = new EffectComposer(renderer, {
        frameBufferType: THREE.HalfFloatType,
      });
      composer.addPass(new RenderPass(scene, camera));

      // --- Ambient occlusion: grounding contact shadows, not dirt ----------
      const bufferSize = renderer.getDrawingBufferSize(new THREE.Vector2());
      const n8ao = new N8AOPostPass(scene, camera, bufferSize.width, bufferSize.height);
      // CRITICAL: n8ao's compositor gamma-corrects by default (sRGB OETF).
      // Mid-chain that lifts linear mids ~2.2x before bloom/ACES — the frame
      // clips to white AND the AO term gets washed out. Keep the chain linear;
      // the ACES effect is the one and only transfer at the end.
      n8ao.configuration.gammaCorrection = false;
      n8ao.configuration.aoRadius = AO_RADIUS;
      n8ao.configuration.distanceFalloff = AO_DISTANCE_FALLOFF;
      n8ao.configuration.intensity = AO_INTENSITY;
      n8ao.configuration.aoSamples = 16;
      n8ao.configuration.denoiseSamples = 8;
      // 12 blurred the 0.6 m contact gradient into invisibility; 8 keeps the
      // crease tight while 16 AO samples still denoise clean at this radius.
      n8ao.configuration.denoiseRadius = 8;
      n8ao.configuration.screenSpaceRadius = false; // radius is in meters
      composer.addPass(n8ao);

      // --- Anti-aliasing (convolution effect — needs its own pass) ---------
      const smaa = new SMAAEffect({
        preset: SMAAPreset.HIGH,
        edgeDetectionMode: EdgeDetectionMode.COLOR,
      });
      composer.addPass(new EffectPass(camera, smaa));

      // --- HDR bloom -> ACES -> grade (single merged pass) ------------------
      const bloom = new BloomEffect({
        mipmapBlur: true,
        luminanceThreshold: BLOOM_THRESHOLD,
        luminanceSmoothing: BLOOM_SMOOTHING,
        intensity: BLOOM_INTENSITY,
        radius: BLOOM_RADIUS,
        levels: 8,
      });
      const toneMapping = new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC });
      // Grade owns the midtone S-curve + magenta pull now — there is NO
      // separate linear contrast pass (see the tonal-chain note above).
      const grade = new CinematicGradeEffect(); // teal<->orange + sCurve + midGreen
      const hueSat = new HueSaturationEffect({ saturation: BASE_SATURATION });
      composer.addPass(new EffectPass(camera, bloom, toneMapping, grade, hueSat));

      // --- Lens character: CA (convolution) + vignette + grain --------------
      const chroma = new LensChromaticAberrationEffect({
        offsetPx: BASE_CA_PX,
        maxOffsetPx: CA_MAX_PX,
        maskInner: CA_MASK_INNER,
      });
      const vignette = new VignetteEffect({
        offset: VIGNETTE_OFFSET,
        darkness: BASE_VIGNETTE_DARKNESS,
      });
      const grain = new FilmGrainEffect({ amount: GRAIN_AMOUNT });
      composer.addPass(new EffectPass(camera, chroma, vignette, grain));

      this._composer = composer;
      this._grade = grade;
      this._vignette = vignette;
      this._chroma = chroma;

      this._bindEvents(ctx);

      // Live only once the whole chain built successfully.
      this.render = (dt, rctx) => {
        // main.js's updateOrder doesn't tick postfx — drive the dynamic grade
        // from here, but skip if update() already ran this frame.
        if (rctx?.time === undefined || rctx.time !== this._lastTickTime) {
          this.update(dt, rctx);
        }
        this._composer.render(dt);
      };
    } catch (err) {
      // Broken chain: restore the renderer's own ACES path so the game still
      // looks reasonable via main.js's plain-render fallback (same exposure
      // target as the composer path so the look doesn't jump).
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = BASE_EXPOSURE;
      this._composer = null;
      this.render = null;
      console.error('[postfx] init failed, falling back to direct render', err);
    }
  }

  _bindEvents(ctx) {
    const events = ctx?.events;
    if (!events?.on) return;

    events.on('weapon:fire', () => {
      this._flashKick = Math.min(this._flashKick + FLASH_KICK_ADD, FLASH_KICK_MAX);
    });
    events.on('player:damage', (payload) => {
      const amount = typeof payload?.amount === 'number' ? payload.amount : 10;
      this._damagePulse = Math.min(1, this._damagePulse + 0.35 + amount * 0.012);
      this._chromaPulse = Math.min(1, this._chromaPulse + 0.5);
    });
    events.on('game:over', () => {
      this._dead = true;
    });
    events.on('game:start', () => {
      this._dead = false;
      this._deathFade = 0;
      this._damagePulse = 0;
      this._chromaPulse = 0;
      this._flashKick = 0;
      this._lowHealth = 0;
    });
  }

  update(dt, ctx) {
    this._lastTickTime = ctx?.time ?? this._lastTickTime;
    if (!this._composer) return;

    // Decay transient pulses.
    this._flashKick = Math.max(0, this._flashKick - dt * FLASH_DECAY);
    this._damagePulse = Math.max(0, this._damagePulse - dt * DAMAGE_PULSE_DECAY);
    this._chromaPulse = Math.max(0, this._chromaPulse - dt * CHROMA_PULSE_DECAY);

    // Death desaturation eases in slowly (no slow-mo, just the color dying).
    const deathTarget = this._dead ? 1 : 0;
    this._deathFade += (deathTarget - this._deathFade) * Math.min(1, dt * DEATH_FADE_RATE);

    // Smoothed low-health factor from the player system (guarded — the player
    // system may have failed or not populated ctx.player yet).
    const health = ctx?.player?.health;
    let lowTarget = 0;
    if (typeof health === 'number' && health < LOW_HEALTH_THRESHOLD) {
      lowTarget = Math.min(1, (LOW_HEALTH_THRESHOLD - Math.max(0, health)) / LOW_HEALTH_THRESHOLD);
    }
    this._lowHealth += (lowTarget - this._lowHealth) * Math.min(1, dt * LOW_HEALTH_SMOOTH);

    // Exposure: base lift * muzzle-flash kick, dimmed while dying.
    if (this._renderer) {
      this._renderer.toneMappingExposure =
        BASE_EXPOSURE * (1 + this._flashKick) * (1 - 0.18 * this._deathFade);
    }

    // Grade: red tinge + desaturation from health state / death.
    if (this._grade) {
      this._grade.redTinge = Math.min(
        0.55,
        this._lowHealth * 0.45 + this._damagePulse * 0.12 * (1 - this._deathFade),
      );
      this._grade.desaturation = Math.min(
        0.85,
        this._lowHealth * 0.35 * (1 - this._deathFade) + this._deathFade * 0.7,
      );
    }

    // Vignette: subtle base, pulses on damage, closes in when hurt/dead.
    if (this._vignette) {
      this._vignette.darkness =
        BASE_VIGNETTE_DARKNESS +
        this._damagePulse * 0.35 +
        this._lowHealth * 0.12 +
        this._deathFade * 0.15;
    }

    // Chromatic aberration, in pixels: sub-pixel whisper at rest, damage
    // pulses push it toward — never past — the 0.9 px corner cap (the effect
    // clamps again inside, and the radial mask zeroes it at screen center).
    if (this._chroma) {
      this._chroma.offsetPx = Math.min(
        CA_MAX_PX,
        BASE_CA_PX +
          this._chromaPulse * (CA_MAX_PX - BASE_CA_PX) +
          this._deathFade * 0.25,
      );
    }
  }

  // render is assigned in init(); stays null if the chain failed to build so
  // main.js can fall back to renderer.render(scene, camera).

  resize(w, h) {
    this._composer?.setSize(w, h);
  }
}
