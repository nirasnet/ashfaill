// LEVEL / ENVIRONMENT — owns: terrain, buildings, props, all static geometry + materials.
//
// A ~120x120 m ruined-city arena: an asphalt plaza with a wrecked fountain at
// the center, four asphalt street arms, a perimeter ring road, quadrant blocks with
// 2-5 story damaged buildings (one enterable via its door, plus an open-front
// ruin on the north wall), and a perimeter row of shattered facades walling the
// arena. Beyond it, a skyline of banded towers (real spandrel geometry on the
// near ring, parapets + HVAC roof clutter on every roofline, a sparse dim
// emissive window grid, albedo clamped off pure black) fades into the fog.
// Street hierarchy: 4 m sidewalk strips behind 15 cm curb meshes, expansion
// joints, manhole + storm-drain decals, spline-aligned eroded lane paint,
// charcoal patch repairs, and tire-wear bands along the drive lanes.
// Cover: sandbag emplacements (deformed stacked bags, per-bag hue), jersey
// barriers with chipped paint + edge chips + top-down grime, dumpsters,
// burned cars (framed cabins, inset reflective glass, wheel wells), a wrecked
// bus, containers (desaturated paint), barrels, pallets, rubble+rebar piles;
// scatter: debris (tint-clamped to gray-browns), sparse desaturated papers,
// sagging catenary wires, painted signage, scorch craters, corner chips, and
// a base-of-wall AO/grime gradient on every wall. Midday scene: window glass
// is dielectric + env-reflective (inset 15 cm, real 10 cm frames); ~25% of
// panes carry a DIM warm interior card so facades read inhabited — no
// clipped-white noon windows.
//
// All geometry is procedural. Repeated props are InstancedMesh; buildings are
// merged per building (tight bounds => cheap raycasts + culling). Total level
// draw calls ~90, far under the 300 budget.
//
// Collision strategy: visual meshes are registered as raycast solids only
// (collide:false — bullets and LOS test real geometry, so windows are
// see-through). Movement collision is hand-authored Box3 volumes (walls with
// door gaps, props, arena boundary) plus one floor box from the ground mesh.
import * as THREE from 'three';
import { buildMaterials } from './level/materials.js';
import { buildStreets } from './level/streets.js';
import { addQuadrantBuildings, addPerimeter, buildSkyline } from './level/buildings.js';
import {
  buildFountain, buildSandbags, buildBarriers, buildContainers, buildBarrels,
  buildPallets, buildVehicles, buildStreetlights, buildWires, buildSigns,
  buildRubble, buildDebris, buildPapers, buildDumpsters,
} from './level/props.js';
import { mergeMesh } from './level/geo.js';

