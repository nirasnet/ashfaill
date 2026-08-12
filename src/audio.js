// AUDIO — owns: all sound, 100% procedural WebAudio (no asset files).
//
// Implementation notes:
//  - AudioContext is created lazily on 'game:start' (autoplay policy). A
//    pointerdown/keydown fallback resumes it if the browser left it suspended.
//  - Graph: voices -> [sfx|ui|amb buses] -> compressor -> master lowpass
//    (health-muffle) -> master gain -> destination. A shared procedural
//    ConvolverNode (exp-decaying noise IR) acts as an outdoor-slap reverb send.
//  - Gunshots are layered: HP transient snap + 2-4kHz bandpass noise crack +
//    80-120Hz swept sine/saw thump + low-passed noise tail, with per-shot
//    pitch/level jitter. Enemy fire reuses the same synth, darker + quieter +
//    stereo-panned by camera-space direction, delayed a touch by distance.
//  - Polyphony is capped (voices are counted and low-priority sounds are
//    skipped when saturated). The only persistent allocations are two shared
//    AudioBuffers (noise + impulse response) and pooled THREE math objects;
//    WebAudio source nodes are one-shot by spec and are released on end.
//  - Timed sequences (reload foley, ambience events, heartbeat) are driven
//    from update(dt) so they can be cancelled and never fire while paused.
import * as THREE from 'three';

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a, b, t) => a + (b - a) * t;
const rand = (a = 1, b) => (b === undefined ? Math.random() * a : a + Math.random() * (b - a));

const MAX_VOICES = { 0: 22, 1: 28, 2: 36, 3: 999 }; // by priority

export class AudioSystem {
  constructor() {
    this.ac = null;          // AudioContext (lazy)
    this._gctx = null;       // game ctx
    this._active = 0;        // live voice count
    this._t = 0;             // unpaused game-time accumulator
    this._seq = [];          // pending timed sounds [{at, fn}] (reload foley)
    this._ambOn = false;
    this._nextAmb = 7;
    this._nextBeat = 0;
    this._lpTarget = 18000;
    this._dead = false;
    // pooled math
    this._vA = new THREE.Vector3();
    this._vB = new THREE.Vector3();
    this._vC = new THREE.Vector3();
    this._qA = new THREE.Quaternion();
    // node refs filled by _boot()
    this.master = null; this.lp = null; this.comp = null;
    this.sfx = null; this.ui = null; this.amb = null;
    this.conv = null; this.noiseBuf = null;
  }

  async init(ctx) {
    this._gctx = ctx;
    const on = (type, fn) => ctx?.events?.on?.(type, (p) => {
      try { fn(p); } catch (_e) { /* audio must never break the event bus */ }
    });
    on('game:start', () => this._onStart());
    on('game:pause', () => { this.ac?.suspend?.()?.catch?.(() => {}); });
    on('game:resume', () => { this.ac?.resume?.()?.catch?.(() => {}); });
    on('game:over', () => this._onGameOver());
    on('weapon:fire', () => this._onPlayerFire());
    on('weapon:empty', () => this._onDryFire());
    on('weapon:reload:start', () => this._onReloadStart());
    on('weapon:reload:end', () => { this._seq.length = 0; });
    on('weapon:ads', (p) => this._onAds(p));
    on('enemy:fire', (p) => this._onEnemyFire(p));
    on('hit:world', (p) => this._onHitWorld(p));
    on('hit:enemy', (p) => this._onHitEnemy(p));
    on('enemy:killed', (p) => this._onKill(p));
    on('player:damage', (p) => this._onPlayerDamage(p));
    on('player:footstep', (p) => this._onFootstep(p));
    on('player:land', (p) => this._onLand(p));
  }

