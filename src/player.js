// PLAYER CONTROLLER — owns: camera rig, movement, capsule collision vs world, health.
//
// Contract recap (kept in full — other systems depend on this):
//  - this.rig = Object3D at feet; camera parented at eye height 1.62. Yaw on
//    rig.rotation.y, pitch on camera.rotation.x (clamped ±89°), sens ~0.0021 rad/px.
//  - ctx.player = this. Exposes: position (=== rig.position, feet), velocity:V3,
//    onGround, crouched, sprinting, ads (written by weapons), adsFov (written by
//    weapons), health (100, CoD regen after 4 s), alive, eyePosition(), aimDirection().
//  - damage(amount, direction) emits 'player:damage'; at <=0 emits 'game:over' once,
//    sets alive=false and plays a dramatic fall/tilt death camera.
//  - Capsule r=0.35 vs ctx.world.colliders (Box3[]), axis-separated with wall slide,
//    gravity -22 m/s², steps over <=0.35 m ledges, never tunnels through floors.
//  - Reads ctx.playerSpawn (set by level) else spawns at (0, 0, 8).
//  - Emits 'player:footstep' {sprinting} and 'player:land' {hard}. Also emits a
//    non-canonical 'player:jump' {} (harmless if nobody listens).
//  - Extra courtesy API for weapons: addViewKick(pitchRad, yawRad) applies recoil to
//    the persistent view angles so it survives the player's per-frame camera rebuild.
//  - Viewmodel framing: the player owns a 'viewmodelFrame' Group parented to the
//    camera. Any Group another system hangs directly off the camera (weapons parents
//    its pose rig there) is adopted under this mount, which composes the hipfire
//    corner pose (drop down-right + cant), idle sway/breathing, locomotion bob and
//    a spring-return fire kick on top of that system's own local animation. At full
//    ADS the POSE terms reduce to a pure axial-Z eye-relief pull-back (optic plane
//    normalized to ~0.21 m from the eye, derived from ctx.weapons.dofHint.
//    focusDistance so it self-cancels if weapons repositions its own pose) — the
//    centred red dot stays centred at rest; only the TRANSIENT recoil kick is
//    allowed to disturb it (scaled to ~55% in ADS), springing back to exact zero.
//  - The mount is hidden whenever a full-screen menu is up (phase 'menu'/'paused')
//    so the gun never renders through the title/pause screens.
//  - ADS presentation (MW-style focus): applied ADS FOV is the weapons-written
//    adsFov clamped into [45, 52], punched in/out over a dedicated 150 ms ramp;
//    look sensitivity drops an extra 35% at full ADS on top of FOV scaling; and a
//    camera-parented focus overlay (src/player/adsFocus.js) blurs + darkens the
//    periphery via a low-res linear scene recapture, keeping the optic sharp.
import * as THREE from 'three';
import { AdsFocus } from './player/adsFocus.js';

// ---------------------------------------------------------------------------
// Tuning constants — the "feel" lives here.
// ---------------------------------------------------------------------------
const EYE_STAND = 1.62;
const EYE_CROUCH = 1.04;
const HEIGHT_STAND = 1.8;
const HEIGHT_CROUCH = 1.22;
const RADIUS = 0.35;
const SKIN = 0.001;          // resolved resting gap so touch != penetration
const EPS = 1e-4;

const GRAVITY = 22;
const TERMINAL_FALL = 38;
const JUMP_VELOCITY = 7.3;   // apex ~1.2 m with g=22
const COYOTE_TIME = 0.12;
const JUMP_BUFFER = 0.15;
const STEP_HEIGHT = 0.35;    // max auto-step while grounded
const STEP_AIR = 0.06;       // tiny tolerance so seams don't snag mid-air
const SNAP_DOWN = 0.45;      // stick to ground walking down steps/slopes

const RUN_SPEED = 5.2;
const SPRINT_SPEED = 7.3;
const CROUCH_SPEED = 2.7;
const ADS_SPEED_MULT = 0.55;
const BACK_MULT = 0.84;
const STRAFE_MULT = 0.92;
const GROUND_ACCEL = 68;     // ~0.08 s to full run speed — crisp, not floaty
const GROUND_DECEL = 62;     // ~0.085 s to stop
const AIR_ACCEL = 14;
const AIR_DECEL = 2.5;

const MOUSE_SENS = 0.0021;
const PITCH_LIMIT = 89 * (Math.PI / 180);

const SPRINT_FOV = 80;
const DEFAULT_ADS_FOV = 52;
// Art-direction pass: whatever weapons writes into adsFov, the camera applies it
// clamped into this band — a real zoom step from the 74 base (critic's "~55"
// directive; weapons' 50 sits just past it) without sniper-glass magnification.
const ADS_FOV_MIN = 45;
const ADS_FOV_MAX = 52;
const ADS_FOV_TIME = 0.15;   // dedicated FOV punch-in/out ramp (s) — crisp, per directive
const ADS_SENS_REDUCE = 0.35; // extra look-sens cut at full ADS (on top of FOV scaling)

const MAX_HEALTH = 100;
const REGEN_DELAY = 4;
const REGEN_RATE = 38;

const HARD_LAND_SPEED = 11;
const LAND_EVENT_SPEED = 3.2;
const FOOTSTEP_MIN_SPEED = 1.2;

// --- Viewmodel framing + motion energy (art-direction pass) -----------------
const VM_REF_DEPTH = 0.30;              // camera-space depth the framing % is measured at
const VM_CORNER_FRAC = 0.06;            // hipfire viewmodel drops 6% of frame down-right
const VM_CANT = 2 * (Math.PI / 180);    // 2-degree relaxed cant in hipfire
const VM_SWAY_HZ = 0.3;                 // idle positional sway frequency
const VM_SWAY_AMP = 0.005;              // 0.5 cm idle sway amplitude
const ADS_BLEND_TIME = 0.18;            // mirrors weapons.js ADS_TIME (linear+smoothstep)
const ADS_EYE_DEPTH = 0.21;             // target optic-plane depth in ADS (m of eye relief)
const ADS_BLUR_MAX = 0.85;              // peak peripheral-blur mix at full ADS
const ADS_DARK_MAX = 0.55;              // peak focus-vignette darkening at full ADS

