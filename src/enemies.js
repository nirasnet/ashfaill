// ENEMIES — owns: enemy soldier models, animation, AI, spawning, death.
//
// Humanoid soldiers built from primitives (see src/enemies/soldier.js) with a
// CoD-bot-lite brain: PATROL between cover points until the player is seen
// (<60m + LOS + frontal cone), then COMBAT — advance between cover, strafe,
// crouch-hold, and fire 3-6 round bursts at ~150ms cadence with distance-scaled
// accuracy. Registered in ctx.world.enemies per the core.js contract; deaths
// emit 'enemy:killed', bump kills/score, ragdoll-ish tumble, corpse fades ~15s,
// respawn 3s later at the spawn point farthest from the player.
import * as THREE from 'three';
import { rng } from './utils.js';
import { Soldier, createSoldierAssets } from './enemies/soldier.js';

const TAU = Math.PI * 2;
const WALK_SPEED = 1.6;
const COMBAT_SPEED = 3.4;
const SIGHT_RANGE = 60;
const FIRE_RANGE = 70;
const SHOT_CADENCE = 0.15;
const RESPAWN_DELAY = 3;
const INITIAL_COUNT = 10;   // spec: spawn 8-12
const MIN_ALIVE = 6;        // spec: keep 6-10 alive while playing
const MAX_ALIVE = 10;
const POOL_CAP = 22;        // alive + fading corpses
const MAX_HP = 100;
const SHOT_DAMAGE = 9;
const PLAYER_HIT_R = 0.45;
const BODY_R = 0.35;        // locomotion cylinder radius
const STEP_H = 0.4;         // ledges lower than this are walkable
const SOLDIER_EYE = 1.62;   // model is height-normalized to 1.83m+ (soldier.js)
const STEER_OFFSETS = [0, 0.5, -0.5, 1.0, -1.0, 1.6, -1.6];
// Muzzle-flash point lights (art dir): every enemy shot pops a 60ms #ffc66e
// light at the muzzle so the flash illuminates the soldier's front + ground
// instead of reading as an unlit sticker. Pooled + shadowless: 4 lights cover
// a whole squad at 150ms cadence; an off light (visible=false) costs nothing.
const MUZZLE_LIGHT_POOL = 4;
const MUZZLE_LIGHT_SECONDS = 0.06;
const MUZZLE_LIGHT_INTENSITY = 8;
const MUZZLE_LIGHT_COLOR = 0xffc66e;

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _v5 = new THREE.Vector3();
const _v6 = new THREE.Vector3();

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function angleDiff(a, b) {
  let d = (a - b) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

export class EnemySystem {
  async init(ctx) {
    this.ctx = ctx;
    this.rnd = rng(20260811);
    this.assets = createSoldierAssets();
    this.group = new THREE.Group();
    this.group.name = 'enemies';
    ctx?.scene?.add(this.group);

    // Cool sky rim light from opposite the sun (art dir: 0.4 intensity) so
    // the drab gear (#4a4a3c/#2a2a28) separates from dark facades instead of
    // merging. Works with the distance-scaled fresnel rim baked into every
    // soldier material (soldier.js) — that one guarantees edge separation
    // against BRIGHT facades too, where a directional key can't help.
    // No shadows — negligible next to the 4k shadow sun.
    const rim = new THREE.DirectionalLight(0xa9c4e6, 0.4);
    rim.castShadow = false;
    const sunDir = ctx?.atmosphere?.sunDirection;
    if (sunDir?.isVector3 && sunDir.lengthSq() > 0.5) {
      rim.position.set(-sunDir.x, 0.55, -sunDir.z);
    } else {
      rim.position.set(0.4, 0.55, 0.8); // fallback: high back-left
    }
    rim.position.normalize().multiplyScalar(60);
    rim.target.position.set(0, 0, 0);
    this.group.add(rim, rim.target);

    // pooled muzzle-flash lights (see MUZZLE_LIGHT_* above)
    this.mLights = [];
    for (let i = 0; i < MUZZLE_LIGHT_POOL; i++) {
      const light = new THREE.PointLight(MUZZLE_LIGHT_COLOR, 0, 9, 2);
      light.castShadow = false;
      light.visible = false;
      this.group.add(light);
      this.mLights.push({ light, t: 0 });
    }

    this.pool = [];           // every unit ever created (entry objects)
    this.respawnQueue = [];   // [{due}]
    this._time = 0;
    this._seedCounter = 1;
    this._pose = { speed: 0, combat: false, aim: false, crouch: false, firing: false, leanOut: 0, lookYaw: 0, lookPitch: 0, aimPitch: 0, leanF: 0, leanS: 0 };

    this.spawnPts = this._resolveSpawns(ctx);
    this.coverPts = this._buildCoverPoints(ctx);
    this._coverFromColliders = (ctx?.world?.colliders?.length ?? 0) > 0;

    // initial wave
    for (let i = 0; i < INITIAL_COUNT; i++) {
      const unit = this._getFreeUnit();
      if (!unit) break;
      const base = this.spawnPts[i % this.spawnPts.length];
      _v1.copy(base);
      _v1.x += (this.rnd() - 0.5) * 2.5;
      _v1.z += (this.rnd() - 0.5) * 2.5;
      this._spawnUnit(unit, _v1);
    }

    // player died: everyone stands down
    ctx?.events?.on?.('game:over', () => {
      for (const u of this.pool) {
        if (!u.alive) continue;
        u.brain.state = 'patrol';
        u.brain.alerted = false;
        u.brain.hasLOS = false;
        u.brain.burst = 0;
      }
    });

    this._ready = true;
  }

  update(dt, ctx) {
    if (!this._ready) return;
    const playing = ctx?.state?.phase === 'playing';
    if (playing) this._time += dt;

    // muzzle lights: ~25ms full pop, then a fast tail-off to 0 at 60ms
    for (const ml of this.mLights) {
      if (ml.t <= 0) continue;
      ml.t -= dt;
      if (ml.t <= 0) {
        ml.light.intensity = 0;
        ml.light.visible = false;
      } else {
        ml.light.intensity = MUZZLE_LIGHT_INTENSITY * Math.min(1, ml.t / (MUZZLE_LIGHT_SECONDS * 0.6));
      }
    }

    // late-arriving level data (defensive: level agent may set ctx.enemySpawns after us)
    if (this._fallbackSpawns && Array.isArray(ctx?.enemySpawns) && ctx.enemySpawns.length >= 4) {
      this.spawnPts = this._resolveSpawns(ctx);
    }
    if (!this._coverFromColliders && (ctx?.world?.colliders?.length ?? 0) > 0) {
      this.coverPts = this._buildCoverPoints(ctx);
      this._coverFromColliders = true;
    }

    // player snapshot for this frame
    const env = this._env || (this._env = {
      pEye: new THREE.Vector3(), pFeet: new THREE.Vector3(), pVel: new THREE.Vector3(),
    });
    env.playing = playing;
    env.hasPlayer = false;
    env.playerAlive = false;
    const p = ctx?.player;
    const eye = p?.eyePosition?.();
    if (eye && eye.isVector3) {
      env.pEye.copy(eye);
      env.hasPlayer = true;
    } else if (ctx?.camera) {
      ctx.camera.getWorldPosition(env.pEye);
      env.hasPlayer = true;
    }
    if (p?.position?.isVector3) env.pFeet.copy(p.position);
    else env.pFeet.copy(env.pEye).y -= 1.62;
    if (p?.velocity?.isVector3) env.pVel.copy(p.velocity);
    else env.pVel.set(0, 0, 0);
    env.playerAlive = env.hasPlayer && p?.alive !== false && !!p;

    const colliders = ctx?.world?.colliders ?? [];
    for (const u of this.pool) this._updateUnit(u, dt, ctx, env, colliders);

    if (playing) this._processRespawns(env);
  }

  /* ------------------------------------------------------------------ */
  /* spawn / pool management                                             */
  /* ------------------------------------------------------------------ */

  _resolveSpawns(ctx) {
    const pts = [];
    const src = ctx?.enemySpawns;
    if (Array.isArray(src)) {
      for (const s of src) {
        if (s && typeof s.x === 'number' && typeof s.z === 'number') {
          pts.push(new THREE.Vector3(s.x, typeof s.y === 'number' ? s.y : 0, s.z));
        }
      }
    }
    if (pts.length >= 4) {
      this._fallbackSpawns = false;
      return pts;
    }
    // fallback: ring at r=25-45m around the arena origin
    this._fallbackSpawns = true;
    const ring = [];
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * TAU + (this.rnd() - 0.5) * 0.35;
      const r = 25 + this.rnd() * 20;
      ring.push(new THREE.Vector3(Math.sin(a) * r, 0, Math.cos(a) * r));
    }
    return ring;
  }

  _buildCoverPoints(ctx) {
    const pts = [];
    const boxes = ctx?.world?.colliders ?? [];
    for (const b of boxes) {
      const h = b.max.y - b.min.y;
      if (h < 0.5 || h > 4.5) continue;               // too low / whole-building boxes
      if (b.max.x - b.min.x > 14 || b.max.z - b.min.z > 14) continue;
      if (b.min.y > 1.2) continue;                     // floating geometry
      const cx = (b.min.x + b.max.x) / 2;
      const cz = (b.min.z + b.max.z) / 2;
      const off = BODY_R + 0.55;
      pts.push(
        new THREE.Vector3(cx, 0, b.min.z - off),
        new THREE.Vector3(cx, 0, b.max.z + off),
        new THREE.Vector3(b.min.x - off, 0, cz),
        new THREE.Vector3(b.max.x + off, 0, cz),
      );
      if (pts.length > 240) break;
    }
    for (const s of this.spawnPts) pts.push(s.clone());
    return pts;
  }

  _getFreeUnit() {
    for (const u of this.pool) if (u.free) return u;
    if (this.pool.length < POOL_CAP) return this._createUnit();
    // pool exhausted: force-recycle the oldest corpse
    let oldest = null;
    for (const u of this.pool) {
      if (u.alive) continue;
      if (!oldest || u.diedAt < oldest.diedAt) oldest = u;
    }
    if (oldest) {
      oldest.soldier.root.visible = false;
      oldest.free = true;
    }
    return oldest;
  }

  _createUnit() {
    const soldier = new Soldier(this.assets, 7000 + this._seedCounter * 131);
    this._seedCounter++;
    soldier.root.visible = false;
    this.group.add(soldier.root);

    const entry = {
      // --- core.js World contract ---
      object3d: soldier.root,
      alive: false,
      position: soldier.root.position, // feet; same object => always synced
      hitMeshes: soldier.hitMeshes,
      takeDamage: null,                // bound below
      // --- internals ---
      soldier,
      hp: MAX_HP,
      free: true,
      diedAt: 0,
      groundBase: 0,
      animSpeed: 0,
      brain: {
        state: 'patrol', alerted: false, hasLOS: false, sinceSeen: 99,
        reaction: 0, acquire: 0, losTimer: this.rnd() * 0.2,
        target: new THREE.Vector3(), hasTarget: false, waitT: this.rnd() * 2,
        mode: 'hold', moveTimer: 0, strafeDir: 1, crouch: false, leanDir: 1,
        burst: 0, shotT: 0, cool: 0.5,
        lastSeen: new THREE.Vector3(),
      },
    };
    entry.takeDamage = (amount, point, headshot) => this._damageUnit(entry, amount, point, headshot);
    for (const m of soldier.hitMeshes) m.userData.enemyRef = entry;

    this.pool.push(entry);
    const list = this.ctx?.world?.enemies;
    if (Array.isArray(list)) list.push(entry);
    return entry;
  }

  _spawnUnit(unit, pos) {
    unit.free = false;
    unit.alive = true;
    unit.hp = MAX_HP;
    unit.groundBase = pos.y;
    unit.animSpeed = 0;
    unit.soldier.reset(pos, this.rnd() * TAU);
    const b = unit.brain;
    b.state = 'patrol';
    b.alerted = false;
    b.hasLOS = false;
    b.sinceSeen = 99;
    b.reaction = 0;
    b.acquire = 0;
    b.losTimer = this.rnd() * 0.2;
    b.hasTarget = false;
    b.waitT = this.rnd() * 1.5;
    b.mode = 'hold';
    b.moveTimer = 0;
    b.crouch = false;
    b.burst = 0;
    b.cool = 0.4 + this.rnd() * 0.5;
  }

  _processRespawns(env) {
    let alive = 0;
    for (const u of this.pool) if (u.alive) alive++;
    while (this.respawnQueue.length && alive < MAX_ALIVE) {
      const next = this.respawnQueue[0];
      if (next.due > this._time && alive >= MIN_ALIVE) break;
      this.respawnQueue.shift();
      const unit = this._getFreeUnit();
      if (!unit) break;
      // farthest spawn point from the player
      let best = this.spawnPts[0], bestD = -1;
      for (const s of this.spawnPts) {
        const d = (s.x - env.pFeet.x) ** 2 + (s.z - env.pFeet.z) ** 2;
        if (d > bestD) { bestD = d; best = s; }
      }
      _v1.copy(best);
      _v1.x += (this.rnd() - 0.5) * 2;
      _v1.z += (this.rnd() - 0.5) * 2;
      this._spawnUnit(unit, _v1);
      alive++;
    }
  }

  /* ------------------------------------------------------------------ */
  /* damage / death                                                      */
  /* ------------------------------------------------------------------ */

  _damageUnit(unit, amount, point, headshot) {
    if (!unit.alive) return;
    unit.hp -= amount;
    unit.soldier.flinch();
    const b = unit.brain;
    b.alerted = true;
    if (b.state === 'patrol') b.state = 'combat';
    if (b.reaction > 0.15) b.reaction = 0.15;
    const pf = this.ctx?.player?.position;
    if (pf?.isVector3) b.lastSeen.copy(pf);
    if (unit.hp <= 0) this._killUnit(unit, !!headshot);
  }

  _killUnit(unit, headshot) {
    const ctx = this.ctx;
    unit.alive = false;
    unit.diedAt = this._time;
    if (ctx?.state) {
      ctx.state.kills = (ctx.state.kills || 0) + 1;
      ctx.state.score = (ctx.state.score || 0) + (headshot ? 150 : 100);
    }
    ctx?.events?.emit?.('enemy:killed', { enemy: unit, headshot });
    // fall away from the shooter
    const pf = ctx?.player?.position;
    if (pf?.isVector3) _v1.set(unit.position.x - pf.x, 0, unit.position.z - pf.z);
    else _v1.set(0, 0, 0);
    unit.soldier.startDeath(_v1);
    this.respawnQueue.push({ due: this._time + RESPAWN_DELAY });
    // gunshot + body drop alerts nearby squadmates
    for (const other of this.pool) {
      if (!other.alive || other === unit) continue;
      const d2 = (other.position.x - unit.position.x) ** 2 + (other.position.z - unit.position.z) ** 2;
      if (d2 < 18 * 18) {
        other.brain.alerted = true;
        if (pf?.isVector3) other.brain.lastSeen.copy(pf);
        if (other.brain.state === 'patrol') {
          other.brain.state = 'combat';
          other.brain.reaction = Math.max(other.brain.reaction, 0.25 + this.rnd() * 0.25);
        }
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* per-unit update                                                     */
  /* ------------------------------------------------------------------ */

  _updateUnit(u, dt, ctx, env, colliders) {
    const s = u.soldier;

    if (!u.alive) {
      if (!u.free && s.updateDeath(dt)) {
        s.root.visible = false;
        u.free = true;
      }
      return;
    }

    const b = u.brain;
    const pos = u.position;
    const pose = this._pose;
    if (!env.playing) u.animSpeed += (0 - u.animSpeed) * Math.min(1, dt * 8);
    pose.speed = u.animSpeed;
    pose.combat = b.state === 'combat';
    pose.aim = false;
    pose.crouch = false;
    pose.firing = false;
    pose.leanOut = 0;
    pose.lookYaw = 0;
    pose.lookPitch = 0;
    pose.aimPitch = 0;
    pose.leanF = 0;
    pose.leanS = 0;

    if (env.playing) {
      const pdx = env.pFeet.x - pos.x;
      const pdz = env.pFeet.z - pos.z;
      const dist = Math.hypot(pdx, pdz);
      const yawToPlayer = Math.atan2(pdx, pdz);
      const crouchDrop = s.crouchT * 0.45;

      /* --- perception (staggered LOS raycasts) --- */
      b.losTimer -= dt;
      if (env.playerAlive && b.losTimer <= 0) {
        b.losTimer = 0.16 + this.rnd() * 0.12;
        let vis = dist < SIGHT_RANGE;
        if (vis) {
          _v1.set(pos.x, pos.y + SOLDIER_EYE - crouchDrop, pos.z);
          if (ctx?.world?.losBlocked) vis = !ctx.world.losBlocked(_v1, env.pEye);
        }
        if (vis && b.state === 'patrol' && !b.alerted && dist > 7) {
          // needs to actually be looking that way to spot you
          if (Math.abs(angleDiff(yawToPlayer, s.root.rotation.y)) > 1.15) vis = false;
        }
        if (vis) {
          if (!b.hasLOS && b.sinceSeen > 2.5) {
            b.reaction = 0.32 + this.rnd() * 0.25; // ~350ms reaction on fresh sight
            b.acquire = b.reaction + 1.2;          // sloppy aim while acquiring
          }
          b.hasLOS = true;
          b.sinceSeen = 0;
          b.lastSeen.copy(env.pFeet);
        } else {
          b.hasLOS = false;
        }
      }
      b.sinceSeen += dt;
      if (b.reaction > 0) b.reaction -= dt;
      if (b.acquire > 0) b.acquire -= dt;

      /* --- state transitions --- */
      if (b.state === 'patrol') {
        if ((b.hasLOS || b.alerted) && env.playerAlive) {
          b.state = 'combat';
          b.moveTimer = 0;
          b.hasTarget = false;
        }
      } else if (b.state === 'combat') {
        if (!env.playerAlive) {
          b.state = 'patrol';
          b.alerted = false;
          b.burst = 0;
        } else if (b.sinceSeen > 8 && dist > 30) {
          b.state = 'patrol';
          b.alerted = false;
          b.hasTarget = false;
          b.burst = 0;
        }
      }

      /* --- movement decision --- */
      let mvx = 0, mvz = 0, speed = 0;
      let desiredYaw = s.root.rotation.y;
      const combat = b.state === 'combat';

      if (!combat) {
        // PATROL: wander between cover points
        if (b.hasTarget) {
          const tx = b.target.x - pos.x, tz = b.target.z - pos.z;
          const td = Math.hypot(tx, tz);
          if (td < 1.2) {
            b.hasTarget = false;
            b.waitT = 1 + this.rnd() * 2.5;
          } else {
            mvx = tx / td; mvz = tz / td;
            speed = WALK_SPEED;
            desiredYaw = Math.atan2(mvx, mvz);
          }
        } else {
          // Stand-and-scan: weapon shouldered, torso sweeping a sector.
          // Replaces the old limp idle — a paused soldier still reads armed.
          b.waitT -= dt;
          pose.aim = true;
          pose.lookYaw = Math.sin(this._time * 0.8 + s.seedPhase) * 0.6;
          pose.aimPitch = 0;
          pose.lookPitch = 0;
          if (b.waitT <= 0) {
            this._pickPatrolPoint(u);
          }
        }
      } else {
        // COMBAT: advance / strafe / crouch-hold micro-behavior
        b.moveTimer -= dt;
        if (b.moveTimer <= 0) {
          const roll = this.rnd();
          if (dist > 26 || (!b.hasLOS && b.sinceSeen > 1.5)) {
            b.mode = 'advance';
            this._pickCombatPoint(u, env, dist);
          } else if (roll < 0.38) {
            b.mode = 'advance';
            this._pickCombatPoint(u, env, dist);
          } else if (roll < 0.72) {
            b.mode = 'strafe';
            b.strafeDir = this.rnd() < 0.5 ? -1 : 1;
          } else {
            b.mode = 'hold';
            b.crouch = this.rnd() < 0.65;
            b.leanDir = this.rnd() < 0.5 ? -1 : 1; // which side to peek out of
          }
          b.moveTimer = 1.2 + this.rnd() * 1.5;
        }

        if (dist < 5.5) {
          // too close — give ground while shooting
          mvx = -pdx / (dist || 1); mvz = -pdz / (dist || 1);
          speed = 2.2;
        } else if (b.mode === 'advance' && b.hasTarget) {
          const tx = b.target.x - pos.x, tz = b.target.z - pos.z;
          const td = Math.hypot(tx, tz);
          if (td < 1.1) {
            b.hasTarget = false;
            b.mode = 'hold';
            b.crouch = this.rnd() < 0.5;
            b.leanDir = this.rnd() < 0.5 ? -1 : 1;
          } else {
            mvx = tx / td; mvz = tz / td;
            speed = COMBAT_SPEED;
          }
        } else if (b.mode === 'strafe') {
          mvx = (pdz / (dist || 1)) * b.strafeDir;
          mvz = (-pdx / (dist || 1)) * b.strafeDir;
          speed = COMBAT_SPEED * 0.8;
          if (this._blocked(pos.x + mvx * 1.0, pos.z + mvz * 1.0, pos.y, colliders)) {
            b.strafeDir = -b.strafeDir;
            mvx = -mvx; mvz = -mvz;
          }
        }
        desiredYaw = yawToPlayer; // always face the target in combat
        pose.crouch = b.mode === 'hold' && b.crouch;
        // holding position = trading from cover: peek-lean the torso out to
        // one side (soldier.js rolls the spine + shifts the hips)
        if (b.mode === 'hold') pose.leanOut = b.leanDir * (b.crouch ? 0.55 : 1);
      }

      /* --- locomotion (steer + collide + ground) --- */
      const moved = this._move(u, dt, mvx, mvz, pose.crouch ? 0 : speed, colliders);
      this._separate(u);

      const turnRate = combat ? 10 : 6;
      s.root.rotation.y += angleDiff(desiredYaw, s.root.rotation.y) * Math.min(1, dt * turnRate);
      u.animSpeed += (moved - u.animSpeed) * Math.min(1, dt * 8);
      pose.speed = u.animSpeed;
      pose.combat = combat;

      // lean into the step: project the move direction into body-local space so
      // the soldier tips forward on an advance and banks into a strafe
      if (moved > 0.05 && (mvx !== 0 || mvz !== 0)) {
        const sy = Math.sin(s.root.rotation.y), cy = Math.cos(s.root.rotation.y);
        const lk = moved / COMBAT_SPEED;
        pose.leanF = (mvx * sy + mvz * cy) * lk;
        pose.leanS = (mvx * cy - mvz * sy) * lk;
      }

      /* --- aim + fire --- */
      if (combat && env.playerAlive) {
        const engaged = b.hasLOS || b.sinceSeen < 2;
        pose.aim = engaged;
        pose.lookYaw = clamp(angleDiff(yawToPlayer, s.root.rotation.y), -1.0, 1.0);
        const dy = env.pEye.y - (pos.y + 1.42 - crouchDrop);
        pose.aimPitch = clamp(Math.atan2(dy, Math.max(dist, 0.5)), -0.75, 0.75);
        pose.lookPitch = pose.aimPitch;

        const canFire = engaged && b.hasLOS && b.reaction <= 0 && dist < FIRE_RANGE;
        if (b.burst > 0) {
          b.shotT -= dt;
          if (b.shotT <= 0) {
            if (canFire || b.sinceSeen < 0.5) {
              this._fireShot(u, env, dist, moved, pose.crouch, ctx);
              b.shotT = SHOT_CADENCE;
              b.burst--;
              if (b.burst === 0) b.cool = 0.7 + this.rnd() * 0.8;
            } else {
              b.burst = 0;
              b.cool = Math.max(b.cool, 0.4);
            }
          }
        } else if (canFire) {
          b.cool -= dt;
          if (b.cool <= 0) {
            b.burst = 3 + Math.floor(this.rnd() * 4); // 3-6 rounds
            b.shotT = 0.04;
          }
        }
        pose.firing = b.burst > 0; // soldier.js sinks into a micro-crouch mid-burst
      } else {
        b.burst = 0;
      }
    }

    s.update(dt, pose);
  }

  _pickPatrolPoint(u) {
    const b = u.brain;
    const pts = this.coverPts;
    if (pts.length) {
      for (let i = 0; i < 6; i++) {
        const c = pts[Math.floor(this.rnd() * pts.length)];
        const d = Math.hypot(c.x - u.position.x, c.z - u.position.z);
        if (d > 3 && d < 28) {
          b.target.copy(c);
          b.hasTarget = true;
          return;
        }
      }
    }
    // no cover data: short random leg, clamped to the arena
    const a = this.rnd() * TAU;
    b.target.set(
      clamp(u.position.x + Math.sin(a) * (4 + this.rnd() * 8), -55, 55),
      u.position.y,
      clamp(u.position.z + Math.cos(a) * (4 + this.rnd() * 8), -55, 55),
    );
    b.hasTarget = true;
  }

  _pickCombatPoint(u, env, dist) {
    const b = u.brain;
    const pts = this.coverPts;
    // without LOS, hunt the last place the player was actually seen
    const hx = b.hasLOS ? env.pFeet.x : b.lastSeen.x;
    const hz = b.hasLOS ? env.pFeet.z : b.lastSeen.z;
    let best = null, bestScore = Infinity;
    if (pts.length) {
      for (let i = 0; i < 12; i++) {
        const c = pts[Math.floor(this.rnd() * pts.length)];
        const dp = Math.hypot(c.x - hx, c.z - hz);
        if (dp < 6 || dp > 30) continue;
        const ds = Math.hypot(c.x - u.position.x, c.z - u.position.z);
        if (ds > 32 || ds < 1.5) continue;
        const score = Math.abs(dp - 11) + ds * 0.35 + this.rnd() * 2;
        if (score < bestScore) { bestScore = score; best = c; }
      }
    }
    if (best) {
      b.target.copy(best);
    } else {
      // push straight toward the hunt point, stopping at a 9m standoff
      const hd = Math.hypot(hx - u.position.x, hz - u.position.z);
      const k = Math.max(0, hd - 9) / (hd || 1);
      b.target.set(
        u.position.x + (hx - u.position.x) * k,
        u.position.y,
        u.position.z + (hz - u.position.z) * k,
      );
    }
    b.hasTarget = true;
  }

  /* ------------------------------------------------------------------ */
  /* locomotion helpers                                                  */
  /* ------------------------------------------------------------------ */

  _blocked(x, z, feetY, colliders) {
    for (const b of colliders) {
      if (b.max.y <= feetY + STEP_H) continue;   // walkable ledge
      if (b.min.y >= feetY + 1.6) continue;      // overhead
      const cx = clamp(x, b.min.x, b.max.x);
      const cz = clamp(z, b.min.z, b.max.z);
      const dx = x - cx, dz = z - cz;
      if (dx * dx + dz * dz < BODY_R * BODY_R) return true;
    }
    return false;
  }

  /** Steer + integrate + resolve vs colliders + ground snap. Returns speed actually used. */
  _move(u, dt, dirX, dirZ, speed, colliders) {
    const pos = u.position;
    let moved = 0;
    if (speed > 0 && (dirX !== 0 || dirZ !== 0)) {
      const baseYaw = Math.atan2(dirX, dirZ);
      let chosen = null;
      for (const off of STEER_OFFSETS) {
        const cy = baseYaw + off;
        const sx = Math.sin(cy), sz = Math.cos(cy);
        if (!this._blocked(pos.x + sx * 0.95, pos.z + sz * 0.95, pos.y, colliders)) {
          chosen = cy;
          break;
        }
      }
      if (chosen !== null) {
        pos.x += Math.sin(chosen) * speed * dt;
        pos.z += Math.cos(chosen) * speed * dt;
        moved = speed;
      }
    }

    // resolve penetration + find ground height in one pass
    let ground = -Infinity;
    for (const b of colliders) {
      if (pos.x < b.min.x - BODY_R || pos.x > b.max.x + BODY_R) continue;
      if (pos.z < b.min.z - BODY_R || pos.z > b.max.z + BODY_R) continue;
      const cx = clamp(pos.x, b.min.x, b.max.x);
      const cz = clamp(pos.z, b.min.z, b.max.z);
      const dx = pos.x - cx, dz = pos.z - cz;
      const d2 = dx * dx + dz * dz;
      if (b.max.y <= pos.y + STEP_H) {
        // walkable surface: track the highest top directly under us
        if (d2 === 0 && b.max.y > ground) ground = b.max.y;
        continue;
      }
      if (b.min.y > pos.y + 1.65) continue;
      if (d2 < BODY_R * BODY_R) {
        if (d2 > 1e-8) {
          const d = Math.sqrt(d2);
          const push = (BODY_R - d) / d;
          pos.x += dx * push;
          pos.z += dz * push;
        } else {
          // center inside the box: exit through the nearest face
          const exL = pos.x - (b.min.x - BODY_R);
          const exR = (b.max.x + BODY_R) - pos.x;
          const ezL = pos.z - (b.min.z - BODY_R);
          const ezR = (b.max.z + BODY_R) - pos.z;
          const m = Math.min(exL, exR, ezL, ezR);
          if (m === exL) pos.x = b.min.x - BODY_R;
          else if (m === exR) pos.x = b.max.x + BODY_R;
          else if (m === ezL) pos.z = b.min.z - BODY_R;
          else pos.z = b.max.z + BODY_R;
        }
      }
    }
    if (ground === -Infinity) ground = u.groundBase;
    pos.y += (ground - pos.y) * Math.min(1, dt * 10);
    return moved;
  }

  /** Keep living units from stacking on each other. */
  _separate(u) {
    for (const other of this.pool) {
      if (other === u || !other.alive) continue;
      const dx = u.position.x - other.position.x;
      const dz = u.position.z - other.position.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > 0.64 || d2 < 1e-8) continue; // 0.8m
      const d = Math.sqrt(d2);
      const push = (0.8 - d) * 0.5 / d;
      u.position.x += dx * push;
      u.position.z += dz * push;
    }
  }

  /* ------------------------------------------------------------------ */
  /* firing                                                              */
  /* ------------------------------------------------------------------ */

  _fireShot(u, env, dist, moving, crouched, ctx) {
    const s = u.soldier;
    const b = u.brain;
    s.getMuzzleWorld(_v1);

    // aim at upper chest, slight velocity lead
    _v2.copy(env.pEye);
    _v2.y -= 0.22;
    _v2.addScaledVector(env.pVel, Math.min(dist * 0.02, 0.25));
    _v3.subVectors(_v2, _v1);
    const d = _v3.length();
    if (d < 0.5) return;
    _v3.divideScalar(d);

    // distance-scaled miss cone (shrinks when close), worse while moving/acquiring
    let spread = 0.017 + 0.06 * clamp((dist - 6) / 50, 0, 1);
    if (moving > 0.5) spread += 0.018;
    if (b.acquire > 0) spread += 0.03;
    if (crouched) spread *= 0.65;

    // jitter within the cone
    _v4.set(0, 1, 0);
    if (Math.abs(_v3.y) > 0.94) _v4.set(1, 0, 0);
    _v5.crossVectors(_v3, _v4).normalize();  // right
    _v4.crossVectors(_v5, _v3).normalize();  // up
    const ja = this.rnd() * TAU;
    const jr = spread * Math.sqrt(this.rnd());
    _v6.copy(_v3)
      .addScaledVector(_v5, Math.cos(ja) * jr)
      .addScaledVector(_v4, Math.sin(ja) * jr)
      .normalize();

    ctx?.events?.emit?.('enemy:fire', { origin: _v1.clone(), direction: _v6.clone(), enemy: u });
    s.fireFlash();

    // 60ms muzzle light: grab a free pool light (steal the oldest if none),
    // parked just ahead of the muzzle so it throws light back across the
    // soldier's chest/arms and down onto the ground.
    let ml = null;
    for (const cand of this.mLights) {
      if (cand.t <= 0) { ml = cand; break; }
      if (!ml || cand.t < ml.t) ml = cand;
    }
    ml.t = MUZZLE_LIGHT_SECONDS;
    ml.light.visible = true;
    ml.light.intensity = MUZZLE_LIGHT_INTENSITY;
    ml.light.position.copy(_v1).addScaledVector(_v6, 0.22);

    if (!env.playerAlive) return;
    // capsule-ish test: sphere at the eye and at the torso
    _v2.copy(env.pEye);
    _v3.copy(env.pEye).y -= 0.55;
    const hit = this._raySphereHit(_v1, _v6, _v2, PLAYER_HIT_R)
      || this._raySphereHit(_v1, _v6, _v3, PLAYER_HIT_R);
    if (!hit) return;
    const blocked = ctx?.world?.losBlocked ? ctx.world.losBlocked(_v1, env.pEye) : false;
    if (blocked) return;
    ctx?.player?.damage?.(SHOT_DAMAGE, _v6.clone());
  }

  _raySphereHit(origin, dir, center, r) {
    const ox = center.x - origin.x;
    const oy = center.y - origin.y;
    const oz = center.z - origin.z;
    const t = ox * dir.x + oy * dir.y + oz * dir.z;
    if (t < 0) return false;
    const c2 = ox * ox + oy * oy + oz * oz - t * t;
    return c2 <= r * r;
  }
}
