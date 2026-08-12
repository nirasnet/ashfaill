// WEAPONS — owns: first-person viewmodel, gun model, fire/reload/ADS logic, recoil.
//
// A procedural M4A1-style rifle (src/weapons/rifle.js) hangs off the camera and
// is driven entirely by springs and blend poses: idle sway/breath, look-lag,
// walk/sprint bob, fire kick, camera recoil, reload choreography, ADS.
// In ADS the red-dot reticle is aligned mathematically to the camera axis, so
// it sits exactly at screen centre; residual sway pivots AROUND the dot, which
// keeps the point of aim rock-solid while the gun still feels alive.
// The optic is brought close in ADS (fills ~35% of frame height, lower-center,
// FOV 50). The collimated dot is live in every stance — dim over the true-glass
// lens in hipfire, full intensity + additive bloom halo once ADS settles.
// The hip pose is raised/canted so the gloved hands read in frame (a grip
// buried below the frame bottom was why the rifle looked unheld).
//
// Cross-system surface for postfx (DOF): 'weapon:ads' events carry
// { ads, fov, focusDistance, bokehPx }, and ctx.weapons exposes per-frame
// `adsProgress` (0..1) plus a static `dofHint` — enough to drive a bokeh pass
// that keeps the optic plane sharp and blurs the receiver in ADS.
//
// Every ctx field owned by another system is optional-chained — this system
// must never take the frame loop down, whatever else failed.
import * as THREE from 'three';
import { buildRifle } from './weapons/rifle.js';
import { Spring1, Spring3, damp, clamp, smoothstep } from './weapons/springs.js';

const MAG_SIZE = 30;
const RESERVE_START = 120;
const FIRE_INTERVAL = 60 / 750;      // ~750 rpm
const RELOAD_TIME = 1.9;
const RELOAD_TRANSFER_T = 1.35;      // mag seated — ammo counts swap here
const RELOAD_BOLT_T = 1.55;          // bolt release on an empty reload
const ADS_TIME = 0.18;
const ADS_FOV = 50;                  // hipfire FOV is player-owned; ADS drops to 50
const VM_SCALE = 0.8;
const DOT_ADS_DIST = 0.105;          // camera-space reticle distance in ADS — the
                                     // 30 mm tube fills ~35% of frame height
const ADS_BOKEH_PX = 2;              // suggested DOF blur radius for the receiver
const BODY_DMG = 26, HEAD_DMG = 55, FALLOFF_START = 40;

const MOUSE_SENS = 0.0021;           // matches the player contract (look-lag only)

