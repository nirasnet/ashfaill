// HUD / UI — owns: #hud and #menu DOM, all 2D chrome. DOM+CSS only.
//
//  - Menu (#menu): cinematic "ASHFALL PROTOCOL" title screen over the live 3D
//    scene; doubles as pause ("PAUSED"/RESUME) and death ("YOU DIED"/REDEPLOY).
//  - Crosshair: dynamic 4-line spread (movement/air/fire), hidden on ADS.
//  - Ammo (bottom right): big mag / small reserve, weapon name, low-ammo flash,
//    reload spinner between 'weapon:reload:start'..'end'.
//  - Health: CoD damage vignette (opacity tracks 1 - health/100) + directional
//    damage wedges toward the shooter on 'player:damage', low-HP heartbeat pulse.
//  - Hitmarker X on 'hit:enemy' (amber on headshot hits, red on kills),
//    "+100"/"+150" confirms.
//  - Top: scrolling compass (camera yaw; 15-deg ticks, 21px cardinals, 11px
//    degree numbers, single amber center needle, heading readout dead-center
//    below the strip).
//  - Top-left: CoD-style circular minimap (rotating, player-up). Static world
//    is baked ONCE from ctx.world.colliders into an offscreen canvas; per frame
//    it is drawn rotated into a 148px circle at 30 Hz with red enemy dots, a
//    rim 'N' marker, and rim damage-direction flashes. The OP TIME / KILLS /
//    SCORE panel docks directly below it in the same column.
//  - Killfeed (top right): "YOU [M4A1] HOSTILE" entries, fade 4s.
// All DOM writes are change-gated; per-event elements come from fixed pools.
import * as THREE from 'three';
import { HUD_CSS } from './hud/styles.js';
import { el, buildMenu } from './hud/screens.js';
import { makeCanvas, rng } from './utils.js';

const PX_DEG = 4;                 // compass pixels per degree
const COMPASS_W = 340;            // compass window width (matches CSS)
const CROSS_LEN = 11;             // crosshair line length (matches CSS)
const RAD2DEG = 57.29577951308232;
const TAU = Math.PI * 2;
const CARDINAL = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' };
const _dir = new THREE.Vector3(); // pooled, reused every frame

// Minimap geometry (css px; canvas is backed at devicePixelRatio).
const MAP_D = 148;                            // minimap diameter (matches CSS)
const MAP_VIEW_R = 45;                        // meters from center to rim
const MAP_PXPM = (MAP_D / 2 - 3) / MAP_VIEW_R; // on-screen px per meter
const MAP_BAKE_PXPM = 3;                      // bake resolution, px per meter
const MAP_HZ = 1 / 30;                        // canvas redraw budget

// Procedural M4-pattern silhouette for the ammo panel (stock, receiver, rear
// sight, grip, mag, handguard, front sight, barrel, flash hider). Pure SVG.
const RIFLE_SVG =
  '<svg viewBox="0 0 118 36" preserveAspectRatio="xMidYMid meet"><path d="' +
  'M2 9 L13 9 L13 12 L22 12 L22 17 L13 17 L13 20 L8 20 L2 15 Z ' +
  'M22 8 L52 8 L52 21 L22 21 Z ' +
  'M25 5 L31 5 L31 8 L25 8 Z ' +
  'M30 21 L37 21 L33 33 L26 33 Z ' +
  'M41 21 L50 21 L54 33 L45 33 Z ' +
  'M52 10 L82 10 L82 19 L52 19 Z ' +
  'M83 13 L83 6 L85 4 L87 6 L87 13 Z ' +
  'M82 13 L106 13 L106 17 L82 17 Z ' +
  'M106 12 L114 12 L115 13 L115 17 L114 18 L106 18 Z' +
  '"/></svg>';

const pad2 = (n) => (n < 10 ? '0' + n : '' + n);
const pad3 = (n) => (n < 10 ? '00' + n : n < 100 ? '0' + n : '' + n);
const fmtTime = (t) => {
  const s = Math.max(0, Math.floor(t));
  return pad2(Math.floor(s / 60)) + ':' + pad2(s % 60);
};

