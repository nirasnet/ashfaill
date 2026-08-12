// Cover props, vehicles, street furniture and scatter detail for the arena.
// Owned by the level agent.
import * as THREE from 'three';
import { rng } from '../utils.js';
import {
  uvBox, uvCyl, uvScale, mergeMesh, mergeGeometries, box3Base, obbBox3, setInstance, finishInstanced,
} from './geo.js';
import { groundHeightAt } from './streets.js';

/* ------------------------------ fountain plaza ----------------------------- */

export function buildFountain(mats, out) {
  const rand = rng(2101);
  const conc = [];
  const R = 3.6, segLen = 2 * R * Math.tan(Math.PI / 8);
  for (let k = 0; k < 8; k++) {
    const a = (k * Math.PI) / 4;
    if (k === 5) continue; // one broken segment
    conc.push(uvBox(segLen * 0.99, 0.85, 0.45, {
      s: mats.scale.concrete, rand,
      ry: -a, x: Math.cos(a + Math.PI / 2) * R, y: 0.475, z: Math.sin(a + Math.PI / 2) * R,
    }));
  }
  // toppled segment lying beside its gap
  conc.push(uvBox(segLen * 0.9, 0.85, 0.45, {
    s: mats.scale.concrete, rand, ry: 0.9, rz: 1.35, x: -4.6, y: 0.28, z: -3.4,
  }));
  const bowl = uvCyl(3.45, 3.45, 0.14, 8, { s: mats.scale.concrete, ry: Math.PI / 8, y: 0.12 });
  conc.push(bowl);
  conc.push(uvBox(1.1, 1.4, 1.1, { s: mats.scale.concrete, rand, y: 0.7 }));            // pedestal
  // broken column: RE-SEATED as a fallen drum lying inside the basin (it used
  // to lean mid-air through the fountain wall, which read as a glitch)
  conc.push(uvCyl(0.3, 0.34, 1.6, 10, {
    s: mats.scale.concrete, rx: Math.PI / 2, ry: 0.7, x: 0.9, y: 0.51, z: -0.8,
  }));
  conc.push(uvBox(0.8, 0.6, 0.7, { s: mats.scale.concrete, rand, ry: 0.5, x: 1.7, y: 0.34, z: 0.9 }));
  // planters at the plaza diagonals
  const dirtTops = [];
  const planterPos = [[8, 8], [-8, 8], [8, -8], [-8, -8]];
  for (const [px, pz] of planterPos) {
    conc.push(uvBox(2.6, 0.7, 1.3, { s: mats.scale.concrete, rand, x: px, y: 0.35, z: pz }));
    dirtTops.push(uvBox(2.3, 0.1, 1.0, { s: mats.scale.dirt, x: px, y: 0.68, z: pz }));
    out.colliders.push(box3Base(px, 0, pz, 2.7, 0.85, 1.4));
  }
  // weathered concrete (#8a877e base, baked streaking) — never raw white
  out.group.add(mergeMesh(conc, mats.fountainConc, { name: 'fountain' }));
  out.group.add(mergeMesh(dirtTops, mats.dirt, { shadow: false, name: 'planter-dirt' }));
  out.colliders.push(box3Base(0, 0, 0, 7.7, 1.0, 7.7));

  // ---- weathering decals: rim grime streaks + interior waterline stain -----
  const streakGeos = [], waterGeos = [];
  for (let k = 0; k < 8; k++) {
    if (k === 5) continue; // skip the broken segment (no wall to stain)
    const a = (k * Math.PI) / 4;
    const nX = -Math.sin(a), nZ = Math.cos(a); // outward normal of segment k
    // vertical grime streaks under the outer rim
    const sg = new THREE.PlaneGeometry(segLen * 0.92, 0.62);
    sg.rotateY(-a);
    sg.translate(nX * (R + 0.234), 0.59, nZ * (R + 0.234));
    streakGeos.push(sg);
    // waterline stain band on the basin's inner face
    const wg = new THREE.PlaneGeometry(segLen * 0.9, 0.5);
    wg.rotateY(-a + Math.PI);
    wg.translate(nX * (R - 0.234), 0.55, nZ * (R - 0.234));
    waterGeos.push(wg);
  }
  // planters get the same under-rim streaking on their long faces
  for (const [px, pz] of planterPos) {
    for (const sgn of [1, -1]) {
      const g = new THREE.PlaneGeometry(2.4, 0.5);
      if (sgn < 0) g.rotateY(Math.PI);
      g.translate(px, 0.38, pz + sgn * 0.658);
      streakGeos.push(g);
    }
  }
  out.group.add(mergeMesh(streakGeos, mats.grimeStreak,
    { shadow: false, receive: true, noHit: true, name: 'fountain-grime' }));
  out.group.add(mergeMesh(waterGeos, mats.waterline,
    { shadow: false, receive: true, noHit: true, name: 'fountain-waterline' }));
}

/* ------------------------------- cover props ------------------------------- */

/**
 * Deformed sandbag geometry: a rounded superellipsoid brick (NOT a scaled
 * sphere — that read as a potato loaf) with a sagging belly, a flattened
 * squashed underside where it rests on the row below, deterministic wrinkle
 * noise, and cinched short ends. Built once, instanced for every bag.
 */
