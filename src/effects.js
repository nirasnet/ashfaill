// EFFECTS — owns: muzzle flash, tracers, impact sparks/dust, decals, shell casings,
// smoke, blood puffs, explosion-ish flair. Owns THIS file only (plus src/effects/*).
//
// Bar = CoD gunfight juice. Everything pooled (no per-shot allocations after init).
// Listens on ctx.events:
//  - 'weapon:fire'   {origin, direction}: muzzle flash — compact CoD pop,
//                    ~0.35m visual diameter at the muzzle: hot #fff4d6 white
//                    core with fast falloff + 2-3 short irregular spikes,
//                    random baked variant/rotation/scale per shot, alive 1-2
//                    rendered frames max — plus a 50ms point
//                    light (intensity ~6, range 4m, #ffb45e) that lights the hands,
//                    weapon top and nearby walls; a thin drifting muzzle-smoke
//                    RIBBON (~5 links, alpha ~0.15, rise 0.2m/s, ~1.5s life, never
//                    drifting toward the camera) that persists briefly after a
//                    burst; camera-space brass eject (full-metal envMapped brass,
//                    spin 14-22 rad/s, motion-blur streak on its first visible
//                    frames, never drawn within 0.25m of the camera); and an
//                    emissive tracer slug every 3rd round (#ffd27a x4, ~1.2m,
//                    motion-stretched per frame so 60fps never strobes a gap).
//  - 'hit:world'     {point, normal, object}: surface-aware impact. Concrete/brick:
//                    300ms grey dust puff + 4cm normal-mapped bullet-hole decal
//                    (pooled 64, oldest recycled) + small spark burst. Metal
//                    (material.metalness >= 0.4): 2-3 hot ricochet spark STREAKS
//                    (reuses the tracer pool) + spark burst, no decal.
//  - 'hit:enemy'     {point}: red mist puff.
//  - 'enemy:fire'    {origin, direction}: enemy muzzle flash + thin, slower tracer
//                    toward the player — every 3rd round, and ONLY when the
//                    muzzle is on screen (a streak entering from off-frame with no
//                    visible origin reads as a glitch, not incoming fire).
//  - 'enemy:killed'  {enemy}: bigger dust/impact burst at their position.
//  - 'player:damage': nothing here (hud handles overlay).
import * as THREE from 'three';
import { ParticlePool, BillboardPool } from './effects/particles.js';
import {
  makeGlowTexture, makeFlashTexture, makeSmokeTexture,
  makeMuzzleSmokeTexture, makeTracerTexture, makeBulletHoleMaps,
} from './effects/textures.js';

// --- Pool capacities -------------------------------------------------------
const MAX_TRACERS = 96;
const MAX_DECALS = 64;
const MAX_CASINGS = 64;
const MAX_FLASHES = 8;
const MAX_LIGHTS = 2;           // hard cap per spec
const TRACER_RANGE = 300;
const TRACER_EVERY = 3;         // tracer cadence: every 3rd round
const TRACER_MAX_W = 0.015;     // hard cap on tracer cross-section, meters
const TRACER_MIN_PX = 2.2;      // distance-scaled width floor: keep >= ~2px at range
const CASING_LIFE = 2.0;        // seconds before a casing despawns
const CASING_HIDE_R = 0.25;     // never draw brass within this radius of the camera
const CASING_HIDE_R2 = CASING_HIDE_R * CASING_HIDE_R;
const CASING_STRETCH_T = 0.12;  // motion-blur streak window: first visible frames
                                // (brass spends ~0.05s inside CASING_HIDE_R first)

/** Metal vs mineral surface for impact feedback. Explicit userData.surface wins;
 *  otherwise sniff the material's PBR metalness (level metals sit at 0.45-0.9,
 *  concrete/brick at 0-0.35). */
function surfaceIsMetal(obj) {
  const tag = obj?.userData?.surface;
  if (typeof tag === 'string') return tag === 'metal';
  let m = obj?.material;
  if (Array.isArray(m)) m = m[0];
  return typeof m?.metalness === 'number' && m.metalness >= 0.4;
}

// --- Module temps (never allocated per shot) -------------------------------
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _e1 = new THREE.Euler();
const _m1 = new THREE.Matrix4();
const _c1 = new THREE.Color();
const _Z = new THREE.Vector3(0, 0, 1);
const _DOWN = new THREE.Vector3(0, -1, 0);
const _WORLD_UP = new THREE.Vector3(0, 1, 0);

function isVec3(v) { return v && typeof v.x === 'number' && typeof v.y === 'number' && typeof v.z === 'number'; }

/** Crossed-quad tracer geometry: head at local origin, tail at z=-1, width 1 on x/y. */
function makeTracerGeometry() {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array([
    // XZ plane quad
    -0.5, 0, 0, 0.5, 0, 0, 0.5, 0, -1, -0.5, 0, -1,
    // YZ plane quad
    0, -0.5, 0, 0, 0.5, 0, 0, 0.5, -1, 0, -0.5, -1,
  ]);
  const uv = new Float32Array([
    1, 0, 1, 1, 0, 1, 0, 0,
    1, 0, 1, 1, 0, 1, 0, 0,
  ]);
  const idx = [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7];
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(idx);
  return geo;
}

