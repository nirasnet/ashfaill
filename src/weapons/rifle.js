// Procedural M4A1-style viewmodel built entirely from primitives.
// Weapon local space: -Z forward (muzzle), +Y up, +X right. Origin on the bore
// axis at the receiver. All real-world-ish metres; the WeaponSystem scales the
// whole group for the viewmodel.
//
// Art-direction pass (round 3):
//  - Three PBR sets from materials.js: anodized receiver, polymer furniture,
//    steel barrel/muzzle — each with curvature-driven edge wear.
//  - Picatinny rails are BAKED into albedo/normal/roughness maps on simple
//    dovetail prisms — the old instanced piano-key teeth are gone.
//  - Handguard is a smooth 24-segment tube (no more octagonal faceting steps).
//  - Magazine is a real swept double-stack curve (constant-radius arc sweep of
//    a rounded-rect cross-section, smooth normals) in FDE with a lengthwise
//    rib normal map.
//  - Support hand is a proper glove wrapping the handguard: back-of-hand plate
//    with the knuckle-wrinkle normal map facing the camera, four segmented
//    fingers curling around the underside, thumb riding the top-left flat.
//  - Red-dot: near-black housing/retainer rings + matte tube interior, neutral
//    glass with a blue-violet fresnel AR-coat at grazing angles, and a crisp
//    2-3 px emissive dot with a tight bloom halo (WeaponSystem drives opacity).
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { buildWeaponMaterials, buildFlashTexture, buildGlowTexture, buildStampTexture } from './materials.js';

function addBox(parent, mat, w, h, d, x, y, z, rx = 0, ry = 0, rz = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  m.rotation.set(rx, ry, rz);
  parent.add(m);
  return m;
}

/** Chamfered box — RoundedBoxGeometry with the radius clamped to the part. */
function addCBox(parent, mat, w, h, d, r, x, y, z, rx = 0, ry = 0, rz = 0) {
  const rad = Math.min(r, w / 3, h / 3, d / 3);
  const m = new THREE.Mesh(new RoundedBoxGeometry(w, h, d, 2, rad), mat);
  m.position.set(x, y, z);
  m.rotation.set(rx, ry, rz);
  parent.add(m);
  return m;
}

/** Box tapered along Y: bottom cross-section scaled by (sxb, szb), top by (sxt, szt). */
function taperedBoxGeo(w, h, d, sxb, szb, sxt = 1, szt = 1) {
  const g = new THREE.BoxGeometry(w, h, d, 1, 1, 1);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const t = p.getY(i) / h + 0.5; // 0 at bottom, 1 at top
    p.setX(i, p.getX(i) * (sxb + (sxt - sxb) * t));
    p.setZ(i, p.getZ(i) * (szb + (szt - szb) * t));
  }
  g.computeVertexNormals();
  return g;
}

// axis: 'x' | 'y' | 'z' — orientation of the cylinder's length.
function addCyl(parent, mat, rTop, rBot, len, seg, x, y, z, axis = 'z', open = false) {
  const g = new THREE.CylinderGeometry(rTop, rBot, len, seg, 1, open);
  const m = new THREE.Mesh(g, mat);
  if (axis === 'z') m.rotation.x = Math.PI / 2;
  else if (axis === 'x') m.rotation.z = Math.PI / 2;
  m.position.set(x, y, z);
  parent.add(m);
  return m;
}

/** Tapered limb (forearm) between two points, cylinder aligned to the segment. */
function addLimb(parent, mat, rA, rB, a, b, seg = 10) {
  const from = new THREE.Vector3(...a);
  const to = new THREE.Vector3(...b);
  const dir = to.clone().sub(from);
  const len = dir.length();
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rB, rA, len, seg), mat);
  m.position.copy(from).addScaledVector(dir, 0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  parent.add(m);
  return m;
}

/** Double-stack magazine body: a rounded-rect cross-section (w x d, corner r)
 *  swept down a constant-curvature arc (radius R, total angle phi) so the
 *  silhouette is one smooth curve — no stacked-box faceting. Starts at the
 *  local origin heading -Y and curves toward -Z (front). Smooth normals come
 *  from the outline's analytic normals; UVs: u = perimeter, v = length (the
 *  FDE rib normal map runs its grooves down constant-u bands). */