function makeBagGeo() {
  const g = new THREE.SphereGeometry(1, 12, 8);
  const pos = g.attributes.position;
  const HX = 0.31, HY = 0.16, HZ = 0.24; // half extents: 62x32x48 cm bag
  for (let i = 0; i < pos.count; i++) {
    let x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    // squared-off profile: push the unit sphere toward a rounded box (n=4)
    const n = 4.0;
    const d = Math.pow(
      Math.abs(x) ** n + Math.abs(y) ** n + Math.abs(z) ** n, 1 / n,
    ) || 1;
    const k = Math.pow(x * x + y * y + z * z, 0.5) / d; // sphere->superellipsoid
    x *= k; y *= k; z *= k;
    // cinch the short (x) ends: filled bags taper where the sack is tied
    const cinch = 1 - 0.24 * Math.pow(Math.abs(x), 4);
    z *= cinch;
    y *= cinch;
    // belly sag + flattened underside (rests on the row below)
    if (y < 0) y *= 0.68;
    y -= 0.10 * (1 - x * x) * (1 - z * z) * (y < 0 ? 1 : -0.4);
    // deterministic wrinkle noise (same for all instances; per-instance
    // rotation/scale jitter de-correlates neighbours)
    const w = Math.sin(x * 9.1 + z * 7.3) * Math.sin(y * 11.7 + x * 5.1) * 0.06
      + Math.sin(x * 21.7 + y * 17.3 + z * 13.1) * 0.028;
    const r = 1 + w;
    pos.setXYZ(i, x * HX * r, y * HY * r, z * HZ * r);
  }
  g.computeVertexNormals();
  return g;
}

export function buildSandbags(mats, out) {
  const rand = rng(2202);
  const bag = makeBagGeo();
  // walls: [cx, cz, alongZ(0|1), length, rows]
  const walls = [
    [6.2, 4.6, 0, 3.2, 3], [4.6, 6.2, 1, 3.2, 3],
    [-6.2, -4.6, 0, 3.2, 3], [-4.6, -6.2, 1, 3.2, 3],
    [2.8, 31, 0, 3.0, 2], [31, -2.8, 1, 3.0, 2],
    [3.5, 44, 0, 2.6, 2], [20, 57, 0, 3.0, 2],
    [-14, -20, 1, 2.6, 2],
  ];
  const mtx = [];
  for (const [cx, cz, alongZ, len, rows] of walls) {
    const gy = groundHeightAt(cx, cz);
    for (let r = 0; r < rows; r++) {
      const n = Math.max(2, Math.round(len / 0.62) - (r === rows - 1 ? 1 : 0));
      for (let b = 0; b < n; b++) {
        const off = (b - (n - 1) / 2) * 0.62 + (r % 2 ? 0.14 : 0);
        mtx.push([
          cx + (alongZ ? (rand() - 0.5) * 0.08 : off),
          gy + 0.13 + r * 0.245, // rows compress: bags squash under load
          cz + (alongZ ? off : (rand() - 0.5) * 0.08),
          (rand() - 0.5) * 0.16,
          (alongZ ? Math.PI / 2 : 0) + (rand() - 0.5) * 0.24,
          (rand() - 0.5) * 0.12,
          0.92 + rand() * 0.18,          // sx
          (r === rows - 1 ? 1 : 0.88) + rand() * 0.1, // lower rows squashed flatter
          0.94 + rand() * 0.16,          // sz
        ]);
      }
    }
    out.colliders.push(box3Base(
      cx, 0, cz,
      alongZ ? 0.75 : len + 0.3, rows * 0.26 + 0.2, alongZ ? len + 0.3 : 0.75,
    ));
  }
  const mesh = new THREE.InstancedMesh(bag, mats.sandbag, mtx.length);
  const col = new THREE.Color();
  mtx.forEach((m, i) => {
    setInstance(mesh, i, m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8]);
    // per-bag hue variation: tan / khaki / olive drift around the burlap map
    const v = 0.88 + rand() * 0.24;
    const hueShift = (rand() - 0.5) * 0.16; // + toward tan, - toward olive
    col.setRGB(
      Math.min(1, v * (1 + hueShift * 0.6)),
      Math.min(1, v * (1 + hueShift * 0.1)),
      Math.min(1, v * (1 - hueShift * 0.8) * 0.92),
    );
    mesh.setColorAt(i, col);
  });
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  finishInstanced(mesh);
  mesh.name = 'sandbags';
  out.group.add(mesh);
}

export function buildBarriers(mats, out) {
  const rand = rng(2303);
  const parts = [
    uvBox(2.0, 0.28, 0.64, { s: mats.scale.concrete, y: 0.14 }),
    uvBox(2.0, 0.55, 0.42, { s: mats.scale.concrete, y: 0.555 }),
    uvBox(2.0, 0.26, 0.24, { s: mats.scale.concrete, y: 0.96 }),
  ];
  const geo = mergeGeometries(parts, false);
  // top-down grime gradient baked as vertex colors (barrier material has
  // vertexColors on): rain-washed grime darkens the crown ~14% and road
  // splash darkens the skirt ~12%; the mid faces stay the base concrete
  const pos = geo.attributes.position;
  const vcol = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i), x = pos.getX(i);
    const top = Math.min(1, Math.max(0, (y - 0.62) / 0.47));   // 0 mid -> 1 crown
    const base = Math.min(1, Math.max(0, 1 - y / 0.32));       // 1 ground -> 0 mid
    const wob = 0.9 + 0.2 * Math.abs(Math.sin(x * 3.1 + y * 5.7));
    const v = 1 - 0.14 * top * wob - 0.12 * base * wob;
    vcol[i * 3] = v;
    vcol[i * 3 + 1] = v * 0.995;
    vcol[i * 3 + 2] = v * 0.975; // grime is slightly warm
  }
  geo.setAttribute('color', new THREE.BufferAttribute(vcol, 3));
  // [cx, cz, alongZ]
  const spots = [
    [-3.2, 15.2, 0], [3.2, 15.2, 0], [-3.2, -15.2, 0], [3.2, -15.2, 0],
    [15.2, -3.2, 1], [15.2, 3.2, 1], [-15.2, -3.2, 1], [-15.2, 3.2, 1],
    [44, -17, 1], [44, -14.8, 1], [-30, 1.1, 1], [-30, -1.1, 1],
    [17.5, 52.6, 0], [21, 52.6, 0], [9, 1, 1], [9, -1.2, 1],
  ];
  // dedicated barrier material: concrete with chipped hazard-paint remnants
  const mesh = new THREE.InstancedMesh(geo, mats.barrier, spots.length);
  spots.forEach(([cx, cz, aZ], i) => {
    const gy = groundHeightAt(cx, cz);
    const ry = (aZ ? Math.PI / 2 : 0) + (rand() - 0.5) * 0.14;
    setInstance(mesh, i, cx, gy, cz, 0, ry, 0, 1);
    out.colliders.push(obbBox3(cx, 0, cz, 2.1, 1.12 + gy, 0.7, ry));
    // edge chips: spalled-corner decals hugging the crown + shoulder edges
    if (out.chipGeos) {
      const nChips = 1 + Math.floor(rand() * 2);
      for (let c = 0; c < nChips; c++) {
        const cell = Math.floor(rand() * 4);
        const u0 = (cell % 2) * 0.5, v0 = Math.floor(cell / 2) * 0.5;
        const sc = 0.10 + rand() * 0.12;
        const cg = new THREE.PlaneGeometry(sc, sc * (0.7 + rand() * 0.5));
        const uv = cg.attributes.uv;
        for (let k = 0; k < uv.count; k++) {
          uv.setXY(k, u0 + 0.02 + uv.getX(k) * 0.46, v0 + 0.02 + uv.getY(k) * 0.46);
        }
        const lu = (rand() - 0.5) * 1.7;                     // along the barrier
        const side = rand() < 0.5 ? 1 : -1;
        const yC = rand() < 0.6 ? 1.02 + rand() * 0.07 : 0.72 + rand() * 0.1;
        const lateral = (yC > 0.9 ? 0.125 : 0.215) + 0.012;  // crown vs shoulder face
        const ca = Math.cos(ry), sa = Math.sin(ry);
        cg.rotateY(ry + (side > 0 ? 0 : Math.PI)); // flush against the side face
        cg.translate(
          cx + lu * ca + side * lateral * sa,
          gy + yC,
          cz - lu * sa + side * lateral * ca,
        );
        out.chipGeos.push(cg);
      }
    }
  });
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  finishInstanced(mesh);
  mesh.name = 'jersey-barriers';
  out.group.add(mesh);
}

