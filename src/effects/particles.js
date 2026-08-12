// Fixed-capacity CPU-simmed particle pools, each rendered as ONE draw call.
//  - ParticlePool:  THREE.Points point sprites. Cheap, but gl_PointSize is clamped
//    (shader clamp 320px + hardware caps), so only for small/distant particles.
//  - BillboardPool: instanced camera-facing quads sized in WORLD meters — no pixel
//    cap, correct for large near-camera volumes like muzzle smoke.
// All buffers allocated at construction; spawn() overwrites the oldest slot when full.
import * as THREE from 'three';

const VERT = /* glsl */`
attribute float aSize;
attribute float aAlpha;
attribute float aRot;
attribute vec3 aColor;
uniform float uPointScale;
varying float vAlpha;
varying float vRot;
varying vec3 vColor;
void main() {
  vColor = aColor;
  vAlpha = aAlpha;
  vRot = aRot;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float d = max(0.15, -mv.z);
  gl_PointSize = clamp(aSize * uPointScale / d, 0.5, 320.0);
  gl_Position = projectionMatrix * mv;
}`;

const FRAG = /* glsl */`
uniform sampler2D uMap;
varying float vAlpha;
varying float vRot;
varying vec3 vColor;
void main() {
  vec2 uv = gl_PointCoord - 0.5;
  float c = cos(vRot), s = sin(vRot);
  uv = vec2(uv.x * c - uv.y * s, uv.x * s + uv.y * c) + 0.5;
  vec4 t = texture2D(uMap, uv);
  float a = t.a * vAlpha;
  if (a < 0.004) discard;
  gl_FragColor = vec4(vColor * t.rgb, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export class ParticlePool {
  /**
   * @param {object} opts
   *  max: capacity; map: THREE.Texture; blending: THREE.*Blending;
   *  fadePow: opacity ease-out exponent; fadeIn: age fraction spent fading in;
   *  renderOrder: draw order for the Points object.
   */
  constructor({ max = 256, map, blending = THREE.NormalBlending, fadePow = 1.5, fadeIn = 0.08, renderOrder = 9 } = {}) {
    this.max = max;
    this.fadePow = fadePow;
    this.fadeIn = Math.max(1e-3, fadeIn);
    this.count = 0;

    // Struct-of-arrays simulation state.
    this.pos = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.life = new Float32Array(max);      // remaining seconds
    this.maxLife = new Float32Array(max);
    this.size0 = new Float32Array(max);
    this.growth = new Float32Array(max);    // relative size gain over full life
    this.alpha0 = new Float32Array(max);
    this.grav = new Float32Array(max);      // m/s^2 (negative = down)
    this.drag = new Float32Array(max);      // per-second velocity damping factor
    this.rot = new Float32Array(max);
    this.rotV = new Float32Array(max);
    this.col = new Float32Array(max * 3);

    // GPU buffers.
    const geo = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(new Float32Array(max * 3), 3);
    this.aSize = new THREE.BufferAttribute(new Float32Array(max), 1);
    this.aAlpha = new THREE.BufferAttribute(new Float32Array(max), 1);
    this.aRot = new THREE.BufferAttribute(new Float32Array(max), 1);
    this.aColor = new THREE.BufferAttribute(new Float32Array(max * 3), 3);
    for (const a of [this.aPos, this.aSize, this.aAlpha, this.aRot, this.aColor]) a.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.aPos);
    geo.setAttribute('aSize', this.aSize);
    geo.setAttribute('aAlpha', this.aAlpha);
    geo.setAttribute('aRot', this.aRot);
    geo.setAttribute('aColor', this.aColor);
    geo.setDrawRange(0, 0);

    this.material = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: map }, uPointScale: { value: 700 } },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending,
    });

    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = renderOrder;
    this.points.userData.noHit = true;
    this.points.matrixAutoUpdate = false;
  }

  /** Spawn one particle. Recycles the oldest slot when the pool is full. */
  spawn(x, y, z, vx, vy, vz, {
    life = 0.5, size = 0.08, growth = 0, alpha = 1, gravity = 0, drag = 0,
    r = 1, g = 1, b = 1, rot = 0, rotSpeed = 0,
  } = {}) {
    let i;
    if (this.count < this.max) {
      i = this.count++;
    } else {
      // Steal the slot closest to death.
      i = 0;
      let best = Infinity;
      for (let k = 0; k < this.max; k++) if (this.life[k] < best) { best = this.life[k]; i = k; }
    }
    const i3 = i * 3;
    this.pos[i3] = x; this.pos[i3 + 1] = y; this.pos[i3 + 2] = z;
    this.vel[i3] = vx; this.vel[i3 + 1] = vy; this.vel[i3 + 2] = vz;
    this.life[i] = life; this.maxLife[i] = life;
    this.size0[i] = size; this.growth[i] = growth;
    this.alpha0[i] = alpha;
    this.grav[i] = gravity; this.drag[i] = drag;
    this.rot[i] = rot; this.rotV[i] = rotSpeed;
    this.col[i3] = r; this.col[i3 + 1] = g; this.col[i3 + 2] = b;
  }

  update(dt, pointScale) {
    this.material.uniforms.uPointScale.value = pointScale;
    let n = this.count;
    for (let i = 0; i < n; i++) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        // Swap-remove with the last live particle.
        n--;
        if (i !== n) {
          const a3 = i * 3, b3 = n * 3;
          for (let k = 0; k < 3; k++) {
            this.pos[a3 + k] = this.pos[b3 + k];
            this.vel[a3 + k] = this.vel[b3 + k];
            this.col[a3 + k] = this.col[b3 + k];
          }
          this.life[i] = this.life[n]; this.maxLife[i] = this.maxLife[n];
          this.size0[i] = this.size0[n]; this.growth[i] = this.growth[n];
          this.alpha0[i] = this.alpha0[n];
          this.grav[i] = this.grav[n]; this.drag[i] = this.drag[n];
          this.rot[i] = this.rot[n]; this.rotV[i] = this.rotV[n];
        }
        i--;
        continue;
      }
      const i3 = i * 3;
      const damp = this.drag[i] > 0 ? Math.max(0, 1 - this.drag[i] * dt) : 1;
      this.vel[i3] *= damp;
      this.vel[i3 + 1] = this.vel[i3 + 1] * damp + this.grav[i] * dt;
      this.vel[i3 + 2] *= damp;
      this.pos[i3] += this.vel[i3] * dt;
      this.pos[i3 + 1] += this.vel[i3 + 1] * dt;
      this.pos[i3 + 2] += this.vel[i3 + 2] * dt;
      this.rot[i] += this.rotV[i] * dt;

      // Write render attributes.
      const age = 1 - this.life[i] / this.maxLife[i];
      const fadeIn = age < this.fadeIn ? age / this.fadeIn : 1;
      const fadeOut = Math.pow(Math.max(0, this.life[i] / this.maxLife[i]), this.fadePow);
      this.aPos.array[i3] = this.pos[i3];
      this.aPos.array[i3 + 1] = this.pos[i3 + 1];
      this.aPos.array[i3 + 2] = this.pos[i3 + 2];
      this.aSize.array[i] = this.size0[i] * (1 + this.growth[i] * age);
      this.aAlpha.array[i] = this.alpha0[i] * fadeIn * fadeOut;
      this.aRot.array[i] = this.rot[i];
      this.aColor.array[i3] = this.col[i3];
      this.aColor.array[i3 + 1] = this.col[i3 + 1];
      this.aColor.array[i3 + 2] = this.col[i3 + 2];
    }
    this.count = n;
    this.points.geometry.setDrawRange(0, n);
    if (n > 0) {
      this.aPos.needsUpdate = true;
      this.aSize.needsUpdate = true;
      this.aAlpha.needsUpdate = true;
      this.aRot.needsUpdate = true;
      this.aColor.needsUpdate = true;
    }
  }
}

// ===========================================================================
// BillboardPool — instanced camera-facing quads with world-space size.
// Same sim model + spawn() signature as ParticlePool; renders via one
// InstancedBufferGeometry mesh so all live smoke sprites stay a single call.
// ===========================================================================

const BILL_VERT = /* glsl */`
attribute vec3 aOffset;
attribute float aScale;
attribute float aAlpha;
attribute float aRot;
attribute vec3 aColor;
varying vec2 vUv;
varying float vAlpha;
varying vec3 vColor;
void main() {
  vUv = uv;
  vAlpha = aAlpha;
  vColor = aColor;
  // Billboard: move to the particle's view-space position, then offset the
  // quad corner in view-space XY (rotated in-plane) scaled to world meters.
  vec4 mv = modelViewMatrix * vec4(aOffset, 1.0);
  float c = cos(aRot), s = sin(aRot);
  mv.xy += vec2(position.x * c - position.y * s, position.x * s + position.y * c) * aScale;
  gl_Position = projectionMatrix * mv;
}`;

const BILL_FRAG = /* glsl */`
uniform sampler2D uMap;
varying vec2 vUv;
varying float vAlpha;
varying vec3 vColor;
void main() {
  vec4 t = texture2D(uMap, vUv);
  float a = t.a * vAlpha;
  if (a < 0.004) discard;
  gl_FragColor = vec4(vColor * t.rgb, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export class BillboardPool {
  /** Same options as ParticlePool. `size` passed to spawn() is the quad edge in meters. */
  constructor({ max = 256, map, blending = THREE.NormalBlending, fadePow = 1.5, fadeIn = 0.08, renderOrder = 8 } = {}) {
    this.max = max;
    this.fadePow = fadePow;
    this.fadeIn = Math.max(1e-3, fadeIn);
    this.count = 0;

    // Struct-of-arrays simulation state (identical layout to ParticlePool).
    this.pos = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max);
    this.size0 = new Float32Array(max);
    this.growth = new Float32Array(max);
    this.alpha0 = new Float32Array(max);
    this.grav = new Float32Array(max);
    this.drag = new Float32Array(max);
    this.rot = new Float32Array(max);
    this.rotV = new Float32Array(max);
    this.col = new Float32Array(max * 3);

    const quad = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.setIndex(quad.getIndex());
    geo.setAttribute('position', quad.getAttribute('position'));
    geo.setAttribute('uv', quad.getAttribute('uv'));
    this.aOffset = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3);
    this.aScale = new THREE.InstancedBufferAttribute(new Float32Array(max), 1);
    this.aAlpha = new THREE.InstancedBufferAttribute(new Float32Array(max), 1);
    this.aRot = new THREE.InstancedBufferAttribute(new Float32Array(max), 1);
    this.aColor = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3);
    for (const a of [this.aOffset, this.aScale, this.aAlpha, this.aRot, this.aColor]) a.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aOffset', this.aOffset);
    geo.setAttribute('aScale', this.aScale);
    geo.setAttribute('aAlpha', this.aAlpha);
    geo.setAttribute('aRot', this.aRot);
    geo.setAttribute('aColor', this.aColor);
    geo.instanceCount = 0;
    this.geo = geo;

    this.material = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: map } },
      vertexShader: BILL_VERT,
      fragmentShader: BILL_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending,
    });

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = renderOrder;
    this.mesh.userData.noHit = true;
    this.mesh.matrixAutoUpdate = false;
  }

  /** Spawn one billboard. Recycles the slot closest to death when full. */
  spawn(x, y, z, vx, vy, vz, {
    life = 0.5, size = 0.3, growth = 0, alpha = 1, gravity = 0, drag = 0,
    r = 1, g = 1, b = 1, rot = 0, rotSpeed = 0,
  } = {}) {
    let i;
    if (this.count < this.max) {
      i = this.count++;
    } else {
      i = 0;
      let best = Infinity;
      for (let k = 0; k < this.max; k++) if (this.life[k] < best) { best = this.life[k]; i = k; }
    }
    const i3 = i * 3;
    this.pos[i3] = x; this.pos[i3 + 1] = y; this.pos[i3 + 2] = z;
    this.vel[i3] = vx; this.vel[i3 + 1] = vy; this.vel[i3 + 2] = vz;
    this.life[i] = life; this.maxLife[i] = life;
    this.size0[i] = size; this.growth[i] = growth;
    this.alpha0[i] = alpha;
    this.grav[i] = gravity; this.drag[i] = drag;
    this.rot[i] = rot; this.rotV[i] = rotSpeed;
    this.col[i3] = r; this.col[i3 + 1] = g; this.col[i3 + 2] = b;
  }

  update(dt) {
    let n = this.count;
    for (let i = 0; i < n; i++) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        n--;
        if (i !== n) {
          const a3 = i * 3, b3 = n * 3;
          for (let k = 0; k < 3; k++) {
            this.pos[a3 + k] = this.pos[b3 + k];
            this.vel[a3 + k] = this.vel[b3 + k];
            this.col[a3 + k] = this.col[b3 + k];
          }
          this.life[i] = this.life[n]; this.maxLife[i] = this.maxLife[n];
          this.size0[i] = this.size0[n]; this.growth[i] = this.growth[n];
          this.alpha0[i] = this.alpha0[n];
          this.grav[i] = this.grav[n]; this.drag[i] = this.drag[n];
          this.rot[i] = this.rot[n]; this.rotV[i] = this.rotV[n];
        }
        i--;
        continue;
      }
      const i3 = i * 3;
      const damp = this.drag[i] > 0 ? Math.max(0, 1 - this.drag[i] * dt) : 1;
      this.vel[i3] *= damp;
      this.vel[i3 + 1] = this.vel[i3 + 1] * damp + this.grav[i] * dt;
      this.vel[i3 + 2] *= damp;
      this.pos[i3] += this.vel[i3] * dt;
      this.pos[i3 + 1] += this.vel[i3 + 1] * dt;
      this.pos[i3 + 2] += this.vel[i3 + 2] * dt;
      this.rot[i] += this.rotV[i] * dt;

      const age = 1 - this.life[i] / this.maxLife[i];
      const fadeIn = age < this.fadeIn ? age / this.fadeIn : 1;
      const fadeOut = Math.pow(Math.max(0, this.life[i] / this.maxLife[i]), this.fadePow);
      this.aOffset.array[i3] = this.pos[i3];
      this.aOffset.array[i3 + 1] = this.pos[i3 + 1];
      this.aOffset.array[i3 + 2] = this.pos[i3 + 2];
      this.aScale.array[i] = this.size0[i] * (1 + this.growth[i] * age);
      this.aAlpha.array[i] = this.alpha0[i] * fadeIn * fadeOut;
      this.aRot.array[i] = this.rot[i];
      this.aColor.array[i3] = this.col[i3];
      this.aColor.array[i3 + 1] = this.col[i3 + 1];
      this.aColor.array[i3 + 2] = this.col[i3 + 2];
    }
    this.count = n;
    this.geo.instanceCount = n;
    if (n > 0) {
      this.aOffset.needsUpdate = true;
      this.aScale.needsUpdate = true;
      this.aAlpha.needsUpdate = true;
      this.aRot.needsUpdate = true;
      this.aColor.needsUpdate = true;
    }
  }
}