function curvedMagGeo(w, d, r, R, phi, slices = 10, cornerSeg = 5) {
  const hw = w / 2, hd = d / 2;
  const pts = [];
  for (let k = 0; k < 4; k++) {
    const a0 = k * Math.PI / 2;
    const cx = (k === 0 || k === 3) ? hw - r : -(hw - r);
    const cz = (k === 0 || k === 1) ? hd - r : -(hd - r);
    for (let i = 0; i <= cornerSeg; i++) {
      const a = a0 + (i / cornerSeg) * (Math.PI / 2);
      pts.push([cx + r * Math.cos(a), cz + r * Math.sin(a), Math.cos(a), Math.sin(a)]);
    }
  }
  pts.push(pts[0].slice()); // duplicate first point -> clean UV seam
  // Perimeter-proportional u.
  const us = [0];
  let per = 0;
  for (let i = 1; i < pts.length; i++) {
    per += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    us.push(per);
  }
  for (let i = 0; i < us.length; i++) us[i] /= per;

  const pos = [], nor = [], uv = [], idx = [];
  for (let s = 0; s <= slices; s++) {
    const t = s / slices;
    const ph = t * phi;
    const cy = -R * Math.sin(ph);
    const cz = -R * (1 - Math.cos(ph));
    // Cross-section frame: X stays world X; "depth" axis tilts with the arc.
    const sy = -Math.sin(ph), sz = Math.cos(ph);
    // Double-stack taper: slightly narrow at the feed end, full at the body.
    const sc = 0.94 + 0.06 * Math.min(1, t * 4);
    for (let i = 0; i < pts.length; i++) {
      const [px, pz, nx, nz] = pts[i];
      const X = px * sc, Z = pz * sc;
      pos.push(X, cy + sy * Z, cz + sz * Z);
      nor.push(nx, sy * nz, sz * nz);
      uv.push(us[i], t);
    }
  }
  const ring = pts.length;
  for (let s = 0; s < slices; s++) {
    for (let i = 0; i < ring - 1; i++) {
      const a = s * ring + i, b = a + ring;
      idx.push(a, a + 1, b, b, a + 1, b + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

export function buildRifle() {
  const M = buildWeaponMaterials();
  const group = new THREE.Group();
  group.name = 'rifle';

  // ---------------------------------------------------------------- receiver
  // Chamfered (~3 mm) so edges catch light instead of reading as raw boxes.
  addCBox(group, M.metal, 0.037, 0.058, 0.205, 0.0035, 0, 0.014, 0.005);   // upper receiver
  addCBox(group, M.metal, 0.034, 0.05, 0.165, 0.003, 0, -0.033, 0.012);    // lower receiver
  {
    // Mag well: tapers inward toward the opening, then flares at the lip.
    const well = new THREE.Mesh(taperedBoxGeo(0.04, 0.052, 0.08, 0.85, 0.9), M.metal);
    well.position.set(0, -0.059, -0.033);
    well.rotation.y = 0.06;
    group.add(well);
    const lip = new THREE.Mesh(taperedBoxGeo(0.035, 0.014, 0.072, 1.24, 1.16), M.metal);
    lip.position.set(0, -0.085, -0.036);
    lip.rotation.y = 0.06;
    group.add(lip);
  }

  // Ejection side (right, +X): framed port, bolt carrier, deflector, forward assist.
  addBox(group, M.steelDark, 0.003, 0.024, 0.06, 0.0185, 0.011, -0.008);   // port inner shadow box
  addBox(group, M.metal, 0.0028, 0.003, 0.068, 0.0195, 0.0245, -0.008);    // port rim top
  addBox(group, M.metal, 0.0028, 0.003, 0.068, 0.0195, -0.0025, -0.008);   // port rim bottom
  addBox(group, M.metal, 0.0028, 0.03, 0.003, 0.0195, 0.011, -0.0395);     // port rim front
  addBox(group, M.metal, 0.0028, 0.03, 0.003, 0.0195, 0.011, 0.0235);      // port rim rear
  const boltGroup = new THREE.Group();
  boltGroup.position.set(0.0165, 0.011, -0.008);
  group.add(boltGroup);
  addBox(boltGroup, M.steelBright, 0.005, 0.019, 0.052, 0, 0, 0);          // bolt carrier (animates)
  addBox(boltGroup, M.steelDark, 0.006, 0.006, 0.008, 0.0015, -0.004, 0.018); // extractor pin detail
  addBox(group, M.metal, 0.009, 0.022, 0.014, 0.021, 0.008, 0.026, 0, -0.5);  // brass deflector
  addCyl(group, M.metal, 0.0075, 0.0075, 0.014, 12, 0.024, 0.012, 0.048, 'x'); // forward assist
  addBox(group, M.metal, 0.0025, 0.02, 0.055, 0.021, -0.008, -0.008, 0.85);   // dust cover (hanging open)

  // Charging handle: chamfered shaft, T-wings, left-side latch + latch pin.
  addCBox(group, M.metal, 0.012, 0.008, 0.05, 0.002, 0, 0.0425, 0.112);
  addCBox(group, M.metal, 0.046, 0.008, 0.014, 0.0025, 0, 0.0425, 0.134);
  addCBox(group, M.metal, 0.011, 0.006, 0.017, 0.0015, -0.028, 0.0425, 0.129);   // latch
  addCyl(group, M.steelDark, 0.0022, 0.0022, 0.009, 8, -0.023, 0.0425, 0.124, 'y'); // latch pin

  // Left-side controls.
  addCyl(group, M.metal, 0.0055, 0.0055, 0.006, 10, -0.0195, -0.02, 0.03, 'x');  // selector axle
  addBox(group, M.metal, 0.005, 0.008, 0.028, -0.021, -0.014, 0.02, 0, 0, 0.2);  // selector lever
  addBox(group, M.metal, 0.005, 0.03, 0.02, -0.0195, -0.002, -0.012);            // bolt release
  addCyl(group, M.metal, 0.006, 0.006, 0.005, 10, 0.0195, -0.028, -0.004, 'x');  // mag release (right)
  addCyl(group, M.steelDark, 0.004, 0.004, 0.04, 8, 0, -0.048, 0.058, 'x');      // takedown pin rear
  addCyl(group, M.steelDark, 0.004, 0.004, 0.04, 8, 0, -0.048, -0.068, 'x');     // pivot pin front

  // Trigger group.
  addBox(group, M.metal, 0.008, 0.004, 0.068, 0, -0.077, 0.026);        // trigger guard bottom
  addBox(group, M.metal, 0.008, 0.02, 0.004, 0, -0.068, -0.006, 0.2);   // trigger guard front
  addBox(group, M.steelDark, 0.006, 0.021, 0.006, 0, -0.062, 0.018, 0.25); // trigger blade

  // Receiver rollmark decal on the left flank (the side the camera sees):
  // model / calibre / serial stamps for texture interest. Slightly proud of
  // the face + polygon offset.
  {
    const stampMat = new THREE.MeshStandardMaterial({
      map: buildStampTexture(), transparent: true, metalness: 0.5, roughness: 0.6,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
      depthWrite: false,
    });
    const stamp = new THREE.Mesh(new THREE.PlaneGeometry(0.052, 0.026), stampMat);
    stamp.position.set(-0.0173, -0.031, 0.03);
    stamp.rotation.y = -Math.PI / 2; // face -X; text runs muzzle->stock
    stamp.renderOrder = 1;
    group.add(stamp);
  }

  // Pistol grip (raked) + right hand live in one rotated frame so they align.
  const gripFrame = new THREE.Group();
  gripFrame.position.set(0, -0.098, 0.078);
  gripFrame.rotation.x = -0.42;
  group.add(gripFrame);
  addCBox(gripFrame, M.polymer, 0.03, 0.098, 0.048, 0.004, 0, -0.012, 0.004);   // grip body
  addBox(gripFrame, M.rubber, 0.031, 0.06, 0.012, 0, -0.02, 0.026);             // backstrap insert
  addCBox(gripFrame, M.polymerDark, 0.032, 0.03, 0.049, 0.003, 0, -0.052, 0.006); // grip plug/base

  // ------------------------------------------------------------------ rails
  // The picatinny slot rows are BAKED into the rail materials' albedo/normal/
  // roughness maps (materials.js) and applied to simple dovetail prisms — the
  // teeth read machined at viewmodel distance without any piano-key geometry.
  {
    const topRail = new THREE.Mesh(taperedBoxGeo(0.032, 0.0105, 0.47, 0.78, 1, 1, 1), M.railTop);
    topRail.position.set(0, 0.0492, -0.115);
    group.add(topRail);
  }

  // ------------------------------------------------------------- handguard
  // Smooth 24-segment tube — the old 8-segment octagon read as unintentional
  // polygonal faceting at viewmodel distance.
  addCyl(group, M.metal, 0.0245, 0.0245, 0.235, 24, 0, 0.002, -0.225, 'z');
  addCyl(group, M.metal, 0.027, 0.027, 0.018, 20, 0, 0.002, -0.115, 'z'); // barrel nut ring
  // Accessory rails: baked-slot prisms (side maps run their slots along the
  // fore-aft axis to match BoxGeometry's per-face UV orientation).
  addBox(group, M.railSide, 0.007, 0.02, 0.11, -0.028, 0.002, -0.26);     // left side rail
  addBox(group, M.railSide, 0.007, 0.02, 0.11, 0.028, 0.002, -0.26);      // right side rail
  {
    const botRail = new THREE.Mesh(taperedBoxGeo(0.02, 0.008, 0.13, 1, 1, 0.75, 1), M.railBottom);
    botRail.position.set(0, -0.0265, -0.26); // dovetail flares DOWN (away from tube)
    group.add(botRail);
  }
  addBox(group, M.rubber, 0.006, 0.016, 0.075, 0.0305, 0.002, -0.19);   // rubber rail cover (right)
  addBox(group, M.rubber, 0.006, 0.016, 0.075, -0.0305, 0.002, -0.175); // rubber rail cover (left)

  // ------------------------------------------------------- barrel + muzzle
  addCyl(group, M.steelDark, 0.0145, 0.0145, 0.032, 18, 0, 0, -0.352, 'z'); // chamber/FSB base
  addCyl(group, M.steelDark, 0.0085, 0.0095, 0.16, 16, 0, 0, -0.435, 'z');  // barrel (slight taper)
  addBox(group, M.steelDark, 0.018, 0.026, 0.028, 0, 0.006, -0.442);        // gas block
  addCyl(group, M.steelDark, 0.003, 0.003, 0.115, 8, 0, 0.021, -0.392, 'z'); // gas tube
  // Birdcage flash hider.
  addCyl(group, M.steelDark, 0.0115, 0.0105, 0.056, 16, 0, 0, -0.528, 'z');
  addCyl(group, M.steelDark, 0.0125, 0.0125, 0.008, 16, 0, 0, -0.553, 'z'); // crown ring
  addBox(group, M.steelBright, 0.002, 0.019, 0.034, 0.0105, 0, -0.527);     // cage slots
  addBox(group, M.steelBright, 0.002, 0.019, 0.034, -0.0105, 0, -0.527);
  addBox(group, M.steelBright, 0.019, 0.002, 0.034, 0, 0.0105, -0.527);

  // Muzzle anchor (world-position queries + flash parent).
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0, -0.562);
  group.add(muzzle);

  // ------------------------------------------------------- backup iron sight
  // Rear BUIS only (it folds behind the optic, out of the sight picture).
  addCBox(group, M.polymerDark, 0.026, 0.011, 0.034, 0.002, 0, 0.058, 0.085); // rear BUIS folded

  // -------------------------------------------------------- red-dot sight
  const sight = new THREE.Group();
  sight.position.set(0, 0, -0.075);
  group.add(sight);
  addCBox(sight, M.alu, 0.03, 0.018, 0.064, 0.0025, 0, 0.062, 0);            // riser mount
  addCBox(sight, M.metal, 0.034, 0.006, 0.052, 0.0018, 0, 0.0715, 0);        // clamp plate
  addCyl(sight, M.metal, 0.004, 0.004, 0.012, 8, 0.019, 0.0715, 0.013, 'x'); // clamp bolt
  addCyl(sight, M.metal, 0.004, 0.004, 0.012, 8, 0.019, 0.0715, -0.013, 'x'); // clamp bolt front
  addCyl(sight, M.alu, 0.019, 0.019, 0.054, 32, 0, 0.092, 0, 'z', true);     // body tube (outer)
  addCyl(sight, M.sightInner, 0.0172, 0.0172, 0.0535, 32, 0, 0.092, 0, 'z', true); // matte near-black interior
  {
    // Housing rings: near-black #141416 (the old mint-green rim is gone).
    const ringGeo = new THREE.TorusGeometry(0.019, 0.003, 10, 40);
    const r1 = new THREE.Mesh(ringGeo, M.sightRing); r1.position.set(0, 0.092, -0.027); sight.add(r1);
    const r2 = new THREE.Mesh(ringGeo, M.sightRing); r2.position.set(0, 0.092, 0.027); sight.add(r2);
    // Lens retainer ring just inside the objective — also near-black.
    const ret = new THREE.Mesh(new THREE.TorusGeometry(0.0155, 0.0013, 8, 40), M.sightRing);
    ret.position.set(0, 0.092, -0.0235);
    sight.add(ret);
  }
  addCyl(sight, M.alu, 0.009, 0.009, 0.012, 12, 0, 0.117, 0.004, 'y');       // elevation turret
  addCyl(sight, M.alu, 0.009, 0.009, 0.012, 12, 0.0235, 0.092, 0.004, 'x');  // windage turret
  addCyl(sight, M.polymerDark, 0.009, 0.009, 0.008, 12, -0.0225, 0.092, 0.008, 'x'); // battery cap
  {
    // TRUE glass lenses (neutral, opacity 0.07 / 0.05) — the world reads
    // through the tube instead of a milky disc.
    const front = new THREE.Mesh(new THREE.CircleGeometry(0.0165, 32), M.glass);
    front.position.set(0, 0.092, -0.0245);
    sight.add(front);
    const rear = new THREE.Mesh(new THREE.CircleGeometry(0.016, 32), M.glassRear);
    rear.position.set(0, 0.092, 0.0245);
    sight.add(rear);
    // AR-coat: slightly domed shell over the objective carrying the fresnel
    // blue-violet tint — visible only at grazing angles, clear dead-on.
    const coatGeo = new THREE.SphereGeometry(0.028, 32, 6, 0, Math.PI * 2, 0, 0.63);
    coatGeo.scale(1, 0.32, 1);           // flatten the cap into a lens dome
    coatGeo.rotateX(-Math.PI / 2);       // cap points -Z (out the objective)
    const coat = new THREE.Mesh(coatGeo, M.fresnelCoat);
    coat.position.set(0, 0.092, -0.0173); // rim lands on the lens plane
    coat.renderOrder = 4;
    sight.add(coat);
  }
  // The reticle — the WeaponSystem aligns THIS mesh to screen centre in ADS
  // (collimated). A crisp ~2.5 px point at 1080p in the ADS framing; the tight
  // additive halo below gives the bloom pass just enough to bite. The
  // WeaponSystem drives dot/halo opacity per-frame.
  const sightDot = new THREE.Mesh(new THREE.CircleGeometry(0.0006, 16), M.redDot);
  sightDot.position.set(0, 0.092, 0.002);
  sightDot.renderOrder = 6;
  sight.add(sightDot);
  const glowMat = new THREE.MeshBasicMaterial({
    map: buildGlowTexture(), transparent: true, depthWrite: false,
    blending: THREE.AdditiveBlending, toneMapped: false, opacity: 0,
  });
  const dotGlow = new THREE.Mesh(new THREE.PlaneGeometry(0.005, 0.005), glowMat);
  dotGlow.position.set(0, 0.092, 0.0025);
  dotGlow.renderOrder = 5;
  dotGlow.visible = false;
  sight.add(dotGlow);
  sightDot.visible = false;
  const reticle = { dot: sightDot, glow: dotGlow, dotMat: M.redDot, glowMat };

  // --------------------------------------------------------------- PEQ box
  const peq = new THREE.Group();
  peq.position.set(-0.041, 0.002, -0.245);
  group.add(peq);
  addCBox(peq, M.polymerDark, 0.026, 0.03, 0.075, 0.003, 0, 0, 0);
  addCBox(peq, M.polymerDark, 0.028, 0.012, 0.02, 0.002, 0, 0.01, 0.03);
  const irDot = new THREE.Mesh(new THREE.CircleGeometry(0.005, 10), M.irLens);
  irDot.position.set(-0.004, 0.005, -0.0378);
  peq.add(irDot);
  addCyl(peq, M.rubber, 0.005, 0.005, 0.006, 8, 0.008, 0.016, -0.01, 'y'); // activation button

  // ------------------------------------------------------ angled foregrip
  addCBox(group, M.polymer, 0.024, 0.045, 0.05, 0.004, 0, -0.048, -0.3, 0.65);
  addCBox(group, M.polymer, 0.024, 0.012, 0.06, 0.003, 0, -0.034, -0.285);

  // ---------------------------------------------------------------- stock
  addCyl(group, M.metal, 0.016, 0.016, 0.155, 16, 0, 0.012, 0.185, 'z'); // buffer tube
  addCBox(group, M.polymer, 0.042, 0.075, 0.095, 0.005, 0, -0.004, 0.245); // stock body
  addCBox(group, M.polymer, 0.038, 0.02, 0.085, 0.004, 0, 0.043, 0.243);   // cheek riser
  addCBox(group, M.rubber, 0.044, 0.108, 0.016, 0.004, 0, -0.004, 0.297);  // butt pad
  addCBox(group, M.polymer, 0.016, 0.013, 0.032, 0.002, 0, -0.048, 0.225); // adjustment lever
  {
    const sling = new THREE.Mesh(new THREE.TorusGeometry(0.009, 0.002, 6, 16), M.metal);
    sling.position.set(-0.022, -0.02, 0.25);
    sling.rotation.y = Math.PI / 2;
    group.add(sling);
  }

  // -------------------------------------------------------------- magazine
  // Swept double-stack curve (see curvedMagGeo) in FDE with rib normal map.
  const magGroup = new THREE.Group();
  magGroup.position.set(0, -0.064, -0.031);
  group.add(magGroup);
  {
    const MAG_R = 0.386, MAG_PHI = 0.35; // ~20° of constant curve over the body
    const body = new THREE.Mesh(curvedMagGeo(0.031, 0.068, 0.007, MAG_R, MAG_PHI, 10, 5), M.magFde);
    body.position.set(0, 0.02, -0.002); // top hidden inside the mag well
    magGroup.add(body);
    // Baseplate + pull tab sit square on the curve's end tangent.
    addCBox(magGroup, M.magFde, 0.0355, 0.012, 0.076, 0.0025, 0, -0.117, -0.027, MAG_PHI);
    addBox(magGroup, M.rubber, 0.012, 0.02, 0.014, 0, -0.121, -0.058, MAG_PHI);
  }

  // ----------------------------------------------------------- misc screws
  {
    const screwGeo = new THREE.CylinderGeometry(0.0032, 0.0032, 0.0045, 8);
    screwGeo.rotateZ(Math.PI / 2);
    const screws = new THREE.InstancedMesh(screwGeo, M.steelDark, 10);
    const m4 = new THREE.Matrix4();
    const pts = [
      [0.019, 0.03, 0.06], [0.019, 0.03, -0.05], [-0.019, 0.03, 0.06], [-0.019, 0.03, -0.05],
      [0.0175, -0.045, 0.045], [-0.0175, -0.045, 0.045],
      [0.026, -0.02, -0.225], [-0.026, -0.02, -0.225],
      [0.022, 0.062, -0.075], [-0.019, -0.05, 0.24],
    ];
    for (let i = 0; i < pts.length; i++) {
      m4.setPosition(pts[i][0], pts[i][1], pts[i][2]);
      screws.setMatrixAt(i, m4);
    }
    screws.instanceMatrix.needsUpdate = true;
    group.add(screws);
  }

  // ------------------------------------------------------------ muzzle flash
  const flashTex = buildFlashTexture();
  const flashMat = new THREE.MeshBasicMaterial({
    map: flashTex, transparent: true, depthWrite: false, side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending, toneMapped: false,
  });
  const flashGroup = new THREE.Group();
  flashGroup.visible = false;
  muzzle.add(flashGroup);
  const star = new THREE.Mesh(new THREE.PlaneGeometry(0.22, 0.22), flashMat);
  star.position.z = -0.015;
  star.renderOrder = 20;
  flashGroup.add(star);
  const petalGeoH = new THREE.PlaneGeometry(0.3, 0.09);
  petalGeoH.rotateY(Math.PI / 2);
  petalGeoH.rotateZ(Math.PI / 2);
  petalGeoH.translate(0, 0, -0.13);
  const petalH = new THREE.Mesh(petalGeoH, flashMat);
  petalH.renderOrder = 20;
  flashGroup.add(petalH);
  const petalGeoV = petalGeoH.clone();
  petalGeoV.rotateZ(Math.PI / 2);
  const petalV = new THREE.Mesh(petalGeoV, flashMat);
  petalV.renderOrder = 20;
  flashGroup.add(petalV);
  const flashLight = new THREE.PointLight(0xffa245, 0, 8, 2);
  flashLight.position.set(0, 0.01, -0.06);
  muzzle.add(flashLight);

  // ---------------------------------------------------- gloved hands + arms
  // Two-bone rig per arm: upper-arm (sleeve) -> forearm (elbow pivot) ->
  // hand (wrist pivot). Right hand is welded around the pistol grip inside
  // gripFrame (inherits the rake); the left chain is articulated at runtime.

  // ---- RIGHT HAND (gripFrame space; grip body x±0.015, front face z≈-0.02)
  addCBox(gripFrame, M.glove, 0.022, 0.054, 0.048, 0.006, 0.0235, -0.002, 0.006); // palm
  addCBox(gripFrame, M.gloveBack, 0.016, 0.03, 0.044, 0.005, 0.0295, 0.004, -0.004); // back-of-hand (knuckle normal map)
  addCBox(gripFrame, M.rubber, 0.008, 0.024, 0.034, 0.003, 0.0355, 0.006, -0.004); // knuckle pad
  {
    // Three gripping fingers (middle/ring/pinky), two segments each:
    // proximal across the grip front, distal wrapping the far corner.
    // A knuckle bump sits at each finger root so the joints catch the light.
    const kGeo = new THREE.SphereGeometry(1, 8, 6);
    const fy = [0.006, -0.0105, -0.027];
    const fs = [1, 0.97, 0.85];
    for (let i = 0; i < 3; i++) {
      const s = fs[i];
      addCBox(gripFrame, M.glove, 0.038 * s, 0.0135 * s, 0.0148 * s, 0.003,
        0.0035, fy[i], -0.0255, 0, 0, -0.06);
      addCBox(gripFrame, M.glove, 0.013 * s, 0.0128 * s, 0.021 * s, 0.003,
        -0.0205, fy[i] - 0.001, -0.013, 0, 0.18, 0);
      const k = new THREE.Mesh(kGeo, M.gloveBack);
      k.position.set(0.021, fy[i] + 0.001, -0.027);
      k.scale.setScalar(0.0052 * s);
      gripFrame.add(k);
    }
  }
  // Thumb over the left side of the grip, two segments.
  addCBox(gripFrame, M.glove, 0.0135, 0.017, 0.032, 0.004, -0.0185, 0.021, 0.004, 0, -0.25, 0.3);
  addCBox(gripFrame, M.glove, 0.012, 0.014, 0.02, 0.0035, -0.0205, 0.014, -0.017, 0, -0.5, 0.1);
  // Index finger straight along the receiver (off the trigger), in group space.
  addCBox(group, M.glove, 0.013, 0.013, 0.02, 0.003, 0.018, -0.05, 0.012);
  addCBox(group, M.glove, 0.0115, 0.0115, 0.036, 0.003, 0.0175, -0.056, -0.012, 0.08);

  // ---- RIGHT ARM (group space): wrist -> elbow -> shoulder, two bones.
  const rightArm = new THREE.Group();
  group.add(rightArm);
  const rightForearm = new THREE.Group();
  rightForearm.position.set(0.08, -0.27, 0.28);              // elbow pivot
  rightArm.add(rightForearm);
  // Forearm splits into dark sleeve + glove GAUNTLET at ~57% — a full-length
  // glove-fabric cylinder caught the warm sun and read as a bare tan arm.
  addLimb(rightForearm, M.sleeve, 0.028, 0.0245,
    [0, 0, 0], [-0.0302, 0.0708, -0.1044]);                  // sleeve: elbow -> mid
  addLimb(rightForearm, M.glove, 0.0262, 0.023,
    [-0.0286, 0.0671, -0.099], [-0.052, 0.122, -0.18]);      // gauntlet over the sleeve
  addLimb(rightForearm, M.rubber, 0.0272, 0.0265,
    [-0.0296, 0.0695, -0.1026], [-0.0338, 0.0793, -0.117]);  // hem cuff
  addLimb(rightForearm, M.strap, 0.0278, 0.027,
    [-0.0304, 0.0713, -0.1053], [-0.033, 0.0774, -0.1143]);  // cinch strap band
  addCBox(rightForearm, M.strap, 0.007, 0.013, 0.018, 0.002,
    -0.052, 0.071, -0.104);                                  // strap velcro tab
  {
    const elbow = new THREE.Mesh(new THREE.SphereGeometry(0.034, 10, 8), M.sleeve);
    rightForearm.add(elbow);                                 // elbow pad at pivot
  }
  addLimb(rightArm, M.sleeve, 0.036, 0.044,
    [0.08, -0.27, 0.28], [0.135, -0.42, 0.46]);              // upper arm sleeve

  // ---- LEFT ARM: root (animated by WeaponSystem) -> forearm -> hand.
  const leftArm = new THREE.Group();
  group.add(leftArm);
  const ELBOW = new THREE.Vector3(-0.045, -0.2, -0.07);
  const WRIST = new THREE.Vector3(-0.005, -0.062, -0.235);
  const wRel = WRIST.clone().sub(ELBOW);
  addLimb(leftArm, M.sleeve, 0.034, 0.044,
    [ELBOW.x, ELBOW.y, ELBOW.z], [-0.1, -0.39, 0.075]);      // upper arm sleeve
  const leftForearm = new THREE.Group();
  leftForearm.position.copy(ELBOW);
  leftArm.add(leftForearm);
  {
    const elbow = new THREE.Mesh(new THREE.SphereGeometry(0.033, 10, 8), M.sleeve);
    leftForearm.add(elbow);                                  // elbow pad at pivot
  }
  // Sleeve + glove gauntlet split (same fix as the right arm — the support
  // arm is the one that filled the frame as a "bare tan cylinder").
  addLimb(leftForearm, M.sleeve, 0.028, 0.0245,
    [0, 0, 0], [wRel.x * 0.58, wRel.y * 0.58, wRel.z * 0.58]); // sleeve: elbow -> mid
  addLimb(leftForearm, M.glove, 0.0262, 0.022,
    [wRel.x * 0.55, wRel.y * 0.55, wRel.z * 0.55],
    [wRel.x, wRel.y, wRel.z]);                               // gauntlet: mid -> wrist
  addLimb(leftForearm, M.rubber, 0.0272, 0.0265,
    [wRel.x * 0.57, wRel.y * 0.57, wRel.z * 0.57],
    [wRel.x * 0.65, wRel.y * 0.65, wRel.z * 0.65]);          // hem cuff
  addLimb(leftForearm, M.strap, 0.0278, 0.027,
    [wRel.x * 0.585, wRel.y * 0.585, wRel.z * 0.585],
    [wRel.x * 0.635, wRel.y * 0.635, wRel.z * 0.635]);       // cinch strap band
  addCBox(leftForearm, M.strap, 0.007, 0.013, 0.018, 0.002,
    0.048, 0.083, -0.099);                                   // strap velcro tab
  const leftHand = new THREE.Group();
  leftHand.position.copy(wRel);                              // wrist pivot
  leftForearm.add(leftHand);
  {
    // C-clamp glove ACTUALLY WRAPPING the handguard. Tube axis in hand space:
    // (0.005, 0.064), tube r 0.0245, wrap radius = tube + glove thickness.
    // The camera sits behind-right, so the visible mass — back-of-hand plate
    // (knuckle-wrinkle normal map), knuckle row, proximal finger segments and
    // thumb — all live on the left/underside of the tube.
    const CX = 0.005, CY = 0.064;
    const RW = 0.0315;
    // Mitten mass: wrist -> knuckle line (bridges the gap below the tube).
    addCBox(leftHand, M.glove, 0.028, 0.052, 0.05, 0.007, -0.014, 0.026, 0.002, -0.08, 0, 0.42);
    // Back-of-hand plate riding tangent on the camera side of the tube.
    addCBox(leftHand, M.gloveBack, 0.013, 0.05, 0.054, 0.004, -0.0255, 0.054, -0.002, 0, 0, 0.26);
    // Four fingers, THREE segments each, curling around the underside from
    // the left knuckle line (225°) through bottom (270°) to bottom-right
    // (~313°) — tangent boxes on the wrap circle, tips tucked under.
    const kGeo = new THREE.SphereGeometry(1, 8, 6);
    const SEGS = [
      [3.95, 0.027, 0.012],   // proximal (bottom-left, camera-visible)
      [4.71, 0.026, 0.0115],  // middle (straight underneath)
      [5.42, 0.021, 0.011],   // tip (bottom-right, tucked)
    ];
    const fs = [1, 1, 0.95, 0.86];
    for (let i = 0; i < 4; i++) {
      const s = fs[i];
      const z = 0.021 - i * 0.0158;
      for (const [th, len, thick] of SEGS) {
        addCBox(leftHand, M.glove, thick * s, len * s, 0.0138 * s, 0.0035,
          CX + Math.cos(th) * RW, CY + Math.sin(th) * RW, z, 0, 0, th);
      }
      // Knuckle bump at each finger root on the visible left side.
      const k = new THREE.Mesh(kGeo, M.gloveBack);
      k.position.set(CX + Math.cos(3.62) * (RW + 0.002), CY + Math.sin(3.62) * (RW + 0.002), z);
      k.scale.set(0.006 * s, 0.0075 * s, 0.0065 * s);
      leftHand.add(k);
    }
    // Thumb riding the top-left flat, two segments pointing at the muzzle.
    addCBox(leftHand, M.glove, 0.0135, 0.014, 0.036, 0.004, -0.0175, 0.0865, -0.006, -0.06, 0, 0.6);
    addCBox(leftHand, M.glove, 0.0115, 0.0125, 0.026, 0.0035, -0.0125, 0.0905, -0.032, -0.12, 0, 0.5);
  }

  // Viewmodel render flags: never frustum-culled (attached to the camera),
  // never casting shadows. DIELECTRICS (fabric/polymer/mag/rubber) DO receive
  // world shadows: the scene sun is ~45 intensity of stacked warm directionals,
  // and without shadow reception the gloves rendered full-sun bright tan while
  // the player stood in building shade. Metals stay shadow-off (their diffuse
  // response is nil, and skipping them avoids close-range acne on bare metal).
  const shadowed = new Set([M.polymer, M.polymerDark, M.magFde, M.rubber,
    M.glove, M.gloveBack, M.strap, M.sleeve]);
  group.traverse((o) => {
    if (o.isMesh || o.isLight) {
      o.frustumCulled = false;
      o.castShadow = false;
      o.receiveShadow = !!o.isMesh && shadowed.has(o.material);
    }
  });

  return {
    group, muzzle, sightDot, magGroup, boltGroup,
    leftArm, leftForearm, leftHand, reticle,
    materials: M,
    // Dielectrics whose env lighting the WeaponSystem manages per-frame
    // (see the envFactor note in materials.js).
    envManaged: [M.polymer, M.polymerDark, M.magFde, M.rubber,
      M.glove, M.gloveBack, M.strap, M.sleeve],
    flash: { group: flashGroup, star, petalH, petalV, light: flashLight },
  };
}