// --- Fire recoil (art-direction pass: recoil must READ in a mid-burst still) --
// The old kick spring (omega 70) recovered in 80 ms — mathematically present,
// invisible on camera. These run slow enough that at 750 rpm (80 ms between
// rounds) each round lands on ~55% of the previous one's displacement, so a
// burst visibly stacks into muzzle climb, then springs back to exact zero in
// ~300 ms. Per-shot peaks are soft-capped (see _onWeaponFire) so a mag dump
// disturbs the frame without winding up into parody.
const VM_KICK_OMEGA = 16;               // viewmodel kick return (peak at ~62 ms)
const CAM_KICK_OMEGA = 24;              // camera flinch return (peak at ~42 ms)
const VM_KICK_Z = 0.016;                // m push-back per shot
const VM_KICK_Z_CAP = 0.035;            // burst travel limit
const VM_KICK_RX = 0.030;               // rad muzzle-up per shot (~1.7 deg)
const VM_KICK_RX_CAP = 0.075;           // burst climb limit (~4.3 deg)
const VM_KICK_RY = 0.016;               // rad lateral muzzle wander (+/- half)
const VM_KICK_RZ = 0.024;               // rad roll jitter (+/- half)
const CAM_KICK_PITCH = 0.0052;          // rad camera flinch per shot (~0.30 deg)
const CAM_KICK_ROLL = 0.0044;           // rad (+/- half)
const CAM_KICK_Z = 0.006;               // m camera push-back per shot
const ADS_KICK_SCALE = 0.45;            // ADS trims kick by this fraction (MW-ish)

// --- Viewmodel locomotion bob (fractions of the camera bob amplitude) --------
const VM_BOB_X = 0.6;
const VM_BOB_Y = 0.45;
const VM_BOB_ROLL = 0.6;
const VM_BOB_PITCH = 0.35;

const clamp = THREE.MathUtils.clamp;
const lerp = THREE.MathUtils.lerp;
/** Frame-rate independent smoothing factor. */
const damp = (k, dt) => 1 - Math.exp(-k * dt);
const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
const smooth01 = (t) => t * t * (3 - 2 * t);

/**
 * Critically damped scalar spring settling to 0 — the recoil/flinch "punch".
 * Stepped with the closed-form solution, so it is unconditionally stable at
 * any dt (main.js caps dt at 50 ms, well past explicit-Euler stability here).
 * punch(peak) injects the velocity impulse (peak * omega * e) that makes the
 * displacement top out at exactly `peak` at t = 1/omega, then decay to zero.
 * Zero allocation after construction.
 */
class PunchSpring {
  constructor(omega) { this.o = omega; this.p = 0; this.v = 0; }
  punch(peak) { this.v += peak * this.o * Math.E; }
  reset() { this.p = 0; this.v = 0; }
  update(dt) {
    const o = this.o;
    const e = Math.exp(-o * dt);
    const B = this.v + o * this.p;
    const p = (this.p + B * dt) * e;
    this.v = (B * (1 - o * dt) - o * this.p) * e;
    this.p = p;
    return p;
  }
}

