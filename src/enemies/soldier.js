// Soldier: procedural humanoid enemy — model, limb rig, gait/aim animation, death.
// Built entirely from primitives. Proportions tuned to read "soldier" at 10-60m:
// shoulders ~0.46m across, hips ~0.36m, slim limbs (no balloon capsules);
// standing height is measured at build time and normalized to 1.83-1.92m
// (helmet top) so figures hold scale against the level's 2.55m door frames.
// Palette (art dir): multi-material combatant read — #4a4a3c olive fatigues,
// #2a2a28 dark vest/pack/belt block, #565748 muted grey-olive mag/admin/hip
// pouches (NO bright tan — gear stays olive/grey so nothing reads as a bright
// chest patch), and skin ONLY on the hands + neck/jaw. Helmet dome + chest-rig
// boxes break the silhouette; a distance-scaled fresnel rim (injected into every soldier
// material via onBeforeCompile) keeps silhouettes separated from facades at
// 40-60m without looking radioactive up close.
// Both hands are pinned to the rifle by a 2-bone analytic arm IK, so the pose
// is always "weapon up, hands on the gun" — a straight-armed toy-soldier idle
// cannot occur in any blend state.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { rng, makeCanvas, canvasTexture } from '../utils.js';

const TAU = Math.PI * 2;
const HIP_Y = 0.98;          // pelvis pivot height (feet at y=0)
const BASE_HEIGHT = 1.83;    // standing helmet top, metres — enforced in ctor
const CORPSE_SECONDS = 15;   // corpse persists, then fades
const FADE_SECONDS = 1.3;
const Y_AXIS = new THREE.Vector3(0, 1, 0);

/* --- arm IK constants (spine-space) --- */
const ARM_L1 = 0.28;         // shoulder pivot -> elbow pivot
const ARM_L2 = 0.26;         // elbow pivot -> palm center
const SHOULDER_X = 0.185;    // shoulder pivot offset from spine center
const SHOULDER_Y = 0.42;
const GRIP_R = new THREE.Vector3(0, -0.10, -0.05); // rifle-local: pistol grip
const GRIP_L = new THREE.Vector3(0, -0.03, 0.22);  // rifle-local: handguard
const POLE_R = new THREE.Vector3(0.65, -1.0, -0.45).normalize(); // elbow out-right/down
const POLE_L = new THREE.Vector3(-0.55, -0.95, -0.35).normalize(); // elbow out-left/down

const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _q3 = new THREE.Quaternion();
const _t1 = new THREE.Vector3();
const _t2 = new THREE.Vector3();
const _d = new THREE.Vector3();
const _dn = new THREE.Vector3();
const _h = new THREE.Vector3();
const _e = new THREE.Vector3();
const _p = new THREE.Vector3();
const _c = new THREE.Vector3();

function lerp(a, b, t) { return a + (b - a) * t; }
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function approach(cur, target, rate, dt) { return cur + (target - cur) * Math.min(1, rate * dt); }
function kneeBend(x) { return Math.max(0, Math.sin(x + 2.4)); }

function box(w, h, d, x = 0, y = 0, z = 0) {
  return new THREE.BoxGeometry(w, h, d).translate(x, y, z);
}
function capsule(r, len, x = 0, y = 0, z = 0) {
  return new THREE.CapsuleGeometry(r, len, 4, 8).translate(x, y, z);
}

/**
 * 2-bone analytic arm IK, solved in spine space (the shoulder groups' parent).
 * Places the palm exactly at `target`, bending the elbow via law of cosines and
 * twisting the arm plane toward `pole` so elbows hang naturally. Zero alloc.
 */
function solveArm(shoulder, elbow, sx, target, pole) {
  _d.set(target.x - sx, target.y - SHOULDER_Y, target.z);
  let d = _d.length();
  if (d < 1e-5) { _d.set(0, -1, 0); d = 1; }
  const reach = clamp(d, Math.abs(ARM_L1 - ARM_L2) + 0.02, (ARM_L1 + ARM_L2) * 0.999);
  _dn.copy(_d).divideScalar(d);
  // interior elbow angle -> hinge bend (forearm folds toward its local +Z)
  const cosE = clamp((ARM_L1 * ARM_L1 + ARM_L2 * ARM_L2 - reach * reach) / (2 * ARM_L1 * ARM_L2), -1, 1);
  const bend = Math.PI - Math.acos(cosE);
  elbow.rotation.set(-bend, 0, 0);
  // direction from shoulder to palm in upper-arm local space, given that bend
  _h.set(0, -(ARM_L1 + ARM_L2 * Math.cos(bend)), ARM_L2 * Math.sin(bend)).normalize();
  _q1.setFromUnitVectors(_h, _dn);
  // twist about the shoulder->target axis so the elbow points at the pole
  _e.set(0, -1, 0).applyQuaternion(_q1);
  _e.addScaledVector(_dn, -_e.dot(_dn));
  _p.copy(pole).addScaledVector(_dn, -pole.dot(_dn));
  if (_e.lengthSq() > 1e-8 && _p.lengthSq() > 1e-8) {
    _e.normalize();
    _p.normalize();
    _c.crossVectors(_e, _p);
    _q2.setFromAxisAngle(_dn, Math.atan2(_c.dot(_dn), clamp(_e.dot(_p), -1, 1)));
    shoulder.quaternion.copy(_q2).multiply(_q1);
  } else {
    shoulder.quaternion.copy(_q1);
  }
}

