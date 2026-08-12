// Cinematic color grade for the shooter look. Owned by the postfx agent.
// Runs AFTER tone mapping (LDR domain, tonemapped-linear until the composer's
// final sRGB encode).
//
// The look is a single teal<->orange axis complementing the level's warm sun —
// implemented analytically (a procedural LUT-equivalent; assets are banned in
// this project, and an analytic transform is cheaper than a 3D LUT fetch):
//
//   - Mid gamma (midGamma, default 1.05): originally 1.2-1.3, tuned to fight
//     the ACES mid lift at exposure 0.85-1.0. The art-director pass moved that
//     job to the exposure itself (-0.5 EV in postfx.js, mids land at ~0.176
//     tonemapped-linear / ~0.46 display) — so the gamma is now a whisper
//     (1.05), kept only as a residual shaper. Leaving it at 1.2 on top of the
//     exposure cut double-dipped and pushed mids to ~0.39 display: too dark.
//   - Midtone S-curve (sCurve, default 0.35): the art-director's "restore
//     midtone contrast with a gentle S-curve". Applied in an approximately
//     perceptual domain (gamma 2.0: sqrt in, square out) so the pivot sits at
//     display ~0.46 — true perceptual mid gray. A linear-domain contrast op
//     pivots at display ~0.74 and crushes shadows instead; that is exactly why
//     the old BrightnessContrastEffect pass was deleted from postfx.js. The
//     curve is smoothstep-based, so 0 and 1 stay pinned; at 0.35 the midtone
//     slope is ~1.18 — contrast, not a hammer.
//   - Midtone magenta pull (midGreen, default 0.06 = LGG "magenta -6"): the
//     purple-gray cast on asphalt/concrete mids. A luma-normalized green tilt
//     (+G, -R/-B) weighted by the classic gamma-wheel parabola 4*l*(1-l), so
//     it acts on midtones only — blacks, whites, and the warm highlights of
//     the split-tone are untouched, and luma does not shift.
//   - Shadow lift: FLOOR-PRESERVING. The lift is weighted to zero at true
//     black (smoothstep over the darkest values), so it tints near-shadows
//     toward teal without raising the black point — this is a TINT device,
//     not a level device (see shadowToe below for the level).
//   - Filmic shadow toe (shadowToe, default 0.02, cap 0.035): the level
//     device. The floor-preserving tint lift above zeroes out exactly where
//     large shadowed surfaces land (street.png's foreground asphalt sat at
//     ~0.002-0.01 tonemapped-linear and crushed to an unreadable black slab),
//     and the S-curve darkens that region another ~35%. The toe is applied
//     AFTER the S-curve — +shadowToe linear at true black, squared falloff,
//     zero by luma ~0.22 — so shade keeps readable texture while everything
//     sunlit (well above the falloff) does not move AT ALL. This is a toe,
//     not the old +0.035 global floor: the falloff keeps it out of the mids,
//     and 0.02 linear still displays as a dark near-black (~13% sRGB).
//   - Split-tone: teal into shadows, orange into highlights. Both tint colors
//     are LUMINANCE-NORMALIZED at construction (divided by their Rec.709
//     luma), so the multiplicative tint shifts hue without shifting
//     brightness.
//   - Gameplay uniforms (postfx.js animates these per frame): desaturation
//     (low health / death) and redTinge (hurt).
import { Uniform, Color, Vector3 } from 'three';
import { BlendFunction, Effect } from 'postprocessing';

const LUMA = new Vector3(0.2126, 0.7152, 0.0722);
const SHADOW_LIFT_CAP = 0.03;
const SHADOW_TOE_CAP = 0.035;
const MID_GAMMA_MIN = 1.0;
const MID_GAMMA_MAX = 1.6;
const S_CURVE_MAX = 0.8;
const MID_GREEN_MAX = 0.15;

// Normalize a tint color so dot(tint, LUMA) == 1 (hue shift, not brightness).
function lumaNormalized(color) {
  const v = new Vector3(color.r, color.g, color.b);
  const luma = v.dot(LUMA);
  return luma > 1e-6 ? v.divideScalar(luma) : v.set(1, 1, 1);
}