/** Street dumpsters drifted into the alleys and along the ring sidewalks. */
export function buildDumpsters(mats, out) {
  const rand = rng(2610);
  const parts = [
    uvBox(1.9, 1.06, 1.05, { s: 1 / 1.9, y: 0.66 }),                    // body
    uvBox(2.0, 0.1, 1.12, { s: 1 / 1.9, y: 1.24 }),                     // rim
    uvBox(1.94, 0.07, 1.1, { s: 1 / 1.9, rx: -0.16, y: 1.36, z: -0.1 }), // lid, ajar
    uvBox(0.09, 0.5, 0.7, { s: 1 / 1.9, x: 1.0, y: 0.5 }),              // fork pockets
    uvBox(0.09, 0.5, 0.7, { s: 1 / 1.9, x: -1.0, y: 0.5 }),
    uvBox(1.7, 0.13, 0.9, { s: 1 / 1.9, y: 0.13 }),                     // skid base
  ];
  const geo = mergeGeometries(parts, false);
  // [cx, cz, ry] — alley mouths + service spots along the ring
  const spotsD = [
    [16.6, 22.6, 0.12], [-14.8, 13.4, 1.62], [22.6, -13.6, 1.5],
    [-13.4, -22.8, -0.1], [52.6, 17.5, 1.57], [-52.6, -31, -1.55],
  ];
  const mesh = new THREE.InstancedMesh(geo, mats.dumpster, spotsD.length);
  const col = new THREE.Color();
  // desaturated municipal paint variation (tints multiply the green base map)
  const tints = [[1, 1, 1], [0.78, 0.82, 0.95], [0.95, 0.9, 0.78], [0.7, 0.72, 0.74]];
  spotsD.forEach(([cx, cz, ry], i) => {
    const gy = groundHeightAt(cx, cz);
    setInstance(mesh, i, cx, gy, cz, 0, ry + (rand() - 0.5) * 0.08, 0, 1);
    const t = tints[Math.floor(rand() * tints.length)];
    const jj = 0.9 + rand() * 0.2;
    col.setRGB(Math.min(1, t[0] * jj), Math.min(1, t[1] * jj), Math.min(1, t[2] * jj));
    mesh.setColorAt(i, col);
    out.colliders.push(obbBox3(cx, 0, cz, 2.05, 1.45 + gy, 1.2, ry));
  });
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  finishInstanced(mesh);
  mesh.name = 'dumpsters';
  out.group.add(mesh);
}

export function buildContainers(mats, out) {
  const geo = uvBox(6, 2.6, 2.4, { s: mats.scale.corrugated });
  // [cx, y, cz, ry, r,g,b, collide]
  // Tints are desaturated weathered paint (chroma-key green/orange placeholder
  // reads are banned). The lone container that used to sit at [13.8, 32.5] —
  // right of frame in the menu view, reading as a raw green box + bare beige
  // end — is DELETED per art direction (nothing within 15 m of the play path
  // may read as an untextured block).
  const list = [
    [-18, 0, 49, 0.06, 0.55, 0.34, 0.30, 1],
    [-11.6, 0, 49.2, -0.05, 0.33, 0.38, 0.45, 1],
    [-15, 2.6, 49.1, 0.1, 0.42, 0.45, 0.36, 0],
    [-47, 0, 30, 1.55, 0.52, 0.52, 0.52, 1],
  ];
  const mesh = new THREE.InstancedMesh(geo, mats.corrugated, list.length);
  const col = new THREE.Color();
  list.forEach(([cx, y, cz, ry, r, g, b, c], i) => {
    setInstance(mesh, i, cx, y + 1.3, cz, 0, ry, 0, 1);
    mesh.setColorAt(i, col.setRGB(r, g, b));
    if (c) out.colliders.push(obbBox3(cx, 0, cz, 6.1, 2.6, 2.5, ry));
  });
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  finishInstanced(mesh);
  mesh.name = 'containers';
  out.group.add(mesh);
}

