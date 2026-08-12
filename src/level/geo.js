// Geometry helpers for the level: world-scaled-UV primitives, merging, colliders.
// Owned by the level agent.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export { mergeGeometries };

/**
 * BoxGeometry whose UVs are scaled so a repeating texture tiles in world units.
 * s = UV repeats per meter (e.g. 1/3 -> one texture tile every 3 m).
 * rand (optional PRNG) offsets UVs per face to hide repetition between boxes.
 * rx/ry/rz rotations are applied before the translate to x/y/z (y = box CENTER).
 */
export function uvBox(w, h, d, opts = {}) {
  const { s = 0.35, rand = null, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0 } = opts;
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.attributes.uv;
  const dims = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  for (let f = 0; f < 6; f++) {
    const du = dims[f][0] * s, dv = dims[f][1] * s;
    const ou = rand ? rand() * 4 : 0, ov = rand ? rand() * 4 : 0;
    for (let v = f * 4; v < f * 4 + 4; v++) {
      uv.setXY(v, uv.getX(v) * du + ou, uv.getY(v) * dv + ov);
    }
  }
  if (rx) g.rotateX(rx);
  if (rz) g.rotateZ(rz);
  if (ry) g.rotateY(ry);
  if (x || y || z) g.translate(x, y, z);
  return g;
}

/** Multiply every UV of a geometry by (ku, kv). */
export function uvScale(g, ku, kv = ku) {
  const uv = g.attributes.uv;
  if (!uv) return g;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * ku, uv.getY(i) * kv);
  return g;
}

/** CylinderGeometry with UVs scaled to world units (s = repeats per meter). */
export function uvCyl(rTop, rBot, h, seg, opts = {}) {
  const { s = 0.35, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, open = false } = opts;
  const g = new THREE.CylinderGeometry(rTop, rBot, h, seg, 1, open);
  const circ = Math.PI * (rTop + rBot);
  uvScale(g, circ * s, h * s);
  if (rx) g.rotateX(rx);
  if (rz) g.rotateZ(rz);
  if (ry) g.rotateY(ry);
  if (x || y || z) g.translate(x, y, z);
  return g;
}

/** Merge a list of BufferGeometries into a single Mesh. Returns null on empty. */
export function mergeMesh(list, material, opts = {}) {
  const { shadow = true, receive = true, noHit = false, name = '' } = opts;
  if (!list || !list.length) return null;
  const g = mergeGeometries(list, false);
  if (!g) return null;
  g.computeBoundingSphere();
  g.computeBoundingBox();
  const m = new THREE.Mesh(g, material);
  m.castShadow = shadow;
  m.receiveShadow = receive;
  if (noHit) m.userData.noHit = true;
  if (name) m.name = name;
  m.matrixAutoUpdate = false;
  return m;
}

/** Axis-aligned Box3 from center-x/z, BASE y, and full extents. */
export function box3Base(cx, yBase, cz, w, h, d) {
  return new THREE.Box3(
    new THREE.Vector3(cx - w / 2, yBase, cz - d / 2),
    new THREE.Vector3(cx + w / 2, yBase + h, cz + d / 2),
  );
}

/** AABB that fully contains a y-rotated box footprint (for rotated props). */
export function obbBox3(cx, yBase, cz, w, h, d, ry) {
  const c = Math.abs(Math.cos(ry)), s = Math.abs(Math.sin(ry));
  const hw = (w * c + d * s) / 2, hd = (w * s + d * c) / 2;
  return new THREE.Box3(
    new THREE.Vector3(cx - hw, yBase, cz - hd),
    new THREE.Vector3(cx + hw, yBase + h, cz + hd),
  );
}

const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();

/** Compose a matrix into an InstancedMesh slot (pos, euler, uniform-ish scale). */
export function setInstance(mesh, i, x, y, z, rx = 0, ry = 0, rz = 0, sx = 1, sy = null, sz = null) {
  _e.set(rx, ry, rz);
  _q.setFromEuler(_e);
  _p.set(x, y, z);
  _s.set(sx, sy === null ? sx : sy, sz === null ? sx : sz);
  _m4.compose(_p, _q, _s);
  mesh.setMatrixAt(i, _m4);
}

/** Finalize an InstancedMesh: mark buffers, compute bounds for culling/raycast. */
export function finishInstanced(mesh) {
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  if (mesh.computeBoundingSphere) mesh.computeBoundingSphere();
  else mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = false;
  return mesh;
}