/* ------------------------------------------------------------------ */
/* Silhouette rim (art dir: distant enemies vanish into facades)       */
/* ------------------------------------------------------------------ */
// Fresnel rim injected into every soldier material. View-dependent, so it
// always brightens the silhouette EDGE against whatever is behind it, and it
// ramps with camera distance (smoothstep 10m->45m) so close-ups stay natural
// while a 50m threat holds >=15% value separation from the facade behind it.
// Constant-folded GLSL: zero uniforms, zero per-frame JS, one shared program
// (customProgramCacheKey) per material feature set.
const RIM_CHUNK = /* glsl */`
  #include <emissivemap_fragment>
  {
    vec3 rimV = normalize( vViewPosition );
    float rimF = pow( 1.0 - saturate( dot( normalize( normal ), rimV ) ), 2.5 );
    float rimD = smoothstep( 10.0, 45.0, length( vViewPosition ) );
    totalEmissiveRadiance += vec3( 0.52, 0.63, 0.80 ) * rimF * ( 0.08 + 0.50 * rimD );
  }
`;
function soldierRimCompile(shader) {
  shader.fragmentShader = shader.fragmentShader.replace('#include <emissivemap_fragment>', RIM_CHUNK);
}
function applyRim(mat) {
  mat.onBeforeCompile = soldierRimCompile;
  mat.customProgramCacheKey = () => 'soldier-rim';
  return mat;
}