export class WeaponSystem {
  async init(ctx) {
    this.name = 'M4A1';
    this.ammo = MAG_SIZE;
    this.reserve = RESERVE_START;
    this.reloading = false;

    // ---- internal state ------------------------------------------------
    this._ctx = ctx;
    this._cooldown = 0;
    this._heat = 0;
    this._trigPrev = false;
    this.ads = false;
    this._adsBlend = 0;
    this._sprintBlend = 0;
    this._lowerBlend = 0;
    this._reloadT = 0;
    this._reloadTransferred = false;
    this._reloadEmptyLock = false;
    this._reloadBoltSlammed = false;
    this._lagX = 0; this._lagY = 0;
    this._bobPhase = 0; this._bobAmp = 0;
    this._airOff = 0;
    this._armFollowY = 0; this._armFollowZ = 0;
    this._flashT = 0;
    this._flashScale = 1;
    this._boltPulse = 0;
    this._boltZ = 0;

    // Springs.
    this._kickPos = new Spring3(420, 26);
    this._kickRot = new Spring3(380, 24);
    this._camPitch = new Spring1(90, 16);
    this._camYaw = new Spring1(90, 16);
    this._camPitchPrev = 0;
    this._camYawPrev = 0;

    // Pooled scratch.
    this._v1 = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._v3 = new THREE.Vector3();
    this._v4 = new THREE.Vector3();
    this._q1 = new THREE.Quaternion();
    this._eye = new THREE.Vector3();
    this._aim = new THREE.Vector3();

    // ---- viewmodel rig -------------------------------------------------
    // camera -> poseGroup (stance blend) -> kickGroup (recoil springs)
    //        -> swayGroup (lag/bob/idle, ADS-pivot-compensated) -> rifle
    const camera = ctx.camera;
    if (camera && !camera.parent) ctx.scene?.add(camera); // fallback if the player rig failed
    this._camera = camera ?? null;

    this._poseGroup = new THREE.Group();
    this._kickGroup = new THREE.Group();
    this._swayGroup = new THREE.Group();
    this._poseGroup.add(this._kickGroup);
    this._kickGroup.add(this._swayGroup);

    this._rifle = buildRifle();
    this._reticle = this._rifle.reticle;   // dot/halo shown only through ADS glass
    this._envApplied = undefined;          // last scene.environment synced to materials
    this._rifle.group.scale.setScalar(VM_SCALE);
    this._rifle.group.updateMatrixWorld(true);
    // Reticle position in pose-group space (rifle at identity under sway/kick).
    this._dotLocal = new THREE.Vector3();
    this._rifle.sightDot.getWorldPosition(this._dotLocal);
    this._swayGroup.add(this._rifle.group);
    camera?.add(this._poseGroup);

    this._magBasePos = this._rifle.magGroup.position.clone();

    // Subtle NEUTRAL fill so the viewmodel always reads, even if scene lighting
    // failed. Kept very weak: with physical (1/d^2) falloff a point light this
    // close would otherwise wash all dielectrics (gloves/polymer) to warm beige
    // — that was the old "two-tone toy" read.
    const fill = new THREE.PointLight(0xdfe6ee, 0.03, 1.6, 2);
    fill.position.set(0.06, 0.16, 0.1);
    fill.castShadow = false;
    this._poseGroup.add(fill);

    // ---- stance poses (camera space) ----------------------------------
    // Hip pose raised ~1.4 cm and canted a touch: the grip + right hand were
    // sitting below the frame bottom, which read as a floating, unheld rifle.
    // The left hand/knuckles and the right thumb now break the frame edge.
    this._hipPos = new THREE.Vector3(0.148, -0.138, -0.295);
    this._hipRot = new THREE.Euler(0.0, 0.045, 0.05);
    // ADS pose is solved so the dot lands exactly on the camera axis.
    this._adsPos = new THREE.Vector3(
      -this._dotLocal.x,
      -this._dotLocal.y,
      -DOT_ADS_DIST - this._dotLocal.z,
    );
    this._adsRot = new THREE.Euler(0, 0, 0);
    this._sprintPos = new THREE.Vector3(0.09, -0.2, -0.32);
    this._sprintRot = new THREE.Euler(-0.32, 0.38, 0.22);
    this._lowerPos = new THREE.Vector3(0.05, -0.24, -0.27);
    this._lowerRot = new THREE.Euler(-0.55, 0.12, 0.1);

    // ---- events --------------------------------------------------------
    ctx.events?.on?.('player:land', (p) => {
      const hard = !!p?.hard;
      this._kickPos.impulse(0, hard ? -0.42 : -0.2, hard ? 0.12 : 0.05);
      this._kickRot.impulse(hard ? -0.9 : -0.45, 0, (Math.random() - 0.5) * 0.3);
    });
    ctx.events?.on?.('game:start', () => this._resetLoadout());

    if (ctx.player) { ctx.player.ads = false; ctx.player.adsFov = ADS_FOV; }
    // DOF surface for the postfx system: focus on the optic plane in ADS,
    // ~2px bokeh on everything nearer/farther (i.e. the receiver).
    this.adsProgress = 0;
    this.dofHint = { focusDistance: DOT_ADS_DIST, bokehPx: ADS_BOKEH_PX };
    ctx.weapons = this;
  }

  _resetLoadout() {
    this.ammo = MAG_SIZE;
    this.reserve = RESERVE_START;
    this.reloading = false;
    this._reloadT = 0;
    this._heat = 0;
    this._cooldown = 0;
    this._reloadEmptyLock = false;
  }

