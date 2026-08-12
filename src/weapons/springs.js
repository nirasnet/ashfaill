// Damped-spring helpers for procedural viewmodel motion.
// Semi-implicit Euler with a fixed internal substep so behaviour is stable and
// frame-rate independent. No per-frame allocation.

const MAX_SUBSTEP = 1 / 240;

/** Scalar damped spring pulled toward `target` (default 0). */
export class Spring1 {
  constructor(stiffness = 200, damping = 20) {
    this.stiffness = stiffness;
    this.damping = damping;
    this.value = 0;
    this.velocity = 0;
    this.target = 0;
  }
  impulse(v) { this.velocity += v; return this; }
  reset(v = 0) { this.value = v; this.velocity = 0; return this; }
  update(dt) {
    let t = Math.min(dt, 0.1);
    while (t > 0) {
      const h = Math.min(t, MAX_SUBSTEP);
      this.velocity += (-this.stiffness * (this.value - this.target) - this.damping * this.velocity) * h;
      this.value += this.velocity * h;
      t -= h;
    }
    return this.value;
  }
}

/** Three independent scalar springs (used for position + euler-rotation kicks). */
export class Spring3 {
  constructor(stiffness = 200, damping = 20) {
    this.x = new Spring1(stiffness, damping);
    this.y = new Spring1(stiffness, damping);
    this.z = new Spring1(stiffness, damping);
  }
  impulse(x, y, z) {
    this.x.velocity += x;
    this.y.velocity += y;
    this.z.velocity += z;
    return this;
  }
  reset() { this.x.reset(); this.y.reset(); this.z.reset(); return this; }
  update(dt) {
    this.x.update(dt);
    this.y.update(dt);
    this.z.update(dt);
  }
}

/** Critically-damped smoothing toward a target (no oscillation). Returns new value. */
export function damp(current, target, lambda, dt) {
  return target + (current - target) * Math.exp(-lambda * dt);
}

export function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

export function smoothstep(edge0, edge1, x) {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Move a scalar toward target at a fixed rate (units/second). */
export function moveTowards(current, target, rate, dt) {
  const d = target - current;
  const step = rate * dt;
  if (Math.abs(d) <= step) return target;
  return current + Math.sign(d) * step;
}