/* ------------------------------------------------------------------ */
/* Shared assets: textures + geometries built once, reused by all units */
/* ------------------------------------------------------------------ */
export function createSoldierAssets() {
  // --- uniform fabric texture (#4a4a3c drab base — art dir: two-tone drab, no
  // green cast; mottle stays within ~±12% value so it reads as cloth pattern,
  // never lime and never black) ---
  const camoC = makeCanvas(128);
  {
    const r = rng(90210);
    const c = camoC.ctx;
    c.fillStyle = '#4a4a3c';
    c.fillRect(0, 0, 128, 128);
    const cols = ['#414136', '#525244', '#3b3b31', '#4f4f41', '#454539', '#555547'];
    for (let i = 0; i < 210; i++) {
      c.fillStyle = cols[(i * 7) % cols.length];
      c.save();
      c.translate(r() * 128, r() * 128);
      c.rotate(r() * TAU);
      c.beginPath();
      c.ellipse(0, 0, 3 + r() * 11, 2 + r() * 5, 0, 0, TAU);
      c.fill();
      c.restore();
    }
    for (let i = 0; i < 500; i++) { // weave speckle — near-neutral, no hue push
      const g = 58 + Math.floor(r() * 36);
      c.fillStyle = `rgba(${g},${g},${g - 8},0.13)`;
      c.fillRect(r() * 128, r() * 128, 1.6, 1.6);
    }
  }
  const camoTex = canvasTexture(camoC.canvas);

  // --- vest/webbing texture (#2a2a28 — art dir: the dark band of the read:
  // vest/pack/belt/boots sit visibly darker than the olive uniform) ---
  const gearC = makeCanvas(64);
  {
    const r = rng(3117);
    const c = gearC.ctx;
    c.fillStyle = '#2a2a28';
    c.fillRect(0, 0, 64, 64);
    for (let i = 0; i < 600; i++) {
      const g = 33 + Math.floor(r() * 24);
      c.fillStyle = `rgba(${g},${g},${g - 5},0.22)`;
      c.fillRect(r() * 64, r() * 64, 1.4, 1.4);
    }
    c.strokeStyle = 'rgba(24,24,19,0.55)'; // strap seams
    for (let i = 0; i < 5; i++) { c.beginPath(); c.moveTo(0, 8 + i * 13); c.lineTo(64, 8 + i * 13); c.stroke(); }
    for (let i = 0; i < 2; i++) { c.beginPath(); c.moveTo(14 + i * 34, 0); c.lineTo(14 + i * 34, 64); c.stroke(); }
  }
  const gearTex = canvasTexture(gearC.canvas);

  // --- pouch texture (#565748 muted grey-olive — art dir: kit accents stay a
  // separate tone from vest + fatigues so the rig still reads "combatant with
  // kit", but MUTED: the old #8a7355 tan flared into a bright chest patch in
  // full sun) ---
  const pouchC = makeCanvas(64);
  {
    const r = rng(5150);
    const c = pouchC.ctx;
    c.fillStyle = '#565748';
    c.fillRect(0, 0, 64, 64);
    for (let i = 0; i < 480; i++) { // cordura weave speckle
      const g = 72 + Math.floor(r() * 34);
      c.fillStyle = `rgba(${g},${g},${g - 14},0.20)`;
      c.fillRect(r() * 64, r() * 64, 1.5, 1.5);
    }
    c.strokeStyle = 'rgba(58,58,48,0.65)'; // flap stitching
    for (let i = 0; i < 3; i++) { c.beginPath(); c.moveTo(0, 12 + i * 20); c.lineTo(64, 12 + i * 20); c.stroke(); }
  }
  const pouchTex = canvasTexture(pouchC.canvas);

  // --- muzzle flash texture: white-hot core + tapered orange rays, drawn
  // additively. Replaces the old untextured quad (which read as a flat gold
  // sticker) with an actual combustion gradient the bloom pass can bite into.
  const flashC = makeCanvas(128);
  {
    const r = rng(4242);
    const c = flashC.ctx;
    c.clearRect(0, 0, 128, 128);
    c.globalCompositeOperation = 'lighter';
    c.lineCap = 'round';
    for (let i = 0; i < 7; i++) { // irregular rays
      const a = (i / 7) * TAU + r() * 0.6;
      const len = 32 + r() * 26;
      const ex = 64 + Math.cos(a) * len, ey = 64 + Math.sin(a) * len;
      const g = c.createLinearGradient(64, 64, ex, ey);
      g.addColorStop(0, 'rgba(255,216,150,0.9)');
      g.addColorStop(1, 'rgba(255,130,30,0)');
      c.strokeStyle = g;
      c.lineWidth = 4 + r() * 5;
      c.beginPath(); c.moveTo(64, 64); c.lineTo(ex, ey); c.stroke();
    }
    const core = c.createRadialGradient(64, 64, 0, 64, 64, 30);
    core.addColorStop(0, 'rgba(255,255,244,1)');
    core.addColorStop(0.35, 'rgba(255,202,110,0.85)');
    core.addColorStop(1, 'rgba(255,120,30,0)');
    c.fillStyle = core;
    c.beginPath(); c.arc(64, 64, 30, 0, TAU); c.fill();
  }
  const flashTex = canvasTexture(flashC.canvas);
  flashTex.wrapS = flashTex.wrapT = THREE.ClampToEdgeWrapping;

  // --- geometry. Widths corrected per art dir: shoulders ~0.46m outer,
  // hips ~0.36m outer, limbs slimmed off the old balloon capsules.
  const geo = {};
  geo.pelvis = box(0.27, 0.14, 0.19, 0, -0.02, 0);
  geo.thigh = capsule(0.068, 0.28, 0, -0.22, 0);
  geo.shin = capsule(0.055, 0.24, 0, -0.19, 0);
  geo.boot = box(0.10, 0.12, 0.24, 0, -0.02, 0.04); // parented to an ankle group
  geo.torso = box(0.33, 0.46, 0.20, 0, 0.21, 0);
  // Chest rig split into TWO materials (art dir): the dark #2a2a28 vest mass
  // and the muted #565748 grey-olive pouch accents. Still just two draws per
  // soldier; the blocky mag/admin/hip pouches keep breaking the silhouette at 20-60m.
  geo.vest = mergeGeometries([
    box(0.36, 0.30, 0.26, 0, 0.23, 0),             // vest block (dark #2a2a28)
    box(0.055, 0.11, 0.06, -0.145, 0.33, 0.11),    // radio pouch on L strap
    box(0.27, 0.28, 0.12, 0, 0.24, -0.16),         // pack
    box(0.09, 0.045, 0.14, -0.175, 0.445, 0),      // shoulder pad L (outer 0.44m)
    box(0.09, 0.045, 0.14, 0.175, 0.445, 0),       // shoulder pad R
    box(0.30, 0.075, 0.22, 0, -0.06, 0),           // battle belt
    new THREE.CylinderGeometry(0.042, 0.042, 0.13, 8).translate(0.10, -0.10, -0.15), // canteen
  ]);
  geo.pouches = mergeGeometries([                  // grey-olive #565748 kit accents
    box(0.088, 0.12, 0.09, -0.098, 0.10, 0.165),   // chest mag pouch L
    box(0.088, 0.12, 0.09, 0, 0.10, 0.165),        // chest mag pouch C
    box(0.088, 0.12, 0.09, 0.098, 0.10, 0.165),    // chest mag pouch R
    box(0.15, 0.06, 0.05, 0, 0.30, 0.15),          // admin pouch
    box(0.065, 0.13, 0.11, -0.145, -0.095, 0.02),  // hip pouch L (hips outer ~0.36m)
    box(0.065, 0.13, 0.11, 0.145, -0.095, 0.02),   // hip pouch R
  ]);
  geo.upperArm = capsule(0.048, 0.17, 0, -0.13, 0);
  geo.forearm = capsule(0.042, 0.15, 0, -0.12, 0);   // sleeve — olive cloth
  geo.hand = box(0.065, 0.08, 0.085, 0, -0.25, 0.015); // bare hand — skin
  geo.neckJaw = mergeGeometries([               // skin: neck + jaw/lower face
    new THREE.CylinderGeometry(0.048, 0.055, 0.10, 8).translate(0, -0.03, 0),
    box(0.155, 0.10, 0.175, 0, 0.055, 0.008),
  ]);
  geo.skull = box(0.17, 0.12, 0.19, 0, 0.165, 0.005); // dark crown under helmet
  geo.helmet = mergeGeometries([                // ballistic dome + brim + NVG mount + ear rails
    new THREE.SphereGeometry(0.132, 12, 9, 0, TAU, 0, 1.95).scale(1.05, 0.85, 1.1).translate(0, 0.20, 0),
    box(0.20, 0.032, 0.06, 0, 0.16, 0.10),
    box(0.05, 0.055, 0.045, 0, 0.23, 0.12),     // NVG shroud (front bump)
    box(0.03, 0.055, 0.13, -0.11, 0.16, 0),     // rail L
    box(0.03, 0.055, 0.13, 0.11, 0.16, 0),      // rail R
  ]);
  geo.visor = box(0.15, 0.05, 0.04, 0, 0.13, 0.105);
  // rifle: receiver/handguard/barrel/sight/stock/grip/mag merged, +Z = muzzle
  geo.rifle = mergeGeometries([
    box(0.050, 0.075, 0.30),
    box(0.044, 0.056, 0.24, 0, 0.004, 0.26),
    new THREE.CylinderGeometry(0.013, 0.013, 0.24, 6).rotateX(Math.PI / 2).translate(0, 0.008, 0.48),
    box(0.032, 0.032, 0.07, 0, 0.008, 0.565),
    box(0.028, 0.050, 0.11, 0, 0.078, 0.02),
    box(0.045, 0.075, 0.19, 0, -0.005, -0.24),
    new THREE.BoxGeometry(0.034, 0.11, 0.05).rotateX(0.4).translate(0, -0.085, -0.06),
    new THREE.BoxGeometry(0.033, 0.15, 0.075).rotateX(0.3).translate(0, -0.10, 0.07),
  ]);
  // muzzle flash: 2 crossed quads down the bore + front card, all mapped with
  // the hot-core texture. Tighter than the old 0.64m boards — the size read
  // now comes from the 60ms point light + bloom, not sticker acreage.
  const f1 = new THREE.PlaneGeometry(0.46, 0.30).rotateY(Math.PI / 2).translate(0, 0, 0.15);
  const f2 = new THREE.PlaneGeometry(0.46, 0.30).rotateX(Math.PI / 2).translate(0, 0, 0.15);
  const f3 = new THREE.PlaneGeometry(0.30, 0.30).translate(0, 0, 0.06);
  geo.flash = mergeGeometries([f1, f2, f3]);

  const flashMat = new THREE.MeshBasicMaterial({
    map: flashTex, transparent: true, opacity: 1,
    blending: THREE.AdditiveBlending, depthWrite: false,
    side: THREE.DoubleSide, toneMapped: false,
  });
  // #ffc66e pushed past 1.0 (linear) so the untonemapped core crosses the
  // bloom threshold and actually GLOWS instead of reading as a badge sticker.
  flashMat.color.setRGB(2.3, 1.75, 0.95);

  return { geo, camoTex, gearTex, pouchTex, flashMat };
}

