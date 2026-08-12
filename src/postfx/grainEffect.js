// Custom film grain. Owned by the postfx agent.
//
// Replaces postprocessing's NoiseEffect, whose shader hashes `uv * (1 + time)`
// — a SCALE of the coordinate space, not a translation. Near the UV origin the
// pattern barely changes frame to frame, and the fract(sin(dot)) hash breaks
// down into coherent blotches at large arguments, which is exactly the
// "upscaled noise texture" look. SCREEN blending white noise also only ever
// brightens, so it reads as haze rather than grain.
//
// This effect:
//   - hashes integer OUTPUT-RESOLUTION pixel coordinates (uv * resolution),
//     so the grain is always 1 px at the drawing-buffer size — never scaled;
//   - re-seeds every frame by translating the hash domain with the pass's
//     `time` uniform (EffectPass updates it each render);
//   - uses a signed, zero-mean noise added in SRC blend, so grain darkens as
//     often as it brightens (film, not fog);
//   - is luminance-weighted: full strength in the midtones, fading in deep
//     shadow (no shadow blotch) and near white (no highlight sparkle), with a
//     small floor so it never fully vanishes;
//   - uses a sin-free Hoskins hash (stable on mobile/laptop GPUs at large
//     coordinates). Zero allocations, zero textures — pure ALU.
import { Uniform } from 'three';
import { BlendFunction, Effect } from 'postprocessing';

const fragmentShader = /* glsl */ `
  uniform float grainAmount;

  float ccGrainHash(vec2 p) {
    // Dave Hoskins hash12 — no sin(), no precision blowup at large coords.
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }

  void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
    // White noise at output resolution, regenerated per frame: translate the
    // pixel-space hash domain by a per-frame offset derived from time.
    vec2 pixel = uv * resolution;
    float t = fract(time * 0.6180339887) * 289.0;
    float n = ccGrainHash(pixel + vec2(t, t * 1.6180339887)) * 2.0 - 1.0;

    float luma = clamp(dot(inputColor.rgb, vec3(0.2126, 0.7152, 0.0722)), 0.0, 1.0);
    // Film-like response curve: peaks at mid-gray, rolls off toward both ends.
    float weight = mix(0.35, 1.0, clamp(4.0 * luma * (1.0 - luma), 0.0, 1.0));

    outputColor = vec4(inputColor.rgb + n * grainAmount * weight, inputColor.a);
  }
`;

export class FilmGrainEffect extends Effect {
  constructor({ amount = 0.03 } = {}) {
    super('FilmGrainEffect', fragmentShader, {
      blendFunction: BlendFunction.SRC,
      uniforms: new Map([['grainAmount', new Uniform(amount)]]),
    });
  }

  get amount() { return this.uniforms.get('grainAmount').value; }
  set amount(v) { this.uniforms.get('grainAmount').value = Math.max(0, v); }
}