export function buildBarrels(mats, out) {
  const geo = uvCyl(0.32, 0.32, 0.92, 12, { s: mats.scale.rust });
  // [cx, cz, tipped]
  const list = [
    [12.2, -30.6, 0], [13.1, -31.2, 0], [12.6, -32, 0],
    [22, -29.5, 0], [22.8, -28.8, 0],
    [-46.2, 11.6, 0], [-45.5, 12.5, 0], [-46.8, 13.4, 1],
    [-19.5, 45.8, 0], [-18.8, 46.4, 0], [-20.2, 46.6, 1],
    [-14.2, -13.5, 0], [-13.4, -14.3, 0],
    [17.5, 57.5, 0],
  ];
  const rand = rng(2404);
  const mesh = new THREE.InstancedMesh(geo, mats.rust, list.length);
  list.forEach(([cx, cz, tip], i) => {
    const gy = groundHeightAt(cx, cz);
    if (tip) setInstance(mesh, i, cx, gy + 0.33, cz, Math.PI / 2, rand() * Math.PI, 0, 1);
    else setInstance(mesh, i, cx, gy + 0.46, cz, 0, rand() * Math.PI, (rand() - 0.5) * 0.06, 1);
  });
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  finishInstanced(mesh);
  mesh.name = 'barrels';
  out.group.add(mesh);
  // one collider per cluster
  out.colliders.push(
    box3Base(12.6, 0, -31.2, 2.1, 0.95, 2.2),
    box3Base(22.4, 0, -29.1, 1.9, 0.95, 1.8),
    box3Base(-46.1, 0, 12.5, 2.4, 0.95, 2.8),
    box3Base(-19.5, 0, 46.2, 2.5, 0.95, 1.9),
    box3Base(-13.8, 0, -13.9, 1.9, 0.95, 1.9),
    box3Base(17.5, 0, 57.5, 1.0, 0.95, 1.0),
  );
}

export function buildPallets(mats, out) {
  const rand = rng(2505);
  const parts = [];
  for (const sx of [-0.55, 0, 0.55]) parts.push(uvBox(0.09, 0.09, 1.0, { s: mats.scale.wood, x: sx, y: 0.085 }));
  for (let i = 0; i < 5; i++) parts.push(uvBox(1.2, 0.022, 0.15, { s: mats.scale.wood, y: 0.141, z: -0.4 + i * 0.2 }));
  for (let i = 0; i < 3; i++) parts.push(uvBox(1.2, 0.022, 0.15, { s: mats.scale.wood, y: 0.03, z: -0.4 + i * 0.4 }));
  const geo = mergeGeometries(parts, false);
  // [x, y, z, rx, ry, rz]
  const list = [
    [30, 0, -23, 0, 0.3, 0], [30.1, 0.17, -22.9, 0, 0.45, 0],
    [19.2, 0.5, 24, 0, Math.PI / 2, 1.22],
    [14, 0, 30.5, 0, 1.2, 0], [34, 0, 44, 0, 0.7, 0],
    [-22, 0, -45, 0, 2.4, 0], [5.5, 0, -19.5, 0, 0.15, 0],
    [44.5, 0, -22, 0, 1.9, 0], [44.6, 0.17, -21.9, 0, 2.05, 0],
    [-44, 0, 30, 0, 0.9, 0],
  ];
  const mesh = new THREE.InstancedMesh(geo, mats.wood, list.length);
  list.forEach(([x, y, z, rx, ry, rz], i) =>
    setInstance(mesh, i, x, y + groundHeightAt(x, z), z, rx, ry + (rand() - 0.5) * 0.1, rz, 1));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  finishInstanced(mesh);
  mesh.name = 'pallets';
  out.group.add(mesh);
}

/* -------------------------------- vehicles --------------------------------- */