/* ------------------------------------------------------------------ */
/* Soldier instance                                                    */
/* ------------------------------------------------------------------ */
export class Soldier {
  constructor(assets, seed) {
    this.rand = rng(seed);
    const r = this.rand;
    this.seedPhase = r() * TAU;

    // --- per-unit materials (cloned palette; enables fade + hit flash).
    // Tints are NEUTRAL scalars only — the old green-biased channel multiply is
    // what pushed uniforms lime under the scene light. The textures already
    // carry the target albedo (#4a4a3c fatigues / #2a2a28 vest / #565748
    // grey-olive pouches); skin appears ONLY on hands + neck/jaw. Every material
    // gets the distance-scaled fresnel rim so silhouettes hold against facades at 50m.
    const cloth = new THREE.MeshStandardMaterial({ map: assets.camoTex, roughness: 0.94, metalness: 0.0 });
    cloth.color.setScalar(0.93 + r() * 0.14);
    const vestM = new THREE.MeshStandardMaterial({ map: assets.gearTex, roughness: 0.9, metalness: 0.04 });
    vestM.color.setScalar(0.92 + r() * 0.16);
    const pouch = new THREE.MeshStandardMaterial({ map: assets.pouchTex, roughness: 0.92, metalness: 0.0 });
    pouch.color.setScalar(0.92 + r() * 0.14);
    const skin = new THREE.MeshStandardMaterial({ roughness: 0.72, metalness: 0.0 });
    // deeper skin range — sunlit hands sat right at the chest and used to read
    // as a bright patch on the rig
    skin.color.setHSL(0.065 + r() * 0.02, 0.36, 0.29 + r() * 0.12);
    const metal = new THREE.MeshStandardMaterial({ color: 0x23262a, roughness: 0.5, metalness: 0.55 });
    const visor = new THREE.MeshStandardMaterial({ color: 0x11181c, roughness: 0.25, metalness: 0.3 });
    this.matCloth = cloth; this.matVest = vestM; this.matPouch = pouch;
    this.materials = [cloth, vestM, pouch, skin, metal, visor];
    for (const m of this.materials) applyRim(m);

    const g = assets.geo;
    const mk = (geoObj, mat, parent, isHead = false) => {
      const m = new THREE.Mesh(geoObj, mat);
      m.castShadow = true;
      m.receiveShadow = true;
      if (isHead) m.userData.isHead = true;
      parent.add(m);
      return m;
    };

    // --- hierarchy (root at feet, faces +Z; final scale set after height check)
    this.root = new THREE.Group();

    this.pelvis = new THREE.Group();
    this.pelvis.position.y = HIP_Y;
    this.root.add(this.pelvis);
    const pelvisMesh = mk(g.pelvis, cloth, this.pelvis);

    this.thighL = new THREE.Group(); this.thighL.position.set(-0.085, -0.04, 0);
    this.thighR = new THREE.Group(); this.thighR.position.set(0.085, -0.04, 0);
    this.pelvis.add(this.thighL, this.thighR);
    const thighLM = mk(g.thigh, cloth, this.thighL);
    const thighRM = mk(g.thigh, cloth, this.thighR);
    this.shinL = new THREE.Group(); this.shinL.position.y = -0.44;
    this.shinR = new THREE.Group(); this.shinR.position.y = -0.44;
    this.thighL.add(this.shinL); this.thighR.add(this.shinR);
    const shinLM = mk(g.shin, cloth, this.shinL);
    const shinRM = mk(g.shin, cloth, this.shinR);
    // ankle joints so the gait gets a heel-toe roll (feet were welded before)
    this.footL = new THREE.Group(); this.footL.position.y = -0.415;
    this.footR = new THREE.Group(); this.footR.position.y = -0.415;
    this.shinL.add(this.footL); this.shinR.add(this.footR);
    mk(g.boot, vestM, this.footL);
    mk(g.boot, vestM, this.footR);

    this.spine = new THREE.Group();
    this.spine.position.y = 0.06;
    this.pelvis.add(this.spine);
    const torsoMesh = mk(g.torso, cloth, this.spine);
    const vestMesh = mk(g.vest, vestM, this.spine);
    const pouchMesh = mk(g.pouches, pouch, this.spine);

    this.shoulderL = new THREE.Group(); this.shoulderL.position.set(-SHOULDER_X, SHOULDER_Y, 0);
    this.shoulderR = new THREE.Group(); this.shoulderR.position.set(SHOULDER_X, SHOULDER_Y, 0);
    this.spine.add(this.shoulderL, this.shoulderR);
    const upArmLM = mk(g.upperArm, cloth, this.shoulderL);
    const upArmRM = mk(g.upperArm, cloth, this.shoulderR);
    this.elbowL = new THREE.Group(); this.elbowL.position.y = -ARM_L1;
    this.elbowR = new THREE.Group(); this.elbowR.position.y = -ARM_L1;
    this.shoulderL.add(this.elbowL); this.shoulderR.add(this.elbowR);
    mk(g.forearm, cloth, this.elbowL);   // olive sleeve
    mk(g.forearm, cloth, this.elbowR);
    mk(g.hand, skin, this.elbowL);       // bare hands on the weapon (art dir)
    mk(g.hand, skin, this.elbowR);

    this.headGrp = new THREE.Group();
    this.headGrp.position.set(0, 0.50, 0.01);
    this.spine.add(this.headGrp);
    const headMesh = mk(g.neckJaw, skin, this.headGrp, true); // skin neck/jaw
    const skullMesh = mk(g.skull, vestM, this.headGrp, true); // dark crown
    // drab cover on the helmet: #4a4a3c dome over the #2a2a28 vest = 4-tone
    // band (helmet / skin jaw / tan pouches / vest) separating head from torso
    const helmetMesh = mk(g.helmet, cloth, this.headGrp, true);
    const visorMesh = mk(g.visor, visor, this.headGrp, true);

    this.rifleRoot = new THREE.Group();
    this.rifleRoot.position.set(0.10, 0.26, 0.12);
    this.spine.add(this.rifleRoot);
    const rifleMesh = mk(g.rifle, metal, this.rifleRoot);
    this.muzzle = new THREE.Object3D();
    this.muzzle.position.set(0, 0.008, 0.62);
    this.rifleRoot.add(this.muzzle);
    this.flash = new THREE.Mesh(g.flash, assets.flashMat);
    this.flash.position.copy(this.muzzle.position);
    this.flash.visible = false;
    this.flash.castShadow = false;
    this.flash.receiveShadow = false;
    this.flash.userData.noHit = true;
    this.rifleRoot.add(this.flash);

    // meshes weapons.js raycasts against (head/skull/helmet/visor flagged isHead)
    this.hitMeshes = [
      torsoMesh, vestMesh, pouchMesh, pelvisMesh, headMesh, skullMesh, helmetMesh, visorMesh,
      thighLM, thighRM, shinLM, shinRM, upArmLM, upArmRM,
    ];
    this.headMesh = headMesh;

    // joints driven by pose / sprawled on death
    // (indices 4/5 must stay the shins — startDeath() special-cases them)
    this._poseJoints = [
      this.spine, this.headGrp, this.thighL, this.thighR, this.shinL, this.shinR,
      this.shoulderL, this.shoulderR, this.elbowL, this.elbowR, this.rifleRoot,
      this.footL, this.footR,
    ];
    this._sprawl = this._poseJoints.map(() => [0, 0, 0]);

    // --- scale enforcement (art dir: figures read under-height vs the 2.55m
    // door frames). Measure the assembled default pose ONCE, derive the factor
    // that puts the helmet top at exactly BASE_HEIGHT, then vary units only
    // UPWARD so nobody dips below 1.8m.
    if (!assets.heightScale) {
      this.root.updateWorldMatrix(true, true);
      const bb = new THREE.Box3().setFromObject(this.root);
      const measured = bb.max.y; // feet are at y=0
      assets.heightScale = measured > 0.1 ? BASE_HEIGHT / measured : 1;
    }
    this.root.scale.setScalar(assets.heightScale * (1.0 + r() * 0.05)); // 1.83-1.92m

    // animation state
    this.phase = r() * TAU;
    this.timeAcc = r() * 10;
    this.aimT = 0; this.combatT = 0; this.crouchT = 0;
    this.fireT = 0; this.leanOut = 0;
    this.lookYaw = 0; this.lookPitch = 0;
    this.leanF = 0; this.leanS = 0;
    this.flinchT = 0; this.flinchYaw = 0; this.flinchRoll = 0;
    this.kick = 0; this.flashT = 0; this._flashFlip = true;

    // death state
    this.dead = false; this.deathT = 0; this.fadeStarted = false;
    this._fallAxis = new THREE.Vector3(1, 0, 0);
    this._fallMax = Math.PI / 2;
    this._spin = 0; this._baseYaw = 0;
    this._qa = new THREE.Quaternion();
    this._qb = new THREE.Quaternion();
  }