export class LevelSystem {
  async init(ctx) {
    this._t = 0;
    this._neonMat = null;

    // ---- spawn data (feet positions, y = 0) --------------------------------
    this.playerSpawn = new THREE.Vector3(0, 0, 47);
    this.enemySpawns = [
      new THREE.Vector3(0, 0, 30), new THREE.Vector3(0, 0, -30),
      new THREE.Vector3(30, 0, 0), new THREE.Vector3(-30, 0, 0),
      new THREE.Vector3(47, 0, 30), new THREE.Vector3(47, 0, -30),
      new THREE.Vector3(-47, 0, 25), new THREE.Vector3(-47, 0, -25),
      new THREE.Vector3(25, 0, 47), new THREE.Vector3(-25, 0, 47),
      new THREE.Vector3(25, 0, -47), new THREE.Vector3(-20, 0, -47),
      new THREE.Vector3(12, 0, 12), new THREE.Vector3(-12, 0, 12),
      new THREE.Vector3(13, 0, -28), new THREE.Vector3(-13, 0, 28),
      new THREE.Vector3(28, 0, 13), new THREE.Vector3(-28, 0, -13),
    ];
    if (ctx) {
      ctx.playerSpawn = this.playerSpawn;
      ctx.enemySpawns = this.enemySpawns;
    }

    // ---- build -------------------------------------------------------------
    const mats = buildMaterials();
    const out = {
      group: new THREE.Group(),
      ground: null,
      colliders: [],
      darkGeos: [],
      chipGeos: [],
      frameGeos: [],
      signAnchors: [],
      wireAnchors: [],
      rubbleSpots: [],
      neonMat: null,
    };
    out.group.name = 'level';

    buildStreets(mats, out);
    addQuadrantBuildings(mats, out);
    addPerimeter(mats, out);
    // 10 cm window frames collected by every addBuilding call => one draw call
    const frameMesh = mergeMesh(out.frameGeos, mats.winFrame,
      { shadow: false, receive: true, noHit: true, name: 'window-frames' });
    if (frameMesh) out.group.add(frameMesh);
    buildFountain(mats, out);
    buildSandbags(mats, out);
    buildBarriers(mats, out);
    buildDumpsters(mats, out);
    buildContainers(mats, out);
    buildBarrels(mats, out);
    buildPallets(mats, out);
    buildVehicles(mats, out);
    buildStreetlights(mats, out);
    buildWires(mats, out);
    buildSigns(mats, out);
    buildRubble(mats, out);
    buildDebris(mats, out);
    buildPapers(mats, out);
    // chip decals: building corners (addBuilding) + barrier edge chips
    // (buildBarriers) => merged AFTER all contributors, one draw call
    const chipMesh = mergeMesh(out.chipGeos, mats.chipDecal,
      { shadow: false, receive: true, noHit: true, name: 'corner-chips' });
    if (chipMesh) out.group.add(chipMesh);
    out.group.add(buildSkyline(mats));

    // leftover dark geometry (bus window band, etc.)
    const darkMesh = mergeMesh(out.darkGeos, mats.darkVoid, { shadow: false, name: 'dark-extra' });
    if (darkMesh) out.group.add(darkMesh);

    out.group.updateMatrixWorld(true);
    this._group = out.group;
    this._ground = out.ground;
    this._neonMat = out.neonMat;
    this._mats = mats;

    // ---- scene + world registration ---------------------------------------
    ctx?.scene?.add(out.group);
    if (out.ground) ctx?.scene?.add(out.ground);

    if (out.ground) ctx?.world?.addStatic?.(out.ground, { collide: true }); // floor box
    ctx?.world?.addStatic?.(out.group, { collide: false });                 // bullet/LOS targets
    if (ctx?.world?.addCollider) {
      for (const box of out.colliders) ctx.world.addCollider(box);
      // arena boundary (beyond the perimeter facades)
      const B = (cx, cz, w, d) => ctx.world.addCollider(new THREE.Box3(
        new THREE.Vector3(cx - w / 2, 0, cz - d / 2),
        new THREE.Vector3(cx + w / 2, 50, cz + d / 2),
      ));
      B(0, 65, 170, 4);
      B(0, -65, 170, 4);
      B(65, 0, 4, 170);
      B(-65, 0, 4, 170);
    }

    // ---- environment safety nets (atmosphere system owns these normally) ---
    if (ctx?.scene && !ctx.scene.fog) {
      ctx.scene.fog = new THREE.FogExp2(0x8f96a0, 0.0052);
    }
    let hasLight = false;
    ctx?.scene?.traverse?.((o) => { if (o.isLight) hasLight = true; });
    if (ctx?.scene && !hasLight) {
      const hemi = new THREE.HemisphereLight(0xbfd0e2, 0x54483a, 0.9);
      const sun = new THREE.DirectionalLight(0xffe6c4, 2.2);
      sun.position.set(60, 90, 30);
      sun.castShadow = true;
      sun.shadow.mapSize.set(2048, 2048);
      sun.shadow.camera.left = -80;
      sun.shadow.camera.right = 80;
      sun.shadow.camera.top = 80;
      sun.shadow.camera.bottom = -80;
      sun.shadow.camera.far = 260;
      sun.shadow.bias = -0.0004;
      ctx.scene.add(hemi, sun, sun.target);
    }
  }

  update(dt, ctx) {
    this._t += dt;
    const t = typeof ctx?.time === 'number' ? ctx.time : this._t;
    const neon = this._neonMat;
    if (neon) {
      // Daytime: keep the flicker but SUBTLE — a noon neon reads as a faint
      // tube glow, not a lamp (ordinary windows have zero emissive).
      const s = Math.sin(t * 23.7) * Math.sin(t * 7.31 + 1.7) + Math.sin(t * 3.1);
      neon.emissiveIntensity = s > -0.55 ? 1.05 : 0.08;
    }
  }
}