export class EffectsSystem {
  async init(ctx) {
    this.ctx = ctx;
    this.enabled = !!ctx?.scene;
    if (!this.enabled) return;
    const scene = ctx.scene;

    // ---- Textures (built once) ------------------------------------------
    const glowTex = makeGlowTexture(128);
    const smokeTex = makeSmokeTexture({ seed: 5 });
    const muzzleSmokeTex = makeMuzzleSmokeTexture({ seed: 9 });
    const tracerTex = makeTracerTexture();
    const hole = makeBulletHoleMaps({ seed: 23 });
    // Compact CoD flash: 4 baked variants, 2-3 short irregular spikes each.
    // spawnFlash picks a random variant + rotation + scale per shot (and a
    // second variant for the residue frame) so no two pops read the same.
    this.flashTex = [
      makeFlashTexture({ spikes: 2, seed: 3 }),
      makeFlashTexture({ spikes: 3, seed: 11 }),
      makeFlashTexture({ spikes: 3, seed: 41 }),
      makeFlashTexture({ spikes: 2, seed: 57 }),
    ];

    // ---- Particle pools --------------------------------------------------
    this.sparks = new ParticlePool({ max: 384, map: glowTex, blending: THREE.AdditiveBlending, fadePow: 1.2, fadeIn: 0.02, renderOrder: 9 });
    this.dust = new ParticlePool({ max: 384, map: smokeTex, blending: THREE.NormalBlending, fadePow: 1.5, fadeIn: 0.1, renderOrder: 8 });
    this.blood = new ParticlePool({ max: 256, map: smokeTex, blending: THREE.NormalBlending, fadePow: 1.3, fadeIn: 0.04, renderOrder: 8 });
    for (const p of [this.sparks, this.dust, this.blood]) scene.add(p.points);
    // Muzzle smoke lives on world-sized billboards (point sprites pixel-clamp
    // and can't reach 1.2m near the camera). One instanced draw call.
    this.muzzleSmoke = new BillboardPool({ max: 224, map: muzzleSmokeTex, blending: THREE.NormalBlending, fadePow: 1.35, fadeIn: 0.06, renderOrder: 8 });
    scene.add(this.muzzleSmoke.mesh);

    // ---- Tracers (one InstancedMesh, crossed additive quads) -------------
    this.tracerMesh = new THREE.InstancedMesh(
      makeTracerGeometry(),
      new THREE.MeshBasicMaterial({
        map: tracerTex, blending: THREE.AdditiveBlending, transparent: true,
        depthWrite: false, side: THREE.DoubleSide, toneMapped: false, fog: false,
      }),
      MAX_TRACERS,
    );
    this.tracerMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.tracerMesh.frustumCulled = false;
    this.tracerMesh.renderOrder = 9;
    this.tracerMesh.userData.noHit = true;
    this.tracerMesh.count = 0;
    _c1.setRGB(1, 1, 1);
    for (let i = 0; i < MAX_TRACERS; i++) this.tracerMesh.setColorAt(i, _c1);
    this.tracerMesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    scene.add(this.tracerMesh);
    // SoA tracer state.
    this.trOrigin = new Float32Array(MAX_TRACERS * 3);
    this.trDir = new Float32Array(MAX_TRACERS * 3);
    this.trQuat = new Float32Array(MAX_TRACERS * 4);
    this.trCol = new Float32Array(MAX_TRACERS * 3);
    this.trSpeed = new Float32Array(MAX_TRACERS);
    this.trTraveled = new Float32Array(MAX_TRACERS);
    this.trMaxDist = new Float32Array(MAX_TRACERS);
    this.trLen = new Float32Array(MAX_TRACERS);
    this.trWidth = new Float32Array(MAX_TRACERS);
    this.trCount = 0;

    // ---- Bullet-hole decals (InstancedMesh ring buffer) ------------------
    // Lit + normal-mapped: the 4cm crater has a real rim lip and pit that catch
    // sun and muzzle-flash light, instead of a flat unlit dark sticker.
    this.decalMesh = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshStandardMaterial({
        map: hole.map, normalMap: hole.normalMap,
        normalScale: new THREE.Vector2(1.5, 1.5),
        roughness: 0.9, metalness: 0,
        transparent: true, depthWrite: false,
        polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
      }),
      MAX_DECALS,
    );
    this.decalMesh.frustumCulled = false;
    this.decalMesh.renderOrder = 2;
    this.decalMesh.userData.noHit = true;
    _m1.makeScale(0, 0, 0);
    for (let i = 0; i < MAX_DECALS; i++) this.decalMesh.setMatrixAt(i, _m1);
    this.decalMesh.instanceMatrix.needsUpdate = true;
    this.decalHead = 0;
    scene.add(this.decalMesh);