  /* full state reset for (re)spawn */
  reset(pos, yaw) {
    this.root.visible = true;
    this.root.position.copy(pos);
    this.root.rotation.set(0, yaw, 0); // also re-syncs quaternion after death tumble
    this.pelvis.position.set(0, HIP_Y, 0);
    this.pelvis.rotation.set(0, 0, 0);
    for (const j of this._poseJoints) j.rotation.set(0, 0, 0);
    this.rifleRoot.position.set(0.10, 0.26, 0.12);
    this.dead = false; this.deathT = 0; this.fadeStarted = false;
    this.aimT = 0; this.combatT = 0; this.crouchT = 0;
    this.fireT = 0; this.leanOut = 0;
    this.lookYaw = 0; this.lookPitch = 0;
    this.leanF = 0; this.leanS = 0;
    this.flinchT = 0; this.kick = 0; this.flashT = 0; this._flashFlip = true;
    this.flash.visible = false;
    this.phase = this.rand() * TAU;
    for (const m of this.materials) {
      m.opacity = 1; m.transparent = false;
    }
    this.matCloth.emissive.setRGB(0, 0, 0);
    this.matVest.emissive.setRGB(0, 0, 0);
    this.matPouch.emissive.setRGB(0, 0, 0);
  }

  flinch() {
    this.flinchT = 1;
    this.flinchYaw = (this.rand() - 0.5) * 0.55;
    this.flinchRoll = (this.rand() - 0.5) * 2;
  }

