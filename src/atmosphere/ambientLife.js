// Ambient life for the atmosphere system — everything cheap that makes the
// warzone feel inhabited by weather and time instead of frozen:
//   - GPU-driven sun-lit dust motes wrapped around the camera (one draw call)
//   - Distant smoke columns on the horizon (billboarded cards + ember glow)
//   - Two bird flocks circling high over the outskirts
//   - Two SMALL additive sun cards pinned at "infinity" along the sun
//     direction: a tight warm halo and a low horizon-haze glow confined below
//     ~5 deg. Both are deliberately dim — the sky-layers disc owns the sun;
//     these must never widen it back into a white blob.
// All allocations happen in init(); update() only mutates pooled objects.
import * as THREE from 'three';
import { rng } from '../utils.js';

const _hdir = new THREE.Vector3();

// ---- procedural textures ---------------------------------------------------

function makeGlowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  grad.addColorStop(0.0, 'rgba(255,244,224,1.0)');
  grad.addColorStop(0.18, 'rgba(255,208,150,0.55)');
  grad.addColorStop(0.45, 'rgba(255,170,100,0.18)');
  grad.addColorStop(1.0, 'rgba(255,150,80,0.0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeSmokeTexture(seed) {
  const w = 128, h = 512;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  const rand = rng(seed);
  let x = w * 0.5;
  // Rising, meandering, widening puffs — dark oily smoke that lightens as it
  // disperses near the top.
  for (let i = 0; i < 110; i++) {
    const f = i / 110; // 0 = base, 1 = top
    const r = (10 + 58 * Math.pow(f, 1.25)) * (0.7 + rand() * 0.6);
    x += (rand() - 0.5) * 14;
    x = Math.min(w - 16, Math.max(16, x));
    const y = (h - 12) - f * (h - 42) + (rand() - 0.5) * 8;
    const shade = Math.floor(52 + rand() * 30 + f * 28);
    const a = (0.16 + rand() * 0.1) * (1 - f * 0.55);
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, `rgba(${shade},${shade - 4},${shade - 8},${a})`);
    grad.addColorStop(1, `rgba(${shade},${shade - 4},${shade - 8},0)`);
    g.fillStyle = grad;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  }
  // Fade the card edges so the billboard never shows a hard border.
  g.globalCompositeOperation = 'destination-in';
  const mh = g.createLinearGradient(0, 0, w, 0);
  mh.addColorStop(0, 'rgba(0,0,0,0)');
  mh.addColorStop(0.2, 'rgba(0,0,0,1)');
  mh.addColorStop(0.8, 'rgba(0,0,0,1)');
  mh.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = mh;
  g.fillRect(0, 0, w, h);
  const mv = g.createLinearGradient(0, 0, 0, h);
  mv.addColorStop(0, 'rgba(0,0,0,0)');
  mv.addColorStop(0.22, 'rgba(0,0,0,1)');
  mv.addColorStop(1, 'rgba(0,0,0,1)');
  g.fillStyle = mv;
  g.fillRect(0, 0, w, h);
  g.globalCompositeOperation = 'source-over';
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

