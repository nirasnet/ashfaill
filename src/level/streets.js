// Ground surfaces: dirt base, asphalt street network + asphalt plaza, 4 m
// sidewalk strips behind 15 cm curb meshes along every roadway, worn lane
// paint (40-60% alpha-eroded, spline-aligned), crosswalks, scorch craters,
// and street-dressing decals: sparse cracks, oil stains, tire arcs, charcoal
// patch repairs, normal-mapped manholes + storm-drain grates, and wheel-rut
// grime bands along the lane splines. Owned by the level agent.
//
// Layout (all axis-aligned, y-up, arena center at origin):
//   plaza   |x|,|z| <= 16 (asphalt, dominant surface)
//   arms    x in [-7,7] crossing z in [16,40] / [-40,-16]; and the transpose
//   ring    bands at 40..54 on all four sides
//   blocks  quadrant squares [18.5,37.5]^2 with dirt alley strips [9.5,18.5]
//   walls   perimeter buildings at ~54..63
import { rng } from '../utils.js';
import { uvBox, uvScale, mergeMesh } from './geo.js';
import * as THREE from 'three';

// Sidewalk rects [x0, z0, x1, z1], filled during buildStreets so props can
// snap to the real surface height via groundHeightAt().
const SW_RECTS = [];

/** Top surface height of the ground stack at (x, z). Flat world, no raycast needed. */
export function groundHeightAt(x, z) {
  for (const r of SW_RECTS) {
    if (x >= r[0] && x <= r[2] && z >= r[1] && z <= r[3]) return 0.2; // sidewalk (curb-height)
  }
  const ax = Math.abs(x), az = Math.abs(z);
  if (ax <= 16 && az <= 16) return 0.052;                       // plaza asphalt
  if ((ax <= 7 && az <= 40) || (az <= 7 && ax <= 40)) return 0.05; // arms
  if ((ax >= 40 && ax <= 54 && az <= 54) || (az >= 40 && az <= 54 && ax <= 54)) return 0.05; // ring
  return 0; // dirt
}

/** Remapped-UV decal quad lying on the ground. */
function decalPlane(sx, sz, px, pz, ry, y, u0, v0, u1, v1) {
  const g = new THREE.PlaneGeometry(sx, sz);
  if (u0 !== undefined) {
    const uv = g.attributes.uv;
    for (let i = 0; i < uv.count; i++) {
      uv.setXY(i, u0 + uv.getX(i) * (u1 - u0), v0 + uv.getY(i) * (v1 - v0));
    }
  }
  g.rotateX(-Math.PI / 2);
  g.rotateY(ry);
  g.translate(px, y, pz);
  return g;
}