export function buildVehicles(mats, out) {
  const rand = rng(2606);
  // burned car hull (one merged geometry, instanced) - wheels, glass and rims
  // are separate instanced meshes so tires read as rubber, not clay.
  // The cabin is a real roof-and-pillar frame (not a solid box), so the glass
  // band sits INSET behind the pillars and reads as dark reflective glazing.
  const cs = mats.scale.charred;
  const parts = [
    uvBox(4.3, 0.55, 1.8, { s: cs, y: 0.62 }),
    uvBox(2.2, 0.12, 1.62, { s: cs, x: -0.2, y: 1.44 }),  // cabin roof
    uvBox(1.0, 0.3, 1.7, { s: cs, x: 1.75, y: 0.53 }),    // crumpled hood drop
    // A / C pillars framing the inset glass band
    uvBox(0.1, 0.52, 0.14, { s: cs, x: 0.8, y: 1.14, z: 0.72 }),
    uvBox(0.1, 0.52, 0.14, { s: cs, x: 0.8, y: 1.14, z: -0.72 }),
    uvBox(0.1, 0.52, 0.14, { s: cs, x: -1.24, y: 1.14, z: 0.72 }),
    uvBox(0.1, 0.52, 0.14, { s: cs, x: -1.24, y: 1.14, z: -0.72 }),
    uvBox(0.09, 0.52, 1.58, { s: cs, x: -0.2, y: 1.14 }), // B pillar
  ];
  const carGeo = mergeGeometries(parts, false);
  // [cx, cz, ry]
  const cars = [
    [3.5, 33, 0.08], [-3.5, -33, 3.05], [46, 8, 1.65], [-10, 18.5, 0.7],
    [13, 25, 1.62], [-47, -8, 1.5], [20, -47, 2.9],
  ];
  const carMesh = new THREE.InstancedMesh(carGeo, mats.charred, cars.length);
  // dark-glass band, inset ~7 cm behind the pillar faces (env-reflective)
  const glassGeo = new THREE.BoxGeometry(2.1, 0.5, 1.44);
  glassGeo.translate(-0.2, 1.14, 0);
  const glassMesh = new THREE.InstancedMesh(glassGeo, mats.glass, cars.length);
  // shared wheel geometry: pre-rotated so the axle runs along local z
  const tireGeo = new THREE.CylinderGeometry(0.34, 0.34, 0.25, 12);
  tireGeo.rotateX(Math.PI / 2);
  const rimGeo = new THREE.CylinderGeometry(0.16, 0.16, 0.27, 8);
  rimGeo.rotateX(Math.PI / 2);
  const wheelSlots = []; // [wx, wy, wz, ry, s]
  const addWheels = (cx, cz, ry, locals, y, s = 1) => {
    const cr = Math.cos(ry), sr = Math.sin(ry);
    for (const [lx, lz] of locals) {
      wheelSlots.push([cx + lx * cr + lz * sr, y, cz - lx * sr + lz * cr, ry, s]);
    }
  };
  const carWheelLocals = [[1.42, 0.82], [1.42, -0.82], [-1.42, 0.82], [-1.42, -0.82]];
  const col = new THREE.Color();
  cars.forEach(([cx, cz, ry], i) => {
    const gy = groundHeightAt(cx, cz); // tires rest ON the road surface
    setInstance(carMesh, i, cx, gy, cz, 0, ry, (rand() - 0.5) * 0.05, 1);
    const t = 0.85 + rand() * 0.3;
    carMesh.setColorAt(i, col.setRGB(t, t * (0.92 + rand() * 0.1), t * (0.88 + rand() * 0.1)));
    setInstance(glassMesh, i, cx, gy, cz, 0, ry, 0, 1);
    addWheels(cx, cz, ry, carWheelLocals, gy + 0.34);
    out.colliders.push(obbBox3(cx, 0, cz, 4.6, 1.55 + gy, 2.0, ry));
  });
  carMesh.castShadow = true;
  carMesh.receiveShadow = true;
  finishInstanced(carMesh);
  carMesh.name = 'car-hulls';
  glassMesh.castShadow = false;
  glassMesh.receiveShadow = true;
  finishInstanced(glassMesh);
  glassMesh.name = 'car-glass';
  out.group.add(carMesh, glassMesh);

  // wrecked bus (single hull on the south ring)
  const bx = 10, bz = -47, bry = 0.18;
  const bgy = groundHeightAt(bx, bz); // rest on the road surface
  const busParts = [
    uvBox(10, 2.5, 2.5, { s: mats.scale.rust, rand, ry: bry, x: bx, y: bgy + 1.55, z: bz }),
    uvBox(9.2, 0.35, 2.3, { s: mats.scale.rust, ry: bry, x: bx, y: bgy + 0.22, z: bz }),
  ];
  // window mullions splitting the glass band into panes
  for (let lx = -3.45; lx <= 3.46; lx += 1.15) {
    busParts.push(uvBox(0.09, 0.95, 2.6, {
      s: mats.scale.rust, ry: bry,
      x: bx + lx * Math.cos(bry), y: bgy + 2.35, z: bz - lx * Math.sin(bry),
    }));
  }
  const busMesh = mergeMesh(busParts, mats.rust, { name: 'bus' });
  out.group.add(busMesh);
  // glass band (real glass, not a black void)
  const busGlass = new THREE.Mesh(
    uvBox(9.5, 0.85, 2.56, { ry: bry, x: bx, y: bgy + 2.35, z: bz }), mats.glass,
  );
  busGlass.castShadow = false;
  busGlass.receiveShadow = true;
  busGlass.matrixAutoUpdate = false;
  busGlass.name = 'bus-glass';
  out.group.add(busGlass);
  addWheels(bx, bz, bry, [[-3.4, 1.08], [-3.4, -1.08], [0, 1.08], [0, -1.08], [3.4, 1.08], [3.4, -1.08]], bgy + 0.41, 1.2);
  out.colliders.push(obbBox3(bx, 0, bz, 10.3, 2.9 + bgy, 2.8, bry));

  // tires + rims for every vehicle (two instanced meshes, one draw call each)
  const tireMesh = new THREE.InstancedMesh(tireGeo, mats.rubber, wheelSlots.length);
  const rimMesh = new THREE.InstancedMesh(rimGeo, mats.rim, wheelSlots.length);
  // wheel wells: shadowed inner tub + fender arch lip over every wheel, so
  // wheels sit IN the body instead of glued beside it
  const wellGeo = new THREE.CylinderGeometry(0.45, 0.45, 0.2, 10);
  wellGeo.rotateX(Math.PI / 2);
  const archGeo = new THREE.CylinderGeometry(0.5, 0.5, 0.3, 10, 1, true, Math.PI / 2, Math.PI);
  archGeo.rotateX(Math.PI / 2); // upper half-shell arching over the tire
  const wellMesh = new THREE.InstancedMesh(wellGeo, mats.darkVoid, wheelSlots.length);
  const archMesh = new THREE.InstancedMesh(archGeo, mats.darkMetal, wheelSlots.length);
  wheelSlots.forEach(([wx, wy, wz, ry, s], i) => {
    setInstance(tireMesh, i, wx, wy, wz, 0, ry, 0, s, s, s * 1.05);
    setInstance(rimMesh, i, wx, wy, wz, 0, ry, 0, s, s, s * 1.12);
    setInstance(wellMesh, i, wx, wy, wz, 0, ry, 0, s);
    setInstance(archMesh, i, wx, wy, wz, 0, ry, 0, s);
  });
  tireMesh.castShadow = true;
  tireMesh.receiveShadow = true;
  finishInstanced(tireMesh);
  tireMesh.name = 'tires';
  rimMesh.castShadow = false;
  rimMesh.receiveShadow = true;
  finishInstanced(rimMesh);
  rimMesh.name = 'rims';
  wellMesh.castShadow = false;
  wellMesh.receiveShadow = false;
  wellMesh.userData.noHit = true;
  finishInstanced(wellMesh);
  wellMesh.name = 'wheel-wells';
  archMesh.castShadow = false;
  archMesh.receiveShadow = true;
  finishInstanced(archMesh);
  archMesh.name = 'fender-arches';
  out.group.add(tireMesh, rimMesh, wellMesh, archMesh);
}

/* ---------------------------- street furniture ----------------------------- */