export class HudSystem {
  async init(ctx) {
    this._ctx = ctx;
    this._phase = null;
    this._headingRad = 0;
    this._ads = false;
    this._reloading = false;
    this._gap = 6;
    this._gapDrawn = -1;
    this._fireKick = 0;
    this._hitTtl = 0;
    this._hitMax = 0.3;
    this._hitScale = 1;
    this._vinFlash = 0;
    this._lowHp = false;
    this._magMax = 30;
    this._popIdx = 0;
    this._feedIdx = 0;
    this._mapClock = 0;
    this._mapBake = null;
    // Rim damage-flash pool (fixed size, oldest slot recycled).
    this._mapHits = [];
    for (let i = 0; i < 4; i++) this._mapHits.push({ ttl: 0, ang: 0 });
    this._cache = {
      mag: -1, reserve: -1, name: '', kills: -1, score: -1, sec: -1,
      vin: -1, deg: -1, stripX: Infinity,
    };

    if (!document.getElementById('af-style')) {
      const style = document.createElement('style');
      style.id = 'af-style';
      style.textContent = HUD_CSS;
      document.head.appendChild(style);
    }

    const noiseUrl = this._makeNoiseUrl();

    let menuRoot = document.getElementById('menu');
    if (!menuRoot) { menuRoot = el('div', '', document.body); menuRoot.id = 'menu'; }
    this._menuRoot = menuRoot;
    this._menu = buildMenu(menuRoot, {
      noiseUrl,
      onPlay: () => ctx.requestStart?.(),
      onResume: () => ctx.requestStart?.(),
      onRedeploy: () => location.reload(),
    });

    this._buildHud();
    this._bakeMap(ctx); // level init precedes hud init; retried in update if empty
    this._wireEvents(ctx);

    document.addEventListener('keydown', (e) => {
      if (e.code !== 'Enter' && e.code !== 'NumpadEnter') return;
      if (this._phase === 'menu' || this._phase === 'paused') ctx.requestStart?.();
      else if (this._phase === 'over') location.reload();
    });

    this._setPhase(ctx.state?.phase ?? 'menu', ctx);
  }