  /**
   * Viewmodel dielectrics get the scene env as their OWN envMap so the
   * per-material envMapIntensity is respected (with `scene.environment` alone,
   * three feeds the shader scene.environmentIntensity and ignores the material
   * knob — the full-strength env diffuse washed the gun to beige). Texture and
   * needsUpdate only churn when the atmosphere actually swaps the env map;
   * intensity/rotation mirroring is a few float copies per frame.
   */
  _syncEnvLighting(ctx) {
    const mats = this._rifle?.envManaged;
    if (!mats) return;
    const scene = ctx.scene;
    const env = scene?.environment ?? null;
    const envInt = scene?.environmentIntensity ?? 1;
    const swap = env !== this._envApplied;
    for (const m of mats) {
      if (swap) {
        m.envMap = env;
        m.needsUpdate = true;
      }
      m.envMapIntensity = (m.userData.envFactor ?? 0.3) * envInt;
      if (env && scene.environmentRotation && m.envMapRotation) {
        m.envMapRotation.copy(scene.environmentRotation);
      }
    }
    if (swap) this._envApplied = env;
  }

  /** World-space muzzle position (fresh vector unless a target is supplied). */
  muzzleWorldPosition(target = new THREE.Vector3()) {
    if (this._rifle?.muzzle) return this._rifle.muzzle.getWorldPosition(target);
    if (this._camera) return this._camera.getWorldPosition(target);
    return target.set(0, 0, 0);
  }