// LGG gamma-wheel "magenta -N": green up, red/blue down, luma-normalized so
// the pull shifts hue only. Writes into `target` (pooled — no allocation).
function midGreenTilt(amount, target) {
  const a = Math.min(MID_GREEN_MAX, Math.max(0, amount));
  target.set(1 - a * 0.5, 1 + a * 0.5, 1 - a * 0.5);
  const luma = target.dot(LUMA);
  if (luma > 1e-6) target.divideScalar(luma);
  return target;
}

const fragmentShader = /* glsl */ `
  uniform vec3 shadowTint;    // teal, luma-normalized
  uniform vec3 highlightTint; // orange, luma-normalized
  uniform vec3 midGreenTilt;  // luma-normalized green tilt (magenta pull)
  uniform float tintStrength;
  uniform float shadowLift;   // <= 0.03, enforced JS-side; floor-preserving
  uniform float shadowToe;    // <= 0.035, filmic toe: +toe at black, gone by ~0.22
  uniform float midGamma;     // > 1 residual mid shaper (exposure does the level)
  uniform float sCurve;       // 0..0.8 midtone S-curve strength
  uniform float desaturation;
  uniform float redTinge;

  #define CC_LUMA vec3(0.2126, 0.7152, 0.0722)

  void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
    // Residual mid shaper: pow() keeps 0 and 1 fixed. Near-neutral now that
    // the -0.5 EV exposure sets the mid level (see postfx.js).
    vec3 color = pow(max(inputColor.rgb, 0.0), vec3(midGamma));
    float luma = clamp(dot(color, CC_LUMA), 0.0, 1.0);

    // Shadow lift (capped +0.03), FLOOR-PRESERVING: the smoothstep term is 0
    // at true black, so the lift tints near-shadows toward teal but never
    // raises the black point. Quadratic falloff — gone by the midtones.
    float liftW = (1.0 - luma) * (1.0 - luma) * smoothstep(0.0, 0.06, luma);
    color += shadowLift * liftW * shadowTint;

    // Split-tone on one teal<->orange axis. Luma-normalized multiplicative
    // tints: hue moves, brightness doesn't.
    float l = dot(color, CC_LUMA);
    float shadowW = (1.0 - smoothstep(0.05, 0.45, l)) * tintStrength;
    float highlightW = smoothstep(0.45, 0.95, l) * tintStrength;
    color = mix(color, color * shadowTint, shadowW);
    color = mix(color, color * highlightTint, highlightW);

    // Midtone magenta pull (LGG gamma wheel): parabola weight peaks at mid
    // gray, zero at both ends — blacks and highlights keep their hue.
    float lm = clamp(dot(color, CC_LUMA), 0.0, 1.0);
    float midW = 4.0 * lm * (1.0 - lm);
    color *= mix(vec3(1.0), midGreenTilt, midW);

    // Gentle midtone S-curve in an approx-perceptual domain (gamma 2.0).
    // sqrt puts tonemapped-linear mid gray (~0.18-0.21) at ~0.43-0.46, right
    // at the smoothstep pivot (0.5) — so this is genuine MIDTONE contrast.
    // smoothstep pins 0 and 1: no black crush, no highlight clip.
    vec3 p = sqrt(max(color, 0.0));
    vec3 s = p * p * (3.0 - 2.0 * p);
    p = mix(p, s, sCurve);
    color = p * p;

    // Filmic shadow toe — the LEVEL device for deep shade (the lift above is
    // the tint device and preserves the floor). Applied AFTER the S-curve so
    // the amount is exact in final linear values: +shadowToe at true black,
    // squared falloff, zero by luma ~0.22. Sunlit values sit far above the
    // falloff and are untouched — this is a toe, not a global pedestal. A
    // whisper of the shadow tint keeps lifted shade on the grade's teal axis.
    float lt = clamp(dot(color, CC_LUMA), 0.0, 1.0);
    float toeW = 1.0 - smoothstep(0.0, 0.22, lt);
    toeW *= toeW;
    color += shadowToe * toeW * mix(vec3(1.0), shadowTint, 0.35);

    // Gameplay-driven desaturation (low health drains color, death drains more).
    float luma2 = dot(color, CC_LUMA);
    color = mix(color, vec3(luma2), desaturation);

    // Red "hurt" tinge: partially desaturate, then push toward blood red.
    vec3 hurt = mix(color, vec3(luma2), 0.55) * vec3(1.28, 0.55, 0.50);
    color = mix(color, hurt, redTinge);

    outputColor = vec4(color, inputColor.a);
  }
`;