  update(dt, ctx) {
    this._gctx = ctx;
    if (!this.ac) return;
    const phase = ctx?.state?.phase;
    if (phase === 'paused') return; // context is suspended; freeze all timers
    this._t += dt;
    const now = this.ac.currentTime;

    // Timed sequence (reload foley etc.)
    while (this._seq.length && this._seq[0].at <= this._t) {
      const item = this._seq.shift();
      try { item.fn(now); } catch (_e) { /* ignore */ }
    }

    // Sporadic far-off battle ambience
    if (this._ambOn && this._t >= this._nextAmb && (phase === 'playing' || phase === 'over')) {
      this._nextAmb = this._t + rand(5, 15);
      if (Math.random() < 0.62) this._distantGunfire(now);
      else this._distantExplosion(now);
    }

    // Low-health heartbeat + master muffle
    const hp = ctx?.player?.health;
    const alive = ctx?.player?.alive !== false;
    let lpTarget = 18000;
    if (this._dead) {
      lpTarget = 750;
    } else if (typeof hp === 'number' && hp < 30 && alive) {
      lpTarget = lerp(650, 18000, clamp(hp / 30, 0, 1));
      if (phase === 'playing' && this._t >= this._nextBeat) {
        const k = clamp(hp / 30, 0, 1);
        const interval = lerp(0.55, 1.15, k);
        const g = 0.4 * (1 - k) + 0.08;
        this._heartbeat(now, g);
        this._nextBeat = this._t + interval;
      }
    }
    if (Math.abs(lpTarget - this._lpTarget) > 40) {
      this._lpTarget = lpTarget;
      this.lp?.frequency?.setTargetAtTime?.(lpTarget, now, 0.18);
    }
  }

  // ---------------------------------------------------------------- lifecycle

  _onStart() {
    if (!this.ac) this._boot();
    if (!this.ac) return;
    this.ac.resume?.()?.catch?.(() => {});
    this._dead = false;
    this._seq.length = 0;
    const now = this.ac.currentTime;
    this._lpTarget = 18000;
    this.lp?.frequency?.setTargetAtTime?.(18000, now, 0.12);
    if (this.amb) {
      this.amb.gain.cancelScheduledValues(now);
      this.amb.gain.setTargetAtTime(1, now, 0.25);
    }
    if (this.master) this.master.gain.setTargetAtTime(0.85, now, 0.2);
    if (!this._ambOn) this._startAmbience();
  }

  _boot() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      const ac = new AC({ latencyHint: 'interactive' });
      this.ac = ac;

      this.master = ac.createGain();
      this.master.gain.value = 0.85;
      this.master.connect(ac.destination);

      this.lp = ac.createBiquadFilter();
      this.lp.type = 'lowpass';
      this.lp.frequency.value = 18000;
      this.lp.Q.value = 0.5;
      this.lp.connect(this.master);

      this.comp = ac.createDynamicsCompressor();
      this.comp.threshold.value = -20;
      this.comp.knee.value = 18;
      this.comp.ratio.value = 7;
      this.comp.attack.value = 0.002;
      this.comp.release.value = 0.14;
      this.comp.connect(this.lp);

      this.sfx = ac.createGain(); this.sfx.gain.value = 1.0; this.sfx.connect(this.comp);
      this.ui = ac.createGain(); this.ui.gain.value = 0.9; this.ui.connect(this.comp);
      this.amb = ac.createGain(); this.amb.gain.value = 1.0; this.amb.connect(this.comp);