  fireFlash() {
    this.flash.visible = true;
    this.flashT = 0.06;      // 60ms — same window as the muzzle point light
    this._flashFlip = false; // second random frame pending (see update)
    this.flash.rotation.z = this.rand() * TAU;
    this.flash.scale.setScalar(0.95 + this.rand() * 0.5);
    this.kick = 1;
  }

  getMuzzleWorld(target) { return this.muzzle.getWorldPosition(target); }

  /* living pose update.
   * p: {speed, combat, aim, crouch, firing, leanOut, lookYaw, lookPitch,
   *     aimPitch, leanF, leanS}
   * leanF/leanS: local forward/lateral movement components (-1..1) so the body
   * leans into its step direction. leanOut (-1..1): peek-around-cover side
   * lean while holding in COMBAT. firing: burst active -> micro-crouch. */
  update(dt, p) {
    this.timeAcc += dt;
    this.aimT = approach(this.aimT, p.aim ? 1 : 0, 6, dt);
    this.combatT = approach(this.combatT, p.combat ? 1 : 0, 4, dt);
    this.crouchT = approach(this.crouchT, p.crouch ? 1 : 0, 5, dt);
    this.fireT = approach(this.fireT, p.firing ? 1 : 0, 9, dt);
    this.leanOut = approach(this.leanOut, p.leanOut || 0, 4, dt);
    this.lookYaw = approach(this.lookYaw, p.lookYaw, 8, dt);
    this.lookPitch = approach(this.lookPitch, p.lookPitch, 8, dt);
    this.leanF = approach(this.leanF, p.leanF || 0, 6, dt);
    this.leanS = approach(this.leanS, p.leanS || 0, 6, dt);

    const speed = p.speed;
    const speedT = clamp(speed / 2.2, 0, 1.4);
    if (speed > 0.05) this.phase += dt * TAU * speed / (1.35 + 0.24 * speed);
    const ph = this.phase;
    const gw = clamp(speed / 0.8, 0, 1);            // gait weight
    // Art dir: strides must READ at 40-60m — swing amplitude up ~40% from the
    // old timid cycle (walk ~37° thigh arc, combat run capped near 49°).
    const sw = Math.min(0.85, 0.42 + speed * 0.13) * gw;
    const cr = this.crouchT;
    const fi = this.fireT * (1 - cr) * (1 - gw * 0.6); // firing micro-crouch (skip if already crouched/running)
    const st = (1 - gw) * (1 - cr);                    // standing -> combat-ready stance weight
    const lean = this.leanOut * this.combatT;          // peek-out-of-cover lean
    const br = Math.sin(this.timeAcc * Math.PI + this.seedPhase); // 0.5Hz breath

    this.flinchT = Math.max(0, this.flinchT - dt * 4.2);
    const fl = this.flinchT;
    const em = fl * 0.55;
    this.matCloth.emissive.setRGB(em, em * 0.12, em * 0.06);
    this.matVest.emissive.setRGB(em, em * 0.12, em * 0.06);
    this.matPouch.emissive.setRGB(em, em * 0.12, em * 0.06);

    // pelvis: step bob + lateral weight shift per stride; slow breathing sway +
    // weight-shift roll when standing so an idle soldier is never a statue;
    // hips drop into the firing micro-crouch and shift under a cover lean
    this.pelvis.position.x = Math.sin(ph) * 0.02 * speedT + br * 0.008 * (1 - speedT) + lean * 0.05;
    this.pelvis.position.y = HIP_Y - 0.26 * cr - 0.085 * fi - 0.03 * st + Math.sin(ph * 2) * 0.04 * speedT;
    this.pelvis.rotation.set(
      this.leanF * 0.10,                                    // lean into the run
      Math.sin(ph) * 0.10 * speedT - 0.10 * st,             // hip yaw sway; bladed stance when standing
      Math.sin(ph) * 0.075 * speedT - this.leanS * 0.12
        + Math.sin(this.timeAcc * 0.42 + this.seedPhase) * 0.022 * st, // idle weight shift
    );

    // legs (negative x-rotation swings the foot forward, +Z facing).
    // Standing (st): staggered combat stance — left foot forward, knees never
    // locked — so a paused soldier holds a ready posture instead of standing
    // at attention. Firing (fi): both knees give a touch more.
    this.thighL.rotation.x = Math.sin(ph) * sw - 0.90 * cr - 0.04 - 0.16 * st - 0.30 * fi;
    this.thighR.rotation.x = Math.sin(ph + Math.PI) * sw - 0.55 * cr - 0.04 + 0.06 * st - 0.30 * fi;
    this.shinL.rotation.x = kneeBend(ph) * sw * 1.5 + 1.05 * cr + 0.20 * st + 0.42 * fi;
    this.shinR.rotation.x = kneeBend(ph + Math.PI) * sw * 1.5 + 0.75 * cr + 0.12 * st + 0.42 * fi;
    // feet: plantar-flex on the trailing (push-off) leg, slight toe-up on the
    // swing leg — the heel-toe roll that sells the step cycle. Stance/fire
    // terms re-flatten the soles under the bent knees.
    const s1 = Math.sin(ph);
    this.footL.rotation.x = (Math.max(0, s1) * 0.5 - Math.max(0, -s1) * 0.15) * gw - 0.13 * cr - 0.04 * st - 0.12 * fi;
    this.footR.rotation.x = (Math.max(0, -s1) * 0.5 - Math.max(0, s1) * 0.15) * gw - 0.13 * cr - 0.18 * st - 0.12 * fi;

    // spine: 0.5Hz breathing, counter-rotation, lean, twist toward the look
    // target (track uses aimT too, so patrol scan-sweeps move the whole torso).
    // Idle scan sweeps torso+head across a sector; combat adds a forward
    // aggression hunch plus the sideways peek lean.
    const track = Math.max(this.combatT, this.aimT);
    const scan = Math.sin(this.timeAcc * 0.55 + this.seedPhase);
    const breathe = br * 0.03 * (1 - speedT * 0.6);
    this.spine.rotation.x = 0.06 + 0.24 * cr + breathe + this.leanF * 0.07
      + 0.05 * this.combatT + 0.09 * fi - fl * 0.5;
    this.spine.rotation.y = -Math.sin(ph) * 0.12 * speedT + this.lookYaw * 0.45 * track
      + scan * 0.16 * (1 - track) + this.flinchYaw * fl;
    this.spine.rotation.z = fl * this.flinchRoll * 0.28 - this.leanS * 0.05 - lean * 0.22;

    // head: tracks the aim target, wide slow scan otherwise, breathes with the
    // chest; counter-tilts against a cover lean so the eyes stay level
    this.headGrp.rotation.y = this.lookYaw * 0.55 * track
      + scan * 0.32 * (1 - track);
    this.headGrp.rotation.x = -this.lookPitch * 0.55 * track + br * 0.012;
    this.headGrp.rotation.z = lean * 0.10;

    // rifle: blend high-ready carry (weapon up at the chest, muzzle ~17° down)
    // <-> shouldered aim. Breathing and gait sway are applied to the GUN, and
    // the 2-bone IK below pins both hands to it — so the sway reads through the
    // whole upper body and no state ever shows a straight-armed idle.
    const a = this.aimT;
    const ap = clamp(p.aimPitch || 0, -0.75, 0.75);
    this.kick = Math.max(0, this.kick - dt * 9);
    this.rifleRoot.position.set(
      lerp(0.095, 0.085, a),
      lerp(0.30, 0.385, a) + br * 0.014 + Math.sin(ph * 2) * 0.018 * speedT,
      lerp(0.13, 0.15, a) - this.kick * 0.04,
    );
    this.rifleRoot.rotation.set(
      lerp(0.30, -ap, a) - this.kick * 0.06 + br * 0.014,
      lerp(-0.10, 0, a) + Math.sin(ph) * 0.05 * speedT,
      0,
    );
    // both hands onto the rifle: right on the pistol grip, left on the handguard
    _q3.setFromEuler(this.rifleRoot.rotation);
    _t1.copy(GRIP_R).applyQuaternion(_q3).add(this.rifleRoot.position);
    _t2.copy(GRIP_L).applyQuaternion(_q3).add(this.rifleRoot.position);
    solveArm(this.shoulderR, this.elbowR, SHOULDER_X, _t1, POLE_R);
    solveArm(this.shoulderL, this.elbowL, -SHOULDER_X, _t2, POLE_L);

    if (this.flashT > 0) {
      this.flashT -= dt;
      if (!this._flashFlip && this.flashT < 0.03) {
        // frame 2 of 2: fresh random roll + size so no two frames of a burst
        // read as the same pasted sprite
        this._flashFlip = true;
        this.flash.rotation.z = this.rand() * TAU;
        this.flash.scale.setScalar(0.7 + this.rand() * 0.45);
      }
      if (this.flashT <= 0) this.flash.visible = false;
    }
  }

