// Core plumbing shared by every system: event bus, collision/raycast world, input.
// This file is OWNED by the integrator. Subsystem agents: read it, do not edit it.
import * as THREE from 'three';

/**
 * Canonical event names (payloads are plain objects):
 *  'game:start'          {}                                  — menu dismissed, gameplay begins
 *  'game:over'           { kills, score }                    — player died
 *  'weapon:fire'         { origin:V3, direction:V3, weapon } — player fired one shot
 *  'weapon:reload:start' { weapon }
 *  'weapon:reload:end'   { weapon }
 *  'weapon:ads'          { ads:boolean }
 *  'weapon:empty'        {}                                  — dry-fire click
 *  'hit:world'           { point:V3, normal:V3, object }     — player bullet hit static geometry
 *  'hit:enemy'           { enemy, point:V3, normal:V3, damage, headshot:boolean }
 *  'enemy:fire'          { origin:V3, direction:V3, enemy }  — an enemy fired at the player
 *  'enemy:killed'        { enemy, headshot:boolean }
 *  'player:damage'       { amount, direction:V3|null }       — player took damage
 *  'player:heal'         {}                                  — regen tick started
 *  'player:footstep'     { sprinting:boolean }
 *  'player:land'         { hard:boolean }
 */
export class EventBus {
  constructor() { this._m = new Map(); }
  on(type, fn) {
    if (!this._m.has(type)) this._m.set(type, []);
    this._m.get(type).push(fn);
    return () => this.off(type, fn);
  }
  off(type, fn) {
    const a = this._m.get(type);
    if (a) { const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); }
  }
  emit(type, payload = {}) {
    const a = this._m.get(type);
    if (a) for (const fn of a.slice()) fn(payload);
  }
}

/**
 * Collision + raycast registry.
 *  - colliders: THREE.Box3[] used by the player capsule and enemy locomotion. Static only.
 *  - solids:    THREE.Object3D[] raycast targets for bullets and enemy line-of-sight.
 *  - enemies:   registered by enemies.js — each entry: {
 *      object3d, alive:boolean, position:V3 (feet),
 *      hitMeshes: Mesh[] (userData.enemyRef -> entry, userData.isHead:boolean on head mesh),
 *      takeDamage(amount, point, headshot): void
 *    }
 */
export class World {
  constructor() {
    this.colliders = [];
    this.solids = [];
    this.enemies = [];
    this._ray = new THREE.Raycaster();
  }
  addStatic(object3d, { collide = true } = {}) {
    this.solids.push(object3d);
    if (collide) {
      object3d.updateWorldMatrix(true, true);
      object3d.traverse((o) => {
        if (o.isMesh) {
          const box = new THREE.Box3().setFromObject(o);
          if (!box.isEmpty()) this.colliders.push(box);
        }
      });
    }
  }
  addCollider(box3) { this.colliders.push(box3); }
  /** Closest bullet hit among enemies + world. Returns null or
   *  { point, normal, distance, object, enemy|null, headshot:boolean } */
  raycast(origin, direction, far = 400) {
    this._ray.set(origin, direction);
    this._ray.far = far;
    const targets = [];
    for (const s of this.solids) targets.push(s);
    for (const e of this.enemies) if (e.alive) targets.push(...e.hitMeshes);
    const hits = this._ray.intersectObjects(targets, true);
    for (const h of hits) {
      if (h.object.userData?.noHit) continue;
      const enemy = h.object.userData?.enemyRef ?? null;
      return {
        point: h.point.clone(),
        normal: h.face ? h.face.normal.clone().transformDirection(h.object.matrixWorld) : new THREE.Vector3(0, 1, 0),
        distance: h.distance,
        object: h.object,
        enemy,
        headshot: !!h.object.userData?.isHead,
      };
    }
    return null;
  }
  /** True if a straight segment from a to b is blocked by static geometry. */
  losBlocked(a, b) {
    const dir = b.clone().sub(a);
    const len = dir.length();
    if (len < 1e-4) return false;
    dir.divideScalar(len);
    this._ray.set(a, dir);
    this._ray.far = len;
    return this._ray.intersectObjects(this.solids, true).some((h) => !h.object.userData?.noHit);
  }
}

/** Keyboard + mouse. Pointer-lock is managed by main.js. */
export class Input {
  constructor(domElement) {
    this.keys = new Set();
    this.mouseDX = 0; this.mouseDY = 0;
    this.mouseDown = [false, false, false];
    this.wheel = 0;
    this.locked = false;
    this._justPressed = new Set();
    domElement.ownerDocument.addEventListener('keydown', (e) => {
      if (!this.keys.has(e.code)) this._justPressed.add(e.code);
      this.keys.add(e.code);
      if (['Space', 'Tab'].includes(e.code)) e.preventDefault();
    });
    domElement.ownerDocument.addEventListener('keyup', (e) => this.keys.delete(e.code));
    domElement.ownerDocument.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.mouseDX += e.movementX; this.mouseDY += e.movementY;
    });
    domElement.ownerDocument.addEventListener('mousedown', (e) => { this.mouseDown[e.button] = true; });
    domElement.ownerDocument.addEventListener('mouseup', (e) => { this.mouseDown[e.button] = false; });
    domElement.ownerDocument.addEventListener('wheel', (e) => { this.wheel += Math.sign(e.deltaY); }, { passive: true });
    domElement.ownerDocument.addEventListener('blur', () => this.keys.clear());
  }
  pressed(code) { return this.keys.has(code); }
  justPressed(code) { return this._justPressed.has(code); }
  /** main.js calls this once per frame AFTER all systems updated. */
  endFrame() { this.mouseDX = 0; this.mouseDY = 0; this.wheel = 0; this._justPressed.clear(); }
}
