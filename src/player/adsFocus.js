// ADS FOCUS OVERLAY — MW-style "eye focuses on the optic" presentation for
// aim-down-sights. Owned by the player system; fully procedural, zero assets.
//
// Peripheral blur, done honestly from inside the scene pass (the postfx
// composer belongs to another system and is not touched): while ADS is
// engaged the player re-renders the scene once per frame into a tiny 128x72
// half-float target. Bilinear-upsampling that thumbnail ~12x plus a 5-tap
// tent in the overlay shader yields a wide, stable gaussian-ish blur for the
// cost of a thumbnail render + one quad. The overlay quad is parented to the
// camera, sized every frame to exactly fill the frustum at 0.25 m (UV == NDC,
// so texture space is screen space), and masks the blurred image plus a soft
// darkening vignette to an elliptical periphery: the screen centre — the
// optic — stays untouched while the frame edges fall out of focus and dim.
//
// Colour correctness: the capture is forced linear (tone mapping is
// temporarily disabled if the no-composer fallback path left ACES on), so
// the composited periphery runs through the exact same tone-map/grade chain
// as the rest of the frame; the tonemapping/colorspace chunks at the end of
// the fragment shader make the direct-render fallback match too.
//
// Perf: RT, material, and quad are allocated once — zero steady-state
// allocation. The extra scene render only happens while the overlay is
// actually visible (during/around ADS), reuses the frame's shadow maps
// (shadowMap.autoUpdate is parked for the capture), and rasterizes 9.2k
// pixels. The capture happens before weapons animates the current frame, so
// the gun in the blurred periphery lags one frame — invisible at 128x72.
import * as THREE from 'three';

const RT_W = 128;
const RT_H = 72;
const QUAD_DEPTH = 0.25;        // camera-space depth of the overlay quad (m)
const QUAD_MIN_ALPHA = 0.004;   // below this the quad turns itself off

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

// Mask geometry: r is 0 at screen centre and 1 at the frame corners (the quad
// is aspect-stretched to the frame, so this is elliptical in true screen
// space, hugging the edges the way a lens falloff does).
//  - blur band rises 0.30 -> 0.80: the inner ~30% radius (optic + reticle)
//    stays perfectly sharp, edges reach full softness.
//  - darkening rises later (0.42 -> beyond-corner 1.06, ^1.5): ~16% at edge
//    midpoints and ~53% of uDark at the extreme corners — a focus cue over
//    the postfx system's always-on base vignette, not a black tube.
const FRAG = /* glsl */ `
uniform sampler2D tScene;
uniform vec2 uTexel;
uniform float uBlur;
uniform float uDark;
varying vec2 vUv;
void main() {
  vec2 p = vUv - 0.5;
  float r = length(p) * 1.41421356;
  float b = uBlur * smoothstep(0.30, 0.80, r);
  float d = uDark * pow(smoothstep(0.42, 1.06, r), 1.5);
  vec2 o = uTexel;
  vec3 blurred = texture2D(tScene, vUv).rgb * 0.36
    + texture2D(tScene, vUv + vec2( o.x,  o.y)).rgb * 0.16
    + texture2D(tScene, vUv + vec2(-o.x,  o.y)).rgb * 0.16
    + texture2D(tScene, vUv + vec2( o.x, -o.y)).rgb * 0.16
    + texture2D(tScene, vUv + vec2(-o.x, -o.y)).rgb * 0.16;
  // Single-blend composition of "mix toward blurred by b, then darken by d":
  // out = scene*(1-b)*(1-d) + blurred*b*(1-d)  ==  src-over with:
  float alpha = 1.0 - (1.0 - b) * (1.0 - d);
  vec3 col = alpha > 1e-4 ? blurred * (b * (1.0 - d) / alpha) : vec3(0.0);
  gl_FragColor = vec4(col, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export class AdsFocus {
  constructor() {
    this._rt = new THREE.WebGLRenderTarget(RT_W, RT_H, {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
    });
    this._mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        tScene: { value: this._rt.texture },
        uTexel: { value: new THREE.Vector2(1.6 / RT_W, 1.6 / RT_H) },
        uBlur: { value: 0 },
        uDark: { value: 0 },
      },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      fog: false,
    });
    // Camera-parented screen quad, drawn last so it composites over the
    // viewmodel (whose stock reaches into the blurred band — correct: MW's
    // edge focus falloff covers the gun too).
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this._mat);
    this.mesh.name = 'adsFocus';
    this.mesh.position.set(0, 0, -QUAD_DEPTH);
    this.mesh.renderOrder = 10000;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
  }

  /** Per-frame drive: strengths 0..1, quad resized to the live frustum. */
  set(cam, blur, dark) {
    const u = this._mat.uniforms;
    u.uBlur.value = blur;
    u.uDark.value = dark;
    const on = blur + dark > QUAD_MIN_ALPHA;
    this.mesh.visible = on;
    if (on && cam) {
      // Exact frustum coverage at the quad's depth — no margin, so quad UV
      // maps 1:1 onto the screen and the RT capture lines up underneath.
      const h = 2 * Math.tan(cam.fov * Math.PI / 360) * QUAD_DEPTH;
      this.mesh.scale.set(h * Math.max(cam.aspect || 1.78, 0.5), h, 1);
    }
  }

  /** Instant off (menu/pause overlays, respawn). */
  hideNow() {
    this._mat.uniforms.uBlur.value = 0;
    this._mat.uniforms.uDark.value = 0;
    this.mesh.visible = false;
  }

  reset() { this.hideNow(); }

  /**
   * Thumbnail scene capture for the blur band. No-ops unless the overlay is
   * actually visible this frame. Restores every piece of renderer state it
   * touches; hides the overlay itself during the capture so the blur never
   * feeds back into itself.
   */
  capture(renderer, scene, camera) {
    if (!this.mesh.visible || !renderer || !scene || !camera) return;
    const mesh = this.mesh;
    mesh.visible = false;
    const prevTarget = renderer.getRenderTarget();
    const prevShadow = renderer.shadowMap.autoUpdate;
    const prevTone = renderer.toneMapping;
    const prevAutoClear = renderer.autoClear;
    renderer.shadowMap.autoUpdate = false;          // reuse this frame's maps
    if (prevTone !== THREE.NoToneMapping) {
      renderer.toneMapping = THREE.NoToneMapping;   // keep the capture linear
    }
    renderer.autoClear = true;
    renderer.setRenderTarget(this._rt);
    renderer.render(scene, camera);
    renderer.setRenderTarget(prevTarget);
    renderer.autoClear = prevAutoClear;
    if (prevTone !== THREE.NoToneMapping) renderer.toneMapping = prevTone;
    renderer.shadowMap.autoUpdate = prevShadow;
    mesh.visible = true;
  }
}