  update(dt, ctx) {
    if (!this._root) return;
    const c = this._cache;
    const st = ctx?.state;

    if (st && st.phase !== this._phase) this._setPhase(st.phase, ctx);

    // --- compass (transform-only writes, compositor-cheap) ---
    const cam = ctx?.camera;
    if (cam?.getWorldDirection) {
      cam.getWorldDirection(_dir);
      const rad = Math.atan2(_dir.x, -_dir.z);
      this._headingRad = rad;
      const deg = (rad * RAD2DEG + 360) % 360;
      const x = COMPASS_W / 2 - (deg + 360) * PX_DEG;
      if (Math.abs(x - c.stripX) > 0.05) {
        c.stripX = x;
        this._strip.style.transform = `translate3d(${x.toFixed(2)}px,0,0)`;
      }
      const d3 = Math.round(deg) % 360;
      if (d3 !== c.deg) { c.deg = d3; this._degEl.textContent = pad3(d3); }
    }

    // --- crosshair spread ---
    const pl = ctx?.player;
    const vel = pl?.velocity;
    const speed = vel ? Math.hypot(vel.x || 0, vel.z || 0) : 0;
    const sprinting = !!pl?.sprinting;
    const airborne = pl ? pl.onGround === false : false;
    this._fireKick = Math.max(0, this._fireKick - dt * 30);
    let target = 5 + speed * 1.35 + (sprinting ? 7 : 0) + (airborne ? 6 : 0) + this._fireKick;
    if (this._ads) target = 4;
    this._gap += (target - this._gap) * Math.min(1, dt * 14);
    if (Math.abs(this._gap - this._gapDrawn) > 0.12) {
      this._gapDrawn = this._gap;
      this._applyGap(this._gap);
    }
    this._cross.classList.toggle('sprint', sprinting && !this._ads);

    // ADS/reload safety-net sync (events are the primary path).
    const ads = !!pl?.ads;
    if (ads !== this._ads) this._setAds(ads);
    const rel = !!ctx?.weapons?.reloading;
    if (rel !== this._reloading) this._setReloading(rel);

    // --- hitmarker decay ---
    if (this._hitTtl > 0) {
      this._hitTtl -= dt;
      const t = Math.max(0, this._hitTtl / this._hitMax);
      this._hm.style.opacity = (t * t).toFixed(3);
      this._hm.style.transform = `scale(${(this._hitScale + (1 - t) * 0.12).toFixed(3)})`;
    }

    // --- ammo ---
    const w = ctx?.weapons;
    if (w) {
      const mag = w.ammo;
      if (Number.isFinite(mag) && mag !== c.mag) {
        c.mag = mag;
        this._magMax = Math.max(this._magMax, mag, 1);
        this._magEl.textContent = String(mag);
        // Low-ammo color shift (mag digits, bar, rifle icon -> #ff6a4a) below
        // 25% of the largest observed mag for this weapon.
        this._ammoEl.classList.toggle('low', mag < this._magMax * 0.25);
        const pct = Math.max(0, Math.min(1, mag / this._magMax)) * 100;
        this._barFill.style.width = pct.toFixed(1) + '%';
      }
      const res = w.reserve;
      if (Number.isFinite(res) && res !== c.reserve) {
        c.reserve = res;
        this._resEl.textContent = String(res);
      }
      const name = w.name;
      if (typeof name === 'string' && name && name !== c.name) {
        c.name = name;
        this._wnameEl.textContent = name;
      }
    }

    // --- damage vignette + low-HP pulse ---
    const hp = Number.isFinite(pl?.health) ? pl.health : 100;
    this._vinFlash = Math.max(0, this._vinFlash - dt * 1.1);
    const vin = Math.round(Math.min(1, Math.max(0, 1 - hp / 100) * 0.85 + this._vinFlash) * 100) / 100;
    if (vin !== c.vin) { c.vin = vin; this._vin.style.opacity = vin; }
    const low = this._lowHp ? hp < 45 : hp < 35; // hysteresis, no flicker at the edge
    if (low !== this._lowHp) { this._lowHp = low; this._lowEl.classList.toggle('on', low); }

    // --- directional damage arcs (world-anchored: re-rotated vs current yaw) ---
    for (const d of this._dmgPool) {
      if (d.ttl <= 0) continue;
      d.ttl -= dt;
      if (d.ttl <= 0) { d.el.style.opacity = '0'; continue; }
      d.el.style.transform = `rotate(${(d.ang - this._headingRad).toFixed(4)}rad)`;
      d.el.style.opacity = Math.min(1, d.ttl / 0.8).toFixed(2);
    }

    // --- minimap (30 Hz canvas redraw; heading was computed above) ---
    this._updateMap(dt, ctx);

    // --- top-left stats ---
    const kills = st?.kills ?? 0;
    if (kills !== c.kills) { c.kills = kills; this._killsEl.textContent = pad2(kills); }
    const score = st?.score ?? 0;
    if (score !== c.score) { c.score = score; this._scoreEl.textContent = String(score); }
    const sec = Math.floor(st?.timeAlive ?? 0);
    if (sec !== c.sec) { c.sec = sec; this._timeEl.textContent = fmtTime(sec); }
  }

  // ------------------------------------------------------------------ build