function makeBirdTexture() {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 32;
  const g = c.getContext('2d');
  g.strokeStyle = 'rgba(22,20,18,0.95)';
  g.lineWidth = 3.5;
  g.lineCap = 'round';
  g.beginPath();
  g.moveTo(6, 22);
  g.quadraticCurveTo(20, 6, 32, 17);
  g.quadraticCurveTo(44, 6, 58, 22);
  g.stroke();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ---- dust shader -----------------------------------------------------------

const DUST_VERT = /* glsl */ `
  uniform float uTime;
  uniform vec3 uCamPos;
  uniform float uPixel;
  attribute float aScale;
  attribute float aPhase;
  varying float vAlpha;
  void main() {
    vec3 box = vec3(40.0, 22.0, 40.0);
    vec3 wind = vec3(0.55, -0.10, 0.30);
    vec3 p = position + wind * uTime;
    p.x += sin(uTime * 0.60 + aPhase * 6.2831) * 0.7;
    p.y += sin(uTime * 0.45 + aPhase * 12.566) * 0.5;
    p.z += cos(uTime * 0.52 + aPhase * 9.4247) * 0.6;
    // Wrap into a box centred on the camera — motes are always around you.
    p = mod(p - uCamPos, box) - 0.5 * box + uCamPos;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    float dist = max(0.0001, -mv.z);
    float size = aScale * uPixel * 42.0 / dist;
    gl_PointSize = min(size, 7.0 * uPixel);
    // Fade in past arm's length, fade out before the wrap boundary can pop.
    vAlpha = smoothstep(1.1, 3.5, dist) * (1.0 - smoothstep(13.0, 19.0, dist));
    gl_Position = projectionMatrix * mv;
  }
`;

const DUST_FRAG = /* glsl */ `
  uniform float uOpacity;
  varying float vAlpha;
  void main() {
    vec2 uv = gl_PointCoord - 0.5;
    float d = length(uv);
    float a = smoothstep(0.5, 0.06, d) * vAlpha * uOpacity;
    if (a < 0.001) discard;
    gl_FragColor = vec4(1.0, 0.87, 0.68, a);
  }
`;

// ---- the system ------------------------------------------------------------

export class AmbientLife {
  constructor() {
    this._group = null;
    this._dust = null;
    this._dustUniforms = null;
    this._smoke = [];
    this._embers = [];
    this._birds = [];
    this._flocks = [];
    this._sunGlow = null;
    this._sunHaze = null;
    this._rand = null;
  }

  init(scene, renderer, { sunDirection, seed = 1337 } = {}) {
    if (!scene) return;
    this._rand = rng(seed);
    this._group = new THREE.Group();
    this._group.name = 'atmosphere:ambientLife';
    scene.add(this._group);

    this._buildDust(renderer);
    this._buildSmoke(sunDirection);
    this._buildBirds();
    this._buildSunGlow();
  }

  update(dt, camera, time, sunDirection) {
    if (!this._group) return;
    const cam = camera || null;

    // Dust: fully GPU-side, just feed time + camera.
    if (this._dustUniforms) {
      this._dustUniforms.uTime.value = time;
      if (cam) this._dustUniforms.uCamPos.value.copy(cam.position);
    }

    // Smoke columns: cylindrical billboard + lazy sway.
    for (let i = 0; i < this._smoke.length; i++) {
      const s = this._smoke[i];
      if (cam) {
        s.mesh.rotation.y = Math.atan2(
          cam.position.x - s.mesh.position.x,
          cam.position.z - s.mesh.position.z
        );
      }
      s.mesh.rotation.z = s.sway * Math.sin(time * 0.12 + s.phase);
      s.mesh.material.opacity = s.baseOpacity * (0.92 + 0.08 * Math.sin(time * 0.31 + s.phase * 2.0));
    }

    // Ember glows at two smoke bases: fast asymmetric flicker.
    for (let i = 0; i < this._embers.length; i++) {
      const e = this._embers[i];
      e.sprite.material.opacity =
        e.base + e.amp * Math.abs(Math.sin(time * 9.1 + e.phase) * Math.sin(time * 13.7 + e.phase * 2.3));
    }

    // Birds: circling flocks in V formation, flapping.
    for (let f = 0; f < this._flocks.length; f++) {
      const fl = this._flocks[f];
      const ang = fl.angle0 + fl.omega * time;
      const fx = Math.cos(ang) * fl.radius;
      const fz = Math.sin(ang) * fl.radius;
      const sgn = fl.omega >= 0 ? 1 : -1;
      const hx = -Math.sin(ang) * sgn; // travel direction (tangent)
      const hz = Math.cos(ang) * sgn;
      for (let b = 0; b < fl.birds.length; b++) {
        const bird = fl.birds[b];
        // Behind the leader along heading, fanned out perpendicular.
        const px = fx - bird.back * hx - bird.lat * hz;
        const pz = fz - bird.back * hz + bird.lat * hx;
        const py = fl.height + bird.dy + Math.sin(time * 0.7 + bird.phase) * 1.6;
        bird.mesh.position.set(px, py, pz);
        if (cam) {
          bird.mesh.rotation.y = Math.atan2(cam.position.x - px, cam.position.z - pz);
        }
        bird.mesh.scale.y = 0.35 + 0.65 * Math.abs(Math.sin(time * bird.flap + bird.phase));
      }
    }

    // Sun cards pinned at "infinity": follow the camera along sunDirection.
    if (cam && sunDirection && this._sunGlow) {
      this._sunGlow.position.copy(cam.position).addScaledVector(sunDirection, 700);
      // Tight + dim: the exp(-3r) corona on the disc owns the falloff; this
      // only warms the immediate surroundings, it must not read as a blob.
      this._sunGlow.material.opacity = 0.09 + 0.02 * Math.sin(time * 0.7);
      _hdir.set(sunDirection.x, 0, sunDirection.z);
      if (_hdir.lengthSq() > 1e-8) _hdir.normalize();
      this._sunHaze.position.copy(cam.position).addScaledVector(_hdir, 640);
      // Centre +22 m, 64 m tall at 640 m out: the warm haze glow spans roughly
      // -1..+4.8 deg of elevation — inside the sub-5-deg height-fog band.
      this._sunHaze.position.y = cam.position.y + 22;
      this._sunHaze.material.opacity = 0.06 + 0.015 * Math.sin(time * 0.23 + 1.7);
    }
  }

  // ---- builders ------------------------------------------------------------

  _buildDust(renderer) {
    const N = 260;
    const pos = new Float32Array(N * 3);
    const scale = new Float32Array(N);
    const phase = new Float32Array(N);
    const rand = this._rand;
    for (let i = 0; i < N; i++) {
      pos[i * 3] = rand() * 40;
      pos[i * 3 + 1] = rand() * 22;
      pos[i * 3 + 2] = rand() * 40;
      scale[i] = 0.8 + rand() * 2.2;
      phase[i] = rand();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aScale', new THREE.BufferAttribute(scale, 1));
    geo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
    this._dustUniforms = {
      uTime: { value: 0 },
      uCamPos: { value: new THREE.Vector3(0, 2, 0) },
      uPixel: { value: renderer?.getPixelRatio?.() ?? 1 },
      uOpacity: { value: 0.09 },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: this._dustUniforms,
      vertexShader: DUST_VERT,
      fragmentShader: DUST_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this._dust = new THREE.Points(geo, mat);
    this._dust.frustumCulled = false; // positions are computed in the shader
    this._dust.renderOrder = 5;
    this._group.add(this._dust);
  }

  _buildSmoke(sunDirection) {
    const rand = this._rand;
    const smokeTexA = makeSmokeTexture(101);
    const smokeTexB = makeSmokeTexture(202);
    const glowTex = makeGlowTexture();
    // Azimuths chosen to ring the horizon without parking a column on the sun disc.
    const azimuths = [18, 75, 132, 168, 246, 318];
    for (let i = 0; i < azimuths.length; i++) {
      const az = THREE.MathUtils.degToRad(azimuths[i] + (rand() - 0.5) * 14);
      const radius = 240 + rand() * 90;
      const height = 150 + rand() * 90;
      const width = height * (0.28 + rand() * 0.1);
      const geo = new THREE.PlaneGeometry(width, height);
      geo.translate(0, height * 0.5, 0); // pivot at the base so sway looks anchored
      const mat = new THREE.MeshBasicMaterial({
        map: i % 2 === 0 ? smokeTexA : smokeTexB,
        transparent: true,
        opacity: 0.75 + rand() * 0.2,
        depthWrite: false,
        side: THREE.DoubleSide,
        fog: true, // haze eats them into silhouettes — exactly the mood
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(Math.sin(az) * radius, 0, Math.cos(az) * radius);
      mesh.renderOrder = 2;
      mesh.userData.noHit = true;
      this._group.add(mesh);
      this._smoke.push({
        mesh,
        phase: rand() * 10,
        sway: 0.02 + rand() * 0.03,
        baseOpacity: mat.opacity,
      });
      // Two of the columns burn at the base.
      if (i === 1 || i === 4) {
        const em = new THREE.SpriteMaterial({
          map: glowTex,
          color: 0xff7a28,
          blending: THREE.AdditiveBlending,
          transparent: true,
          depthWrite: false,
          opacity: 0.2,
          fog: false, // fire light punches through haze
        });
        const sprite = new THREE.Sprite(em);
        sprite.position.set(mesh.position.x, 7, mesh.position.z);
        sprite.scale.set(30, 22, 1);
        this._group.add(sprite);
        this._embers.push({ sprite, base: 0.14, amp: 0.1, phase: rand() * 6.28 });
      }
    }
  }

  _buildBirds() {
    const rand = this._rand;
    const tex = makeBirdTexture();
    const mat = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: true,
    });
    const geo = new THREE.PlaneGeometry(2.4, 1.0);
    this._flocks = [
      { angle0: 0.9, omega: 0.021, radius: 175, height: 82, birds: [] },
      { angle0: 3.8, omega: -0.017, radius: 215, height: 96, birds: [] },
    ];
    const counts = [6, 5];
    for (let f = 0; f < this._flocks.length; f++) {
      const fl = this._flocks[f];
      for (let b = 0; b < counts[f]; b++) {
        const mesh = new THREE.Mesh(geo, mat);
        mesh.renderOrder = 3;
        this._group.add(mesh);
        const rank = Math.ceil(b / 2); // 0, 1, 1, 2, 2, 3 — V formation
        fl.birds.push({
          mesh,
          back: rank * 3.6 + rand() * 0.8,
          lat: (b % 2 === 0 ? 1 : -1) * (rank * 2.8 + rand() * 0.6),
          dy: (rand() - 0.5) * 3,
          flap: 5.5 + rand() * 2.5,
          phase: rand() * 6.28,
        });
        this._birds.push(mesh);
      }
    }
  }

  _buildSunGlow() {
    // Both cards were the main culprits of the 15-degree white blob (120 m and
    // 430x110 m additive quads at ~700 m = ~10 and ~37 degrees of glow). Now:
    // a ~3.6-degree warm halo and a low, dim horizon glow inside the haze band.
    const glowTex = makeGlowTexture();
    this._sunGlow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTex,
      color: 0xffcf9e, // warm — additive white is what made the blob read white
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      opacity: 0.09,
      fog: false,
    }));
    this._sunGlow.scale.set(44, 44, 1);
    this._sunGlow.renderOrder = 1;
    this._group.add(this._sunGlow);

    this._sunHaze = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTex,
      color: 0xffb877,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      opacity: 0.06,
      fog: false,
    }));
    this._sunHaze.scale.set(360, 64, 1);
    this._sunHaze.renderOrder = 1;
    this._group.add(this._sunHaze);
  }
}