  /* dir: world horizontal direction the body should fall toward (away from shooter) */
  startDeath(dir) {
    this.dead = true;
    this.deathT = 0;
    this.fadeStarted = false;
    this.flash.visible = false;
    this._baseYaw = this.root.rotation.y;
    const r = this.rand;
    let dx = dir ? dir.x : 0, dz = dir ? dir.z : 0;
    const l = Math.hypot(dx, dz);
    if (l < 1e-3) { const a = r() * TAU; dx = Math.sin(a); dz = Math.cos(a); }
    else { dx /= l; dz /= l; }
    // jitter the fall direction so deaths don't look identical
    const j = (r() - 0.5) * 0.9, ca = Math.cos(j), sa = Math.sin(j);
    const fx = dx * ca + dz * sa, fz = dz * ca - dx * sa;
    this._fallAxis.set(fz, 0, -fx).normalize(); // up x fallDir
    this._fallMax = (Math.PI / 2) * (0.94 + r() * 0.16);
    this._spin = (r() - 0.5) * 1.4;
    // sprawl targets
    for (let i = 0; i < this._sprawl.length; i++) {
      const s = this._sprawl[i];
      s[0] = (r() - 0.5) * 1.3;
      s[1] = (r() - 0.5) * 0.9;
      s[2] = (r() - 0.5) * 0.9;
    }
    this._sprawl[4][0] = r() * 1.1;   // shins bend the natural way
    this._sprawl[5][0] = r() * 1.1;
  }