export function buildStreetlights(mats, out) {
  const parts = [
    uvCyl(0.07, 0.095, 5.4, 8, { s: 0.5, y: 2.7 }),
    uvBox(1.5, 0.1, 0.12, { s: 0.5, x: 0.65, y: 5.32 }),
    uvBox(0.5, 0.16, 0.24, { s: 0.5, x: 1.3, y: 5.22 }),
  ];
  const geo = mergeGeometries(parts, false);
  // [x, z, ry] upright
  const up = [
    [9.2, 20.5, Math.PI], [-9.2, 35, 0], [9.2, -35, Math.PI], [-9.2, -20.5, 0],
    [20.5, 9.2, Math.PI / 2], [35, -9.2, -Math.PI / 2],
    [-35, 9.2, Math.PI / 2], [-20.5, -9.2, -Math.PI / 2],
  ];
  const mesh = new THREE.InstancedMesh(geo, mats.darkMetal, up.length + 2);
  up.forEach(([x, z, ry], i) => {
    const gy = groundHeightAt(x, z); // poles stand on the sidewalk strips
    setInstance(mesh, i, x, gy, z, 0, ry, 0, 1);
    out.colliders.push(box3Base(x, 0, z, 0.35, 5.4 + gy, 0.35));
  });
  setInstance(mesh, up.length, 44, 0.12, 26, 0, 0.2, 1.52, 1);      // fallen, ring east
  setInstance(mesh, up.length + 1, -16, 0.12, -39.5, 0, 2.6, -1.5, 1); // fallen, south
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  finishInstanced(mesh);
  mesh.name = 'streetlights';
  out.group.add(mesh);
}

export function buildWires(mats, out) {
  // The two 40 m+ rooftop spans carry heavy sag: with a shallow dip their
  // visible tail ends rendered as dead-straight lines across the sky.
  const spans = [
    [[9.2, 5.45, 20.5], [-9.2, 5.45, 35], 1.4],
    [[9.2, 5.45, -35], [-9.2, 5.45, -20.5], 1.4],
    [[20.5, 5.45, 9.2], [35, 5.45, -9.2], 1.4],
    [[-35, 5.45, 9.2], [-20.5, 5.45, -9.2], 1.4],
    [[-19.5, 15.9, -22], [-19.9, 9.5, 19.8], 4.5],
    [[34.5, 12.7, 33], [33, 9.5, -20.5], 4.5],
    [[9.2, 5.45, 20.5], [20.1, 6.2, 22], 0.8],
    [[-9.2, 5.45, -20.5], [-19.6, 6.4, -22.6], 0.8],
  ];
  const geos = [];
  const a = new THREE.Vector3(), b = new THREE.Vector3();
  for (const [pa, pb, sag] of spans) {
    a.set(pa[0], pa[1], pa[2]);
    b.set(pb[0], pb[1], pb[2]);
    const len = a.distanceTo(b);
    // Catenary droop, sampled explicitly so no span can read as a straight
    // line from any camera angle. Guaranteed dip >= 1.5% of the span (the
    // old bezier control point delivered only half its nominal sag, which
    // flattened out visually on the long sky-crossing spans).
    const dip = Math.max(sag * 0.9, 0.02 * len);
    const pts = [];
    const K = 8;
    for (let i = 0; i <= K; i++) {
      const t = i / K;
      const u = 2 * t - 1;
      // cosh-shaped catenary (flatter belly than a parabola)
      const shape = (Math.cosh(1.6 * u) - Math.cosh(1.6)) / (1 - Math.cosh(1.6));
      pts.push(new THREE.Vector3(
        a.x + (b.x - a.x) * t,
        a.y + (b.y - a.y) * t - dip * shape,
        a.z + (b.z - a.z) * t,
      ));
    }
    const curve = new THREE.CatmullRomCurve3(pts);
    geos.push(new THREE.TubeGeometry(curve, 28, 0.02, 4, false));
  }
  const mesh = mergeMesh(geos, mats.darkMetal, { shadow: false, receive: false, noHit: true, name: 'wires' });
  out.group.add(mesh);
}

export function buildSigns(mats, out) {
  const rand = rng(2707);
  const geos = [];
  const anchors = out.signAnchors.slice(0, 8);
  anchors.forEach((aSpec, i) => {
    const row = i % 4;
    const g = new THREE.PlaneGeometry(aSpec.w, aSpec.h);
    const uv = g.attributes.uv;
    const v0 = 1 - (row + 1) * 0.125 + 0.008, v1 = 1 - row * 0.125 - 0.008;
    for (let k = 0; k < uv.count; k++) {
      uv.setXY(k, 0.02 + uv.getX(k) * 0.96, v0 + uv.getY(k) * (v1 - v0));
    }
    g.rotateY(aSpec.ry + (rand() - 0.5) * 0.04);
    g.rotateZ((rand() - 0.5) * 0.05);
    g.translate(aSpec.x, aSpec.y, aSpec.z);
    geos.push(g);
  });
  if (geos.length) {
    const mesh = mergeMesh(geos, mats.sign, { shadow: false, name: 'signs' });
    out.group.add(mesh);
  }
  // flickering neon by the enterable building's door
  const neon = new THREE.Mesh(new THREE.PlaneGeometry(1.15, 0.6), mats.neon);
  neon.position.set(19.42, 3.05, -24.2);
  neon.rotation.y = -Math.PI / 2;
  neon.castShadow = false;
  neon.userData.noHit = true;
  neon.name = 'neon';
  out.group.add(neon);
  out.neonMat = mats.neon;
}

/* ------------------------------ scatter detail ----------------------------- */

/**
 * Clamp any ground-scatter instance tint to desaturated gray-browns.
 * Hard guard against stray saturated (pink/magenta/blue) debris specks:
 * saturation is crushed 65% toward luma and the blue channel can never
 * exceed red, so every possible output is a neutral or warm earth tone.
 */