  _buildHud() {
    let host = document.getElementById('hud');
    if (!host) { host = el('div', '', document.body); host.id = 'hud'; }
    const root = this._root = el('div', 'af-root', host);

    // Full-screen overlays.
    this._vin = el('div', 'af-vignette', root);
    this._lowEl = el('div', 'af-lowhp', root);

    // Directional damage arc pool: filled 70-degree wedge band (r 62..80)
    // plus a hot stroked outer edge, rotated toward the shooter.
    const dmgLayer = el('div', 'af-dmg-layer', root);
    this._dmgPool = [];
    for (let i = 0; i < 8; i++) {
      const d = el('div', 'af-dmg', dmgLayer);
      d.innerHTML =
        '<svg viewBox="0 0 200 200">' +
        '<path class="af-dmg-fill" d="M 54.1 34.5 A 80 80 0 0 1 145.9 34.5 L 135.6 49.2 A 62 62 0 0 0 64.4 49.2 Z"/>' +
        '<path class="af-dmg-edge" d="M 54.1 34.5 A 80 80 0 0 1 145.9 34.5"/>' +
        '</svg>';
      this._dmgPool.push({ el: d, ttl: 0, ang: 0 });
    }

    // Compass. Fixed 15-degree tick spacing on every mark; labels live in a
    // separate upper band (21px cardinals at 90s, 11px degree numbers at 45s)
    // so glyphs can never collide with the tick row. The only heading
    // indicator is the amber center needle + the readout centered below it.
    const comp = el('div', 'af-compass', root);
    const win = el('div', 'af-compass-win', comp);
    const strip = this._strip = el('div', 'af-compass-strip', win);
    for (let cyc = 0; cyc < 3; cyc++) {
      for (let d = 0; d < 360; d += 15) {
        const x = (cyc * 360 + d) * PX_DEG;
        const major = d % 45 === 0;
        el('span', major ? 'af-c-tick af-c-major' : 'af-c-tick', strip).style.left = x + 'px';
        if (d % 90 === 0) {
          el('span', 'af-c-card', strip, CARDINAL[d]).style.left = x + 'px';
        } else if (major) {
          el('span', 'af-c-num', strip, pad3(d)).style.left = x + 'px';
        }
      }
    }
    el('div', 'af-compass-marker', comp);
    this._degEl = el('div', 'af-compass-deg', comp, '000');

    // Top-left column: circular minimap with the stats panel docked below it.
    const tlcol = el('div', 'af-tlcol', root);
    const map = el('div', 'af-map', tlcol);
    const dpr = this._mapDpr = Math.min(window.devicePixelRatio || 1, 2);
    const cv = this._mapCv = el('canvas', 'af-map-cv', map);
    cv.width = cv.height = Math.round(MAP_D * dpr);
    this._mapC2 = cv.getContext('2d');
    el('div', 'af-map-ring', map);
    const arrow = el('div', 'af-map-arrow', map);
    // Fixed player chevron: the map rotates under it (player-up convention).
    arrow.innerHTML = '<svg viewBox="-8 -8 16 16"><path d="M0 -6.2 L5 5.4 L0 2.6 L-5 5.4 Z"/></svg>';

    const tl = el('div', 'af-topleft', tlcol);
    const mkRow = (label) => {
      const row = el('div', 'af-tl-row', tl);
      el('span', 'af-tl-lab', row, label);
      return el('span', 'af-tl-val', row, label === 'OP TIME' ? '00:00' : '0');
    };
    this._timeEl = mkRow('OP TIME');
    this._killsEl = mkRow('KILLS');
    this._scoreEl = mkRow('SCORE');
    this._killsEl.textContent = '00';

    // Killfeed pool.
    this._feed = el('div', 'af-killfeed', root);
    this._feedPool = [];
    for (let i = 0; i < 8; i++) {
      const e = el('div', 'af-feed-e');
      e.style.display = 'none';
      el('span', 'af-f-you', e, 'YOU');
      const wep = el('span', 'af-f-wep', e, '[M4A1]');
      const hs = el('span', 'af-f-hs', e, 'HEADSHOT');
      hs.style.display = 'none';
      el('span', 'af-f-tgt', e, 'HOSTILE');
      e.addEventListener('animationend', () => { e.style.display = 'none'; e.classList.remove('go'); });
      this._feedPool.push({ el: e, wep, hs });
    }

    // Crosshair.
    const cross = this._cross = el('div', 'af-cross', root);
    this._cxT = el('div', 'af-cx af-cx-v', cross);
    this._cxB = el('div', 'af-cx af-cx-v', cross);
    this._cxL = el('div', 'af-cx af-cx-h', cross);
    this._cxR = el('div', 'af-cx af-cx-h', cross);
    el('div', 'af-cx-dot', cross);
    this._applyGap(this._gap);

    // Hitmarker (X of 4 diagonal arms with a gap around the crosshair center).
    const hm = this._hm = el('div', 'af-hm', root);
    for (let i = 0; i < 4; i++) {
      el('span', '', hm).style.transform = `rotate(${45 + 90 * i}deg) translateY(-15px)`;
    }

    // Kill-confirm popup pool.
    const popLayer = el('div', 'af-popups', root);
    this._popPool = [];
    for (let i = 0; i < 5; i++) {
      const p = el('div', 'af-popup', popLayer);
      const val = el('span', 'af-pop-val', p, '+100');
      const lab = el('span', 'af-pop-lab', p, 'HEADSHOT');
      lab.style.display = 'none';
      p.addEventListener('animationend', () => p.classList.remove('go'));
      this._popPool.push({ el: p, val, lab });
    }

    // Ammo block.
    const am = this._ammoEl = el('div', 'af-ammo', root);
    const head = el('div', 'af-ammo-head', am);
    const icon = el('span', 'af-ammo-icon', head);
    icon.innerHTML = RIFLE_SVG; // procedural weapon silhouette, tints red on low
    this._wnameEl = el('span', 'af-ammo-name', head, 'M4A1');
    el('span', 'af-ammo-mode', head, 'FULL AUTO');
    const nums = this._numsEl = el('div', 'af-ammo-nums', am);
    el('div', 'af-spinner', nums);
    this._magEl = el('span', 'af-ammo-mag', nums, '30');
    el('span', 'af-ammo-sep', nums, '/');
    this._resEl = el('span', 'af-ammo-res', nums, '120');
    const bar = el('div', 'af-ammo-bar', am);
    this._barFill = el('div', 'af-ammo-fill', bar);
    el('div', 'af-ammo-sub', am, '5.56 × 45 MM // RDS');
    el('div', 'af-reload-lab', am, 'RELOADING');
  }