  update(dt, ctx) {
    if (!this._poseGroup) return;
    this._syncEnvLighting(ctx);
    const playing = ctx.state?.phase === 'playing';
    const alive = ctx.player?.alive ?? true;
    const active = playing && alive;
    const input = ctx.input;

    // ---- player motion sampling ---------------------------------------
    const vel = ctx.player?.velocity;
    const speed = vel ? Math.hypot(vel.x ?? 0, vel.z ?? 0) : 0;
    const grounded = ctx.player?.onGround ?? true;
    const sprinting = !!ctx.player?.sprinting && speed > 1.5;

    // ---- ADS -----------------------------------------------------------
    const adsWanted = !!(active && input?.mouseDown?.[2]) && !this.reloading;
    if (adsWanted !== this.ads) {
      this.ads = adsWanted;
      ctx.events?.emit?.('weapon:ads', {
        ads: this.ads, fov: ADS_FOV,
        focusDistance: DOT_ADS_DIST, bokehPx: ADS_BOKEH_PX,
      });
    }
    if (ctx.player) { ctx.player.ads = this.ads; ctx.player.adsFov = ADS_FOV; }
    this._adsBlend = clamp(this._adsBlend + (this.ads ? dt : -dt) / ADS_TIME, 0, 1);
    const adsCurve = smoothstep(0, 1, this._adsBlend);
    const hipF = 1 - adsCurve;
    this.adsProgress = adsCurve; // read by postfx for its DOF/ADS grading

    // Reticle: the collimated dot is live in every stance (a dead lens was the
    // single worst optic read) — dim over the glass in hipfire, full intensity
    // in ADS. The dot is a crisp 2-3 px emissive point; the tight additive
    // halo fades in late in the ADS blend only and stays subtle (the bloom
    // pass supplies the rest), so the reticle never reads as a fuzzy blob.
    if (this._reticle) {
      const adsVis = smoothstep(0.55, 0.95, adsCurve);
      this._reticle.dot.visible = true;
      this._reticle.glow.visible = adsVis > 0.004;
      this._reticle.dotMat.opacity = 0.55 + 0.45 * adsVis;
      this._reticle.glowMat.opacity = 0.55 * adsVis;
    }

    // ---- sprint / lowered blends ---------------------------------------
    const sprintTarget = active && sprinting && !this.reloading ? 1 : 0;
    this._sprintBlend = damp(this._sprintBlend, sprintTarget, 12, dt);
    const lowerTarget = (!alive || ctx.state?.phase === 'over') ? 1 : 0;
    this._lowerBlend = damp(this._lowerBlend, lowerTarget, 4, dt);

    // ---- reload ---------------------------------------------------------
    if (active && input?.justPressed?.('KeyR') && !this.reloading
        && this.ammo < MAG_SIZE && this.reserve > 0) {
      this.reloading = true;
      this._reloadT = 0;
      this._reloadTransferred = false;
      this._reloadBoltSlammed = false;
      this._reloadEmptyLock = this.ammo === 0;
      ctx.events?.emit?.('weapon:reload:start', { weapon: this });
    }
    if (this.reloading && playing) {
      this._reloadT += dt;
      if (!this._reloadTransferred && this._reloadT >= RELOAD_TRANSFER_T) {
        this._reloadTransferred = true;
        const take = Math.min(MAG_SIZE - this.ammo, this.reserve);
        this.ammo += take;
        this.reserve -= take;
        this._kickPos.impulse(0, 0.4, 0.1);
        this._kickRot.impulse(0.8, 0, -0.4);
      }
      if (this._reloadEmptyLock && !this._reloadBoltSlammed && this._reloadT >= RELOAD_BOLT_T) {
        this._reloadBoltSlammed = true;
        this._kickPos.impulse(0, 0.12, 0.3);
        this._kickRot.impulse(0.7, 0.2, 0.2);
      }
      if (this._reloadT >= RELOAD_TIME) {
        this.reloading = false;
        this._reloadEmptyLock = false;
        ctx.events?.emit?.('weapon:reload:end', { weapon: this });
      }
    }

    // ---- trigger --------------------------------------------------------
    const trigger = !!(active && input?.mouseDown?.[0]);
    const trigEdge = trigger && !this._trigPrev;
    this._trigPrev = trigger;
    this._cooldown = Math.max(0, this._cooldown - dt);
    const canFire = active && !this.reloading && !sprinting && this._sprintBlend < 0.5;
    if (trigger && canFire && this.ammo > 0 && this._cooldown <= 0) {
      this._fire(ctx, adsCurve, speed);
      this._cooldown = FIRE_INTERVAL;
    } else if (trigEdge && !this.reloading && this.ammo === 0) {
      ctx.events?.emit?.('weapon:empty', {});
    }
    this._heat = Math.max(0, this._heat - dt * 6);

    // ---- camera recoil (applied as per-frame deltas so the player's own
    // look code keeps ownership of the camera angles) ---------------------
    this._camPitch.update(dt);
    this._camYaw.update(dt);
    const dPitch = this._camPitch.value - this._camPitchPrev;
    const dYaw = this._camYaw.value - this._camYawPrev;
    this._camPitchPrev = this._camPitch.value;
    this._camYawPrev = this._camYaw.value;
    if (ctx.player?.addViewKick) {
      // Player rebuilds camera angles from its own yaw/pitch every frame —
      // route recoil through its supported hook so the kick persists.
      ctx.player.addViewKick(dPitch, dYaw);
    } else {
      const cam = this._camera;
      if (cam) {
        cam.rotation.x = clamp(cam.rotation.x + dPitch, -1.55, 1.55);
        const parent = cam.parent;
        if (parent && !parent.isScene) parent.rotation.y += dYaw;
        else cam.rotation.y += dYaw;
      }
    }

    // ---- viewmodel kick springs -----------------------------------------
    this._kickPos.update(dt);
    this._kickRot.update(dt);
    // Spring impulses are tuned so peak displacement ≈ velocity / ω:
    // position peaks around 2 cm and rotation around 3° per shot, decaying fast.
    this._kickGroup.position.set(
      this._kickPos.x.value,
      this._kickPos.y.value,
      this._kickPos.z.value,
    );
    this._kickGroup.rotation.set(
      this._kickRot.x.value,
      this._kickRot.y.value,
      this._kickRot.z.value,
    );

    // ---- stance pose blend ----------------------------------------------
    const t = ctx.time ?? 0;
    const pos = this._v1.copy(this._hipPos).lerp(this._adsPos, adsCurve);
    let rx = this._hipRot.x + (this._adsRot.x - this._hipRot.x) * adsCurve;
    let ry = this._hipRot.y + (this._adsRot.y - this._hipRot.y) * adsCurve;
    let rz = this._hipRot.z + (this._adsRot.z - this._hipRot.z) * adsCurve;

    const sprintW = this._sprintBlend * hipF * (1 - this._lowerBlend);
    if (sprintW > 0.001) {
      pos.lerp(this._sprintPos, sprintW);
      rx += (this._sprintRot.x - rx) * sprintW;
      ry += (this._sprintRot.y - ry) * sprintW;
      rz += (this._sprintRot.z - rz) * sprintW;
    }
    if (this._lowerBlend > 0.001) {
      pos.lerp(this._lowerPos, this._lowerBlend);
      rx += (this._lowerRot.x - rx) * this._lowerBlend;
      ry += (this._lowerRot.y - ry) * this._lowerBlend;
      rz += (this._lowerRot.z - rz) * this._lowerBlend;
    }

    // Reload dip + roll (shows the magwell to the camera).
    const rT = this.reloading ? this._reloadT : RELOAD_TIME;
    const rw = this.reloading
      ? smoothstep(0, 0.22, rT) * (1 - smoothstep(1.6, 1.88, rT))
      : 0;
    if (rw > 0.001) {
      pos.x += -0.012 * rw;
      pos.y += -0.052 * rw;
      pos.z += 0.012 * rw;
      rx += -0.2 * rw;
      ry += 0.14 * rw;
      rz += 0.38 * rw;
    }

    // Air / jump offset.
    const vy = vel?.y ?? 0;
    const airTarget = grounded ? 0 : clamp(-vy * 0.0045, -0.02, 0.022);
    this._airOff = damp(this._airOff, airTarget, 10, dt);
    pos.y += this._airOff * (0.3 + 0.7 * hipF);

    this._poseGroup.position.copy(pos);
    this._poseGroup.rotation.set(rx, ry, rz);

    // ---- procedural sway / look-lag / bob -------------------------------
    if (input && playing) {
      this._lagX = clamp(this._lagX + (input.mouseDX ?? 0) * MOUSE_SENS, -0.07, 0.07);
      this._lagY = clamp(this._lagY + (input.mouseDY ?? 0) * MOUSE_SENS, -0.06, 0.06);
    }
    const lagDecay = Math.exp(-11 * dt);
    this._lagX *= lagDecay;
    this._lagY *= lagDecay;

    // Bob amplitude/frequency from player locomotion.
    const moveAmt = clamp(speed / 5.2, 0, 1);
    const bobTarget = active && grounded ? moveAmt : 0;
    this._bobAmp = damp(this._bobAmp, bobTarget, 9, dt);
    if (this._bobAmp > 0.005) {
      this._bobPhase += dt * (5.2 + speed * 1.35 + this._sprintBlend * 2.5);
    }
    const bA = this._bobAmp * (1 + 0.55 * this._sprintBlend);
    const ph = this._bobPhase;

    const idle = 1 - moveAmt * 0.7;
    // Rotational sway: look-lag + breathing + bob roll. Scaled down (not off)
    // in ADS because it pivots around the reticle and cannot move the dot.
    const rotScale = 1 - 0.68 * adsCurve;
    const swayRX = (-this._lagY * 0.85
      + Math.sin(t * 1.9) * 0.006 * idle
      + Math.sin(ph * 2 + 0.7) * 0.008 * bA) * rotScale;
    const swayRY = (-this._lagX * 0.85
      + Math.sin(t * 1.32 + 1.7) * 0.005 * idle
      + Math.sin(ph) * 0.006 * bA) * rotScale;
    const swayRZ = (-this._lagX * 0.5
      + Math.sin(t * 1.61 + 0.4) * 0.004 * idle
      + Math.sin(ph) * 0.016 * bA) * rotScale;

    // Translational sway: fully faded out by full ADS (exact dot centring).
    const transX = (Math.sin(ph) * 0.008 * bA - this._lagX * 0.012) * hipF;
    const transY = (Math.sin(ph * 2) * 0.0055 * bA + Math.sin(t * 1.9) * 0.0014 * idle
      + this._lagY * 0.008) * hipF;
    const transZ = Math.sin(ph * 2 + 1.2) * 0.002 * bA * hipF;

    // Apply the sway rotation about a pivot that slides onto the reticle as
    // ADS engages: position = P - R*P keeps the pivot point fixed.
    this._swayGroup.rotation.set(swayRX, swayRY, swayRZ);
    this._q1.setFromEuler(this._swayGroup.rotation);
    const pivot = this._v2.copy(this._dotLocal).multiplyScalar(adsCurve);
    const rotated = this._v3.copy(pivot).applyQuaternion(this._q1);
    this._swayGroup.position.set(
      pivot.x - rotated.x + transX,
      pivot.y - rotated.y + transY,
      pivot.z - rotated.z + transZ,
    );

    // ---- reload choreography: magazine + supporting hand ----------------
    let magY = 0, magRX = 0, magVisible = true;
    if (this.reloading) {
      const rt = this._reloadT;
      if (rt < 0.42) {
        const k = smoothstep(0, 0.42, rt);
        magY = -0.1 * k; magRX = 0.25 * k;
      } else if (rt < 0.65) {
        const u = (rt - 0.42) / 0.23;
        magY = -0.1 - 0.4 * u * u; magRX = 0.25 + 0.9 * u;
        magVisible = u < 0.72;
      } else if (rt < 0.78) {
        magY = -0.45; magRX = 1.1; magVisible = false;
      } else {
        const u = smoothstep(0.78, 1.3, rt);
        magY = -0.34 * (1 - u); magRX = -0.55 * (1 - u);
      }
    }
    const mg = this._rifle.magGroup;
    mg.visible = magVisible;
    mg.position.set(
      this._magBasePos.x,
      this._magBasePos.y + magY,
      this._magBasePos.z + magRX * 0.045,
    );
    mg.rotation.x = magRX;

    // Left hand chases the magazine (grab, discard, insert), then returns.
    // Root translation carries the gross motion; the two-bone chain (elbow +
    // wrist pivots) adds the articulation so the arm bends instead of sliding.
    const armMagY = Math.max(magY, -0.26);
    const followY = this.reloading ? armMagY * 0.85 : 0;
    const followZ = this.reloading ? 0.17 * smoothstep(0, 0.05, -magY) : 0;
    this._armFollowY = damp(this._armFollowY, followY, 14, dt);
    this._armFollowZ = damp(this._armFollowZ, followZ, 14, dt);
    this._rifle.leftArm.position.set(0, this._armFollowY, this._armFollowZ);
    this._rifle.leftArm.rotation.x = this._armFollowZ * -1.1;
    const elbowBend = clamp(-this._armFollowY * 5, 0, 1);
    this._rifle.leftForearm.rotation.x = -0.22 * elbowBend;   // elbow flexes down
    this._rifle.leftHand.rotation.x = 0.34 * elbowBend;       // wrist keeps the palm level
    this._rifle.leftHand.rotation.z = 0.3 * elbowBend;        // slight pronation on the grab

    // ---- bolt carrier ---------------------------------------------------
    this._boltPulse = Math.max(0, this._boltPulse - dt / 0.075);
    let boltTarget = 0;
    if (this.reloading) boltTarget = (this._reloadEmptyLock && this._reloadT < RELOAD_BOLT_T) ? 0.034 : 0;
    else if (this.ammo === 0) boltTarget = 0.034;
    this._boltZ = damp(this._boltZ, boltTarget, 40, dt);
    this._rifle.boltGroup.position.z = -0.008 + this._boltZ + Math.sin(this._boltPulse * Math.PI) * 0.03;

    // ---- muzzle flash ---------------------------------------------------
    this._flashT = Math.max(0, this._flashT - dt);
    const flash = this._rifle.flash;
    if (this._flashT > 0) {
      const f = this._flashT / 0.05;
      flash.group.visible = true;
      flash.group.scale.setScalar(this._flashScale * (0.6 + f * 0.5));
      flash.light.intensity = 26 * f * f;
    } else {
      flash.group.visible = false;
      flash.light.intensity = 0;
    }
  }

