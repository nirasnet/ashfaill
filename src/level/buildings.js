// Damaged-building generator, arena building layout, and background skyline.
// Owned by the level agent.
import * as THREE from 'three';
import { rng } from '../utils.js';
import { uvBox, mergeMesh, box3Base, setInstance, finishInstanced } from './geo.js';

export const FLOOR_H = 3.2;
const WALL_T = 0.34;
const WIN_W = 1.5;
const WIN_H = 1.5;
const SILL_H = 1.05;
const HEAD_H = FLOOR_H - SILL_H - WIN_H; // 0.65
const REV_D = 0.30; // reveal depth: visible wall-section return at every opening
const REV_T = 0.07; // reveal thickness

/**
 * Base-of-wall AO + grime gradient baked as vertex colors (multiplies the
 * wall map): the lowest 50 cm is darkened ~25% (contact-shadow AO so the
 * building sits ON the ground instead of floating), blending out through a
 * ragged splash-grime band that clears by ~1.6 m. World x/z wobble the band
 * edge. Used with the *Wall material variants (vertexColors: true).
 */
function grimeAttr(g) {
  const pos = g.attributes.position;
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const wob = 0.85 + 0.3 * Math.abs(Math.sin(pos.getX(i) * 1.7 + pos.getZ(i) * 2.3));
    const y = pos.getY(i);
    const tAO = Math.min(1, Math.max(0, y / 0.5));            // 25% AO, lowest 50 cm
    const tGr = Math.min(1, Math.max(0, (y - 0.5) / (1.1 * wob))); // grime tail
    const v = (0.75 + 0.10 * tAO) + 0.15 * tGr;
    col[i * 3] = v;
    col[i * 3 + 1] = v * (0.985 + 0.015 * tGr);  // grime slightly warm at the base
    col[i * 3 + 2] = v * (0.96 + 0.04 * tGr);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

/**
 * Generate one damaged building (axis-aligned) and append it to `out`.
 * opts: { x, z, w, d, floors, style:'brick'|'concrete', seed, damage:0..1,
 *         door:{side, col?}|null, openSide:int|null, sign:boolean }
 * Sides: 0:+z  1:-z  2:+x  3:-x
 * out:  { group, colliders[], darkGeos[], signAnchors[], wireAnchors[], rubbleSpots[] }
 */
export function addBuilding(opts, mats, out) {
  const {
    x, z, w, d, floors, style = 'brick', seed = 1, damage = 0.5,
    door = null, openSide = null, sign = false,
  } = opts;
  const rand = rng(seed);
  const wallGeos = [];
  const concGeos = [];
  const winGeos = [];
  const wallS = style === 'brick' ? mats.scale.brick : mats.scale.concrete;
  const H = floors * FLOOR_H;

  // X-normal facades are inset by WALL_T so corners butt cleanly (no coplanar faces).
  const sides = [
    { nx: 0, nz: 1, fw: w, off: d / 2 },
    { nx: 0, nz: -1, fw: w, off: d / 2 },
    { nx: 1, nz: 0, fw: d - 2 * WALL_T, off: w / 2 },
    { nx: -1, nz: 0, fw: d - 2 * WALL_T, off: w / 2 },
  ];

  for (let si = 0; si < 4; si++) {
    const S = sides[si];
    const alongX = S.nz !== 0;
    const cols = Math.max(1, Math.floor((S.fw - 1.4) / 2.7));
    const pierW = (S.fw - cols * WIN_W) / (cols + 1);
    const doorHere = (door && door.side === si) ? door : null;
    const doorCol = doorHere ? (doorHere.col ?? Math.floor(cols / 2)) : -1;
    const openHere = openSide === si;

    const wallX = alongX ? null : x + S.nx * (S.off - WALL_T / 2);
    const wallZ = alongX ? z + S.nz * (S.off - WALL_T / 2) : null;

    const place = (len, hgt, yBase, u) => {
      wallGeos.push(uvBox(
        alongX ? len : WALL_T, hgt, alongX ? WALL_T : len,
        {
          s: wallS, rand,
          x: alongX ? x + u : wallX, y: yBase + hgt / 2, z: alongX ? wallZ : z + u,
        },
      ));
    };
    // Reveal box: du along the facade, dh tall, dd deep, centered at depthOff
    // from the building center along the facade normal. Concrete on every
    // style, so window cuts read as real wall sections (matches the
    // open-front ruin's construction).
    const rvb = (du, dh, dd, u, yC, depthOff) => {
      concGeos.push(uvBox(
        alongX ? du : dd, dh, alongX ? dd : du,
        {
          s: mats.scale.concrete, rand,
          x: alongX ? x + u : x + S.nx * depthOff,
          y: yC,
          z: alongX ? z + S.nz * depthOff : z + u,
        },
      ));
    };
    const revealJambs = (u, yBase, hgt) => {
      rvb(REV_T, hgt, REV_D, u - WIN_W / 2 + REV_T / 2, yBase + hgt / 2, S.off - REV_D / 2);
      rvb(REV_T, hgt, REV_D, u + WIN_W / 2 - REV_T / 2, yBase + hgt / 2, S.off - REV_D / 2);
    };
    const revealHead = (u, yTop) => {
      rvb(WIN_W, REV_T, REV_D, u, yTop - REV_T / 2, S.off - REV_D / 2);
    };
    // Glass/blind/curtain/interior-card pane from the 4x4 variation atlas,
    // inset 15 cm behind the facade face, wrapped by a REAL 10 cm painted
    // frame (4 sash members, merged level-wide into one winFrame mesh).
    const placeWin = (u, yBase) => {
      const cell = Math.floor(rand() * 16);
      const cu = (cell % 4) * 0.25, cv = Math.floor(cell / 4) * 0.25;
      const g = new THREE.BoxGeometry(
        alongX ? WIN_W + 0.06 : 0.05, WIN_H + 0.06, alongX ? 0.05 : WIN_W + 0.06,
      );
      const uv = g.attributes.uv;
      for (let i = 0; i < uv.count; i++) {
        uv.setXY(i, cu + 0.008 + uv.getX(i) * 0.234, cv + 0.008 + uv.getY(i) * 0.234);
      }
      const inset = 0.15;
      const wx = alongX ? x + u : x + S.nx * (S.off - inset);
      const wz = alongX ? z + S.nz * (S.off - inset) : z + u;
      const wy = yBase + SILL_H + WIN_H / 2;
      g.translate(wx, wy, wz);
      winGeos.push(g);
      if (out.frameGeos) {
        const FT = 0.10, FD = 0.07; // 10 cm members, slightly proud of the glass
        const fx = alongX ? x + u : x + S.nx * (S.off - inset + 0.035);
        const fz = alongX ? z + S.nz * (S.off - inset + 0.035) : z + u;
        const horiz = (yC) => out.frameGeos.push(uvBox(
          alongX ? WIN_W + 0.06 : FD, FT, alongX ? FD : WIN_W + 0.06,
          { s: 1, x: fx, y: yC, z: fz },
        ));
        const vert = (uOff) => out.frameGeos.push(uvBox(
          alongX ? FT : FD, WIN_H - 2 * FT, alongX ? FD : FT,
          {
            s: 1,
            x: alongX ? fx + uOff : fx,
            y: wy,
            z: alongX ? fz : fz + uOff,
          },
        ));
        horiz(yBase + SILL_H + FT / 2);
        horiz(yBase + SILL_H + WIN_H - FT / 2);
        vert(-(WIN_W + 0.06 - FT) / 2);
        vert((WIN_W + 0.06 - FT) / 2);
      }
    };

    for (let f = 0; f < floors; f++) {
      const yB = f * FLOOR_H;
      const top = f === floors - 1;
      const dmg = f === 0 ? 0 : Math.min(0.7, damage * (0.12 + 0.11 * f) + (top ? damage * 0.28 : 0));
      // piers (track survival so reveals never float beside a missing pier)
      const pierUp = [];
      for (let p = 0; p <= cols; p++) {
        const u = -S.fw / 2 + p * (pierW + WIN_W) + pierW / 2;
        let up = true;
        if (openHere && f === 0 && p > 0 && p < cols) up = false;
        else if (f > 0 && p > 0 && p < cols && rand() < dmg * 0.4) up = false;
        pierUp.push(up);
        if (up) place(pierW, FLOOR_H, yB, u);
      }
      // window cells
      for (let k = 0; k < cols; k++) {
        const u = -S.fw / 2 + (k + 1) * pierW + (k + 0.5) * WIN_W;
        if (openHere && f === 0) continue;
        const isDoor = doorHere && f === 0 && k === doorCol;
        const blown = f > 0 && rand() < dmg;
        if (isDoor) {
          place(WIN_W, HEAD_H, yB + SILL_H + WIN_H, u); // header above door
          revealJambs(u, yB, SILL_H + WIN_H);
          revealHead(u, yB + SILL_H + WIN_H);
        } else if (blown) {
          if (rand() < 0.35) place(WIN_W, 0.3, yB, u);  // broken sill stub
          // blown-out cell still shows a wall section, not a paper edge
          if (pierUp[k]) rvb(REV_T, FLOOR_H, REV_D, u - WIN_W / 2 + REV_T / 2, yB + FLOOR_H / 2, S.off - REV_D / 2);
          if (pierUp[k + 1]) rvb(REV_T, FLOOR_H, REV_D, u + WIN_W / 2 - REV_T / 2, yB + FLOOR_H / 2, S.off - REV_D / 2);
          revealHead(u, yB + FLOOR_H); // slab-edge return at the cell top
        } else {
          place(WIN_W, SILL_H, yB, u);
          place(WIN_W, HEAD_H, yB + SILL_H + WIN_H, u);
          revealJambs(u, yB + SILL_H, WIN_H);
          revealHead(u, yB + SILL_H + WIN_H);
          // protruding sill tray
          rvb(WIN_W + 0.16, 0.09, 0.42, u, yB + SILL_H + 0.045, S.off - 0.17);
          placeWin(u, yB);
        }
      }
      // open ground-floor bay: reveal returns on the surviving edge piers
      if (openHere && f === 0 && cols > 0) {
        const uEdge = S.fw / 2 - pierW;
        rvb(REV_T, FLOOR_H, REV_D, -uEdge + REV_T / 2, yB + FLOOR_H / 2, S.off - REV_D / 2);
        rvb(REV_T, FLOOR_H, REV_D, uEdge - REV_T / 2, yB + FLOOR_H / 2, S.off - REV_D / 2);
      }
    }

    // parapet, segmented so damage can bite pieces out of the roofline
    const segs = cols * 2 + 1;
    const step = S.fw / segs;
    for (let sIdx = 0; sIdx < segs; sIdx++) {
      if (rand() < damage * 0.45) continue;
      place(step * 0.96, 0.45, H, -S.fw / 2 + step * (sIdx + 0.5));
    }

    // collision: one wall slab per side, split around the door / open bay
    const cw = alongX ? S.fw + 0.2 : WALL_T;
    const cd = alongX ? WALL_T : S.fw + 0.2;
    const ccx = alongX ? x : wallX;
    const ccz = alongX ? wallZ : z;
    if (doorHere) {
      const uD = -S.fw / 2 + (doorCol + 1) * pierW + (doorCol + 0.5) * WIN_W;
      const gapHalf = WIN_W / 2 + 0.12;
      const aLen = (uD - gapHalf) - (-S.fw / 2);
      const bLen = (S.fw / 2) - (uD + gapHalf);
      if (aLen > 0.05) {
        const c = -S.fw / 2 + aLen / 2;
        out.colliders.push(box3Base(alongX ? x + c : ccx, 0, alongX ? ccz : z + c,
          alongX ? aLen : WALL_T, H, alongX ? WALL_T : aLen));
      }
      if (bLen > 0.05) {
        const c = S.fw / 2 - bLen / 2;
        out.colliders.push(box3Base(alongX ? x + c : ccx, 0, alongX ? ccz : z + c,
          alongX ? bLen : WALL_T, H, alongX ? WALL_T : bLen));
      }
    } else if (openHere) {
      const stub = pierW + 0.4;
      for (const sgn of [-1, 1]) {
        const c = sgn * (S.fw / 2 - stub / 2);
        out.colliders.push(box3Base(alongX ? x + c : ccx, 0, alongX ? ccz : z + c,
          alongX ? stub : WALL_T, H, alongX ? WALL_T : stub));
      }
    } else {
      out.colliders.push(box3Base(ccx, 0, ccz, cw, H, cd));
    }
  }

  // Unlit dark interior liner (midday): the atmosphere sun leaks through the
  // shell walls, so without this every window opening / blown-out cell shows a
  // bright sun-lit interior face — reading as "glowing windows" at noon. One
  // dark box (darkVoid, merged into 'dark-extra') fills the interior 6 cm
  // behind the wall inner faces. Ground floor is skipped when the building is
  // enterable (door or open bay) so real interiors stay real.
  {
    const linerY0 = (door || openSide !== null) ? FLOOR_H : 0.12;
    const linerY1 = H - 0.2;
    if (linerY1 - linerY0 > 0.5) {
      out.darkGeos.push(uvBox(
        w - 2 * WALL_T - 0.12, linerY1 - linerY0, d - 2 * WALL_T - 0.12,
        { s: mats.scale.dark, rand, x, y: (linerY0 + linerY1) / 2, z },
      ));
    }
  }

  // floor slabs + roof (broken roofs on heavy damage), interior ground pad
  for (let f = 1; f <= floors; f++) {
    const roof = f === floors;
    if (roof && damage > 0.55 && rand() < 0.8) {
      concGeos.push(uvBox(
        (w - 0.5) * (0.45 + rand() * 0.3), 0.16, (d - 0.5) * (0.5 + rand() * 0.3),
        {
          s: mats.scale.concrete, rand,
          x: x + (rand() - 0.5) * w * 0.25, y: f * FLOOR_H - 0.08, z: z + (rand() - 0.5) * d * 0.25,
        },
      ));
    } else {
      concGeos.push(uvBox(w - 0.5, 0.16, d - 0.5,
        { s: mats.scale.concrete, rand, x, y: f * FLOOR_H - 0.08, z }));
    }
  }
  concGeos.push(uvBox(w - 0.4, 0.1, d - 0.4, { s: mats.scale.concrete, rand, x, y: 0.05, z }));

  // corner chip decals: spalled patches hugging every building corner so the
  // brick/concrete tiling breaks up exactly where the eye checks for it
  if (out.chipGeos) {
    const chip = (px, pz, nx, nz, yC, sc) => {
      const g = new THREE.PlaneGeometry(sc, sc * (0.7 + rand() * 0.6));
      const cell = Math.floor(rand() * 4);
      const u0 = (cell % 2) * 0.5, v0 = Math.floor(cell / 2) * 0.5;
      const uv = g.attributes.uv;
      for (let i = 0; i < uv.count; i++) {
        uv.setXY(i, u0 + 0.02 + uv.getX(i) * 0.46, v0 + 0.02 + uv.getY(i) * 0.46);
      }
      g.rotateY(Math.atan2(nx, nz));
      g.translate(px + nx * 0.012, yC, pz + nz * 0.012);
      out.chipGeos.push(g);
    };
    for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const cx = x + sx * (w / 2), cz = z + sz * (d / 2);
      const nChips = 1 + Math.floor(rand() * 2);
      for (let i = 0; i < nChips; i++) {
        if (rand() < 0.3) continue;
        const yC = 0.3 + rand() * Math.min(H - 0.6, 6);
        const sc = 0.16 + rand() * 0.3;
        if (rand() < 0.5) chip(cx - sx * (0.1 + rand() * 0.3), cz, 0, sz, yC, sc);
        else chip(cx, cz - sz * (0.1 + rand() * 0.3), sx, 0, yC, sc);
      }
    }
  }

  // meshes (per building => tight bounding spheres for raycast + frustum culling)
  // Walls use the vertexColors material variants: grimeAttr bakes the
  // bottom-1.5 m grime gradient into every wall/reveal/slab geometry.
  for (const g of wallGeos) grimeAttr(g);
  for (const g of concGeos) grimeAttr(g);
  if (style === 'brick') {
    const wm = mergeMesh(wallGeos, mats.brickWall, { name: 'bldg-brick' });
    if (wm) out.group.add(wm);
    const cm = mergeMesh(concGeos, mats.concreteWall, { name: 'bldg-conc' });
    if (cm) out.group.add(cm);
  } else {
    const all = wallGeos.concat(concGeos);
    const wm = mergeMesh(all, rand() < 0.5 ? mats.concreteWall : mats.concreteDarkWall, { name: 'bldg-conc' });
    if (wm) out.group.add(wm);
  }
  const wnm = mergeMesh(winGeos, mats.window, { shadow: false, name: 'bldg-win' });
  if (wnm) out.group.add(wnm);

  // wire anchors on two roof corners
  out.wireAnchors.push(
    new THREE.Vector3(x + w / 2 - 0.5, H + 0.1, z + d / 2 - 0.5),
    new THREE.Vector3(x - w / 2 + 0.5, H + 0.1, z - d / 2 + 0.5),
  );

  // sign anchor on the facade facing the arena center
  if (sign) {
    let best = 0, bestDot = -Infinity;
    for (let si = 0; si < 4; si++) {
      const S = sides[si];
      const dot = S.nx * (0 - x) + S.nz * (0 - z);
      if (dot > bestDot) { bestDot = dot; best = si; }
    }
    const S = sides[best];
    const ry = S.nz === 1 ? 0 : S.nz === -1 ? Math.PI : S.nx === 1 ? Math.PI / 2 : -Math.PI / 2;
    out.signAnchors.push({
      x: x + S.nx * (S.off + 0.07), y: Math.min(3.55, H - 0.8), z: z + S.nz * (S.off + 0.07),
      ry, w: Math.min(S.fw * 0.6, 6.5), h: 1.15,
    });
  }
}