function debrisTint(col, r, g, b) {
  const l = 0.35 * r + 0.5 * g + 0.15 * b;
  const rr = Math.min(1, Math.max(0, l + (r - l) * 0.35));
  let gg = Math.min(1, Math.max(0, l + (g - l) * 0.35));
  let bb = Math.min(1, Math.max(0, l + (b - l) * 0.35));
  bb = Math.min(bb, rr);            // never cooler than neutral (kills pink/blue)
  gg = Math.min(gg, rr * 1.02);     // green never dominates red (stays earthy)
  return col.setRGB(rr, gg, bb);
}

export function buildRubble(mats, out) {
  const rand = rng(2808);
  const spots = out.rubbleSpots.concat([
    { x: 18.5, z: -13.5, r: 2.0 }, { x: 36, z: 10.5, r: 2.2 },
    { x: -19, z: 30, r: 2.4 }, { x: 24, z: -36.5, r: 2.5 },
    { x: -13, z: -27, r: 2.0 }, { x: 14, z: 33, r: 1.8 },
    { x: 24, z: 57, r: 1.6 }, { x: 14.5, z: -14.5, r: 1.5 },
  ]);
  const chunkGeo = new THREE.IcosahedronGeometry(0.55, 0);
  const mats4 = [];
  const rebar = [];
  const coreGeos = [];
  for (const s of spots) {
    const big = !!s.big;
    const n = Math.round((big ? 5.2 : 4.2) * s.r);
    const mound = s.r * (big ? 0.5 : 0.33);
    const gy = groundHeightAt(s.x, s.z);
    // solid mound core under the chunks - chunks rest ON this, never hover
    if (mound > 0.25) {
      const dome = (rr, hh, ox, oz) => {
        const g = new THREE.SphereGeometry(1, 10, 5, 0, Math.PI * 2, 0, Math.PI / 2);
        g.scale(rr, hh, rr * (0.8 + rand() * 0.2));
        g.rotateY(rand() * Math.PI);
        uvScale(g, rr * 3 * mats.scale.concrete, hh * 3 * mats.scale.concrete);
        g.translate(s.x + ox, gy, s.z + oz);
        coreGeos.push(g);
      };
      dome(s.r * 0.9, mound, 0, 0);
      dome(s.r * 0.55, mound * 0.7, (rand() - 0.5) * s.r * 0.7, (rand() - 0.5) * s.r * 0.7);
    }
    for (let i = 0; i < n; i++) {
      const rr = s.r * Math.sqrt(rand());
      const ang = rand() * Math.PI * 2;
      const edge = 1 - 0.4 * (rr / s.r); // smaller chunks toward the pile edge
      const sc = ((big ? 0.45 : 0.28) + rand() * (big ? 0.85 : 0.5)) * edge;
      const px = s.x + Math.cos(ang) * rr;
      const pz = s.z + Math.sin(ang) * rr;
      // sit on / embed into the core profile at this radius (never float)
      const prof = (1 - (rr / s.r) ** 2) * mound;
      const py = gy + Math.max(sc * 0.25, prof * 0.85 - sc * 0.15);
      mats4.push([px, py, pz, rand() * Math.PI, rand() * Math.PI, rand() * Math.PI,
        sc, sc * (0.6 + rand() * 0.5), sc * (0.7 + rand() * 0.5)]);
    }
    if (s.r >= 2) {
      out.colliders.push(box3Base(s.x, 0, s.z, s.r * 1.4, big ? 2.2 : Math.max(0.6, s.r * 0.33), s.r * 1.4));
      const bars = big ? 7 : 4;
      for (let i = 0; i < bars; i++) {
        const ang = rand() * Math.PI * 2, rr = rand() * s.r * 0.7;
        rebar.push([s.x + Math.cos(ang) * rr, gy + mound * 0.4, s.z + Math.sin(ang) * rr,
          (rand() - 0.5) * 1.2, rand() * Math.PI, (rand() - 0.5) * 1.2]);
      }
    }
  }
  const coreMesh = mergeMesh(coreGeos, mats.concreteDark, { name: 'rubble-core' });
  if (coreMesh) out.group.add(coreMesh);
  const mesh = new THREE.InstancedMesh(chunkGeo, mats.concrete, mats4.length);
  const col = new THREE.Color();
  mats4.forEach((m, i) => {
    setInstance(mesh, i, m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8]);
    const t = 0.6 + rand() * 0.3; // muted concrete-debris tones, not white
    mesh.setColorAt(i, debrisTint(col, t, t * 0.98, t * 0.94));
  });
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  finishInstanced(mesh);
  mesh.name = 'rubble';
  out.group.add(mesh);

  const barGeo = new THREE.CylinderGeometry(0.016, 0.016, 1.3, 5);
  const barMesh = new THREE.InstancedMesh(barGeo, mats.rust, rebar.length);
  rebar.forEach((m, i) => setInstance(barMesh, i, m[0], m[1], m[2], m[3], m[4], m[5], 1));
  barMesh.castShadow = false;
  barMesh.receiveShadow = true;
  barMesh.userData.noHit = true;
  finishInstanced(barMesh);
  barMesh.name = 'rebar';
  out.group.add(barMesh);
}