export function buildStreets(mats, out) {
  const rand = rng(31337);
  const S = mats.scale;

  /* ------------------------------ dirt base ------------------------------ */
  const ground = new THREE.Mesh(
    uvBox(640, 1, 640, { s: S.dirt, x: 0, y: -0.5, z: 0 }),
    mats.dirt,
  );
  ground.receiveShadow = true;
  ground.castShadow = false;
  ground.name = 'ground';
  ground.matrixAutoUpdate = false;
  out.ground = ground; // registered separately with collide:true (floor collider)

  /* ------------------------------- asphalt ------------------------------- */
  // The plaza is asphalt too: dark broken tarmac is the dominant surface.
  const asp = [];
  const slab = (w, d, x, z, y = 0.0275, h = 0.045) =>
    asp.push(uvBox(w, h, d, { s: S.asphalt, rand, x, y, z }));
  slab(32, 32, 0, 0, 0.0285, 0.047); // plaza
  slab(14, 24, 0, 28);   // arm +z
  slab(14, 24, 0, -28);  // arm -z
  slab(24, 14, 28, 0);   // arm +x
  slab(24, 14, -28, 0);  // arm -x
  slab(14, 108, 47, 0);  // ring east
  slab(14, 108, -47, 0); // ring west
  slab(80, 14, 0, 47);   // ring north
  slab(80, 14, 0, -47);  // ring south
  const aspMesh = mergeMesh(asp, mats.asphalt, { shadow: false, name: 'asphalt' });
  out.group.add(aspMesh);

  /* -------------------- macro tonal variation overlay ---------------------- */
  // The asphalt map tiles at 7 m and carries the 0.5 m / 2 m noise octaves;
  // this single whole-arena transparent plane carries the 8 m / 32 m octaves
  // (tile = 64 m), so the ground has low-frequency tonal drift with no
  // camo-blob or tiling repetition. Drawn before all other ground decals.
  const macroGeo = new THREE.PlaneGeometry(130, 130);
  uvScale(macroGeo, 130 / 64);
  macroGeo.rotateX(-Math.PI / 2);
  macroGeo.translate(0, 0.0585, 0);
  const macro = new THREE.Mesh(macroGeo, mats.groundMacro);
  macro.castShadow = false;
  macro.receiveShadow = true;
  macro.renderOrder = -2;
  macro.userData.noHit = true;
  macro.matrixAutoUpdate = false;
  macro.name = 'ground-macro';
  out.group.add(macro);

  /* ------------------------- sidewalks + curbs --------------------------- */
  // Real street hierarchy: 4 m concrete sidewalk strips (top at 0.20 m) along
  // every roadway, separated from the roadbed by 15 cm curb faces. `edges`
  // lists the road-facing sides ('n' -z, 's' +z, 'e' +x, 'w' -x) that get a
  // curb mesh; building-apron pads stay curbless.
  SW_RECTS.length = 0;
  const sw = [];
  const curbGeos = [];
  const CURB_W = 0.22, CURB_H = 0.2; // face: road 0.05 -> top 0.20 = 15 cm reveal
  const walk = (w, d, x, z, edges = '') => {
    sw.push(uvBox(w, 0.2, d, { s: S.sidewalk, rand, x, y: 0.1, z }));
    SW_RECTS.push([x - w / 2, z - d / 2, x + w / 2, z + d / 2]);
    for (const e of edges) {
      const alongX = e === 'n' || e === 's';
      const sgn = (e === 's' || e === 'e') ? 1 : -1;
      // curb runs the strip length minus a hair so neighbouring strips never
      // get coplanar-top overlaps at junctions
      curbGeos.push(uvBox(
        alongX ? w - 0.02 : CURB_W, CURB_H, alongX ? CURB_W : d - 0.02,
        {
          s: mats.scale.concrete, rand,
          x: alongX ? x : x + sgn * (w / 2 + CURB_W / 2),
          y: CURB_H / 2,
          z: alongX ? z + sgn * (d / 2 + CURB_W / 2) : z,
        },
      ));
    }
  };
  // arm sidewalks: both flanks of all four street arms (road edge at +-7);
  // strips stop at z/x 36 where the ring-inner strips take over (no coplanar
  // overlap => no z-fighting)
  for (const sgn of [1, -1]) {
    walk(4, 20, sgn * 9.2, 26, sgn > 0 ? 'w' : 'e');
    walk(4, 20, sgn * 9.2, -26, sgn > 0 ? 'w' : 'e');
    walk(20, 4, 26, sgn * 9.2, sgn > 0 ? 'n' : 's');
    walk(20, 4, -26, sgn * 9.2, sgn > 0 ? 'n' : 's');
  }
  // ring inner edge (fronting the quadrant blocks; ring roads run 40..54).
  // E/W strips run the full 7.2..38 span; N/S strips stop against them.
  for (const sgn of [1, -1]) {
    walk(4, 30.8, sgn * 38, 22.6, sgn > 0 ? 'e' : 'w');
    walk(4, 30.8, sgn * 38, -22.6, sgn > 0 ? 'e' : 'w');
    walk(28.8, 4, 21.6, sgn * 38, sgn > 0 ? 's' : 'n');
    walk(28.8, 4, -21.6, sgn * 38, sgn > 0 ? 's' : 'n');
  }
  // ring outer edge (fronting the perimeter buildings; road edge at +-54).
  // E/W strips stop at +-54 so the corners (buried under the corner rubble
  // mountains) never stack two coplanar strips.
  walk(4, 108, 56, 0, 'w');
  walk(4, 108, -56, 0, 'e');
  walk(108, 4, 0, 56, 'n');
  walk(108, 4, 0, -56, 's');
  // pads along the arena-facing faces of the quadrant buildings (no curbs)
  walk(15, 3, 27.5, 20);   walk(3, 12, 18.5, 27.5);   // NE main
  walk(13, 3, -26, 18);    walk(3, 13, -18, 26);      // NW main
  walk(16, 3, -27, -20);   walk(3, 11, -17.5, -27);   // SW main
  walk(14, 3, 26.5, -19);  walk(3, 11, 18, -26);      // SE main (door side)
  const swMesh = mergeMesh(sw, mats.sidewalk, { shadow: false, name: 'sidewalks' });
  out.group.add(swMesh);
  // curbs are a separate concrete mesh so the vertical face reads as its own
  // element (catches its own shading + AO line against the asphalt)
  const curbMesh = mergeMesh(curbGeos, mats.concrete, { shadow: false, name: 'curbs' });
  if (curbMesh) out.group.add(curbMesh);

  /* ------------------------------ lane paint ------------------------------ */
  const yellow = [], white = [];
  const dashY = 0.0555;
  // yellow center dashes on arms
  for (let z = 19; z <= 39; z += 4) {
    yellow.push(uvBox(0.16, 0.008, 2.2, { x: 0, y: dashY, z }));
    yellow.push(uvBox(0.16, 0.008, 2.2, { x: 0, y: dashY, z: -z }));
    yellow.push(uvBox(2.2, 0.008, 0.16, { x: z, y: dashY, z: 0 }));
    yellow.push(uvBox(2.2, 0.008, 0.16, { x: -z, y: dashY, z: 0 }));
  }
  // yellow center dashes on the ring
  for (let z = -51; z <= 51; z += 4) {
    yellow.push(uvBox(0.16, 0.008, 2.2, { x: 47, y: dashY, z }));
    yellow.push(uvBox(0.16, 0.008, 2.2, { x: -47, y: dashY, z }));
  }
  for (let x = -37; x <= 37; x += 4) {
    yellow.push(uvBox(2.2, 0.008, 0.16, { x, y: dashY, z: 47 }));
    yellow.push(uvBox(2.2, 0.008, 0.16, { x, y: dashY, z: -47 }));
  }
  // white edge lines on arms + ring outer edge
  for (const sgn of [1, -1]) {
    white.push(uvBox(0.12, 0.008, 23.6, { x: 6.6, y: dashY, z: sgn * 28 }));
    white.push(uvBox(0.12, 0.008, 23.6, { x: -6.6, y: dashY, z: sgn * 28 }));
    white.push(uvBox(23.6, 0.008, 0.12, { x: sgn * 28, y: dashY, z: 6.6 }));
    white.push(uvBox(23.6, 0.008, 0.12, { x: sgn * 28, y: dashY, z: -6.6 }));
    white.push(uvBox(0.12, 0.008, 107, { x: sgn * 53.4, y: dashY, z: 0 }));
    white.push(uvBox(107, 0.008, 0.12, { x: 0, y: dashY, z: sgn * 53.4 }));
  }
  // crosswalks at the four plaza mouths
  for (let k = 0; k < 8; k++) {
    const off = -5.6 + k * 1.6;
    white.push(uvBox(0.9, 0.008, 2.4, { x: off, y: dashY, z: 18 }));
    white.push(uvBox(0.9, 0.008, 2.4, { x: off, y: dashY, z: -18 }));
    white.push(uvBox(2.4, 0.008, 0.9, { x: 18, y: dashY, z: off }));
    white.push(uvBox(2.4, 0.008, 0.9, { x: -18, y: dashY, z: off }));
  }
  const yMesh = mergeMesh(yellow, mats.paintYellow, { shadow: false, noHit: true, name: 'paint-y' });
  const wMesh = mergeMesh(white, mats.paintWhite, { shadow: false, noHit: true, name: 'paint-w' });
  out.group.add(yMesh, wMesh);

  /* --------------------------- sparse crack decals ------------------------- */
  // 5-8 per 100 m^2, random rotation, 0.5-2 m scale, 4-variant atlas. Replaces
  // any baked per-tile crack lines (none remain in the surface textures).
  const asphaltRects = [
    [0, 0, 32, 32, 0.0528],
    [0, 28, 14, 24, 0.0508], [0, -28, 14, 24, 0.0508],
    [28, 0, 24, 14, 0.0508], [-28, 0, 24, 14, 0.0508],
    [47, 0, 14, 108, 0.0508], [-47, 0, 14, 108, 0.0508],
    [0, 47, 80, 14, 0.0508], [0, -47, 80, 14, 0.0508],
  ];
  const crackGeos = [];
  for (const [cx, cz, w, d, yTop] of asphaltRects) {
    const n = Math.round((w * d / 100) * (5 + rand() * 3));
    for (let i = 0; i < n; i++) {
      const px = cx + (rand() - 0.5) * (w - 2);
      const pz = cz + (rand() - 0.5) * (d - 2);
      if (Math.abs(px) < 5.5 && Math.abs(pz) < 5.5) continue; // fountain zone
      const sc = 0.5 + rand() * 1.5;
      const cell = Math.floor(rand() * 4);
      const u0 = (cell % 2) * 0.5, v0 = Math.floor(cell / 2) * 0.5;
      crackGeos.push(decalPlane(
        sc, sc * (0.7 + rand() * 0.6), px, pz, rand() * Math.PI * 2,
        yTop + rand() * 0.0004,
        u0 + 0.01, v0 + 0.01, u0 + 0.49, v0 + 0.49,
      ));
    }
  }
  out.group.add(mergeMesh(crackGeos, mats.crackDecal,
    { shadow: false, receive: true, noHit: true, name: 'crack-decals' }));

  /* ------------------- oil stains + tire arcs (drive lanes) ---------------- */
  const lanes = [
    [0, 20, 0, 38], [0, -20, 0, -38], [20, 0, 38, 0], [-20, 0, -38, 0],
    [47, -50, 47, 50], [-47, -50, -47, 50], [-37, 47, 37, 47], [-37, -47, 37, -47],
  ];

  /* ---------- tire-track darkening along the vehicle paths (ruts) ---------- */
  // Continuous wheel-band grime running the full length of every drive lane,
  // one rut strip per travel direction, V-repeating so long lanes don't smear.
  const rutGeos = [];
  for (const [x0, z0, x1, z1] of lanes) {
    const dx = x1 - x0, dz = z1 - z0;
    const len = Math.hypot(dx, dz);
    const nx = -dz / len, nz = dx / len;
    const laneRy = Math.atan2(dx, dz);
    for (const lat of [-1.75, 1.75]) {
      const g = new THREE.PlaneGeometry(2.3, len);
      const uv = g.attributes.uv;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i), uv.getY(i) * (len / 8));
      g.rotateX(-Math.PI / 2);
      g.rotateY(laneRy);
      g.translate((x0 + x1) / 2 + nx * lat, 0.051, (z0 + z1) / 2 + nz * lat);
      rutGeos.push(g);
    }
  }
  const rutMesh = mergeMesh(rutGeos, mats.wheelPath,
    { shadow: false, receive: true, noHit: true, name: 'wheel-ruts' });
  rutMesh.renderOrder = -1; // over the macro overlay, under the sharp decals
  out.group.add(rutMesh);

  const oilGeos = [], tireGeos = [];
  for (const [x0, z0, x1, z1] of lanes) {
    const dx = x1 - x0, dz = z1 - z0;
    const len = Math.hypot(dx, dz);
    const nx = -dz / len, nz = dx / len; // lateral unit
    const laneRy = Math.atan2(dx, dz);
    const nOil = 2 + Math.floor(rand() * 2);
    for (let i = 0; i < nOil; i++) {
      const t = rand();
      const lat = (rand() - 0.5) * 8;
      oilGeos.push(decalPlane(
        0.9 + rand() * 1.4, 0.55 + rand() * 0.9,
        x0 + dx * t + nx * lat, z0 + dz * t + nz * lat,
        rand() * Math.PI * 2, 0.051,
      ));
    }
    for (let i = 0; i < 2; i++) {
      const t = 0.15 + rand() * 0.7;
      const lat = (rand() < 0.5 ? -1 : 1) * (1.5 + rand() * 2.5);
      tireGeos.push(decalPlane(
        1.7, 4 + rand() * 2,
        x0 + dx * t + nx * lat, z0 + dz * t + nz * lat,
        laneRy + (rand() - 0.5) * 0.45, 0.0512,
      ));
    }
  }
  out.group.add(mergeMesh(oilGeos, mats.oilDecal,
    { shadow: false, receive: true, noHit: true, name: 'oil-decals' }));
  out.group.add(mergeMesh(tireGeos, mats.tireDecal,
    { shadow: false, receive: true, noHit: true, name: 'tire-decals' }));

  /* -------------------- charcoal patch-repair decals ----------------------- */
  // Hard-edged tar repairs (#232325 + aggregate speckle) breaking the asphalt
  // tiling: 2-3 per drive lane + a scatter on the plaza, 1.5-4 m, axis-biased
  // rotation so they read as road-crew cuts rather than random blobs.
  const patchGeos = [];
  const addPatch = (px, pz, baseRy) => {
    const cell = Math.floor(rand() * 4);
    const u0 = (cell % 2) * 0.5, v0 = Math.floor(cell / 2) * 0.5;
    const sc = 1.5 + rand() * 2.5;
    patchGeos.push(decalPlane(
      sc, sc * (0.6 + rand() * 0.7), px, pz,
      baseRy + (rand() - 0.5) * 0.3, 0.0532 + rand() * 0.0004,
      u0 + 0.01, v0 + 0.01, u0 + 0.49, v0 + 0.49,
    ));
  };
  for (const [x0, z0, x1, z1] of lanes) {
    const dx = x1 - x0, dz = z1 - z0;
    const len = Math.hypot(dx, dz);
    const nx = -dz / len, nz = dx / len;
    const laneRy = Math.atan2(dx, dz);
    const n = 2 + Math.floor(rand() * 2);
    for (let i = 0; i < n; i++) {
      const t = rand();
      const lat = (rand() - 0.5) * 7;
      addPatch(x0 + dx * t + nx * lat, z0 + dz * t + nz * lat, laneRy);
    }
  }
  for (let i = 0; i < 5; i++) { // plaza scatter (clear of the fountain)
    const a = rand() * Math.PI * 2, r = 7 + rand() * 7;
    addPatch(Math.cos(a) * r, Math.sin(a) * r, (rand() < 0.5 ? 0 : Math.PI / 2));
  }
  out.group.add(mergeMesh(patchGeos, mats.patchRepair,
    { shadow: false, receive: true, noHit: true, name: 'patch-decals' }));

  /* --------------------- manholes + storm drains --------------------------- */
  // Manhole covers every 20-30 m along the drive-lane centerlines (small
  // lateral offset off the paint line); storm-drain grates in the gutter
  // against the curb faces. Both normal-mapped so they catch the sun.
  const mhGeos = [];
  for (const [x0, z0, x1, z1] of lanes) {
    const dx = x1 - x0, dz = z1 - z0;
    const len = Math.hypot(dx, dz);
    const nx = -dz / len, nz = dx / len;
    const step = 20 + rand() * 10;
    for (let d = step * 0.5; d < len; d += 20 + rand() * 10) {
      const t = d / len;
      const lat = (rand() < 0.5 ? -1 : 1) * (1.1 + rand() * 0.6);
      mhGeos.push(decalPlane(
        0.75, 0.75, x0 + dx * t + nx * lat, z0 + dz * t + nz * lat,
        rand() * Math.PI * 2, 0.0538,
      ));
    }
  }
  out.group.add(mergeMesh(mhGeos, mats.manhole,
    { shadow: false, receive: true, noHit: true, name: 'manholes' }));
  // gutter grates: [x, z, ry] hugging arm curbs (x/z ~ +-6.6) and ring curbs;
  // long axis runs ALONG the curb (ry = PI/2 for z-running curbs)
  const drGeos = [];
  const drains = [
    [6.6, 23, Math.PI / 2], [-6.6, 31, Math.PI / 2], [6.6, -33, Math.PI / 2], [-6.6, -22, Math.PI / 2],
    [24, 6.6, 0], [34, -6.6, 0], [-27, 6.6, 0], [-36, -6.6, 0],
    [40.55, 18, Math.PI / 2], [40.55, -26, Math.PI / 2], [-40.55, 12, Math.PI / 2], [-40.55, -30, Math.PI / 2],
    [53.55, 34, Math.PI / 2], [-53.55, -8, Math.PI / 2], [20, 53.55, 0], [-30, 53.55, 0],
    [12, -53.55, 0], [-24, -53.55, 0],
  ];
  for (const [px, pz, ry] of drains) {
    drGeos.push(decalPlane(0.95, 0.55, px, pz, ry, 0.0538));
  }
  out.group.add(mergeMesh(drGeos, mats.drain,
    { shadow: false, receive: true, noHit: true, name: 'storm-drains' }));

  /* ------------------------------- craters -------------------------------- */
  const craters = [];
  const craterSpots = [
    [6, -4, 2.5, 0.058], [-9, 7, 1.8, 0.058], [2, 26, 2.0, 0.056],
    [46, 20, 3.0, 0.056], [-14, -24, 2.2, 0.02], [-30, 44, 2.4, 0.056],
  ];
  for (const [cx, cz, r, cy] of craterSpots) {
    const p = new THREE.PlaneGeometry(r * 2, r * 2);
    p.rotateX(-Math.PI / 2);
    p.rotateY(rand() * Math.PI * 2);
    p.translate(cx, cy, cz);
    craters.push(p);
  }
  const crMesh = mergeMesh(craters, mats.crater, { shadow: false, receive: true, noHit: true, name: 'craters' });
  out.group.add(crMesh);
}