export class CinematicGradeEffect extends Effect {
  constructor({
    // Art-review pass: the old tints (0.86..1.10 pre-normalization) at
    // strength 0.35 worked out to a ±3% channel shift — frames read as
    // ungraded gray. These land ~-0.02 R / +0.02 B in deep shadow (teal) and
    // ~+0.05 R / -0.08 B in highlights (warm) at full weight: a visible
    // teal/orange axis, still a grade rather than a gel.
    shadowTint = new Color(0.78, 1.02, 1.14),    // teal (normalized below)
    highlightTint = new Color(1.16, 0.99, 0.78), // orange (normalized below)
    // 0.5 teal-tinted the ENTIRE sunlit plaza floor (its luma sits in the
    // shadowW ramp), fighting the warm key — 0.35 keeps teal in true shade.
    tintStrength = 0.35,
    shadowLift = 0.012,   // capped at +0.03, floor-preserving (tint device)
    shadowToe = 0.02,     // capped at +0.035, filmic toe (level device)
    // Residual only: the -0.5 EV exposure in postfx.js took over the mid-level
    // pull this gamma used to do at 1.2-1.3 (stacking both landed mids at
    // ~0.39 display — muddy). 1.05 keeps a whisper of shape.
    midGamma = 1.05,
    sCurve = 0.35,        // gentle midtone contrast (slope ~1.18 at the pivot)
    midGreen = 0.06,      // LGG "magenta -6": pulls the magenta cast from mids
  } = {}) {
    super('CinematicGradeEffect', fragmentShader, {
      blendFunction: BlendFunction.SRC,
      uniforms: new Map([
        ['shadowTint', new Uniform(lumaNormalized(shadowTint))],
        ['highlightTint', new Uniform(lumaNormalized(highlightTint))],
        ['midGreenTilt', new Uniform(midGreenTilt(midGreen, new Vector3()))],
        ['tintStrength', new Uniform(tintStrength)],
        ['shadowLift', new Uniform(Math.min(SHADOW_LIFT_CAP, Math.max(0, shadowLift)))],
        ['shadowToe', new Uniform(Math.min(SHADOW_TOE_CAP, Math.max(0, shadowToe)))],
        ['midGamma', new Uniform(Math.min(MID_GAMMA_MAX, Math.max(MID_GAMMA_MIN, midGamma)))],
        ['sCurve', new Uniform(Math.min(S_CURVE_MAX, Math.max(0, sCurve)))],
        ['desaturation', new Uniform(0.0)],
        ['redTinge', new Uniform(0.0)],
      ]),
    });
    this._midGreen = Math.min(MID_GREEN_MAX, Math.max(0, midGreen));
  }

  get desaturation() { return this.uniforms.get('desaturation').value; }
  set desaturation(v) { this.uniforms.get('desaturation').value = v; }

  get redTinge() { return this.uniforms.get('redTinge').value; }
  set redTinge(v) { this.uniforms.get('redTinge').value = v; }

  get tintStrength() { return this.uniforms.get('tintStrength').value; }
  set tintStrength(v) { this.uniforms.get('tintStrength').value = v; }

  get shadowLift() { return this.uniforms.get('shadowLift').value; }
  set shadowLift(v) {
    this.uniforms.get('shadowLift').value = Math.min(SHADOW_LIFT_CAP, Math.max(0, v));
  }

  get shadowToe() { return this.uniforms.get('shadowToe').value; }
  set shadowToe(v) {
    this.uniforms.get('shadowToe').value = Math.min(SHADOW_TOE_CAP, Math.max(0, v));
  }

  get midGamma() { return this.uniforms.get('midGamma').value; }
  set midGamma(v) {
    this.uniforms.get('midGamma').value = Math.min(MID_GAMMA_MAX, Math.max(MID_GAMMA_MIN, v));
  }

  get sCurve() { return this.uniforms.get('sCurve').value; }
  set sCurve(v) {
    this.uniforms.get('sCurve').value = Math.min(S_CURVE_MAX, Math.max(0, v));
  }

  get midGreen() { return this._midGreen; }
  set midGreen(v) {
    this._midGreen = Math.min(MID_GREEN_MAX, Math.max(0, v));
    // In-place update of the pooled uniform vector — no allocation.
    midGreenTilt(this._midGreen, this.uniforms.get('midGreenTilt').value);
  }
}