  _makeNoiseUrl() {
    const size = 128;
    const { canvas, ctx: c2 } = makeCanvas(size);
    const rand = rng(97);
    const img = c2.createImageData(size, size);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = 90 + Math.floor(rand() * 140);
      img.data[i] = v;
      img.data[i + 1] = v;
      img.data[i + 2] = v;
      img.data[i + 3] = Math.floor(rand() * 60);
    }
    c2.putImageData(img, 0, 0);
    return canvas.toDataURL('image/png');
  }

  // ------------------------------------------------------------------ minimap

  /** One-time top-down bake of the static world from ctx.world.colliders.
   *  Buildings/walls read bright, low cover dimmer; ground/curbs are skipped. */
  _bakeMap(ctx) {
    const boxes = ctx?.world?.colliders;
    if (!boxes?.length) return;
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    const keep = [];
    for (const b of boxes) {
      const sx = b.max.x - b.min.x, sy = b.max.y - b.min.y, sz = b.max.z - b.min.z;
      if (sy < 0.9) continue;              // curbs / ground trim: map noise
      if (sx > 100 && sz > 100) continue;  // the ground slab itself
      keep.push(b);
      if (b.min.x < minX) minX = b.min.x;
      if (b.min.z < minZ) minZ = b.min.z;
      if (b.max.x > maxX) maxX = b.max.x;
      if (b.max.z > maxZ) maxZ = b.max.z;
    }
    if (!keep.length) return;
    const pad = 6, pxm = MAP_BAKE_PXPM;
    minX -= pad; minZ -= pad;
    const w = Math.min(2048, Math.ceil((maxX - minX + pad * 2) * pxm));
    const h = Math.min(2048, Math.ceil((maxZ - minZ + pad * 2) * pxm));
    const { canvas, ctx: c2 } = makeCanvas(Math.max(w, h));
    canvas.width = w; canvas.height = h; // makeCanvas is square; trim to fit
    // Low cover first, tall structures on top so building edges stay crisp.
    for (const pass of [0, 1]) {
      c2.fillStyle = pass ? 'rgba(233, 238, 244, 0.32)' : 'rgba(233, 238, 244, 0.15)';
      for (const b of keep) {
        if (((b.max.y - b.min.y) > 5 ? 1 : 0) !== pass) continue;
        c2.fillRect((b.min.x - minX) * pxm, (b.min.z - minZ) * pxm,
          (b.max.x - b.min.x) * pxm, (b.max.z - b.min.z) * pxm);
      }
    }
    c2.strokeStyle = 'rgba(233, 238, 244, 0.30)';
    c2.lineWidth = 1;
    for (const b of keep) {
      if ((b.max.y - b.min.y) <= 5) continue;
      c2.strokeRect((b.min.x - minX) * pxm, (b.min.z - minZ) * pxm,
        (b.max.x - b.min.x) * pxm, (b.max.z - b.min.z) * pxm);
    }
    this._mapBake = canvas;
    this._mapMinX = minX;
    this._mapMinZ = minZ;
  }

  /** 30 Hz circular minimap redraw: rotated bake (player-up), enemy dots,
   *  rim damage-direction flashes, upright 'N' riding the rim. Zero alloc. */
  _updateMap(dt, ctx) {
    for (const m of this._mapHits) if (m.ttl > 0) m.ttl -= dt;
    this._mapClock += dt;
    if (this._mapClock < MAP_HZ) return;
    this._mapClock = 0;
    if (this._phase !== 'playing') return; // hidden behind menu/pause/death
    const c2 = this._mapC2;
    if (!c2) return;
    if (!this._mapBake) this._bakeMap(ctx);

    const p = ctx?.player?.position;
    const px = p ? p.x : 0, pz = p ? p.z : 0;
    const hd = this._headingRad;
    const S = MAP_D, R = S / 2;
    c2.setTransform(this._mapDpr, 0, 0, this._mapDpr, 0, 0);
    c2.clearRect(0, 0, S, S);
    c2.beginPath(); c2.arc(R, R, R - 1, 0, TAU);
    c2.fillStyle = 'rgba(7, 11, 17, 0.62)';
    c2.fill();

    const bake = this._mapBake;
    if (bake) {
      c2.save();
      c2.beginPath(); c2.arc(R, R, R - 2.5, 0, TAU); c2.clip();
      c2.translate(R, R);
      c2.rotate(-hd); // player-up: world spins under the fixed chevron
      const s = MAP_PXPM / MAP_BAKE_PXPM;
      c2.scale(s, s);
      c2.drawImage(bake,
        -(px - this._mapMinX) * MAP_BAKE_PXPM,
        -(pz - this._mapMinZ) * MAP_BAKE_PXPM);
      c2.restore();
    }

    // Range ring at half view distance.
    c2.beginPath(); c2.arc(R, R, R * 0.5, 0, TAU);
    c2.strokeStyle = 'rgba(233, 238, 244, 0.07)';
    c2.lineWidth = 1;
    c2.stroke();

    // Enemy dots (red, edge-faded). Same rotation math as the bake layer.
    const cos = Math.cos(-hd), sin = Math.sin(-hd);
    const rim = R - 6;
    const enemies = ctx?.world?.enemies;
    if (enemies) {
      for (const e of enemies) {
        if (!e.alive || !e.position) continue;
        const ox = (e.position.x - px) * MAP_PXPM;
        const oz = (e.position.z - pz) * MAP_PXPM;
        const x = R + ox * cos - oz * sin;
        const y = R + ox * sin + oz * cos;
        const d = Math.hypot(x - R, y - R);
        if (d > rim) continue;
        const a = d > rim - 8 ? Math.max(0.15, (rim - d) / 8) : 1;
        c2.beginPath(); c2.arc(x, y, 3.6, 0, TAU);
        c2.fillStyle = `rgba(255, 73, 60, ${(0.3 * a).toFixed(3)})`;
        c2.fill();
        c2.beginPath(); c2.arc(x, y, 2, 0, TAU);
        c2.fillStyle = `rgba(255, 92, 78, ${a.toFixed(3)})`;
        c2.fill();
      }
    }

    // Damage-direction flashes on the rim (CoD-style, world-anchored).
    for (const m of this._mapHits) {
      if (m.ttl <= 0) continue;
      const t = Math.min(1, m.ttl / 1.15);
      const ca = m.ang - hd - Math.PI / 2; // bearing-from-up -> canvas angle
      c2.beginPath(); c2.arc(R, R, R - 4, ca - 0.55, ca + 0.55);
      c2.strokeStyle = `rgba(255, 69, 58, ${(t * 0.9).toFixed(3)})`;
      c2.lineWidth = 3.5;
      c2.lineCap = 'round';
      c2.stroke();
    }

    // Upright 'N' riding the rim at world north.
    const nx = R + Math.sin(-hd) * (R - 11);
    const ny = R - Math.cos(-hd) * (R - 11);
    c2.font = '700 10px "Helvetica Neue", "Segoe UI", Arial, sans-serif';
    c2.textAlign = 'center';
    c2.textBaseline = 'middle';
    c2.shadowColor = 'rgba(0, 0, 0, 0.9)';
    c2.shadowBlur = 3;
    c2.fillStyle = 'rgba(233, 238, 244, 0.92)';
    c2.fillText('N', nx, ny);
    c2.shadowBlur = 0;
  }

  // ------------------------------------------------------------------ events

  _wireEvents(ctx) {
    const ev = ctx?.events;
    if (!ev?.on) return;
    ev.on('weapon:ads', (p) => this._setAds(!!p?.ads));
    ev.on('weapon:reload:start', () => this._setReloading(true));
    ev.on('weapon:reload:end', () => this._setReloading(false));
    ev.on('weapon:fire', () => { this._fireKick = Math.min(this._fireKick + 3.2, 14); });
    ev.on('weapon:empty', () => this._retrigger(this._numsEl, 'af-dry'));
    ev.on('hit:enemy', (p) => this._showHitmarker(false, !!p?.headshot));
    ev.on('enemy:killed', (p) => {
      const headshot = !!p?.headshot;
      this._showHitmarker(true, headshot);
      this._spawnPopup(headshot);
      this._spawnFeed(headshot, ctx?.weapons?.name);
    });
    ev.on('player:damage', (p) => {
      this._vinFlash = Math.min(this._vinFlash + 0.4, 0.65);
      if (p?.direction) this._spawnDamageArc(p.direction);
    });
  }

  _setAds(v) {
    this._ads = v;
    this._cross.classList.toggle('ads', v);
  }

  _setReloading(v) {
    this._reloading = v;
    this._ammoEl.classList.toggle('af-reloading', v);
  }

  _retrigger(node, cls) {
    node.classList.remove(cls);
    void node.offsetWidth; // restart the CSS animation
    node.classList.add(cls);
  }

  _showHitmarker(kill, headshot) {
    this._hitMax = kill ? 0.45 : 0.3;
    this._hitTtl = this._hitMax;
    this._hitScale = headshot ? 1.35 : kill ? 1.15 : 1.05;
    // Tier grammar: white = hit, amber = headshot hit, red = any kill.
    this._hm.classList.toggle('hs', headshot && !kill);
    this._hm.classList.toggle('red', kill);
  }

  _spawnPopup(headshot) {
    const p = this._popPool[this._popIdx++ % this._popPool.length];
    p.val.textContent = headshot ? '+150' : '+100';
    p.lab.style.display = headshot ? '' : 'none';
    p.el.style.left = `calc(50% + ${Math.floor(Math.random() * 44 - 22)}px)`;
    p.el.style.top = `calc(56% + ${Math.floor(Math.random() * 14 - 7)}px)`;
    this._retrigger(p.el, 'go');
  }

  _spawnFeed(headshot, weaponName) {
    const f = this._feedPool[this._feedIdx++ % this._feedPool.length];
    f.wep.textContent = '[' + (weaponName || 'M4A1') + ']';
    f.hs.style.display = headshot ? '' : 'none';
    f.el.style.display = 'flex';
    this._feed.prepend(f.el); // newest on top
    this._retrigger(f.el, 'go');
  }

  _spawnDamageArc(direction) {
    const dx = Number(direction?.x) || 0;
    const dz = Number(direction?.z) || 0;
    if (dx === 0 && dz === 0) return;
    // direction = shot travel (enemy -> player); indicator points back at the shooter.
    const ang = Math.atan2(-dx, dz);
    let slot = this._dmgPool[0];
    for (const d of this._dmgPool) if (d.ttl < slot.ttl) slot = d;
    slot.ttl = 1.15;
    slot.ang = ang;
    slot.el.style.transform = `rotate(${(ang - this._headingRad).toFixed(4)}rad)`;
    slot.el.style.opacity = '1';
    // Mirror the hit direction on the minimap rim (same world bearing).
    let ms = this._mapHits[0];
    for (const m of this._mapHits) if (m.ttl < ms.ttl) ms = m;
    ms.ttl = 1.15;
    ms.ang = ang;
  }

  // ------------------------------------------------------------------ phase

  _applyGap(gap) {
    const g = gap.toFixed(2);
    this._cxT.style.transform = `translate(-1px, ${-(gap + CROSS_LEN).toFixed(2)}px)`;
    this._cxB.style.transform = `translate(-1px, ${g}px)`;
    this._cxL.style.transform = `translate(${-(gap + CROSS_LEN).toFixed(2)}px, -1px)`;
    this._cxR.style.transform = `translate(${g}px, -1px)`;
  }

  _setPhase(phase, ctx) {
    this._phase = phase;
    const m = this._menuRoot;
    if (m) {
      m.dataset.phase = phase;
      m.classList.toggle('af-hidden', phase === 'playing');
    }
    this._root.classList.toggle('on', phase === 'playing');

    const panels = this._menu?.panels;
    if (panels) {
      for (const key of Object.keys(panels)) {
        const panel = panels[key];
        const show = key === phase; // panel keys mirror phases: 'menu' | 'paused' | 'over'
        panel.classList.toggle('on', show);
        if (show) this._retrigger(panel, 'af-in');
      }
    }

    if (phase === 'paused' || phase === 'over') {
      const stats = phase === 'over' ? this._menu?.deathStats : this._menu?.pauseStats;
      const st = ctx?.state ?? {};
      if (stats) {
        stats.kills.textContent = String(st.kills ?? 0);
        stats.score.textContent = String(st.score ?? 0);
        stats.time.textContent = fmtTime(st.timeAlive ?? 0);
      }
    }
  }
}