    // ---- Shell casings (InstancedMesh + tiny physics) --------------------
    // Rifle brass at true scale: 5.7cm long x 1cm diameter. Full-metal brass,
    // metalness 1.0 / roughness 0.25, with an EXPLICIT envMap (the PMREM sky
    // from atmosphere.js) + envMapIntensity boost so tumbling brass throws
    // warm sky glints instead of reading as a flat white litter speck.
    // scene.environment may land after our init, so updateCasings re-checks.
    this.casingMesh = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.005, 0.005, 0.057, 8, 1),
      new THREE.MeshStandardMaterial({
        color: 0xc9973b, metalness: 1.0, roughness: 0.25,
        envMap: scene.environment || null, envMapIntensity: 1.8,
      }),
      MAX_CASINGS,
    );
    this.casingMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.casingMesh.frustumCulled = false;
    this.casingMesh.userData.noHit = true;
    this.casingMesh.count = 0;
    scene.add(this.casingMesh);
    this.caPos = new Float32Array(MAX_CASINGS * 3);
    this.caVel = new Float32Array(MAX_CASINGS * 3);
    this.caEul = new Float32Array(MAX_CASINGS * 3);
    this.caAv = new Float32Array(MAX_CASINGS * 3);
    this.caLife = new Float32Array(MAX_CASINGS);
    this.caFloor = new Float32Array(MAX_CASINGS);
    this.caCount = 0;

    // ---- Muzzle flash (compact core sprite + small warm glow per slot) ----
    // Additive HDR pop: a #fff4d6 hot-white CORE (x8 on its first frame,
    // toneMapped: false so it survives ACES + reads through bloom) whose
    // baked texture carries the 2-3 short irregular spikes, over a small
    // #ff9c3f glow. The whole thing lives 1-2 rendered frames — a strobe,
    // not a lamp — while spawnLight's 50ms flicker carries the afterglow.
    this.flashes = [];
    for (let i = 0; i < MAX_FLASHES; i++) {
      const starMat = new THREE.SpriteMaterial({
        map: this.flashTex[0], blending: THREE.AdditiveBlending, transparent: true,
        depthWrite: false, toneMapped: false, fog: false, opacity: 0,
      });
      starMat.color.set(0xfff4d6).multiplyScalar(8);
      const glowMat = new THREE.SpriteMaterial({
        map: glowTex, blending: THREE.AdditiveBlending, transparent: true,
        depthWrite: false, toneMapped: false, fog: false, opacity: 0,
      });
      glowMat.color.set(0xff9c3f).multiplyScalar(2.2);
      const star = new THREE.Sprite(starMat);
      const glow = new THREE.Sprite(glowMat);
      star.visible = glow.visible = false;
      star.renderOrder = 10; glow.renderOrder = 10;
      star.userData.noHit = glow.userData.noHit = true;
      scene.add(star); scene.add(glow);
      this.flashes.push({
        star, glow, t: 0, frames: 0, maxFrames: 1, dur: 0.06,
        scale: 0.3, tex2: null, active: false,
      });
    }
    this.flashHead = 0;

    // ---- Muzzle lights (max 2; 50ms spike, intensity ~6, range 4m) -------
    // The one thing a sprite can't fake: the flash as LIGHT on the hands, the
    // weapon top and nearby surfaces.
    this.lights = [];
    for (let i = 0; i < MAX_LIGHTS; i++) {
      const l = new THREE.PointLight(0xffb45e, 0, 4, 2);
      l.userData.noHit = true;
      scene.add(l);
      this.lights.push({ light: l, t: 1, dur: 0.05, peak: 0 });
    }
    this.lightHead = 0;

    // Tracer cadence countdowns (player / enemy fire pools kept separate):
    // one emissive slug every TRACER_EVERY rounds.
    this._tracerIn = 1;
    this._enemyTracerIn = 1;

    // ---- Event wiring ----------------------------------------------------
    const ev = ctx.events;
    if (ev?.on) {
      ev.on('weapon:fire', (p) => { try { this.onWeaponFire(p); } catch (e) { /* never break the emitter */ } });
      ev.on('hit:world', (p) => { try { this.onHitWorld(p); } catch (e) {} });
      ev.on('hit:enemy', (p) => { try { this.onHitEnemy(p); } catch (e) {} });
      ev.on('enemy:fire', (p) => { try { this.onEnemyFire(p); } catch (e) {} });
      ev.on('enemy:killed', (p) => { try { this.onEnemyKilled(p); } catch (e) {} });
    }
  }

  // ======================================================================
  // Spawners
  // ======================================================================

  /** Muzzle flash: compact CoD pop. `scale` is the sprite size in meters
   *  (player: 0.3 -> spike tips span ~0.35m visual diameter). Random baked
   *  variant + rotation + scale per shot; updateFlashes kills the whole
   *  thing after 1-2 rendered frames. */
  spawnFlash(pos, scale, isEnemy) {
    const f = this.flashes[this.flashHead];
    this.flashHead = (this.flashHead + 1) % MAX_FLASHES;
    f.active = true;
    f.t = 0;
    f.frames = 0;
    // 1-2 rendered frames, chosen per shot — mid-burst the muzzle strobes
    // instead of holding a lamp. dur is only a low-fps backstop so a hitched
    // frame can't pin the pop on screen.
    f.maxFrames = Math.random() < 0.45 ? 1 : 2;
    f.dur = 0.06;
    f.scale = scale * (0.8 + Math.random() * 0.45);
    // Random variant now + a DIFFERENT one queued for the residue frame.
    const nTex = this.flashTex.length;
    const ti = (Math.random() * nTex) | 0;
    f.tex2 = this.flashTex[(ti + 1 + ((Math.random() * (nTex - 1)) | 0)) % nTex];
    f.star.position.copy(pos);
    f.glow.position.copy(pos);
    f.star.material.map = this.flashTex[ti];
    f.star.material.rotation = Math.random() * Math.PI * 2;
    // Frame one is the HDR x8 pop; updateFlashes relaxes the residue frame.
    f.star.material.color.set(0xfff4d6).multiplyScalar(8);
    f.star.material.opacity = 1;
    f.glow.material.opacity = isEnemy ? 0.3 : 0.4;
    f.star.scale.setScalar(f.scale);
    f.glow.scale.setScalar(f.scale * 1.25);
    f.star.visible = f.glow.visible = true;
  }

  spawnLight(pos, peak) {
    const s = this.lights[this.lightHead];
    this.lightHead = (this.lightHead + 1) % MAX_LIGHTS;
    s.t = 0;
    s.dur = 0.05;
    s.peak = peak;
    s.light.position.copy(pos);
    s.light.position.y += 0.02;
    s.light.intensity = peak;
  }

  /** dir must be normalized. Registers a streak from `pos` along `dir`. */
  spawnTracer(pos, dir, speed, len, width, r, g, b, maxDist) {
    let i;
    if (this.trCount < MAX_TRACERS) i = this.trCount++;
    else { // recycle the one closest to finishing
      i = 0; let best = -Infinity;
      for (let k = 0; k < MAX_TRACERS; k++) {
        const done = this.trTraveled[k] - this.trMaxDist[k];
        if (done > best) { best = done; i = k; }
      }
    }
    const i3 = i * 3, i4 = i * 4;
    this.trOrigin[i3] = pos.x; this.trOrigin[i3 + 1] = pos.y; this.trOrigin[i3 + 2] = pos.z;
    this.trDir[i3] = dir.x; this.trDir[i3 + 1] = dir.y; this.trDir[i3 + 2] = dir.z;
    _q1.setFromUnitVectors(_Z, dir);
    this.trQuat[i4] = _q1.x; this.trQuat[i4 + 1] = _q1.y; this.trQuat[i4 + 2] = _q1.z; this.trQuat[i4 + 3] = _q1.w;
    this.trCol[i3] = r; this.trCol[i3 + 1] = g; this.trCol[i3 + 2] = b;
    this.trSpeed[i] = speed;
    this.trTraveled[i] = 0;
    this.trMaxDist[i] = maxDist;
    this.trLen[i] = len;
    this.trWidth[i] = width;
  }

  spawnDecal(point, normal) {
    const i = this.decalHead;
    this.decalHead = (this.decalHead + 1) % MAX_DECALS;
    const size = 0.036 + Math.random() * 0.012; // ~4cm: a rifle hole, not a cannonball crater
    _v1.copy(point).addScaledVector(normal, 0.006);
    _q1.setFromUnitVectors(_Z, normal);
    _q2.setFromAxisAngle(_Z, Math.random() * Math.PI * 2);
    _q1.multiply(_q2);
    _v2.set(size, size, 1);
    _m1.compose(_v1, _q1, _v2);
    this.decalMesh.setMatrixAt(i, _m1);
    this.decalMesh.instanceMatrix.needsUpdate = true;
  }

  /**
   * Brass ejects from a port fixed in CAMERA space: +0.12m right, -0.03m down
   * from the eye, velocity ~(2.2, 1.6, 0.3) m/s in camera right/up/forward —
   * sideways and away from the view axis, never across it. The spawn point sits
   * inside CASING_HIDE_R, so updateCasings keeps the first ~3 simulated frames
   * invisible; the casing pops in already clear of the near plane instead of
   * smearing across it as a meter-long gold pipe.
   */
  spawnCasing() {
    const cam = this.ctx?.camera;
    if (!cam) return; // no viewer, no brass
    let i;
    if (this.caCount < MAX_CASINGS) i = this.caCount++;
    else { // recycle the deadest
      i = 0; let best = Infinity;
      for (let k = 0; k < MAX_CASINGS; k++) if (this.caLife[k] < best) { best = this.caLife[k]; i = k; }
    }
    const i3 = i * 3;
    _right.setFromMatrixColumn(cam.matrixWorld, 0);
    _up.setFromMatrixColumn(cam.matrixWorld, 1);
    _v4.setFromMatrixColumn(cam.matrixWorld, 2); // camera BACKWARD (+Z column)
    _v2.copy(cam.position).addScaledVector(_right, 0.12).addScaledVector(_up, -0.03);
    this.caPos[i3] = _v2.x; this.caPos[i3 + 1] = _v2.y; this.caPos[i3 + 2] = _v2.z;
    // Find the floor once at spawn (cheap: one ray per shot).
    const hit = this.ctx?.world?.raycast?.(_v2, _DOWN, 8);
    this.caFloor[i] = hit ? hit.point.y : _v2.y - 1.7;
    // ~(2.2 right, 1.6 up, 0.3 forward) m/s with per-shot jitter: a flick out of
    // the port that arcs right and drops, always diverging from the view axis.
    _v2.copy(_right).multiplyScalar(2.2 * (0.85 + Math.random() * 0.3))
      .addScaledVector(_up, 1.6 * (0.85 + Math.random() * 0.3))
      .addScaledVector(_v4, -0.3 * (0.7 + Math.random() * 0.6));
    this.caVel[i3] = _v2.x; this.caVel[i3 + 1] = _v2.y; this.caVel[i3 + 2] = _v2.z;
    this.caEul[i3] = Math.random() * Math.PI * 2;
    this.caEul[i3 + 1] = Math.random() * Math.PI * 2;
    this.caEul[i3 + 2] = Math.random() * Math.PI * 2;
    // Spin: random axis at 14-22 rad/s — fast enough that the brass visibly
    // tumbles and its envMap glint sweeps as it flies.
    _v4.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5);
    if (_v4.lengthSq() < 1e-6) _v4.set(1, 0, 0);
    _v4.normalize().multiplyScalar(14 + Math.random() * 8);
    this.caAv[i3] = _v4.x;
    this.caAv[i3 + 1] = _v4.y;
    this.caAv[i3 + 2] = _v4.z;
    this.caLife[i] = CASING_LIFE;
  }

  /**
   * Muzzle smoke RIBBON — not a blob. A chain of small low-alpha billboard
   * links laid along the first half-meter of the shot, each with a sustained
   * ~0.2 m/s rise (buoyancy 0.25 against drag 1.25 -> terminal 0.2) and ~1.5s
   * life, so a burst leaves a thin curling trail that drifts up and lingers
   * briefly after the last round. Art-director rules kept from the last pass:
   *  - alpha ~0.15 per link: a full-overlap stack can never build past ~30%
   *    gray, never an opaque ball;
   *  - near the camera, any drift toward it is killed (enemy fire aims dir AT
   *    the camera) — the sight picture stays readable in ADS.
   */
  muzzleRibbon(pos, dir, count = 5) {
    // Lateral basis + a per-shot curl so consecutive ribbons wander apart.
    _right.crossVectors(dir, _WORLD_UP);
    if (_right.lengthSq() < 1e-6) _right.set(1, 0, 0); else _right.normalize();
    const cam = this.ctx?.camera;
    const bend = (Math.random() - 0.5) * 0.6;
    for (let k = 0; k < count; k++) {
      const t = count > 1 ? k / (count - 1) : 0;         // 0 at muzzle -> 1 at tip
      const ahead = 0.06 + t * 0.42;
      const px = pos.x + dir.x * ahead + _right.x * bend * t * 0.12 + (Math.random() - 0.5) * 0.02;
      const py = pos.y + dir.y * ahead + t * t * 0.04 + (Math.random() - 0.5) * 0.02;
      const pz = pos.z + dir.z * ahead + _right.z * bend * t * 0.12 + (Math.random() - 0.5) * 0.02;
      // Muzzle-end links hang near the barrel; tip links carry residual
      // forward drift, so the ribbon stretches then rises as one sheet.
      const fwd = 0.55 - t * 0.35;
      let vx = dir.x * fwd + _right.x * bend * 0.3;
      let vy = dir.y * fwd + 0.16 + Math.random() * 0.08; // buoyancy tops this up to ~0.2
      let vz = dir.z * fwd + _right.z * bend * 0.3;
      // Hard guarantee: near the camera, kill any velocity component that
      // points back toward it.
      if (cam) {
        _v4.set(px - cam.position.x, py - cam.position.y, pz - cam.position.z);
        const d2 = _v4.lengthSq();
        if (d2 < 16 && d2 > 1e-6) {
          _v4.multiplyScalar(1 / Math.sqrt(d2));
          const away = vx * _v4.x + vy * _v4.y + vz * _v4.z; // <0 = toward camera
          if (away < 0.15) {
            const fix = 0.15 - away;
            vx += _v4.x * fix; vy += _v4.y * fix; vz += _v4.z * fix;
          }
        }
      }
      this.muzzleSmoke.spawn(px, py, pz, vx, vy, vz, {
        life: 1.35 + Math.random() * 0.35,               // ~1.5s
        size: 0.045 + t * 0.05,                          // thin 4.5-9.5cm links
        growth: 2.6,                                     // disperses to ~0.2-0.3m
        alpha: 0.13 + Math.random() * 0.04,              // ~0.15
        drag: 1.25, gravity: 0.25,                       // rise settles at 0.2 m/s
        r: 0.58, g: 0.575, b: 0.56,                      // neutral gray, not white
        rot: Math.random() * Math.PI * 2, rotSpeed: (Math.random() - 0.5) * 0.9,
      });
    }
  }

  // ======================================================================
  // Event handlers
  // ======================================================================

  onWeaponFire(p) {
    if (!this.enabled || !isVec3(p?.origin) || !isVec3(p?.direction)) return;
    const dir = _v3.copy(p.direction).normalize();
    // Basis around the shot direction.
    _right.crossVectors(dir, _WORLD_UP);
    if (_right.lengthSq() < 1e-6) _right.set(1, 0, 0); else _right.normalize();
    _up.crossVectors(_right, dir).normalize();
    // If the reported origin is basically the camera, offset to a viewmodel muzzle.
    _v1.copy(p.origin);
    const cam = this.ctx?.camera;
    if (cam && _v2.copy(cam.position).sub(_v1).lengthSq() < 0.16) {
      _v1.addScaledVector(dir, 0.55).addScaledVector(_right, 0.13).addScaledVector(_up, -0.09);
    }
    // Compact ~0.35m flash pop (1-2 frames) + 50ms light spike (intensity ~6,
    // range 4m) that lights the hands, weapon top, and nearby surfaces.
    this.spawnFlash(_v1, 0.3, false);
    this.spawnLight(_v1, 6);
    // Thin drifting muzzle-smoke ribbon (5 links, ~1.5s persistence).
    this.muzzleRibbon(_v1, dir, 5);
    // Brass: camera-space eject port, hidden until clear of the near plane.
    this.spawnCasing();
    // Emissive tracer slug every 3rd round.
    if (--this._tracerIn <= 0) {
      this._tracerIn = TRACER_EVERY;
      // Find the stop distance with one ray (offset past the viewmodel).
      // Ray starts at origin+0.6*dir; the tracer spawns ~0.25m further along, so
      // subtract that offset to stop the streak exactly at the wall.
      _v2.copy(p.origin).addScaledVector(dir, 0.6);
      const hit = this.ctx?.world?.raycast?.(_v2, dir, TRACER_RANGE);
      const maxDist = hit ? Math.max(0.4, hit.distance - 0.25) : TRACER_RANGE;
      _v2.copy(_v1).addScaledVector(dir, 0.3);
      // ~1.2m slug, 1.2cm base cross-section (distance-scaled at render, never
      // >1.5cm near), additive #ffd27a x4. updateTracers adds per-frame motion
      // stretch (speed*dt) so consecutive frames never strobe a gap.
      this.spawnTracer(_v2, dir, 330, 1.15 + Math.random() * 0.25, 0.012, 4.0, 3.29, 1.91, maxDist);
    }
  }

  onEnemyFire(p) {
    if (!this.enabled || !isVec3(p?.origin) || !isVec3(p?.direction)) return;
    const dir = _v3.copy(p.direction).normalize();
    _v1.copy(p.origin);
    // Bigger flash so it reads at range: you should SEE who is shooting.
    this.spawnFlash(_v1, 0.45, true);
    this.spawnLight(_v1, 5);
    this.muzzleRibbon(_v1, dir, 3);
    // Slower #ffd27a tracer streaking toward the player, every 3rd round —
    // and ONLY when the muzzle is on screen. A streak entering from off-frame
    // with no visible origin reads as a renderer glitch, not incoming fire.
    const cam = this.ctx?.camera;
    if (!cam) return;
    _v4.setFromMatrixColumn(cam.matrixWorld, 2);          // camera backward
    _v2.copy(_v1).sub(cam.position);
    if (_v2.dot(_v4) >= 0) return;                        // muzzle behind camera
    _v4.copy(_v1).project(cam);                           // NDC test, small margin
    if (Math.abs(_v4.x) > 1.06 || Math.abs(_v4.y) > 1.06 || _v4.z >= 1) return;
    if (--this._enemyTracerIn > 0) return;                // cadence counts on-screen rounds only
    this._enemyTracerIn = TRACER_EVERY;
    _v2.copy(_v1).addScaledVector(dir, 0.25);             // start AT the visible muzzle
    const hit = this.ctx?.world?.raycast?.(_v2, dir, TRACER_RANGE);
    const maxDist = hit ? Math.max(0.4, hit.distance) : TRACER_RANGE;
    // ~1.4m slug, max-width 1.5cm cross-section, #ffd27a x2.5 (dimmer than the
    // player's so incoming fire reads hostile-warm, not identical).
    this.spawnTracer(
      _v2, dir, 115 + Math.random() * 25, 1.3 + Math.random() * 0.3, TRACER_MAX_W,
      2.5, 2.06, 1.2, maxDist,
    );
  }

  onHitWorld(p) {
    if (!this.enabled || !isVec3(p?.point)) return;
    const n = isVec3(p.normal) ? _v3.copy(p.normal) : _v3.set(0, 1, 0);
    if (n.lengthSq() < 1e-6) n.set(0, 1, 0); else n.normalize();
    const pt = _v1.copy(p.point).addScaledVector(n, 0.01);
    const metal = surfaceIsMetal(p.object);
    // One-frame hot core at the impact point — both surfaces flash on contact.
    this.sparks.spawn(pt.x, pt.y, pt.z, n.x * 0.4, n.y * 0.4, n.z * 0.4, {
      life: 0.06, size: 0.12, alpha: 1, r: 3.2, g: 2.7, b: 1.8,
    });
    // Spark burst — HDR-hot (colors >1, additive) so hits register through
    // bloom. Metal rings with more, concrete chips off a few.
    const nSparks = (metal ? 12 : 6) + (Math.random() * 5 | 0);
    for (let k = 0; k < nSparks; k++) {
      _v2.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(4.4)
        .addScaledVector(n, 1.5 + Math.random() * 3.5);
      this.sparks.spawn(pt.x, pt.y, pt.z, _v2.x, _v2.y, _v2.z, {
        life: 0.12 + Math.random() * 0.3, size: 0.016 + Math.random() * 0.03,
        alpha: 1, gravity: -14, drag: 1.6,
        r: 2.6, g: 1.2 + Math.random() * 0.9, b: 0.3 + Math.random() * 0.35,
      });
    }
    if (metal) {
      // METAL: 2-3 hot ricochet spark STREAKS — elongated additive slugs off
      // the tracer pool, scattered around the surface normal, dying within
      // ~0.1s and half a meter. No decal: thin sheet metal doesn't crater.
      const nStreaks = 2 + (Math.random() * 2 | 0);
      for (let k = 0; k < nStreaks; k++) {
        _v2.set(Math.random() - 0.5, Math.random() - 0.3, Math.random() - 0.5)
          .addScaledVector(n, 0.8 + Math.random() * 0.7).normalize();
        this.spawnTracer(
          pt, _v2, 6 + Math.random() * 5, 0.14 + Math.random() * 0.12, 0.004,
          3.4, 2.0 + Math.random() * 0.6, 0.8, 0.3 + Math.random() * 0.4,
        );
      }
      return;
    }
    // CONCRETE/BRICK: 300ms grey dust puff kicked off the surface + a 4cm
    // normal-mapped bullet-hole decal.
    for (let k = 0; k < 6; k++) {
      _v2.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(1.3)
        .addScaledVector(n, 0.7 + Math.random());
      this.dust.spawn(pt.x, pt.y, pt.z, _v2.x, _v2.y, _v2.z, {
        life: 0.24 + Math.random() * 0.1,               // ~300ms: a chuff, not a fog bank
        size: 0.05 + Math.random() * 0.05,
        growth: 6, alpha: 0.3 + Math.random() * 0.12, gravity: -0.5, drag: 2.2,
        r: 0.6, g: 0.56, b: 0.5,
        rot: Math.random() * Math.PI * 2, rotSpeed: (Math.random() - 0.5) * 2.5,
      });
    }
    this.spawnDecal(p.point, n);
  }

  onHitEnemy(p) {
    if (!this.enabled || !isVec3(p?.point)) return;
    const n = isVec3(p.normal) ? _v3.copy(p.normal).normalize() : _v3.set(0, 1, 0);
    const pt = _v1.copy(p.point);
    // Red mist droplets.
    const nDrops = 10 + (Math.random() * 5 | 0);
    for (let k = 0; k < nDrops; k++) {
      _v2.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(3.2)
        .addScaledVector(n, 0.9);
      this.blood.spawn(pt.x, pt.y, pt.z, _v2.x, _v2.y, _v2.z, {
        life: 0.24 + Math.random() * 0.34, size: 0.028 + Math.random() * 0.05,
        growth: 1.6, alpha: 0.8, gravity: -3.2, drag: 2.2,
        r: 0.4 + Math.random() * 0.18, g: 0.015, b: 0.02,
        rot: Math.random() * Math.PI * 2, rotSpeed: (Math.random() - 0.5) * 3,
      });
    }
    // Hanging mist.
    for (let k = 0; k < 2; k++) {
      this.blood.spawn(
        pt.x + (Math.random() - 0.5) * 0.1, pt.y + (Math.random() - 0.5) * 0.1, pt.z + (Math.random() - 0.5) * 0.1,
        n.x * 0.5, n.y * 0.5 + 0.15, n.z * 0.5, {
          life: 0.4 + Math.random() * 0.25, size: 0.11, growth: 3.2, alpha: 0.34,
          drag: 3, r: 0.32, g: 0.02, b: 0.02,
          rot: Math.random() * Math.PI * 2, rotSpeed: (Math.random() - 0.5) * 2,
        },
      );
    }
  }

  onEnemyKilled(p) {
    if (!this.enabled) return;
    const pos = isVec3(p?.enemy?.position) ? p.enemy.position
      : isVec3(p?.enemy?.object3d?.position) ? p.enemy.object3d.position : null;
    if (!pos) return;
    _v1.copy(pos);
    // Ground dust ring.
    const N = 14;
    for (let k = 0; k < N; k++) {
      const a = (k / N) * Math.PI * 2 + Math.random() * 0.5;
      this.dust.spawn(
        _v1.x + Math.cos(a) * 0.22, _v1.y + 0.12, _v1.z + Math.sin(a) * 0.22,
        Math.cos(a) * (0.9 + Math.random() * 1.6), 0.4 + Math.random() * 1.1, Math.sin(a) * (0.9 + Math.random() * 1.6),
        {
          life: 0.65 + Math.random() * 0.7, size: 0.1 + Math.random() * 0.1,
          growth: 4.2, alpha: 0.3 + Math.random() * 0.12, gravity: -0.6, drag: 1.9,
          r: 0.56, g: 0.51, b: 0.45,
          rot: Math.random() * Math.PI * 2, rotSpeed: (Math.random() - 0.5) * 2,
        },
      );
    }
    // Central thump puff + a few chest-height sparks for flair.
    this.dust.spawn(_v1.x, _v1.y + 0.7, _v1.z, 0, 0.5, 0, {
      life: 0.6, size: 0.24, growth: 3, alpha: 0.36, drag: 2, r: 0.5, g: 0.46, b: 0.41,
      rot: Math.random() * Math.PI * 2, rotSpeed: 0.8,
    });
    const flair = p?.headshot ? 10 : 5;
    for (let k = 0; k < flair; k++) {
      _v2.set(Math.random() - 0.5, Math.random() * 0.7, Math.random() - 0.5).multiplyScalar(3.4);
      this.sparks.spawn(_v1.x, _v1.y + 1.1, _v1.z, _v2.x, _v2.y, _v2.z, {
        life: 0.18 + Math.random() * 0.28, size: 0.02 + Math.random() * 0.02,
        alpha: 1, gravity: -11, drag: 1.4,
        r: 1.0, g: 0.6 + Math.random() * 0.3, b: 0.2,
      });
    }
  }

  // ======================================================================
  // Frame update — advances every pool. Never throws on missing ctx bits.
  // ======================================================================
  update(dt, ctx) {
    if (!this.enabled || dt <= 0) return;

    // World-size -> pixel-size factor for point sprites.
    const h = ctx?.renderer?.domElement?.height || 1080;
    const fov = ctx?.camera?.fov || 74;
    const pointScale = h / (2 * Math.tan((fov * Math.PI) / 360));

    this.sparks.update(dt, pointScale);
    this.muzzleSmoke.update(dt);
    this.dust.update(dt, pointScale);
    this.blood.update(dt, pointScale);
    this.updateTracers(dt, pointScale, ctx?.camera || this.ctx?.camera);
    this.updateFlashes(dt);
    this.updateLights(dt);
    this.updateCasings(dt);
  }

  updateTracers(dt, pointScale = 700, cam = null) {
    let n = this.trCount;
    for (let i = 0; i < n; i++) {
      this.trTraveled[i] += this.trSpeed[i] * dt;
      const tail = this.trTraveled[i] - this.trLen[i];
      if (tail >= this.trMaxDist[i]) {
        // Swap-remove.
        n--;
        if (i !== n) {
          const a3 = i * 3, b3 = n * 3, a4 = i * 4, b4 = n * 4;
          for (let k = 0; k < 3; k++) {
            this.trOrigin[a3 + k] = this.trOrigin[b3 + k];
            this.trDir[a3 + k] = this.trDir[b3 + k];
            this.trCol[a3 + k] = this.trCol[b3 + k];
          }
          for (let k = 0; k < 4; k++) this.trQuat[a4 + k] = this.trQuat[b4 + k];
          this.trSpeed[i] = this.trSpeed[n];
          this.trTraveled[i] = this.trTraveled[n];
          this.trMaxDist[i] = this.trMaxDist[n];
          this.trLen[i] = this.trLen[n];
          this.trWidth[i] = this.trWidth[n];
        }
        i--;
        continue;
      }
      const i3 = i * 3, i4 = i * 4;
      // Motion stretch: the drawn slug covers its ~1.2m base length PLUS the
      // distance flown this frame (speed*dt ~ 5.5m at 60fps), so consecutive
      // frames overlap into one continuous streak instead of strobing gaps.
      const mLen = this.trLen[i] + this.trSpeed[i] * dt;
      const headDist = Math.min(this.trTraveled[i], this.trMaxDist[i]);
      const tailDist = Math.max(0, this.trTraveled[i] - mLen);
      const visLen = Math.max(0.05, headDist - tailDist);
      _v1.set(
        this.trOrigin[i3] + this.trDir[i3] * headDist,
        this.trOrigin[i3 + 1] + this.trDir[i3 + 1] * headDist,
        this.trOrigin[i3 + 2] + this.trDir[i3 + 2] * headDist,
      );
      _q1.set(this.trQuat[i4], this.trQuat[i4 + 1], this.trQuat[i4 + 2], this.trQuat[i4 + 3]);
      // Distance-scaled width: physical cross-section stays <= TRACER_MAX_W near
      // the camera (no pipes across the frame), but scales up with range so a
      // far streak still holds ~TRACER_MIN_PX pixels through bloom. Recomputed
      // every frame, so an incoming tracer thins as it approaches.
      let w = this.trWidth[i];
      if (cam) {
        const dx = _v1.x - cam.position.x, dy = _v1.y - cam.position.y, dz = _v1.z - cam.position.z;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        w = Math.min(0.35, Math.max(w, (dist * TRACER_MIN_PX) / pointScale));
      }
      _v2.set(w, w, visLen);
      _m1.compose(_v1, _q1, _v2);
      this.tracerMesh.setMatrixAt(i, _m1);
      // Additive fade: shrink brightness as the streak is absorbed at the hit point.
      const fade = 0.35 + 0.65 * Math.min(1, visLen / mLen);
      _c1.setRGB(this.trCol[i3] * fade, this.trCol[i3 + 1] * fade, this.trCol[i3 + 2] * fade);
      this.tracerMesh.setColorAt(i, _c1);
    }
    this.trCount = n;
    this.tracerMesh.count = n;
    if (n > 0) {
      this.tracerMesh.instanceMatrix.needsUpdate = true;
      if (this.tracerMesh.instanceColor) this.tracerMesh.instanceColor.needsUpdate = true;
    }
  }

  updateFlashes(dt) {
    for (const f of this.flashes) {
      if (!f.active) continue;
      f.t += dt;
      f.frames += 1;
      // update() runs before render, so frames === 1 during the flash's first
      // rendered frame. Hard cap at maxFrames (1-2 per shot) — or at dur if
      // the frame rate hitches — then everything goes dark at once; only the
      // point light's 50ms flicker lingers.
      if (f.frames > f.maxFrames || f.t >= f.dur) {
        f.active = false;
        f.star.visible = f.glow.visible = false;
        continue;
      }
      if (f.frames === 2) {
        // Residue frame: a different baked variant, dimmer, warmer and a
        // touch wider — cooling gas, not the same sprite fading out.
        f.star.material.map = f.tex2;
        f.star.material.color.set(0xffd9a4).multiplyScalar(3.2);
        f.star.material.opacity = 0.75;
        f.glow.material.opacity *= 0.4;
        f.star.scale.setScalar(f.scale * 1.18);
        f.glow.scale.setScalar(f.scale * 1.5);
      }
    }
  }

  updateLights(dt) {
    for (const s of this.lights) {
      if (s.t >= s.dur) { if (s.light.intensity !== 0) s.light.intensity = 0; continue; }
      s.t += dt;
      const k = Math.max(0, 1 - s.t / s.dur);
      // Slight flicker on the way down sells "burning gas", not "lightbulb".
      s.light.intensity = s.peak * k * (0.8 + Math.random() * 0.35);
    }
  }

  updateCasings(dt) {
    const cam = this.ctx?.camera;
    // atmosphere.js publishes the PMREM sky to scene.environment after our
    // init on some paths — pick it up as soon as it exists so brass always
    // has an envMap to glint with.
    const env = this.ctx?.scene?.environment;
    const mat = this.casingMesh.material;
    if (env && mat.envMap !== env) { mat.envMap = env; mat.needsUpdate = true; }
    let n = this.caCount;
    for (let i = 0; i < n; i++) {
      this.caLife[i] -= dt;
      if (this.caLife[i] <= 0) {
        n--;
        if (i !== n) {
          const a3 = i * 3, b3 = n * 3;
          for (let k = 0; k < 3; k++) {
            this.caPos[a3 + k] = this.caPos[b3 + k];
            this.caVel[a3 + k] = this.caVel[b3 + k];
            this.caEul[a3 + k] = this.caEul[b3 + k];
            this.caAv[a3 + k] = this.caAv[b3 + k];
          }
          this.caLife[i] = this.caLife[n];
          this.caFloor[i] = this.caFloor[n];
        }
        i--;
        continue;
      }
      const i3 = i * 3;
      this.caVel[i3 + 1] -= 11.5 * dt;
      this.caPos[i3] += this.caVel[i3] * dt;
      this.caPos[i3 + 1] += this.caVel[i3 + 1] * dt;
      this.caPos[i3 + 2] += this.caVel[i3 + 2] * dt;
      this.caEul[i3] += this.caAv[i3] * dt;
      this.caEul[i3 + 1] += this.caAv[i3 + 1] * dt;
      this.caEul[i3 + 2] += this.caAv[i3 + 2] * dt;
      // Bounce on the floor recorded at spawn.
      const floor = this.caFloor[i] + 0.015;
      if (this.caPos[i3 + 1] < floor && this.caVel[i3 + 1] < 0) {
        this.caPos[i3 + 1] = floor;
        this.caVel[i3 + 1] *= -0.36;
        this.caVel[i3] *= 0.55;
        this.caVel[i3 + 2] *= 0.55;
        this.caAv[i3] *= 0.45; this.caAv[i3 + 1] *= 0.45; this.caAv[i3 + 2] *= 0.45;
        if (Math.abs(this.caVel[i3 + 1]) < 0.35) { // settled
          this.caVel[i3 + 1] = 0;
          this.caAv[i3] = this.caAv[i3 + 2] = 0;
        }
      }
      _v1.set(this.caPos[i3], this.caPos[i3 + 1], this.caPos[i3 + 2]);
      // NEVER draw brass within CASING_HIDE_R of the camera: a 5.7cm cylinder
      // crossing the near plane rasterizes as a meter-long gold pipe. Simulate,
      // but write a zero-scale matrix until it is clear.
      if (cam) {
        const dx = _v1.x - cam.position.x, dy = _v1.y - cam.position.y, dz = _v1.z - cam.position.z;
        if (dx * dx + dy * dy + dz * dz < CASING_HIDE_R2) {
          _m1.makeScale(0, 0, 0);
          this.casingMesh.setMatrixAt(i, _m1);
          continue;
        }
      }
      // Shrink out over the last 0.25s instead of popping.
      const sc = this.caLife[i] < 0.25 ? Math.max(0.001, this.caLife[i] / 0.25) : 1;
      const age = CASING_LIFE - this.caLife[i];
      let stretched = false;
      if (age < CASING_STRETCH_T) {
        // First visible frames: align to velocity and elongate to cover this
        // frame's actual travel (speed*dt) — a real motion-blur streak out of
        // the port that decays into the normal spin/tumble.
        _v2.set(this.caVel[i3], this.caVel[i3 + 1], this.caVel[i3 + 2]);
        const sp2 = _v2.lengthSq();
        if (sp2 > 1e-4) {
          const sp = Math.sqrt(sp2);
          _v2.multiplyScalar(1 / sp);
          _q1.setFromUnitVectors(_WORLD_UP, _v2); // cylinder axis is +Y
          const decay = 1 - age / CASING_STRETCH_T;
          const smear = Math.min(5, (sp * dt) / 0.057); // frame travel in casing-lengths
          // Decays to exactly 1x at the window edge: no scale pop into tumble.
          _v2.set(sc, sc * (1 + (0.6 + smear) * 2.2 * decay), sc);
          stretched = true;
        }
      }
      if (!stretched) {
        _e1.set(this.caEul[i3], this.caEul[i3 + 1], this.caEul[i3 + 2]);
        _q1.setFromEuler(_e1);
        _v2.setScalar(sc);
      }
      _m1.compose(_v1, _q1, _v2);
      this.casingMesh.setMatrixAt(i, _m1);
    }
    this.caCount = n;
    this.casingMesh.count = n;
    if (n > 0) this.casingMesh.instanceMatrix.needsUpdate = true;
  }
}