  /* Returns true once fully faded (system then hides + recycles). */
  updateDeath(dt) {
    this.deathT += dt;
    const t = Math.min(1, this.deathT / 0.85);
    const e = t * t * (0.4 + 0.6 * t); // gravity-flavored ease-in
    let ang = this._fallMax * Math.min(1, e * 1.02);
    if (this.deathT > 0.85 && this.deathT < 1.3) {
      ang = this._fallMax - Math.sin(((this.deathT - 0.85) / 0.45) * Math.PI) * 0.06; // settle bounce
    } else if (this.deathT >= 1.3) {
      ang = this._fallMax;
    }
    this._qa.setFromAxisAngle(this._fallAxis, ang);
    this._qb.setFromAxisAngle(Y_AXIS, this._baseYaw + this._spin * t);
    this.root.quaternion.copy(this._qa).multiply(this._qb);

    if (t < 1) { // limbs relax into sprawl
      const k = Math.min(1, dt * 7);
      for (let i = 0; i < this._poseJoints.length; i++) {
        const jr = this._poseJoints[i].rotation, s = this._sprawl[i];
        jr.x += (s[0] - jr.x) * k;
        jr.y += (s[1] - jr.y) * k;
        jr.z += (s[2] - jr.z) * k;
      }
      // hit-flash emissive dies out
      const em = Math.max(0, 0.4 - this.deathT);
      this.matCloth.emissive.setRGB(em, em * 0.1, 0.02 * em);
      this.matVest.emissive.setRGB(em, em * 0.1, 0.02 * em);
      this.matPouch.emissive.setRGB(em, em * 0.1, 0.02 * em);
    }

    if (this.deathT > CORPSE_SECONDS) {
      if (!this.fadeStarted) {
        this.fadeStarted = true;
        for (const m of this.materials) m.transparent = true;
      }
      const o = 1 - (this.deathT - CORPSE_SECONDS) / FADE_SECONDS;
      if (o <= 0) return true;
      for (const m of this.materials) m.opacity = o;
    }
    return false;
  }
}