      // Shared noise buffer (1.5 s) — every noise layer reads from this.
      const sr = ac.sampleRate;
      const nLen = Math.floor(sr * 1.5);
      this.noiseBuf = ac.createBuffer(1, nLen, sr);
      const nd = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < nLen; i++) nd[i] = Math.random() * 2 - 1;

      // Procedural impulse response: 1.7 s exp-decaying stereo noise -> convolver.
      const irLen = Math.floor(sr * 1.7);
      const ir = ac.createBuffer(2, irLen, sr);
      const pre = Math.floor(sr * 0.012);
      for (let ch = 0; ch < 2; ch++) {
        const d = ir.getChannelData(ch);
        for (let i = pre; i < irLen; i++) {
          const x = (i - pre) / (irLen - pre);
          d[i] = (Math.random() * 2 - 1) * Math.pow(1 - x, 2.6);
        }
      }
      this.conv = ac.createConvolver();
      this.conv.buffer = ir;
      const convOut = ac.createGain();
      convOut.gain.value = 0.4;
      this.conv.connect(convOut);
      convOut.connect(this.comp);

      // Autoplay-policy safety net: any later gesture revives a suspended context.
      const kick = () => { if (this.ac && this.ac.state !== 'running') this.ac.resume?.()?.catch?.(() => {}); };
      document.addEventListener('pointerdown', kick, { passive: true });
      document.addEventListener('keydown', kick);
    } catch (_e) {
      this.ac = null; // stay silent, never crash the game
    }
  }

  _onGameOver() {
    if (!this.ac) return;
    this._dead = true;
    this._seq.length = 0;
    const now = this.ac.currentTime;
    this._deathSting(now + 0.02);
    if (this.amb) {
      this.amb.gain.cancelScheduledValues(now);
      this.amb.gain.setTargetAtTime(0.45, now, 0.4);
    }
    this._lpTarget = 750;
    this.lp?.frequency?.setTargetAtTime?.(750, now, 0.25);
  }

  // ------------------------------------------------------------ voice plumbing

  /** Allocates a routed, panned, counted voice input GainNode; null if saturated. */
  _voice({ pan = 0, bus = null, send = 0, dur = 0.6, priority = 1 } = {}) {
    const ac = this.ac;
    if (!ac) return null;
    if (this._active >= (MAX_VOICES[priority] ?? 28)) return null;
    this._active++;
    const g = ac.createGain();
    let tail = g;
    if (ac.createStereoPanner) {
      const p = ac.createStereoPanner();
      p.pan.value = clamp(pan, -1, 1);
      g.connect(p);
      tail = p;
    }
    tail.connect(bus || this.sfx);
    if (send > 0 && this.conv) {
      const s = ac.createGain();
      s.gain.value = send;
      g.connect(s);
      s.connect(this.conv);
    }
    setTimeout(() => {
      this._active--;
      try { g.disconnect(); tail.disconnect(); } catch (_e) { /* ignore */ }
    }, (dur + 0.3) * 1000);
    return g;
  }

  /** Fast attack / exponential decay envelope on an AudioParam. */
  _env(param, t0, peak, attack, decay) {
    const p = Math.max(peak, 1e-4);
    param.setValueAtTime(0, t0);
    param.linearRampToValueAtTime(p, t0 + attack);
    param.exponentialRampToValueAtTime(1e-4, t0 + attack + decay);
    param.linearRampToValueAtTime(0, t0 + attack + decay + 0.015);
  }

  _noise(t0, t1, dest, rate = 1) {
    const s = this.ac.createBufferSource();
    s.buffer = this.noiseBuf;
    s.loop = true;
    s.playbackRate.value = rate;
    s.connect(dest);
    s.start(t0, rand(1.2));
    s.stop(t1 + 0.03);
    return s;
  }

  _osc(type, freq, t0, t1, dest, sweepTo = 0, sweepTime = 0) {
    const o = this.ac.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(Math.max(freq, 1), t0);
    if (sweepTo > 0) o.frequency.exponentialRampToValueAtTime(Math.max(sweepTo, 1), t0 + (sweepTime || t1 - t0));
    o.connect(dest);
    o.start(t0);
    o.stop(t1 + 0.03);
    return o;
  }

  _bq(type, freq, q = 0.8) {
    const f = this.ac.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    return f;
  }

  /** {pan, dist} of a world position relative to the listener (player eye / camera). */
  _spatial(worldPos) {
    const cam = this._gctx?.camera;
    let eye = null;
    const player = this._gctx?.player;
    if (typeof player?.eyePosition === 'function') {
      try { eye = player.eyePosition(); } catch (_e) { eye = null; }
    }
    if (!eye && cam) eye = cam.getWorldPosition(this._vB);
    if (!eye || !worldPos) return { pan: 0, dist: 25 };
    this._vA.set(worldPos.x ?? 0, worldPos.y ?? 0, worldPos.z ?? 0).sub(eye);
    const dist = this._vA.length();
    let pan = 0;
    if (cam && dist > 1e-3) {
      cam.getWorldQuaternion(this._qA).invert();
      this._vA.applyQuaternion(this._qA).divideScalar(dist);
      pan = clamp(this._vA.x * 0.9, -0.9, 0.9);
    }
    return { pan, dist };
  }

  // ------------------------------------------------------------------ gunshots

  /** Layered gunshot: transient snap + bandpass crack + swept thump + noise tail. */
  _gunshot(t0, { vol = 1, pan = 0, dark = 0, send = 0.28, priority = 1 } = {}) {
    const lead = Math.max(0, t0 - this.ac.currentTime); // scheduled-ahead margin
    const v = this._voice({ pan, send, dur: 0.55 + lead, priority });
    if (!v) return;
    const ac = this.ac;
    const jit = rand(0.92, 1.08);          // per-shot pitch jitter
    const lvl = vol * rand(0.9, 1.05);     // per-shot level jitter

    // Transient snap — very short highpassed noise, gives the "mechanical" edge.
    if (dark < 0.7) {
      const hp = this._bq('highpass', 4200, 0.7);
      const kg = ac.createGain();
      this._env(kg.gain, t0, (0.5 - dark * 0.5) * lvl, 0.0006, 0.012);
      this._noise(t0, t0 + 0.03, hp, 2.0 * jit);
      hp.connect(kg); kg.connect(v);
    }

    // Crack — 2-4 kHz bandpass noise burst, ~30 ms.
    const bp = this._bq('bandpass', lerp(2900, 1000, dark) * jit, 0.7);
    const cg = ac.createGain();
    this._env(cg.gain, t0, 0.85 * lvl, 0.001, 0.034);
    this._noise(t0, t0 + 0.07, bp, 1.4 * jit);
    bp.connect(cg); cg.connect(v);

    // Thump — 110->55 Hz sine with a low-passed saw for grit, ~90 ms decay.
    const tg = ac.createGain();
    this._env(tg.gain, t0, 0.95 * lvl, 0.002, 0.09);
    this._osc('sine', 112 * jit, t0, t0 + 0.13, tg, 55 * jit, 0.1);
    const grit = ac.createGain(); grit.gain.value = 0.22;
    const glp = this._bq('lowpass', 480, 0.5);
    this._osc('sawtooth', 90 * jit, t0, t0 + 0.11, glp, 48, 0.09);
    glp.connect(grit); grit.connect(tg);
    tg.connect(v);

    // Tail — low-passed noise wash, ~200 ms, reverb-ish body.
    const tl = this._bq('lowpass', lerp(1700, 480, dark), 0.4);
    const tlg = ac.createGain();
    this._env(tlg.gain, t0 + 0.014, 0.3 * lvl, 0.012, 0.21);
    this._noise(t0 + 0.014, t0 + 0.3, tl, 0.8 * jit);
    tl.connect(tlg); tlg.connect(v);
  }

  _onPlayerFire() {
    if (!this.ac) return;
    const t = this.ac.currentTime;
    this._gunshot(t, {
      vol: 0.95,
      pan: rand(-0.04, 0.04),
      dark: 0,
      send: 0.3,
      priority: 2,
    });
    // Brief ambience duck so the shot owns the mix (sidechain feel).
    if (this.amb) {
      const g = this.amb.gain;
      g.cancelScheduledValues(t);
      g.setTargetAtTime(0.55, t, 0.015);
      g.setTargetAtTime(1.0, t + 0.09, 0.35);
    }
  }

  _onEnemyFire(p) {
    if (!this.ac) return;
    const { pan, dist } = this._spatial(p?.origin);
    const att = clamp(9 / (9 + dist), 0.05, 0.8);
    const dark = clamp(dist / 110, 0.1, 0.85);
    const delay = clamp(dist / 340, 0, 0.5) * 0.5; // compressed speed-of-sound lag
    this._gunshot(this.ac.currentTime + 0.005 + delay, {
      vol: att * 0.8,
      pan,
      dark,
      send: 0.4,
      priority: 1,
    });
    this._crackBy(p);
  }

  /** Supersonic snap when an enemy round passes within 2 m of the player's head. */
  _crackBy(p) {
    const player = this._gctx?.player;
    if (typeof player?.eyePosition !== 'function') return;
    let eye;
    try { eye = player.eyePosition(); } catch (_e) { return; }
    const o = p?.origin, d = p?.direction;
    if (!eye || !o || !d) return;
    let dx = d.x ?? 0, dy = d.y ?? 0, dz = d.z ?? 0;
    const dl = Math.hypot(dx, dy, dz) || 1;
    dx /= dl; dy /= dl; dz /= dl;
    const wx = eye.x - o.x, wy = eye.y - o.y, wz = eye.z - o.z;
    const t = wx * dx + wy * dy + wz * dz; // closest-approach distance along the ray
    if (t < 2 || t > 130) return;
    const cx = o.x + dx * t, cy = o.y + dy * t, cz = o.z + dz * t;
    const miss = Math.hypot(cx - eye.x, cy - eye.y, cz - eye.z);
    if (miss > 2) return;
    const { pan } = this._spatial(this._vC.set(cx, cy, cz));
    const t0 = this.ac.currentTime + 0.004 + clamp(t / 700, 0, 0.18);
    const v = this._voice({ pan, dur: 0.12, send: 0.12, priority: 1 });
    if (!v) return;
    const vol = 0.14 + 0.3 * (1 - miss / 2);
    const bp = this._bq('bandpass', rand(3200, 4200), 1.1);
    const g = this.ac.createGain();
    this._env(g.gain, t0, vol, 0.0005, 0.02);
    this._noise(t0, t0 + 0.04, bp, 2.2);
    bp.connect(g); g.connect(v);
    const hp = this._bq('highpass', 5000, 0.7);
    const g2 = this.ac.createGain();
    this._env(g2.gain, t0, vol * 0.6, 0.0004, 0.009);
    this._noise(t0, t0 + 0.02, hp, 2.6);
    hp.connect(g2); g2.connect(v);
  }

  // ------------------------------------------------------------------- impacts

  _onHitWorld(p) {
    if (!this.ac) return;
    const { pan, dist } = this._spatial(p?.point);
    const att = clamp(10 / (10 + dist), 0.06, 1);
    if (att < 0.08) return;
    const t0 = this.ac.currentTime + 0.002;
    const v = this._voice({ pan, dur: 0.3, send: 0.15, priority: 0 });
    if (!v) return;
    const ac = this.ac;
    // Tick — bright bandpass noise.
    const bp = this._bq('bandpass', rand(4200, 6200), 1.4);
    const tg = ac.createGain();
    this._env(tg.gain, t0, 0.24 * att, 0.0007, 0.018);
    this._noise(t0, t0 + 0.04, bp, 2.0);
    bp.connect(tg); tg.connect(v);
    // Low thock — impact body.
    const lp = this._bq('lowpass', 750, 0.6);
    const bg = ac.createGain();
    this._env(bg.gain, t0, 0.13 * att, 0.001, 0.035);
    this._noise(t0, t0 + 0.06, lp, 0.9);
    lp.connect(bg); bg.connect(v);
    // Occasional metallic spark ring.
    if (Math.random() < 0.3) {
      const rg = ac.createGain();
      this._env(rg.gain, t0 + 0.004, 0.05 * att, 0.001, 0.13);
      this._osc('sine', rand(4200, 8200), t0 + 0.004, t0 + 0.16, rg);
      rg.connect(v);
    }
  }

  _onHitEnemy(p) {
    if (!this.ac) return;
    const t0 = this.ac.currentTime + 0.002;
    // Flesh thud, spatialized at the wound.
    const { pan, dist } = this._spatial(p?.point);
    const att = clamp(12 / (12 + dist), 0.1, 1);
    const v = this._voice({ pan, dur: 0.25, send: 0.08, priority: 1 });
    if (v) {
      const bp = this._bq('bandpass', rand(280, 420), 0.6);
      const fg = this.ac.createGain();
      this._env(fg.gain, t0, 0.32 * att, 0.001, 0.055);
      this._noise(t0, t0 + 0.09, bp, 0.7);
      bp.connect(fg); fg.connect(v);
      const kg = this.ac.createGain();
      this._env(kg.gain, t0, 0.24 * att, 0.002, 0.05);
      this._osc('sine', 135, t0, t0 + 0.08, kg, 70, 0.05);
      kg.connect(v);
    }
    // Hitmarker tick — UI bus, dry, constant volume.
    this._uiTick(t0 + 0.004, p?.headshot ? 3100 : 2500, p?.headshot ? 0.2 : 0.16);
  }

  _uiTick(t0, freq, gain) {
    const v = this._voice({ bus: this.ui, dur: 0.08, priority: 2 });
    if (!v) return;
    const bp = this._bq('bandpass', freq, 2.2);
    const g = this.ac.createGain();
    this._env(g.gain, t0, gain, 0.0006, 0.014);
    this._noise(t0, t0 + 0.03, bp, 2.0);
    bp.connect(g); g.connect(v);
    const og = this.ac.createGain();
    this._env(og.gain, t0, gain * 0.55, 0.0006, 0.02);
    this._osc('square', freq, t0, t0 + 0.04, og);
    og.connect(v);
  }

  _onKill(p) {
    if (!this.ac) return;
    const t0 = this.ac.currentTime + 0.01;
    const notes = p?.headshot ? [1180, 1560, 1980] : [1180, 1560];
    const v = this._voice({ bus: this.ui, dur: 0.4, priority: 2 });
    if (!v) return;
    notes.forEach((f, i) => {
      const t = t0 + i * 0.07;
      const g = this.ac.createGain();
      this._env(g.gain, t, 0.13, 0.004, 0.09);
      this._osc('triangle', f, t, t + 0.13, g);
      g.connect(v);
    });
    // Low confirm punch under the blip.
    const kg = this.ac.createGain();
    this._env(kg.gain, t0, 0.14, 0.003, 0.09);
    this._osc('sine', 150, t0, t0 + 0.12, kg, 80, 0.08);
    kg.connect(v);
  }

  // ------------------------------------------------------------ weapon foley

  /** Mechanical click: resonant noise tick + optional low knock + optional ring. */
  _click(t0, { freq = 2000, gain = 0.14, knock = 0, ring = 0, pan = 0, dur = 0.03 } = {}) {
    const v = this._voice({ pan, dur: dur + 0.2, send: 0.06, priority: 1 });
    if (!v) return;
    const bp = this._bq('bandpass', freq * rand(0.94, 1.06), 2.6);
    const g = this.ac.createGain();
    this._env(g.gain, t0, gain, 0.0007, dur);
    this._noise(t0, t0 + dur + 0.02, bp, 1.8);
    bp.connect(g); g.connect(v);
    if (knock > 0) {
      const kg = this.ac.createGain();
      this._env(kg.gain, t0, knock, 0.001, 0.05);
      this._osc('triangle', 175, t0, t0 + 0.08, kg, 92, 0.06);
      kg.connect(v);
    }
    if (ring > 0) {
      const rg = this.ac.createGain();
      this._env(rg.gain, t0 + 0.003, ring, 0.001, 0.11);
      this._osc('sine', freq * 1.7, t0 + 0.003, t0 + 0.14, rg);
      rg.connect(v);
    }
  }

  /** Sliding friction noise with a filter sweep (mag out / mag in). */
  _slide(t0, { from = 1400, to = 650, dur = 0.12, gain = 0.08 } = {}) {
    const v = this._voice({ dur: dur + 0.15, priority: 1 });
    if (!v) return;
    const bp = this._bq('bandpass', from, 1.2);
    bp.frequency.setValueAtTime(from, t0);
    bp.frequency.exponentialRampToValueAtTime(Math.max(to, 40), t0 + dur);
    const g = this.ac.createGain();
    this._env(g.gain, t0, gain, 0.012, dur);
    this._noise(t0, t0 + dur + 0.02, bp, 1.1);
    bp.connect(g); g.connect(v);
  }

  _onReloadStart() {
    if (!this.ac) return;
    this._seq.length = 0;
    const q = (dt, fn) => this._seq.push({ at: this._t + dt, fn });
    q(0.10, (now) => this._click(now, { freq: 2400, gain: 0.12, knock: 0.05 }));            // mag release
    q(0.30, (now) => this._slide(now, { from: 1500, to: 600, dur: 0.13, gain: 0.09 }));     // mag out
    q(0.52, (now) => this._click(now, { freq: 900, gain: 0.07, knock: 0.07 }));             // mag away
    q(1.00, (now) => this._slide(now, { from: 600, to: 1500, dur: 0.11, gain: 0.09 }));     // mag in
    q(1.13, (now) => this._click(now, { freq: 1500, gain: 0.16, knock: 0.13 }));            // mag seat
    q(1.48, (now) => this._click(now, { freq: 2100, gain: 0.13, knock: 0.06 }));            // bolt pull
    q(1.64, (now) => this._click(now, { freq: 1700, gain: 0.19, knock: 0.15, ring: 0.03 }));// bolt slam
  }

  _onDryFire() {
    if (!this.ac) return;
    const t0 = this.ac.currentTime + 0.002;
    this._click(t0, { freq: 1900, gain: 0.15, knock: 0.03 });
    this._click(t0 + 0.028, { freq: 2600, gain: 0.06 }); // spring rebound
  }

  _onAds(p) {
    if (!this.ac) return;
    const t0 = this.ac.currentTime + 0.002;
    this._click(t0, { freq: p?.ads ? 1450 : 1100, gain: 0.05 });
    // Cloth rustle.
    const v = this._voice({ dur: 0.15, priority: 0 });
    if (!v) return;
    const lp = this._bq('lowpass', 1200, 0.5);
    const g = this.ac.createGain();
    this._env(g.gain, t0, 0.035, 0.01, 0.07);
    this._noise(t0, t0 + 0.1, lp, 0.9);
    lp.connect(g); g.connect(v);
  }

  // ------------------------------------------------------------- player foley

  _onFootstep(p) {
    if (!this.ac) return;
    const sprint = !!p?.sprinting;
    const t0 = this.ac.currentTime + 0.002;
    const v = this._voice({ pan: rand(-0.14, 0.14), dur: 0.3, priority: 0 });
    if (!v) return;
    const ac = this.ac;
    // Heel tap — filtered noise thud.
    const lp = this._bq('lowpass', rand(620, 950), 0.6);
    const hg = ac.createGain();
    this._env(hg.gain, t0, sprint ? 0.16 : 0.1, 0.002, 0.05);
    this._noise(t0, t0 + 0.08, lp, rand(0.8, 1.1));
    lp.connect(hg); hg.connect(v);
    // Body knock.
    const kg = ac.createGain();
    this._env(kg.gain, t0, sprint ? 0.06 : 0.04, 0.002, 0.04);
    this._osc('sine', rand(85, 105), t0, t0 + 0.06, kg, 60, 0.04);
    kg.connect(v);
    // Gravel crackle — a few micro-ticks.
    const nTicks = sprint ? 4 : 3;
    for (let i = 0; i < nTicks; i++) {
      const tt = t0 + rand(0.005, 0.075);
      const bp = this._bq('bandpass', rand(2400, 5200), 1.6);
      const g = ac.createGain();
      this._env(g.gain, tt, rand(0.018, 0.045) * (sprint ? 1.3 : 1), 0.0006, 0.012);
      this._noise(tt, tt + 0.025, bp, 2.2);
      bp.connect(g); g.connect(v);
    }
  }

  _onLand(p) {
    if (!this.ac) return;
    const hard = !!p?.hard;
    const t0 = this.ac.currentTime + 0.002;
    const v = this._voice({ dur: 0.45, send: 0.06, priority: 1 });
    if (!v) return;
    const ac = this.ac;
    // Body thud.
    const tg = ac.createGain();
    this._env(tg.gain, t0, hard ? 0.5 : 0.28, 0.003, 0.16);
    this._osc('sine', 78, t0, t0 + 0.2, tg, 44, 0.15);
    tg.connect(v);
    // Dust/gravel wash.
    const lp = this._bq('lowpass', 460, 0.5);
    const ng = ac.createGain();
    this._env(ng.gain, t0, hard ? 0.28 : 0.14, 0.004, 0.2);
    this._noise(t0, t0 + 0.26, lp, 0.9);
    lp.connect(ng); ng.connect(v);
    // Scattered crackle.
    const nTicks = hard ? 6 : 4;
    for (let i = 0; i < nTicks; i++) {
      const tt = t0 + rand(0.01, 0.12);
      const bp = this._bq('bandpass', rand(2200, 4800), 1.5);
      const g = ac.createGain();
      this._env(g.gain, tt, rand(0.02, 0.05) * (hard ? 1.4 : 1), 0.0006, 0.014);
      this._noise(tt, tt + 0.03, bp, 2.0);
      bp.connect(g); g.connect(v);
    }
  }

  _onPlayerDamage(p) {
    if (!this.ac) return;
    const t0 = this.ac.currentTime + 0.002;
    let pan = 0;
    const cam = this._gctx?.camera;
    const dir = p?.direction;
    if (cam && dir) {
      this._vC.set(dir.x ?? 0, dir.y ?? 0, dir.z ?? 0);
      if (this._vC.lengthSq() > 1e-6) {
        cam.getWorldQuaternion(this._qA).invert();
        this._vC.applyQuaternion(this._qA).normalize();
        pan = clamp(this._vC.x * 0.7, -0.7, 0.7);
      }
    }
    const v = this._voice({ pan, dur: 0.6, priority: 2 });
    if (!v) return;
    const tg = this.ac.createGain();
    this._env(tg.gain, t0, 0.3, 0.002, 0.08);
    this._osc('sine', 130, t0, t0 + 0.11, tg, 58, 0.08);
    tg.connect(v);
    const bp = this._bq('bandpass', 320, 0.7);
    const ng = this.ac.createGain();
    this._env(ng.gain, t0, 0.18, 0.002, 0.06);
    this._noise(t0, t0 + 0.09, bp, 0.8);
    bp.connect(ng); ng.connect(v);
    // Big hits leave a brief ear ring.
    if ((p?.amount ?? 0) >= 28) {
      const rg = this.ac.createGain();
      this._env(rg.gain, t0 + 0.02, 0.04, 0.01, 0.45);
      this._osc('sine', 3600, t0 + 0.02, t0 + 0.5, rg);
      rg.connect(v);
    }
  }

  _heartbeat(now, gain) {
    // Lub-dub: two low sine pulses. Routed to UI bus (dry, survives the muffle).
    const v = this._voice({ bus: this.ui, dur: 0.4, priority: 2 });
    if (!v) return;
    const beat = (t, g) => {
      const bg = this.ac.createGain();
      this._env(bg.gain, t, g, 0.008, 0.1);
      this._osc('sine', 58, t, t + 0.14, bg, 40, 0.1);
      bg.connect(v);
    };
    beat(now + 0.01, gain);
    beat(now + 0.19, gain * 0.7);
  }

  _deathSting(t0) {
    const v = this._voice({ dur: 2.2, send: 0.5, priority: 3 });
    if (!v) return;
    const ac = this.ac;
    // Dark descending drone.
    const lp = this._bq('lowpass', 700, 0.7);
    const dg = ac.createGain();
    dg.gain.setValueAtTime(0.0001, t0);
    dg.gain.linearRampToValueAtTime(0.4, t0 + 0.08);
    dg.gain.exponentialRampToValueAtTime(1e-4, t0 + 1.7);
    this._osc('sawtooth', 160, t0, t0 + 1.75, lp, 32, 1.5);
    lp.connect(dg); dg.connect(v);
    // Sub drop.
    const sg = ac.createGain();
    this._env(sg.gain, t0, 0.5, 0.02, 1.2);
    this._osc('sine', 55, t0, t0 + 1.3, sg, 28, 1.1);
    sg.connect(v);
    // Noise swell.
    const nlp = this._bq('lowpass', 420, 0.5);
    const ng = ac.createGain();
    ng.gain.setValueAtTime(0.0001, t0);
    ng.gain.linearRampToValueAtTime(0.22, t0 + 0.3);
    ng.gain.exponentialRampToValueAtTime(1e-4, t0 + 1.5);
    this._noise(t0, t0 + 1.55, nlp, 0.7);
    nlp.connect(ng); ng.connect(v);
  }

  // ------------------------------------------------------------------ ambience

  _startAmbience() {
    if (!this.ac || this._ambOn) return;
    this._ambOn = true;
    const ac = this.ac;
    const t0 = ac.currentTime;

    // Wind — looped noise through a slowly-wandering lowpass, gusting gain LFO.
    const windLp = this._bq('lowpass', 340, 0.6);
    const windLfoAmp = ac.createGain(); windLfoAmp.gain.value = 1;   // LFO target
    const windTrim = ac.createGain(); windTrim.gain.value = 0.05;
    this._noise(t0, t0 + 1e7, windLp, 0.9); // effectively infinite loop
    windLp.connect(windLfoAmp); windLfoAmp.connect(windTrim); windTrim.connect(this.amb);
    const gust = ac.createOscillator(); gust.type = 'sine'; gust.frequency.value = 0.07;
    const gustDepth = ac.createGain(); gustDepth.gain.value = 0.45;
    gust.connect(gustDepth); gustDepth.connect(windLfoAmp.gain); gust.start(t0);
    const drift = ac.createOscillator(); drift.type = 'sine'; drift.frequency.value = 0.043;
    const driftDepth = ac.createGain(); driftDepth.gain.value = 130;
    drift.connect(driftDepth); driftDepth.connect(windLp.frequency); drift.start(t0);

    // Distant rumble bed — very low, very quiet.
    const rumLp = this._bq('lowpass', 90, 0.6);
    const rumTrim = ac.createGain(); rumTrim.gain.value = 0.055;
    this._noise(t0, t0 + 1e7, rumLp, 0.6);
    rumLp.connect(rumTrim); rumTrim.connect(this.amb);

    this._nextAmb = this._t + rand(4, 9);
  }

  _distantGunfire(now) {
    const pan = rand(-0.8, 0.8);
    const shots = 3 + Math.floor(rand(4));
    const vol = rand(0.045, 0.11);
    let t = now + 0.02;
    for (let i = 0; i < shots; i++) {
      this._gunshot(t, { vol: vol * rand(0.85, 1.1), pan, dark: 0.9, send: 0.7, priority: 0 });
      t += rand(0.08, 0.14);
    }
  }

  _distantExplosion(now) {
    const t0 = now + 0.02;
    const v = this._voice({ pan: rand(-0.7, 0.7), dur: 2.4, send: 0.6, priority: 0 });
    if (!v) return;
    const vol = rand(0.06, 0.13);
    // Deep boom.
    const bg = this.ac.createGain();
    this._env(bg.gain, t0, vol, 0.015, 1.3);
    this._osc('sine', 52, t0, t0 + 1.4, bg, 26, 1.2);
    bg.connect(v);
    // Rumbling debris wash.
    const lp = this._bq('lowpass', 210, 0.5);
    const ng = this.ac.createGain();
    this._env(ng.gain, t0 + 0.02, vol * 0.8, 0.05, 1.7);
    this._noise(t0 + 0.02, t0 + 1.9, lp, 0.55);
    lp.connect(ng); ng.connect(v);
  }
}