/** The four inner-quadrant buildings + annexes. Returns the enterable-building info. */
export function addQuadrantBuildings(mats, out) {
  addBuilding({ x: 27.5, z: 27.5, w: 15, d: 12, floors: 4, style: 'brick', seed: 4101, damage: 0.5, sign: true }, mats, out);
  addBuilding({ x: 34, z: 16.5, w: 7, d: 8, floors: 2, style: 'concrete', seed: 4102, damage: 0.6 }, mats, out);

  addBuilding({ x: -26, z: 26, w: 13, d: 13, floors: 3, style: 'concrete', seed: 4201, damage: 0.55, sign: true }, mats, out);
  addBuilding({ x: -17.5, z: 34.5, w: 8, d: 6, floors: 2, style: 'brick', seed: 4202, damage: 0.5 }, mats, out);

  addBuilding({ x: -27, z: -27, w: 16, d: 11, floors: 5, style: 'brick', seed: 4301, damage: 0.6, sign: true }, mats, out);
  addBuilding({ x: -33.5, z: -16.5, w: 6, d: 7, floors: 2, style: 'concrete', seed: 4302, damage: 0.65 }, mats, out);

  // the enterable building: door on -x facade, faces the alley strip
  addBuilding({
    x: 26.5, z: -26, w: 14, d: 11, floors: 3, style: 'brick', seed: 4401,
    damage: 0.45, door: { side: 3 }, sign: true,
  }, mats, out);
  addBuilding({ x: 32, z: -35, w: 9, d: 7, floors: 2, style: 'concrete', seed: 4402, damage: 0.65 }, mats, out);

  return { enterable: { x: 26.5, z: -26, w: 14, d: 11 } };
}