export class PlayerSystem {
  async init(ctx) {
    this._ctx = ctx;

    // --- Rig: feet-origin Object3D -> head (eye height) -> camera -------------
    this.rig = new THREE.Object3D();
    this.rig.name = 'playerRig';
    this.head = new THREE.Object3D();
    this.head.name = 'playerHead';
    this.head.position.set(0, EYE_STAND, 0);
    this.rig.add(this.head);

    const cam = ctx.camera;
    if (cam) {
      cam.position.set(0, 0, 0);
      cam.rotation.set(0, 0, 0);
      cam.rotation.order = 'YXZ';
      this.head.add(cam);
      this._baseFov = cam.fov || 74;
    } else {
      this._baseFov = 74;
    }
    ctx.scene?.add(this.rig);

    // --- Spawn ---------------------------------------------------------------
    const sp = ctx.playerSpawn;
    if (sp && typeof sp.x === 'number' && typeof sp.y === 'number' && typeof sp.z === 'number') {
      this.rig.position.set(sp.x, sp.y, sp.z);
    } else {
      this.rig.position.set(0, 0, 8);
    }
    this._spawn = this.rig.position.clone();
    let yaw = 0;
    if (typeof ctx.playerSpawnYaw === 'number') yaw = ctx.playerSpawnYaw;
    else if (this._spawn.x * this._spawn.x + this._spawn.z * this._spawn.z > 1) {
      // Face the level center on spawn.
      yaw = Math.atan2(this._spawn.x, this._spawn.z);
    }
    this._spawnYaw = yaw;
    this.rig.rotation.y = yaw;

    // --- Public contract state ----------------------------------------------
    this.position = this.rig.position; // feet, shared reference
    this.velocity = new THREE.Vector3();
    this.onGround = false;
    this.crouched = false;
    this.sprinting = false;
    this.ads = false;                  // written by weapons.js
    this.adsFov = DEFAULT_ADS_FOV;     // written by weapons.js
    this.health = MAX_HEALTH;
    this.alive = true;
    this.radius = RADIUS;
    this.height = HEIGHT_STAND;

    // --- Internals -----------------------------------------------------------
    this._pitch = 0;
    this._crouchToggle = false;
    this._jumpBuffer = 0;
    this._coyote = 0;
    this._stepDist = 0;
    this._wasMovingGround = false;
    this._eyeSmooth = EYE_STAND;
    this._smoothFeetY = this.rig.position.y;
    this._bobPhase = 0;
    this._bobAmp = 0;
    this._dipY = 0;
    this._dipVel = 0;
    this._strafeRoll = 0;
    this._damageRoll = 0;
    this._sinceDamage = 999;
    this._regenActive = false;
    this._death = null;
    this._groundedThisFrame = false;
    this._time = 0;

    // --- Viewmodel frame mount + motion-energy state -------------------------
    // Camera-parented Group that adopts other systems' camera-hung rigs (see
    // header). All offsets it applies are scaled by (1 - adsEase) so full ADS
    // composes to exact identity.
    this._vmMount = new THREE.Group();
    this._vmMount.name = 'viewmodelFrame';
    cam?.add(this._vmMount);
    this._vmAdopt = [];        // pooled scratch for re-parenting scans
    this._vmAds = 0;           // 0..1 linear ADS ramp (mirror of weapons' blend)
    this._adsEase = 0;         // smoothstepped version, shared with camera pass
    this._fovAds = 0;          // 0..1 dedicated ADS FOV punch ramp (0.15 s)
    this._fovHip = this._baseFov; // damped hip/sprint FOV the ADS ramp blends from
    this._vmKickZ = new PunchSpring(VM_KICK_OMEGA);   // viewmodel push-back (m)
    this._vmKickRX = new PunchSpring(VM_KICK_OMEGA);  // viewmodel muzzle-up (rad)
    this._vmKickRY = new PunchSpring(VM_KICK_OMEGA);  // viewmodel lateral wander (rad)
    this._vmKickRZ = new PunchSpring(VM_KICK_OMEGA);  // viewmodel roll jitter (rad)
    this._punchPitch = new PunchSpring(CAM_KICK_OMEGA); // camera flinch pitch (rad)
    this._punchRoll = new PunchSpring(CAM_KICK_OMEGA);  // camera flinch roll (rad)
    this._punchZ = new PunchSpring(CAM_KICK_OMEGA);     // camera flinch push-back (m)

    // --- ADS presentation: MW-style focus overlay (peripheral blur + soft
    // vignette; see src/player/adsFocus.js). Built once; per-frame cost is a
    // couple of uniform writes plus, only while ADS is up, one 128x72 capture.
    this._focus = new AdsFocus();
    cam?.add(this._focus.mesh);

    ctx.player = this;
    ctx.events?.on('game:start', () => { if (!this.alive) this._respawn(); });
    ctx.events?.on('weapon:fire', () => this._onWeaponFire());
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------
  /** World-space eye (camera) position. Pass a Vector3 to avoid allocation. */
  eyePosition(target) {
    const out = target && target.isVector3 ? target : new THREE.Vector3();
    const cam = this._ctx?.camera;
    if (cam && cam.parent === this.head) return cam.getWorldPosition(out);
    return out.set(this.position.x, this.position.y + this._eyeSmooth, this.position.z);
  }

  /** Unit world-space aim direction. Pass a Vector3 to avoid allocation. */
  aimDirection(target) {
    const out = target && target.isVector3 ? target : new THREE.Vector3();
    const cam = this._ctx?.camera;
    if (cam) return cam.getWorldDirection(out);
    const cp = Math.cos(this._pitch);
    const yaw = this.rig.rotation.y;
    return out.set(-Math.sin(yaw) * cp, Math.sin(this._pitch), -Math.cos(yaw) * cp);
  }

  /** Recoil hook for weapons: kicks the persistent view angles (radians). */
  addViewKick(pitchRad = 0, yawRad = 0) {
    if (!this.alive) return;
    this._pitch = clamp(this._pitch + pitchRad, -PITCH_LIMIT, PITCH_LIMIT);
    this.rig.rotation.y += yawRad;
  }

  damage(amount, direction = null) {
    if (!this.alive || !(amount > 0)) return;
    this.health -= amount;
    this._sinceDamage = 0;
    this._regenActive = false;
    this._damageRoll += (Math.random() < 0.5 ? -1 : 1) * Math.min(0.05, amount * 0.002);
    const ev = this._ctx?.events;
    ev?.emit('player:damage', { amount, direction: direction || null });
    if (this.health <= 0) {
      this.health = 0;
      this.alive = false;
      this.sprinting = false;
      this._death = {
        t: 0,
        pitch: this._pitch,
        eye: this.head.position.y,
        side: Math.random() < 0.5 ? -1 : 1,
      };
      ev?.emit('game:over', {
        kills: this._ctx?.state?.kills ?? 0,
        score: this._ctx?.state?.score ?? 0,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Frame update
  // -------------------------------------------------------------------------
  update(dt, ctx) {
    if (!(dt > 0)) return;
    this._ctx = ctx;
    this._time += dt;

    // Runs in EVERY phase: adopt camera-hung rigs and gate their visibility so
    // the gun never renders through the title/pause menus (art-direction fix).
    this._syncViewmodelMount(ctx);

    if (!this.alive) { this._updateDeath(dt, ctx.camera); return; }
    if (ctx.state?.phase !== 'playing') {
      this._focus?.hideNow(); // a menu is up — kill the ADS focus overlay too
      return; // menu / paused: fully frozen
    }

    this._updateLook(dt, ctx);
    this._updateStance(dt, ctx);
    this._updateMove(dt, ctx);
    this._updatePhysics(dt, ctx);
    this._updateHealth(dt, ctx);
    this._updateViewmodel(dt, ctx); // before camera: shares this._adsEase
    this._updateCamera(dt, ctx);
  }

  // --- Weapon fire feedback: viewmodel kick + camera flinch ----------------
  // Purely cosmetic offsets that recover to exactly zero (~300 ms), so they
  // never fight the persistent addViewKick recoil weapons drives. Slow enough
  // to stack visibly across a 750 rpm burst (each round lands on ~55% of the
  // last one's displacement); `room` soft-caps the accumulation so sustained
  // fire holds a strong, stable climb instead of winding up forever.
  _onWeaponFire() {
    if (!this.alive) return;
    const r = Math.random() - 0.5;
    const vm = 1 - ADS_KICK_SCALE * this._adsEase; // trimmed, never erased, in ADS
    const room = (s, cap) => Math.max(0.25, 1 - Math.abs(s.p) / cap);
    // Viewmodel: ~1.6 cm push-back + ~1.7 deg muzzle-up per shot, capped at
    // ~3.5 cm / ~4.3 deg mid-burst, with lateral wander and roll jitter.
    this._vmKickZ.punch(VM_KICK_Z * vm * room(this._vmKickZ, VM_KICK_Z_CAP));
    this._vmKickRX.punch(VM_KICK_RX * vm * room(this._vmKickRX, VM_KICK_RX_CAP));
    this._vmKickRY.punch(r * VM_KICK_RY * vm);
    this._vmKickRZ.punch(r * VM_KICK_RZ * vm);
    // Camera: ~0.30 deg pitch flinch, +/-0.13 deg roll, 6 mm push-back.
    this._punchPitch.punch(CAM_KICK_PITCH * (1 - 0.3 * this._adsEase));
    this._punchRoll.punch(r * CAM_KICK_ROLL);
    this._punchZ.punch(CAM_KICK_Z);
  }

  // --- Viewmodel mount adoption + menu visibility gate ---------------------
  // Runs every frame in every phase (menus included). Adopts viewmodel rigs
  // other systems hang directly off the raw camera (weapons parents its pose
  // Group there at init) so our frame offsets compose on top of their own
  // local animation — and hides the whole mount whenever a full-screen menu
  // is displayed: the gun rendering through the title screen read as a bug.
  // Non-Group camera children (e.g. an AudioListener, our focus quad) are
  // untouched. Phase 'over' keeps the gun visible for the death camera.
  _syncViewmodelMount(ctx) {
    const cam = ctx.camera;
    const mount = this._vmMount;
    if (!mount || !cam) return;
    if (mount.parent !== cam) cam.add(mount);
    const kids = cam.children;
    if (kids.length > 1) {
      const list = this._vmAdopt;
      for (let i = 0; i < kids.length; i++) {
        const c = kids[i];
        if (c !== mount && c.isGroup) list.push(c);
      }
      for (let i = 0; i < list.length; i++) mount.add(list[i]);
      list.length = 0;
    }
    const phase = ctx.state?.phase;
    const show = phase === 'playing' || phase === 'over';
    if (mount.visible !== show) mount.visible = show;
  }

  // --- Viewmodel frame: corner pose, idle sway, breathing, bob, fire kick --
  _updateViewmodel(dt, ctx) {
    const cam = ctx.camera;
    const mount = this._vmMount;
    if (!mount) return;

    // Advance the kick springs even if there is no camera to apply them to.
    const kZ = this._vmKickZ.update(dt);
    const kRX = this._vmKickRX.update(dt);
    const kRY = this._vmKickRY.update(dt);
    const kRZ = this._vmKickRZ.update(dt);

    // Mirror weapons' ADS blend (weapons writes this.ads back to us each frame,
    // ramping linearly over ADS_TIME then smoothstepping — same curve here).
    this._vmAds = clamp(this._vmAds + (this.ads ? dt : -dt) / ADS_BLEND_TIME, 0, 1);
    this._adsEase = smooth01(this._vmAds);
    const hipF = 1 - this._adsEase;
    // Recoil kick survives ADS at ~55% strength: a transient that springs back
    // to exact zero, so the centred red dot is only disturbed WHILE recoiling.
    const kickF = 1 - ADS_KICK_SCALE * this._adsEase;

    if (!cam) return;

    // Corner drop: 6% of the live frame down-right, measured at rifle depth,
    // so the framing holds across FOV kicks and any aspect ratio.
    const frameH = 2 * Math.tan(cam.fov * Math.PI / 360) * VM_REF_DEPTH;
    const frameW = frameH * clamp(cam.aspect || 1.78, 1, 2.2);

    // ADS eye-relief normalization. Weapons solves its ADS pose so the optic
    // plane sits dofHint.focusDistance in front of the eye (0.105 m today —
    // an eyepiece jammed against the eyeball, filling ~40% of the frame). If
    // that plane is closer than the art-directed ~0.21 m, slide the whole
    // adopted viewmodel STRAIGHT BACK along the camera axis by the shortfall.
    // Reading the live hint means this self-cancels to zero the moment
    // weapons repositions its own pose — no double correction — and pure
    // axial-Z translation keeps every on-axis point (the centred red dot)
    // projecting to exact screen centre, so the point of aim is untouched.
    const focus = ctx.weapons?.dofHint?.focusDistance;
    const adsPull = (typeof focus === 'number' && focus > 0.02)
      ? Math.max(0, ADS_EYE_DEPTH - focus)
      : 0;

    // Idle positional sway (0.5 cm at ~0.3 Hz, incommensurate axes so the
    // path never closes) + slow asymmetric breathing bob.
    const t = this._time;
    const swX = Math.sin(t * (Math.PI * 2 * VM_SWAY_HZ)) * VM_SWAY_AMP
      + Math.sin(t * 0.83 + 2.1) * 0.0012;
    const swY = Math.sin(t * (Math.PI * 2 * 0.21) + 1.4) * (VM_SWAY_AMP * 0.7);
    const swZ = Math.sin(t * (Math.PI * 2 * 0.26) + 0.6) * 0.002;
    const breath = Math.sin(t * 1.55) + 0.35 * Math.sin(t * 3.1 + 0.9);

    // Locomotion bob: figure-8 sharing the camera's bob phase/amplitude (one
    // frame stale — the gun trailing the body is exactly right) at a larger
    // throw plus a roll/pitch rock, so a moving gun visibly pumps instead of
    // gliding on rails. _bobAmp already fades out in ADS and when stopping.
    const ph = this._bobPhase;
    const bobAmp = this._bobAmp;
    const bobX = Math.cos(ph) * bobAmp * VM_BOB_X;
    const bobY = Math.sin(ph * 2) * bobAmp * VM_BOB_Y;
    const bobRZ = Math.sin(ph + 0.9) * bobAmp * VM_BOB_ROLL;
    const bobRX = Math.sin(ph * 2 + 0.4) * bobAmp * VM_BOB_PITCH;

    mount.position.set(
      (frameW * VM_CORNER_FRAC + swX + bobX) * hipF,
      (-frameH * VM_CORNER_FRAC + swY + breath * 0.0022 + bobY) * hipF,
      (swZ) * hipF + kZ * kickF - adsPull * this._adsEase,
    );
    mount.rotation.set(
      (breath * 0.0045 + bobRX) * hipF + kRX * kickF,
      kRY * kickF,
      (VM_CANT + Math.sin(t * 1.13 + 0.5) * 0.006 + bobRZ) * hipF + kRZ * kickF,
    );
  }

  // --- Mouse look ----------------------------------------------------------
  _updateLook(dt, ctx) {
    const input = ctx.input;
    if (!input?.locked) return;
    const cam = ctx.camera;
    // Scale sensitivity down with FOV so ADS feels consistent, then cut a
    // further 35% at full ADS (art directive): fine aim over the red dot,
    // net ~0.44x hipfire at the ADS FOV.
    const fovScale = cam ? Math.max(0.35, cam.fov / this._baseFov) : 1;
    const s = MOUSE_SENS * fovScale * (1 - ADS_SENS_REDUCE * this._adsEase);
    this.rig.rotation.y -= (input.mouseDX || 0) * s;
    this._pitch = clamp(this._pitch - (input.mouseDY || 0) * s, -PITCH_LIMIT, PITCH_LIMIT);
  }

  // --- Crouch / sprint intent / jump buffering -----------------------------
  _updateStance(dt, ctx) {
    const input = ctx.input;
    const boxes = ctx.world?.colliders;

    if (input?.justPressed?.('KeyC')) this._crouchToggle = !this._crouchToggle;
    const ctrlHeld = !!(input?.pressed?.('ControlLeft') || input?.pressed?.('ControlRight'));
    const shift = !!(input?.pressed?.('ShiftLeft') || input?.pressed?.('ShiftRight'));
    const forward = !!(input?.pressed?.('KeyW') || input?.pressed?.('ArrowUp'));
    if (shift && forward) this._crouchToggle = false; // sprint breaks crouch toggle
    const wantCrouch = this._crouchToggle || ctrlHeld;

    if (wantCrouch && !this.crouched) {
      this.crouched = true;
      this.height = HEIGHT_CROUCH;
    } else if (!wantCrouch && this.crouched) {
      // Stand only with headroom.
      if (!this._capsuleOverlaps(boxes, this.position.x, this.position.y + 0.02,
        this.position.z, HEIGHT_STAND - 0.04, RADIUS - 0.03)) {
        this.crouched = false;
        this.height = HEIGHT_STAND;
      }
    }

    if (input?.justPressed?.('Space')) this._jumpBuffer = JUMP_BUFFER;
    else if (this._jumpBuffer > 0) this._jumpBuffer = Math.max(0, this._jumpBuffer - dt);
  }

  // --- Wish velocity + acceleration ----------------------------------------
  _updateMove(dt, ctx) {
    const input = ctx.input;
    let ix = 0, iz = 0;
    if (input?.pressed?.('KeyW') || input?.pressed?.('ArrowUp')) iz -= 1;
    if (input?.pressed?.('KeyS') || input?.pressed?.('ArrowDown')) iz += 1;
    if (input?.pressed?.('KeyA') || input?.pressed?.('ArrowLeft')) ix -= 1;
    if (input?.pressed?.('KeyD') || input?.pressed?.('ArrowRight')) ix += 1;
    const hasInput = ix !== 0 || iz !== 0;
    if (hasInput) {
      const il = 1 / Math.hypot(ix, iz);
      ix *= il; iz *= il;
    }

    const shift = !!(input?.pressed?.('ShiftLeft') || input?.pressed?.('ShiftRight'));
    this.sprinting = !!(shift && iz < -0.3 && !this.crouched && !this.ads
      && (this.onGround || this.sprinting));

    let speed = this.crouched ? CROUCH_SPEED : (this.sprinting ? SPRINT_SPEED : RUN_SPEED);
    if (this.ads) speed = Math.min(speed, RUN_SPEED * ADS_SPEED_MULT);
    if (iz > 0.05) speed *= BACK_MULT;
    else if (Math.abs(ix) > 0.7 && iz > -0.3) speed *= STRAFE_MULT;

    // Local wish -> world (yaw only).
    const yaw = this.rig.rotation.y;
    const cos = Math.cos(yaw), sin = Math.sin(yaw);
    const tx = (ix * cos + iz * sin) * speed;
    const tz = (-ix * sin + iz * cos) * speed;

    const vel = this.velocity;
    const accel = this.onGround
      ? (hasInput ? GROUND_ACCEL : GROUND_DECEL)
      : (hasInput ? AIR_ACCEL : AIR_DECEL);
    const dvx = tx - vel.x, dvz = tz - vel.z;
    const dlen = Math.hypot(dvx, dvz);
    const maxD = accel * dt;
    if (dlen <= maxD || dlen < 1e-6) { vel.x = tx; vel.z = tz; }
    else { const f = maxD / dlen; vel.x += dvx * f; vel.z += dvz * f; }
    if (!hasInput && this.onGround && Math.hypot(vel.x, vel.z) < 0.04) { vel.x = 0; vel.z = 0; }
  }

  // --- Physics: gravity, jump, capsule collision, ground snap, events ------
  _updatePhysics(dt, ctx) {
    const boxes = ctx.world?.colliders;
    const hasWorld = !!(boxes && boxes.length);
    const pos = this.rig.position;
    const vel = this.velocity;
    const wasGround = this.onGround;

    // Coyote + buffered jump.
    if (this.onGround) this._coyote = COYOTE_TIME;
    else this._coyote = Math.max(0, this._coyote - dt);
    let jumped = false;
    if (this._jumpBuffer > 0 && (this.onGround || this._coyote > 0) && vel.y <= 4) {
      if (this.crouched
        && !this._capsuleOverlaps(boxes, pos.x, pos.y + 0.02, pos.z, HEIGHT_STAND - 0.04, RADIUS - 0.03)) {
        this.crouched = false;
        this.height = HEIGHT_STAND;
        this._crouchToggle = false;
      }
      vel.y = this.crouched ? JUMP_VELOCITY * 0.82 : JUMP_VELOCITY;
      this._jumpBuffer = 0;
      this._coyote = 0;
      this.onGround = false;
      jumped = true;
      ctx.events?.emit('player:jump', {});
    }

    // Gravity.
    vel.y -= GRAVITY * dt;
    if (vel.y < -TERMINAL_FALL) vel.y = -TERMINAL_FALL;
    const impactSpeed = -vel.y; // fall speed going into this frame's resolve

    this._groundedThisFrame = false;

    // Vertical move, substepped so fast falls never tunnel through thin floors.
    const dy = vel.y * dt;
    const vSteps = Math.min(6, Math.max(1, Math.ceil(Math.abs(dy) / 0.24)));
    for (let i = 0; i < vSteps; i++) {
      const prevFeet = pos.y;
      pos.y += dy / vSteps;
      if (hasWorld) this._resolveVertical(boxes, prevFeet);
    }
    if (!hasWorld) {
      // Safety net: no colliders registered (level failed) — virtual floor at spawn height.
      if (pos.y <= this._spawn.y && vel.y <= 0) {
        pos.y = this._spawn.y;
        vel.y = 0;
        this._groundedThisFrame = true;
      }
    }

    // Horizontal, axis-separated (X then Z) with substeps against thin walls.
    const dx = vel.x * dt, dz = vel.z * dt;
    const hLen = Math.hypot(dx, dz);
    if (hLen > 1e-7) {
      if (hasWorld) {
        const stepAllow = (wasGround || this._groundedThisFrame) ? STEP_HEIGHT : STEP_AIR;
        const hSteps = Math.min(5, Math.max(1, Math.ceil(hLen / 0.2)));
        for (let i = 0; i < hSteps; i++) {
          pos.x += dx / hSteps;
          this._resolveHorizontal(boxes, stepAllow);
          pos.z += dz / hSteps;
          this._resolveHorizontal(boxes, stepAllow);
        }
      } else {
        pos.x += dx;
        pos.z += dz;
      }
    }

    // Step-up onto low ledges / stick to ground walking down steps.
    if (hasWorld) this._groundSnapAndStep(boxes, wasGround, jumped);
    this.onGround = this._groundedThisFrame;

    // Landing.
    if (!wasGround && this.onGround) {
      const hard = impactSpeed > HARD_LAND_SPEED;
      this._dipVel -= Math.min(2.4, 0.45 + impactSpeed * (hard ? 0.11 : 0.055));
      if (impactSpeed > LAND_EVENT_SPEED) ctx.events?.emit('player:land', { hard });
    }

    // Footsteps (distance cadence).
    if (this.onGround) {
      const sp = Math.hypot(vel.x, vel.z);
      if (sp > FOOTSTEP_MIN_SPEED) {
        const stride = this.sprinting ? 2.3 : (this.crouched ? 1.5 : 1.9);
        if (!this._wasMovingGround) this._stepDist = stride * 0.55; // quick first step
        this._stepDist += sp * dt;
        if (this._stepDist >= stride) {
          this._stepDist -= stride;
          ctx.events?.emit('player:footstep', { sprinting: this.sprinting });
        }
        this._wasMovingGround = true;
      } else {
        this._stepDist = 0;
        this._wasMovingGround = false;
      }
    } else {
      this._stepDist = 0;
      this._wasMovingGround = false;
    }

    // Fell out of the world: recover, at a price.
    if (pos.y < this._spawn.y - 70) {
      pos.copy(this._spawn);
      vel.set(0, 0, 0);
      this._smoothFeetY = pos.y;
      this.damage(25, null);
    }
  }

  /**
   * Vertical resolve at the current XZ. Ground/ceiling only — deep lateral
   * overlaps with tall wall boxes are left for the horizontal passes, which
   * prevents walls from crushing the capsule through the floor.
   */
  _resolveVertical(boxes, prevFeet) {
    const pos = this.rig.position;
    const vel = this.velocity;
    const r = RADIUS - 0.02;
    const rr = r * r;
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      if (!b) continue;
      const h = this.height;
      const top = pos.y + h;
      if (b.max.y <= pos.y + EPS || b.min.y >= top - EPS) continue;
      const cx = clamp(pos.x, b.min.x, b.max.x);
      const cz = clamp(pos.z, b.min.z, b.max.z);
      const ddx = pos.x - cx, ddz = pos.z - cz;
      if (ddx * ddx + ddz * ddz >= rr) continue;
      const upPen = b.max.y - pos.y;   // push up onto the box top
      const downPen = top - b.min.y;   // push down under the box bottom
      if (upPen <= downPen) {
        if (upPen <= STEP_HEIGHT + 0.15 || prevFeet >= b.max.y - 0.02) {
          pos.y = b.max.y;
          if (vel.y < 0) vel.y = 0;
          this._groundedThisFrame = true;
        }
      } else if (downPen <= 0.5 || prevFeet + h <= b.min.y + 0.02) {
        pos.y = b.min.y - h;
        if (vel.y > 0) vel.y = 0;
      }
    }
  }

  /**
   * Horizontal capsule (circle in XZ) vs Box3 footprints occupying the band
   * [feet+stepAllow, head]. Minimum-translation resolution: face contacts push
   * along the face normal, corner contacts push along the corner normal — the
   * capsule slides around convex corners instead of sticking. Velocity into
   * the contact normal is clipped, which is what produces wall sliding.
   */
  _resolveHorizontal(boxes, stepAllow) {
    const pos = this.rig.position;
    const vel = this.velocity;
    const rr = RADIUS * RADIUS;
    for (let iter = 0; iter < 2; iter++) {
      let any = false;
      const bottom = pos.y + stepAllow;
      const top = pos.y + this.height;
      for (let i = 0; i < boxes.length; i++) {
        const b = boxes[i];
        if (!b) continue;
        if (b.max.y <= bottom + EPS || b.min.y >= top - EPS) continue;
        const cx = clamp(pos.x, b.min.x, b.max.x);
        const cz = clamp(pos.z, b.min.z, b.max.z);
        const ddx = pos.x - cx, ddz = pos.z - cz;
        const d2 = ddx * ddx + ddz * ddz;
        if (d2 >= rr) continue;
        any = true;
        if (d2 > 1e-10) {
          const d = Math.sqrt(d2);
          const nx = ddx / d, nz = ddz / d;
          const push = RADIUS - d + SKIN;
          pos.x += nx * push;
          pos.z += nz * push;
          const vn = vel.x * nx + vel.z * nz;
          if (vn < 0) { vel.x -= vn * nx; vel.z -= vn * nz; }
        } else {
          // Center inside the footprint: eject through the nearest face.
          const pushMinX = pos.x - b.min.x + RADIUS;
          const pushMaxX = b.max.x - pos.x + RADIUS;
          const pushMinZ = pos.z - b.min.z + RADIUS;
          const pushMaxZ = b.max.z - pos.z + RADIUS;
          const m = Math.min(pushMinX, pushMaxX, pushMinZ, pushMaxZ);
          if (m === pushMinX) { pos.x = b.min.x - RADIUS - SKIN; if (vel.x > 0) vel.x = 0; }
          else if (m === pushMaxX) { pos.x = b.max.x + RADIUS + SKIN; if (vel.x < 0) vel.x = 0; }
          else if (m === pushMinZ) { pos.z = b.min.z - RADIUS - SKIN; if (vel.z > 0) vel.z = 0; }
          else { pos.z = b.max.z + RADIUS + SKIN; if (vel.z < 0) vel.z = 0; }
        }
      }
      if (!any) break;
    }
  }

  /**
   * After horizontal movement: settle onto the best supporting box top within
   * [feet - SNAP_DOWN, feet + STEP_HEIGHT]. Stepping up requires headroom;
   * snapping down keeps stairs/ramps from launching the player airborne.
   */
  _groundSnapAndStep(boxes, wasGround, jumped) {
    const pos = this.rig.position;
    const vel = this.velocity;
    if (jumped || vel.y > 0.01) return;
    const r = RADIUS - 0.02;
    const rr = r * r;
    const upMax = wasGround ? STEP_HEIGHT : 0.02;
    const downMax = wasGround ? SNAP_DOWN : 0.0;
    let best = -Infinity;
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      if (!b) continue;
      const t = b.max.y;
      if (t < pos.y - downMax - EPS || t > pos.y + upMax + EPS) continue;
      const cx = clamp(pos.x, b.min.x, b.max.x);
      const cz = clamp(pos.z, b.min.z, b.max.z);
      const ddx = pos.x - cx, ddz = pos.z - cz;
      if (ddx * ddx + ddz * ddz >= rr) continue;
      if (t > best) best = t;
    }
    if (best === -Infinity) return;
    const delta = best - pos.y;
    if (delta > 0.001) {
      // Step up — only with headroom at the new height.
      if (this._capsuleOverlaps(boxes, pos.x, best + 0.02, pos.z, this.height - 0.04, RADIUS - 0.03)) {
        this._resolveHorizontal(boxes, 0.02); // treat the ledge as a wall instead
        return;
      }
      pos.y = best;
    } else if (delta < -0.001) {
      pos.y = best; // walk down steps without going airborne
    }
    this._groundedThisFrame = true;
    if (vel.y < 0) vel.y = 0;
  }

  /** True if a capsule (feet y0, height h, radius r) at x,z overlaps any collider. */
  _capsuleOverlaps(boxes, x, y0, z, h, r) {
    if (!boxes || !boxes.length) return false;
    const rr = r * r;
    const top = y0 + h;
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      if (!b) continue;
      if (b.max.y <= y0 + EPS || b.min.y >= top - EPS) continue;
      const cx = clamp(x, b.min.x, b.max.x);
      const cz = clamp(z, b.min.z, b.max.z);
      const ddx = x - cx, ddz = z - cz;
      if (ddx * ddx + ddz * ddz < rr) return true;
    }
    return false;
  }

  // --- Health / regen ------------------------------------------------------
  _updateHealth(dt, ctx) {
    this._sinceDamage += dt;
    if (this.health < MAX_HEALTH && this._sinceDamage >= REGEN_DELAY) {
      if (!this._regenActive) {
        this._regenActive = true;
        ctx.events?.emit('player:heal', {});
      }
      this.health = Math.min(MAX_HEALTH, this.health + REGEN_RATE * dt);
      if (this.health >= MAX_HEALTH) this._regenActive = false;
    }
  }

  // --- Camera presentation: crouch/step smoothing, bob, dip, roll, FOV -----
  _updateCamera(dt, ctx) {
    const cam = ctx.camera;
    const vel = this.velocity;

    // Crouch eye height (smooth).
    const targetEye = this.crouched ? EYE_CROUCH : EYE_STAND;
    this._eyeSmooth += (targetEye - this._eyeSmooth) * damp(12, dt);

    // Step smoothing: the collision snaps feet up stairs; the camera glides.
    this._smoothFeetY += (this.position.y - this._smoothFeetY) * damp(this.onGround ? 18 : 40, dt);
    const stepOff = clamp(this._smoothFeetY - this.position.y, -0.35, 0.35);
    this.head.position.y = this._eyeSmooth + stepOff;

    // Headbob — speed-scaled, halved when crouched, none when ADS.
    const sp = Math.hypot(vel.x, vel.z);
    const moving = this.onGround && sp > 0.6;
    const ampTarget = (moving && !this.ads)
      ? Math.min(1, sp / SPRINT_SPEED) * (this.crouched ? 0.55 : 1) * 0.031
      : 0;
    this._bobAmp += (ampTarget - this._bobAmp) * damp(10, dt);
    if (moving) this._bobPhase += dt * (2.4 + sp * 1.25);
    const bobX = Math.cos(this._bobPhase) * this._bobAmp * 0.8;
    const bobY = Math.sin(this._bobPhase * 2) * this._bobAmp * 0.55;
    const bobRoll = Math.sin(this._bobPhase) * this._bobAmp * 0.4;

    // Breathing — asymmetric dual-sine cycle (~0.25 Hz), damped while moving
    // and in ADS but never zeroed: a captured frame always carries life.
    const adsEase = this._adsEase;
    const still = 1 - Math.min(1, sp / 2);
    const breathCycle = Math.sin(this._time * 1.55) + 0.35 * Math.sin(this._time * 3.1 + 0.9);
    const breathe = breathCycle * 0.0032 * (1 - 0.65 * adsEase) * (0.45 + 0.55 * still);
    const breathePitch = breathCycle * 0.0009 * (1 - 0.7 * adsEase);

    // Slow positional weight-shift sway — 0.5 cm at ~0.3 Hz. Kept partially in
    // ADS: translating the eye never rotates the aim ray, so it cannot move
    // the point of aim, only add parallax life to the frame.
    const swayScale = 1 - 0.45 * adsEase;
    const swayX = (Math.sin(this._time * 1.885) * 0.005
      + Math.sin(this._time * 0.741 + 1.9) * 0.0018) * swayScale;
    const swayY = Math.sin(this._time * 1.313 + 0.8) * 0.0035 * swayScale;

    // Fire flinch punches (critically damped, ~80 ms recovery — see _onWeaponFire).
    const punchP = this._punchPitch.update(dt);
    const punchR = this._punchRoll.update(dt);
    const punchZ = this._punchZ.update(dt);

    // Landing dip spring.
    this._dipVel += (-130 * this._dipY - 14 * this._dipVel) * dt;
    this._dipY = clamp(this._dipY + this._dipVel * dt, -0.28, 0.12);

    // Strafe lean + damage roll decay.
    const yaw = this.rig.rotation.y;
    const latV = vel.x * Math.cos(yaw) - vel.z * Math.sin(yaw);
    const rollTarget = clamp(-latV * 0.0035, -0.022, 0.022);
    this._strafeRoll += (rollTarget - this._strafeRoll) * damp(8, dt);
    this._damageRoll *= Math.exp(-6 * dt);

    if (cam) {
      cam.position.set(bobX + swayX, bobY + breathe + swayY + this._dipY, punchZ);
      cam.rotation.x = this._pitch + this._dipY * 0.35 + breathePitch + punchP;
      cam.rotation.z = bobRoll + this._strafeRoll + this._damageRoll + punchR;

      // FOV: the ADS zoom rides a dedicated 150 ms smoothstepped ramp (crisp
      // punch-in/out, per the art directive — the old exponential damp took
      // ~270 ms to settle and read as mushy), layered over a damped hip/sprint
      // drift so sprint-widening keeps its lazier feel.
      this._fovAds = clamp(this._fovAds + (this.ads ? dt : -dt) / ADS_FOV_TIME, 0, 1);
      let hipT = this._baseFov;
      if (this.sprinting && sp > RUN_SPEED * 0.9) hipT = SPRINT_FOV;
      this._fovHip += (hipT - this._fovHip) * damp(11, dt);
      const adsT = clamp(this.adsFov || DEFAULT_ADS_FOV, ADS_FOV_MIN, ADS_FOV_MAX);
      const nf = lerp(this._fovHip, adsT, smooth01(this._fovAds));
      if (Math.abs(nf - cam.fov) > 0.001) {
        cam.fov = nf;
        cam.updateProjectionMatrix();
      }
    }

    // ADS focus overlay (after the FOV write so the quad fits the frame):
    // peripheral blur tracks the gun raise; the darkening vignette arrives in
    // the back half of the blend so it reads as the eye settling on the optic.
    if (this._focus) {
      const e = this._adsEase;
      const dark = smooth01(clamp((e - 0.35) / 0.65, 0, 1)) * ADS_DARK_MAX;
      this._focus.set(cam, e * ADS_BLUR_MAX, dark);
      this._focus.capture(ctx.renderer, ctx.scene, cam);
    }
  }

  // --- Death camera: tilt and crumple to the ground ------------------------
  _updateDeath(dt, cam) {
    this._focus?.hideNow(); // no ADS focus on a dead man's eyes
    const d = this._death;
    if (!d) return;
    d.t = Math.min(1, d.t + dt / 1.15);
    const t = d.t;

    // Fall: eye accelerates down, tiny bounce at impact.
    const fallT = Math.min(1, t / 0.55);
    let eye = lerp(d.eye, 0.34, fallT * fallT);
    if (t > 0.55 && t < 0.75) eye += Math.sin(((t - 0.55) / 0.2) * Math.PI) * 0.05;
    this.head.position.y = eye;

    // Roll over sideways, gaze drifting skyward.
    const rollT = easeOutCubic(Math.min(1, t / 0.85));
    this.rig.rotation.y += d.side * dt * 0.12 * (1 - t);
    if (cam) {
      cam.rotation.z = d.side * 1.18 * rollT;
      cam.rotation.x = lerp(d.pitch, 0.32, rollT);
      cam.position.set(0, 0, 0);
      const nf = cam.fov + (this._baseFov - cam.fov) * damp(6, dt);
      if (Math.abs(nf - cam.fov) > 0.001) {
        cam.fov = nf;
        cam.updateProjectionMatrix();
      }
    }
  }

  // --- Full reset (restart after death) ------------------------------------
  _respawn() {
    const ctx = this._ctx;
    this.rig.position.copy(this._spawn);
    this.rig.rotation.set(0, this._spawnYaw, 0);
    this.velocity.set(0, 0, 0);
    this.health = MAX_HEALTH;
    this.alive = true;
    this.onGround = false;
    this.crouched = false;
    this.sprinting = false;
    this.ads = false;
    this.height = HEIGHT_STAND;
    this._pitch = 0;
    this._crouchToggle = false;
    this._jumpBuffer = 0;
    this._coyote = 0;
    this._stepDist = 0;
    this._wasMovingGround = false;
    this._eyeSmooth = EYE_STAND;
    this._smoothFeetY = this.rig.position.y;
    this._bobPhase = 0;
    this._bobAmp = 0;
    this._dipY = 0;
    this._dipVel = 0;
    this._strafeRoll = 0;
    this._damageRoll = 0;
    this._sinceDamage = 999;
    this._regenActive = false;
    this._death = null;
    this._groundedThisFrame = false;
    this._vmAds = 0;
    this._adsEase = 0;
    this._fovAds = 0;
    this._fovHip = this._baseFov;
    this._vmKickZ.reset();
    this._vmKickRX.reset();
    this._vmKickRY.reset();
    this._vmKickRZ.reset();
    this._punchPitch.reset();
    this._punchRoll.reset();
    this._punchZ.reset();
    if (this._vmMount) {
      this._vmMount.position.set(0, 0, 0);
      this._vmMount.rotation.set(0, 0, 0);
    }
    this._focus?.reset();
    this.head.position.y = EYE_STAND;
    const cam = ctx?.camera;
    if (cam) {
      cam.position.set(0, 0, 0);
      cam.rotation.set(0, 0, 0);
      cam.fov = this._baseFov;
      cam.updateProjectionMatrix();
    }
  }
}