export function buildDebris(mats, out) {
  const rand = rng(2909);
  const geo = new THREE.IcosahedronGeometry(0.5, 0);
  const COUNT = 380;
  const mesh = new THREE.InstancedMesh(geo, mats.concreteDark, COUNT);
  // dust contact splat under every chunk (single instanced draw)
  const dustGeo = new THREE.PlaneGeometry(1, 1);
  dustGeo.rotateX(-Math.PI / 2);
  const dust = new THREE.InstancedMesh(dustGeo, mats.dustDecal, COUNT);
  const col = new THREE.Color();
  // concrete debris clusters at the feet of the damaged buildings,
  // not a uniform carpet across the arena
  const clusters = [
    [27.5, 20, 6], [21, 27.5, 5], [-26, 18.5, 6], [-18.5, 26, 5],
    [-27, -20.5, 7], [-19.5, -27, 5], [26.5, -19.5, 6], [19, -26, 5],
    [20, 53.5, 7], [31, 55, 5], [-25, 54.5, 6], [45, -25, 5],
    [-45, 25, 5], [55, 10, 5], [-55, -10, 5], [10, -54, 5],
  ];
  let placed = 0, guard = 0;
  while (placed < COUNT && guard++ < COUNT * 6) {
    let px, pz;
    if (rand() < 0.78) { // clustered near damage
      const c = clusters[Math.floor(rand() * clusters.length)];
      px = c[0] + (rand() + rand() - 1) * c[2];
      pz = c[1] + (rand() + rand() - 1) * c[2];
    } else { // sparse strays
      px = (rand() - 0.5) * 112;
      pz = (rand() - 0.5) * 112;
    }
    if (Math.abs(px) < 4.5 && Math.abs(pz) < 4.5) continue; // fountain
    if (Math.abs(px) > 58 || Math.abs(pz) > 58) continue;
    const sc = 0.05 + rand() * 0.10; // hard 15 cm cap
    const gy = groundHeightAt(px, pz);
    setInstance(mesh, placed, px, gy + sc * 0.3, pz,
      rand() * Math.PI, rand() * Math.PI, rand() * Math.PI,
      sc, sc * (0.5 + rand() * 0.6), sc * (0.6 + rand() * 0.6));
    // concrete-debris tint (~#6f6c66 against the concreteDark base map),
    // clamped to gray-brown (the old formula let blue lead => cool specks)
    const t = 0.86 + rand() * 0.16;
    mesh.setColorAt(placed, debrisTint(col, 0.96 * t, 0.95 * t, 0.9 * t));
    const ds = sc * (2.2 + rand() * 1.6);
    setInstance(dust, placed, px, gy + 0.006, pz, 0, rand() * Math.PI * 2, 0, ds, 1, ds);
    placed++;
  }
  mesh.count = placed;
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  mesh.userData.noHit = true;
  finishInstanced(mesh);
  mesh.name = 'debris';
  dust.count = placed;
  dust.castShadow = false;
  dust.receiveShadow = true;
  dust.userData.noHit = true;
  finishInstanced(dust);
  dust.name = 'debris-dust';
  out.group.add(mesh, dust);
}

export function buildPapers(mats, out) {
  const rand = rng(3010);
  const geo = new THREE.PlaneGeometry(0.3, 0.38);
  // density cut to ~30% of the old 90-quad scatter (and the paper map itself
  // dropped to #b8b4a8): the plaza must not read as white confetti
  const COUNT = 28;
  const mesh = new THREE.InstancedMesh(geo, mats.paper, COUNT);
  for (let i = 0; i < COUNT; i++) {
    let px, pz;
    const zone = rand();
    if (zone < 0.4) { // plaza
      px = (rand() - 0.5) * 30; pz = (rand() - 0.5) * 30;
    } else if (zone < 0.7) { // arms
      const swap = rand() < 0.5;
      const a = (rand() - 0.5) * 13, b = (rand() < 0.5 ? 1 : -1) * (17 + rand() * 22);
      px = swap ? b : a; pz = swap ? a : b;
    } else { // ring
      const swap = rand() < 0.5;
      const a = (rand() < 0.5 ? 1 : -1) * (41 + rand() * 12), b = (rand() - 0.5) * 104;
      px = swap ? b : a; pz = swap ? a : b;
    }
    setInstance(mesh, i, px, groundHeightAt(px, pz) + 0.008, pz,
      -Math.PI / 2 + (rand() - 0.5) * 0.1, rand() * Math.PI * 2, (rand() - 0.5) * 0.08,
      0.8 + rand() * 0.5);
  }
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  mesh.userData.noHit = true;
  finishInstanced(mesh);
  mesh.name = 'papers';
  out.group.add(mesh);

  // trash / cardboard cards drifted into the gutters along curb lines
  const trashGeo = new THREE.PlaneGeometry(1, 1);
  const TCOUNT = 64;
  const trash = new THREE.InstancedMesh(trashGeo, mats.trash, TCOUNT);
  const col = new THREE.Color();
  // gutter segments [x0, z0, x1, z1] hugging lane edges + sidewalk fronts
  const gutters = [
    [6.3, 17, 6.3, 39], [-6.3, 17, -6.3, 39], [6.3, -17, 6.3, -39], [-6.3, -17, -6.3, -39],
    [17, 6.3, 39, 6.3], [17, -6.3, 39, -6.3], [-17, 6.3, -39, 6.3], [-17, -6.3, -39, -6.3],
    [53.2, -50, 53.2, 50], [-53.2, -50, -53.2, 50], [-45, 53.2, 45, 53.2], [-45, -53.2, 45, -53.2],
    [40.8, -35, 40.8, 35], [-40.8, -35, -40.8, 35], [-35, 40.8, 35, 40.8], [-35, -40.8, 35, -40.8],
  ];
  const tints = [[0.74, 0.62, 0.46], [0.62, 0.6, 0.56], [0.86, 0.84, 0.78], [0.55, 0.48, 0.4]];
  for (let i = 0; i < TCOUNT; i++) {
    const g = gutters[Math.floor(rand() * gutters.length)];
    const t = rand();
    const px = g[0] + (g[2] - g[0]) * t + (rand() - 0.5) * 1.2;
    const pz = g[1] + (g[3] - g[1]) * t + (rand() - 0.5) * 1.2;
    const s = 0.16 + rand() * 0.26;
    setInstance(trash, i, px, groundHeightAt(px, pz) + 0.006, pz,
      -Math.PI / 2 + (rand() - 0.5) * 0.12, rand() * Math.PI * 2, (rand() - 0.5) * 0.1,
      s, s * (0.7 + rand() * 0.5), s);
    const tc = tints[Math.floor(rand() * tints.length)];
    const j = 0.85 + rand() * 0.3;
    trash.setColorAt(i, debrisTint(col, tc[0] * j, tc[1] * j, tc[2] * j));
  }
  trash.castShadow = false;
  trash.receiveShadow = true;
  trash.userData.noHit = true;
  finishInstanced(trash);
  trash.name = 'trash';
  out.group.add(trash);
}
