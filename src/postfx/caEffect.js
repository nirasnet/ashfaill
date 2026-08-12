// Custom lens chromatic aberration. Owned by the postfx agent.
//
// Replaces postprocessing's ChromaticAberrationEffect, which had two problems
// for this game:
//   1. Its offset is a constant UV-space vector — a fixed diagonal shift. On
//      thin high-contrast line decals (curb edges, lane paint, barrier tops,
//      window frames) that reads as magenta/green "dashes" plastered across
//      the whole frame, and the damage pulse pushed it to ~6+ physical pixels
//      at 1080p. At that strength it reads as a broken renderer, not a lens.
//   2. Its radial modulation never reaches zero at the center and scales past
//      1.0 in the corners, so there is no clean zone and no upper bound.
//
// Art-director spec this implements: strength cut ~80% (0.6 px -> 0.12 px at
// rest), FULLY radial — exactly zero at screen center, quadratic-eased growth,
// maximum only at the extreme corners, and that maximum bounded well under the
// 0.3%-of-frame ceiling (the 0.9 px damage-pulse cap is ~0.06% of a 1600 px
// frame; the 0.12 px rest state is ~0.008%, genuinely sub-pixel).
//
// Mechanics:
//   - offset expressed in OUTPUT PIXELS (converted via texelSize) and hard
//     capped at `maxOffsetPx` in both the JS setter and the shader — the
//     fringe can never exceed the cap regardless of resolution or pulses;
//   - radial mask normalized to CORNER distance (rc = 1 at the exact frame
//     corners, not the edge midpoints): zero inside the inner `maskInner`
//     fraction, then a SQUARED smoothstep ramp — quadratic near onset, so the
//     mid-frame where facades, curbs, and readable geometry live stays clean
//     and full strength exists only in the last few percent of the corners;
//   - shifts R/B along the actual radial direction (true transverse CA), so
//     edges aligned with the radius don't fringe at all — kinder to the
//     street's long straight lines than any fixed diagonal shift.
import { Uniform } from 'three';
import { BlendFunction, Effect, EffectAttribute } from 'postprocessing';

const fragmentShader = /* glsl */ `
  uniform float offsetPx;    // fringe width in pixels AT THE CORNERS
  uniform float maxOffsetPx; // hard cap (defense in depth; setter clamps too)

  void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
    vec2 fromCenter = uv - 0.5;
    float dist = length(fromCenter);
    // rc: 0 at screen center, 1 at the exact frame corners (|fromCenter| of a
    // corner is sqrt(0.5) in UV space, whatever the aspect ratio).
    float rc = dist * 1.41421356;
    // Dead zone inside the inner CA_MASK_INNER of the corner radius, then a
    // squared ease: quadratic growth near onset, 1.0 only at the corners.
    float m = smoothstep(CA_MASK_INNER, 1.0, rc);
    float mask = m * m;
    float px = min(offsetPx, maxOffsetPx) * mask;

    vec3 color = inputColor.rgb;
    float alpha = inputColor.a;
    if (px > 0.001) {
      vec2 dir = fromCenter / max(dist, 1e-4);
      vec2 shift = dir * px * texelSize;
      vec2 ra = texture2D(inputBuffer, uv + shift).ra;
      vec2 ba = texture2D(inputBuffer, uv - shift).ba;
      color = vec3(ra.x, inputColor.g, ba.x);
      alpha = max(alpha, max(ra.y, ba.y));
    }
    outputColor = vec4(color, alpha);
  }
`;

export class LensChromaticAberrationEffect extends Effect {
  constructor({ offsetPx = 0.12, maxOffsetPx = 0.9, maskInner = 0.3 } = {}) {
    super('LensChromaticAberrationEffect', fragmentShader, {
      blendFunction: BlendFunction.SRC,
      // Samples inputBuffer at shifted UVs -> convolution effect. Must stay
      // the only convolution effect in its EffectPass.
      attributes: EffectAttribute.CONVOLUTION,
      defines: new Map([['CA_MASK_INNER', maskInner.toFixed(4)]]),
      uniforms: new Map([
        ['offsetPx', new Uniform(Math.min(offsetPx, maxOffsetPx))],
        ['maxOffsetPx', new Uniform(maxOffsetPx)],
      ]),
    });
  }

  get offsetPx() { return this.uniforms.get('offsetPx').value; }
  set offsetPx(v) {
    const cap = this.uniforms.get('maxOffsetPx').value;
    this.uniforms.get('offsetPx').value = Math.max(0, Math.min(cap, v));
  }

  get maxOffsetPx() { return this.uniforms.get('maxOffsetPx').value; }
}