  _fire(ctx, adsCurve, speed) {
    this.ammo -= 1;
    this._heat = Math.min(6, this._heat + 1);
    const r = Math.random();

    // Eye + aim (player-owned when available, camera fallback).
    const pe = ctx.player?.eyePosition?.();
    if (pe) this._eye.copy(pe);
    else if (this._camera) this._camera.getWorldPosition(this._eye);
    const pa = ctx.player?.aimDirection?.();
    if (pa) this._aim.copy(pa).normalize();
    else if (this._camera) this._camera.getWorldDirection(this._aim);

    // Spread: generous from the hip, laser-tight in ADS, blooms with heat/movement.
    const move = clamp(speed / 7, 0, 1);
    const hipSpread = 0.017 + this._heat * 0.0032 + move * 0.011;
    const adsSpread = 0.0009 + this._heat * 0.0009;
    const spread = hipSpread + (adsSpread - hipSpread) * adsCurve;
    const ang = Math.random() * Math.PI * 2;
    const rad = Math.sqrt(Math.random()) * spread;
    const dir = this._v4.copy(this._aim);
    if (this._camera) {
      const right = this._v2.setFromMatrixColumn(this._camera.matrixWorld, 0);
      const up = this._v3.setFromMatrixColumn(this._camera.matrixWorld, 1);
      dir.addScaledVector(right, Math.cos(ang) * rad).addScaledVector(up, Math.sin(ang) * rad);
    }
    dir.normalize();

    // Hitscan.
    const hit = ctx.world?.raycast?.(this._eye, dir, 400) ?? null;
    ctx.events?.emit?.('weapon:fire', {
      origin: this.muzzleWorldPosition(),
      direction: dir.clone(),
      weapon: this,
    });
    if (hit) {
      if (hit.enemy) {
        const base = hit.headshot ? HEAD_DMG : BODY_DMG;
        const fall = hit.distance <= FALLOFF_START
          ? 1
          : Math.max(0.5, 1 - (hit.distance - FALLOFF_START) * 0.011);
        const dmg = Math.round(base * fall);
        hit.enemy.takeDamage?.(dmg, hit.point, hit.headshot);
        ctx.events?.emit?.('hit:enemy', {
          enemy: hit.enemy, point: hit.point, normal: hit.normal,
          damage: dmg, headshot: hit.headshot,
        });
      } else {
        ctx.events?.emit?.('hit:world', {
          point: hit.point, normal: hit.normal, object: hit.object,
        });
      }
    }

    // Feel: viewmodel kick + camera recoil (softened in ADS).
    const k = 1 - 0.45 * adsCurve;
    this._kickPos.impulse((r - 0.5) * 0.14 * k, (0.12 + r * 0.06) * k, (0.4 + r * 0.14) * k);
    this._kickRot.impulse(
      (0.95 + r * 0.4) * k,
      (r - 0.5) * 0.5 * k,
      (r - 0.5) * 1.1 * k,
    );
    const ck = 1 - 0.18 * adsCurve;
    this._camPitch.impulse((0.155 + Math.random() * 0.06) * ck);
    this._camYaw.impulse((Math.random() - 0.5) * 0.11 * ck);

    // Flash + bolt cycling.
    this._flashT = 0.05;
    this._flashScale = 0.8 + Math.random() * 0.5;
    const flash = this._rifle.flash;
    flash.star.rotation.z = Math.random() * Math.PI * 2;
    flash.petalH.rotation.z = (Math.random() - 0.5) * 0.5;
    this._boltPulse = 1;
  }
}