/** Perimeter building rows that wall the arena, plus the open-front ruin. */
export function addPerimeter(mats, out) {
  const rand = rng(9091);
  const rows = [
    { ax: 'z', sign: 1, from: -56, to: 56 },
    { ax: 'z', sign: -1, from: -56, to: 56 },
    { ax: 'x', sign: 1, from: -44, to: 44 },
    { ax: 'x', sign: -1, from: -44, to: 44 },
  ];
  for (const row of rows) {
    let u = row.from;
    while (u < row.to - 8) {
      let bw = 14 + rand() * 12;
      if (u + bw > row.to) bw = row.to - u;
      if (bw < 8) break;
      const cx = u + bw / 2;
      // leave a slot on the +z row for the hand-placed open-front ruin (x 12..28)
      if (row.ax === 'z' && row.sign === 1 && u + bw > 10 && u < 30) {
        u = 30.5 + rand() * 3;
        out.rubbleSpots.push({ x: 31, z: 57, r: 2.2, big: false });
        continue;
      }
      const depth = 9 + rand() * 2;
      const floors = 3 + Math.floor(rand() * 3);
      const px = row.ax === 'z' ? cx : row.sign * 60;
      const pz = row.ax === 'z' ? row.sign * 60 : cx;
      addBuilding({
        x: px, z: pz,
        w: row.ax === 'z' ? bw : depth,
        d: row.ax === 'z' ? depth : bw,
        floors, style: rand() < 0.5 ? 'brick' : 'concrete',
        seed: Math.floor(rand() * 1e6) + 17,
        damage: 0.45 + rand() * 0.4,
        sign: rand() < 0.3,
      }, mats, out);
      const gap = 2 + rand() * 4;
      const gu = u + bw + gap / 2;
      if (gu < row.to - 2) {
        out.rubbleSpots.push({
          x: row.ax === 'z' ? gu : row.sign * 56.5,
          z: row.ax === 'z' ? row.sign * 56.5 : gu,
          r: 2 + rand() * 1.2, big: false,
        });
      }
      u += bw + gap;
    }
  }

  // open-front ruin (second enterable interior: a sniper-nest ground floor)
  addBuilding({
    x: 20, z: 59.5, w: 16, d: 10, floors: 3, style: 'concrete', seed: 5501,
    damage: 0.85, openSide: 1, sign: false,
  }, mats, out);

  // arena corner rubble mountains
  for (const [sx, sz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
    out.rubbleSpots.push({ x: sx * 55, z: sz * 55, r: 5.5, big: true });
  }
}

/** Constant per-tower vertex color (multiplies the near-white facade map). */
function flatColor(g, r, gg, b) {
  const n = g.attributes.position.count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    col[i * 3] = r;
    col[i * 3 + 1] = gg;
    col[i * 3 + 2] = b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

/**
 * Background skyline. No sticker-window extrusions: towers are merged real
 * geometry with floor-aligned facade UVs (1 texture tile = one 3.2 m floor,
 * spandrel band + inset-shaded windows baked). The near ring (< 150 m) gets
 * REAL 0.4 m spandrel band boxes protruding 0.15 m each floor, so the glass
 * curtain reads inset; farther rings rely on the baked band/shadow parallax.
 * Every roofline carries a parapet + HVAC roof clutter. Tower albedo varies
 * #2e3138..#4a4d55 via per-tower vertex colors. 3 draw calls total.
 */
export function buildSkyline(mats) {
  const rand = rng(7788);
  const FLOOR = 3.2;
  const facadeGeos = [], bandGeos = [];
  const hvac = []; // [x, y, z, ry, sx, sy, sz]
  // albedo floor 0x383c44 (> #2c3038 after the map multiply): daylight towers
  // must never read pure black even on their unlit faces
  const cLo = new THREE.Color(0x383c44), cHi = new THREE.Color(0x585c65);
  const cc = new THREE.Color();
  let placed = 0, guard = 0;
  while (placed < 110 && guard++ < 4000) {
    const ang = rand() * Math.PI * 2;
    const rad = 82 + rand() * 175;
    const px = Math.cos(ang) * rad;
    const pz = Math.sin(ang) * rad;
    if (Math.abs(px) < 68 && Math.abs(pz) < 68) continue;
    const w = 10 + rand() * 20;
    const dd = 10 + rand() * 20;
    const floors = Math.max(5, Math.round((16 + Math.pow(rand(), 1.4) * 72) / FLOOR));
    const H = floors * FLOOR;
    const ry = rand() * Math.PI;
    // facade core: floor-aligned world-scaled UVs (no rand => v0 sits on a
    // floor line and the spandrel rows land exactly at each slab). The map is
    // a 4x4-floor block, so one tile = 4 floors.
    const core = uvBox(w, H, dd, { s: 1 / (FLOOR * 4), ry, x: px, y: H / 2, z: pz });
    cc.lerpColors(cLo, cHi, rand());
    const j = 0.94 + rand() * 0.12;
    flatColor(core, cc.r * j, cc.g * j, cc.b * j);
    facadeGeos.push(core);
    // real spandrel band geometry on the nearest ring
    if (rad < 150) {
      for (let f = 1; f < floors; f++) {
        bandGeos.push(uvBox(w + 0.3, 0.4, dd + 0.3, { ry, x: px, y: f * FLOOR + 0.2, z: pz }));
      }
    }
    // parapet on every roofline
    bandGeos.push(uvBox(w + 0.35, 0.8, dd + 0.35, { ry, x: px, y: H + 0.25, z: pz }));
    // roof clutter: HVAC boxes / stair heads breaking the flat silhouette
    const ca = Math.cos(ry), sa = Math.sin(ry);
    const nH = 2 + Math.floor(rand() * 3);
    for (let k = 0; k < nH; k++) {
      const hw = 1.5 + rand() * 3, hh = 1.2 + rand() * 2.4, hd = 1.5 + rand() * 3;
      const lx = (rand() - 0.5) * Math.max(1, w - hw - 1.5);
      const lz = (rand() - 0.5) * Math.max(1, dd - hd - 1.5);
      hvac.push([px + lx * ca + lz * sa, H + hh / 2, pz - lx * sa + lz * ca, ry, hw, hh, hd]);
    }
    placed++;
  }
  const group = new THREE.Group();
  group.name = 'skyline';
  const fMesh = mergeMesh(facadeGeos, mats.skyline,
    { shadow: false, receive: false, name: 'skyline-facades' });
  if (fMesh) group.add(fMesh);
  const bMesh = mergeMesh(bandGeos, mats.spandrel,
    { shadow: false, receive: false, name: 'skyline-bands' });
  if (bMesh) group.add(bMesh);
  const hGeo = new THREE.BoxGeometry(1, 1, 1);
  const hMesh = new THREE.InstancedMesh(hGeo, mats.darkMetal, hvac.length);
  hvac.forEach((mtx, i) =>
    setInstance(hMesh, i, mtx[0], mtx[1], mtx[2], 0, mtx[3], 0, mtx[4], mtx[5], mtx[6]));
  hMesh.castShadow = false;
  hMesh.receiveShadow = false;
  finishInstanced(hMesh);
  hMesh.name = 'skyline-roof-clutter';
  group.add(hMesh);
  return group;
}
