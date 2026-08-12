// HUD stylesheet — injected once by hud.js as a <style> tag. No external assets.
export const HUD_CSS = `
/* ============ shared tokens ============ */
#hud, #menu {
  --af-fg: #e9eef4;
  --af-dim: rgba(233, 238, 244, 0.55);
  --af-faint: rgba(233, 238, 244, 0.38);
  --af-line: rgba(233, 238, 244, 0.28);
  --af-accent: #ffb454;
  --af-red: #ff453a;
  --af-low: #ff6a4a;
  --af-glow: 0 0 6px rgba(180, 215, 255, 0.35), 0 1px 2px rgba(0, 0, 0, 0.85);
  font-family: "Helvetica Neue", "Segoe UI", "Roboto Condensed", Roboto, Arial, system-ui, sans-serif;
  color: var(--af-fg);
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}
/* Zero-specificity reset (:where) so class rules below can restore margins/
   paddings — an id-boosted "#menu *" reset would override every class rule. */
:where(#hud *, #menu *) { box-sizing: border-box; margin: 0; padding: 0; }
#hud { z-index: 10; }
#menu { z-index: 20; }
#menu.af-hidden { display: none; }

/* ============ HUD root ============ */
#hud .af-root { position: absolute; inset: 0; opacity: 0; transition: opacity 0.35s ease; }
#hud .af-root.on { opacity: 1; }

/* ---- damage vignette + low HP pulse ---- */
.af-vignette {
  position: absolute; inset: 0; opacity: 0; will-change: opacity;
  background: radial-gradient(ellipse at center, rgba(120, 0, 0, 0) 38%, rgba(150, 10, 6, 0.5) 72%, rgba(90, 0, 0, 0.85) 100%);
}
.af-lowhp {
  position: absolute; inset: 0; opacity: 0;
  background: radial-gradient(ellipse at center, transparent 45%, rgba(255, 30, 20, 0.28) 100%);
}
.af-lowhp.on { animation: afHeartbeat 1.6s ease-in-out infinite; }
@keyframes afHeartbeat {
  0%, 100% { opacity: 0.12; } 12% { opacity: 0.5; } 24% { opacity: 0.18; }
  36% { opacity: 0.45; } 55% { opacity: 0.12; }
}

/* ---- directional damage arcs (filled wedge + hot outer edge, points at shooter) ---- */
.af-dmg-layer { position: absolute; left: 50%; top: 50%; }
.af-dmg { position: absolute; left: -140px; top: -140px; width: 280px; height: 280px; opacity: 0; will-change: transform, opacity; }
.af-dmg svg { width: 100%; height: 100%; overflow: visible; display: block; }
.af-dmg .af-dmg-fill { fill: rgba(255, 59, 48, 0.38); stroke: none; }
.af-dmg .af-dmg-edge { fill: none; stroke: #ff453a; stroke-width: 5; stroke-linecap: round; filter: drop-shadow(0 0 8px rgba(255, 59, 48, 0.9)); }

/* ---- compass ----
   Two vertical bands so glyphs can never collide with tick marks:
   labels (21px cardinals / 11px degree numbers) live in the upper band,
   ticks hang from the bottom of the 38px window (fixed 15-deg spacing).
   One heading indicator only: an amber center needle through the tick band
   with the readout centered directly beneath it — no marker triangles. */
.af-compass { position: absolute; top: 16px; left: 50%; margin-left: -170px; width: 340px; height: 62px; }
.af-compass-win {
  position: absolute; top: 0; left: 0; right: 0; height: 38px; overflow: hidden;
  -webkit-mask-image: linear-gradient(90deg, transparent 0, #000 18%, #000 82%, transparent 100%);
  mask-image: linear-gradient(90deg, transparent 0, #000 18%, #000 82%, transparent 100%);
}
.af-compass-strip { position: absolute; top: 0; left: 0; height: 100%; width: 4320px; will-change: transform; }
.af-c-card {
  position: absolute; top: 0; transform: translateX(-50%); line-height: 1;
  font-size: 21px; font-weight: 800; letter-spacing: 0.04em; color: var(--af-fg);
  text-shadow: var(--af-glow);
}
.af-c-num {
  position: absolute; top: 7px; transform: translateX(-50%); line-height: 1;
  font-size: 11px; font-weight: 600; letter-spacing: 0.08em; color: var(--af-dim);
  font-variant-numeric: tabular-nums; text-shadow: var(--af-glow);
}
.af-c-tick { position: absolute; bottom: 0; width: 1px; height: 6px; background: rgba(233, 238, 244, 0.45); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.8); }
.af-c-tick.af-c-major { width: 2px; margin-left: -1px; height: 10px; background: rgba(233, 238, 244, 0.7); }
.af-compass-marker {
  position: absolute; top: 24px; left: 50%; width: 2px; height: 16px; margin-left: -1px;
  background: var(--af-accent);
  box-shadow: 0 0 5px rgba(255, 180, 84, 0.65), 0 1px 2px rgba(0, 0, 0, 0.7);
}
.af-compass-deg {
  position: absolute; top: 45px; left: 50%; transform: translateX(-50%);
  font-size: 12px; font-weight: 700; line-height: 1;
  letter-spacing: 0.18em; text-indent: 0.18em; /* indent balances trailing tracking: true optical center */
  color: var(--af-fg); font-variant-numeric: tabular-nums;
  text-shadow: 0 0 6px rgba(180, 215, 255, 0.3), 0 1px 2px rgba(0, 0, 0, 0.85);
}

/* ---- top-left column: circular minimap, stats panel docked below ---- */
.af-tlcol {
  position: absolute; top: 16px; left: 22px;
  display: flex; flex-direction: column; align-items: flex-start; gap: 10px;
}
.af-map { position: relative; width: 148px; height: 148px; }
.af-map-cv { display: block; width: 148px; height: 148px; border-radius: 50%; }
.af-map-ring {
  position: absolute; inset: 0; border-radius: 50%; pointer-events: none;
  border: 2px solid rgba(233, 238, 244, 0.3);
  box-shadow: 0 2px 14px rgba(0, 0, 0, 0.45), inset 0 0 20px rgba(0, 0, 0, 0.55);
}
.af-map-ring::before { /* forward notch — the map is player-up */
  content: ""; position: absolute; left: 50%; top: -4px; width: 2px; height: 7px;
  margin-left: -1px; background: var(--af-accent);
  box-shadow: 0 0 4px rgba(255, 180, 84, 0.7);
}
.af-map-arrow { position: absolute; left: 50%; top: 50%; width: 0; height: 0; pointer-events: none; }
.af-map-arrow svg {
  position: absolute; left: -9px; top: -9px; width: 18px; height: 18px; display: block;
}
.af-map-arrow path {
  fill: var(--af-accent); stroke: rgba(0, 0, 0, 0.75); stroke-width: 0.8;
  filter: drop-shadow(0 0 3px rgba(255, 180, 84, 0.55));
}

/* ---- stats panel (subtle dark gradient plate, heaviest at the top where it
        sits against open sky; 2px corners — sharp, mil-spec) ---- */
.af-topleft {
  display: flex; flex-direction: column; gap: 7px; min-width: 148px;
  padding: 12px 18px 12px 14px; text-transform: uppercase;
  background: linear-gradient(180deg, rgba(9, 13, 20, 0.68) 0%, rgba(6, 9, 14, 0.52) 55%, rgba(3, 5, 9, 0.38) 100%);
  border-radius: 2px;
  border-left: 3px solid var(--af-accent);
  border-top: 1px solid rgba(233, 238, 244, 0.09);
  box-shadow: 0 2px 14px rgba(0, 0, 0, 0.4);
}
.af-tl-row { display: flex; align-items: baseline; gap: 10px; }
.af-tl-lab { width: 64px; white-space: nowrap; font-size: 10px; letter-spacing: 0.3em; color: var(--af-dim); }
.af-tl-val { font-size: 16px; font-weight: 700; letter-spacing: 0.08em; text-shadow: var(--af-glow); font-variant-numeric: tabular-nums; }

/* ---- killfeed ---- */
.af-killfeed { position: absolute; top: 72px; right: 26px; display: flex; flex-direction: column; align-items: flex-end; width: 340px; text-transform: uppercase; }
.af-feed-e {
  display: flex; align-items: center; gap: 9px; margin-top: 6px; padding: 6px 12px;
  font-size: 11px; letter-spacing: 0.16em; opacity: 0;
  background: linear-gradient(270deg, rgba(8, 12, 18, 0.78), rgba(8, 12, 18, 0.25));
  border-right: 2px solid var(--af-accent); text-shadow: 0 1px 2px rgba(0, 0, 0, 0.9);
}
.af-f-you { color: var(--af-accent); font-weight: 700; }
.af-f-wep { color: var(--af-dim); }
.af-f-hs { color: var(--af-red); font-size: 9px; letter-spacing: 0.24em; border: 1px solid rgba(255, 69, 58, 0.5); padding: 1px 5px; }
.af-f-tgt { color: var(--af-fg); font-weight: 600; }
.af-feed-e.go { animation: afFeed 4s ease both; }
@keyframes afFeed {
  0% { opacity: 0; transform: translateX(18px); }
  4% { opacity: 1; transform: none; }
  82% { opacity: 1; }
  100% { opacity: 0; }
}

/* ---- crosshair ---- */
.af-cross { position: absolute; left: 50%; top: 50%; width: 0; height: 0; opacity: 0.92; transition: opacity 0.12s ease; }
.af-cross.ads { opacity: 0; }
.af-cross.sprint { opacity: 0.35; }
.af-cx { position: absolute; left: 0; top: 0; background: #f2f6fa; box-shadow: 0 0 4px rgba(190, 220, 255, 0.65), 0 0 1px rgba(0, 0, 0, 0.9); }
.af-cx-v { width: 2px; height: 11px; }
.af-cx-h { width: 11px; height: 2px; }
.af-cx-dot { position: absolute; left: -1px; top: -1px; width: 2px; height: 2px; background: #f2f6fa; box-shadow: 0 0 3px rgba(190, 220, 255, 0.8); }

/* ---- hitmarker (X of 4 diagonal arms, gap around the crosshair center)
        white = hit, amber = headshot hit, red = kill (.red last: kill wins) ---- */
.af-hm { position: absolute; left: 50%; top: 50%; width: 0; height: 0; opacity: 0; color: #ffffff; will-change: transform, opacity; }
.af-hm.hs { color: #ffcf7a; }
.af-hm.red { color: #ff5148; }
.af-hm span {
  position: absolute; left: -1.5px; top: -5px; width: 3px; height: 11px; border-radius: 1px;
  background: currentColor; box-shadow: 0 0 6px currentColor, 0 0 1px rgba(0, 0, 0, 0.9);
}

/* ---- kill confirm popups ---- */
.af-popups { position: absolute; inset: 0; }
.af-popup { position: absolute; left: 50%; top: 56%; opacity: 0; text-align: center; transform: translate(-50%, 0); }
.af-popup.go { animation: afPop 0.95s cubic-bezier(0.17, 0.84, 0.44, 1) forwards; }
.af-pop-val { font-size: 22px; font-weight: 800; letter-spacing: 0.06em; color: var(--af-accent); text-shadow: 0 0 8px rgba(255, 180, 84, 0.5), 0 1px 2px rgba(0, 0, 0, 0.9); }
.af-pop-lab { display: block; font-size: 9px; letter-spacing: 0.4em; color: var(--af-red); margin-top: 2px; text-shadow: 0 1px 2px rgba(0, 0, 0, 0.9); }
@keyframes afPop {
  0% { opacity: 0; transform: translate(-50%, 10px) scale(0.7); }
  12% { opacity: 1; transform: translate(-50%, 0) scale(1.08); }
  24% { transform: translate(-50%, -2px) scale(1); }
  70% { opacity: 1; }
  100% { opacity: 0; transform: translate(-50%, -30px) scale(1); }
}

/* ---- ammo block (subtle dark gradient plate, heaviest at the bottom where
        the 46px mag count sits against bright pavement/sky) ---- */
.af-ammo {
  position: absolute; right: 22px; bottom: 22px; text-align: right; min-width: 210px; text-transform: uppercase;
  padding: 12px 16px 14px;
  background: linear-gradient(180deg, rgba(3, 5, 9, 0.38) 0%, rgba(6, 9, 14, 0.54) 45%, rgba(9, 13, 20, 0.68) 100%);
  border-radius: 2px;
  border-right: 3px solid var(--af-accent);
  border-top: 1px solid rgba(233, 238, 244, 0.09);
  box-shadow: 0 2px 14px rgba(0, 0, 0, 0.4);
}
.af-ammo-head { display: flex; justify-content: flex-end; align-items: baseline; gap: 12px; font-size: 12px; letter-spacing: 0.26em; }
.af-ammo-icon { margin-right: auto; align-self: center; line-height: 0; }
.af-ammo-icon svg {
  display: block; width: 59px; height: 18px;
  fill: rgba(233, 238, 244, 0.55); filter: drop-shadow(0 1px 1px rgba(0, 0, 0, 0.8));
  transition: fill 0.15s;
}
.af-ammo-mode { font-size: 9px; color: var(--af-dim); letter-spacing: 0.3em; border: 1px solid var(--af-line); padding: 2px 6px; }
.af-ammo-nums { display: flex; justify-content: flex-end; align-items: baseline; margin-top: 2px; text-shadow: var(--af-glow); }
.af-ammo-nums.af-dry { animation: afDry 0.3s ease; }
.af-ammo-mag { font-size: 46px; font-weight: 800; letter-spacing: 0.02em; line-height: 1; font-variant-numeric: tabular-nums; transition: color 0.15s; }
.af-ammo-sep { font-size: 20px; margin: 0 7px; color: var(--af-dim); font-weight: 300; transform: skewX(-12deg); }
.af-ammo-res { font-size: 19px; font-weight: 600; color: var(--af-dim); font-variant-numeric: tabular-nums; }
.af-ammo-bar { margin: 8px 0 0 auto; width: 150px; height: 3px; background: rgba(233, 238, 244, 0.16); }
.af-ammo-fill { height: 100%; width: 100%; background: var(--af-fg); box-shadow: 0 0 6px rgba(200, 225, 255, 0.5); transition: width 0.12s ease, background 0.2s; }
.af-ammo-sub { margin-top: 7px; font-size: 9px; letter-spacing: 0.34em; color: var(--af-faint); }
.af-ammo.low .af-ammo-mag { color: var(--af-low); animation: afPulseTxt 1s ease infinite; }
.af-ammo.low .af-ammo-fill { background: var(--af-low); box-shadow: 0 0 6px rgba(255, 106, 74, 0.6); }
.af-ammo.low .af-ammo-icon svg { fill: rgba(255, 106, 74, 0.8); }
.af-spinner {
  display: none; width: 18px; height: 18px; border-radius: 50%; align-self: center; margin-right: 10px;
  border: 2px solid rgba(233, 238, 244, 0.15); border-top-color: var(--af-fg);
  animation: afSpin 0.7s linear infinite;
}
.af-ammo.af-reloading .af-spinner { display: block; }
.af-ammo.af-reloading .af-ammo-mag, .af-ammo.af-reloading .af-ammo-res { opacity: 0.35; }
.af-reload-lab { display: none; margin-top: 6px; font-size: 10px; letter-spacing: 0.4em; color: var(--af-accent); }
.af-ammo.af-reloading .af-reload-lab { display: block; animation: afBlink 0.8s linear infinite; }
.af-ammo.af-reloading .af-ammo-sub { display: none; }

/* ============ MENU / TITLE / PAUSE / DEATH ============ */
.af-m-blur {
  position: absolute; inset: 0; z-index: 1;
  -webkit-backdrop-filter: blur(3px) saturate(0.9) brightness(0.85);
  backdrop-filter: blur(3px) saturate(0.9) brightness(0.85);
}
#menu[data-phase="paused"] .af-m-blur {
  -webkit-backdrop-filter: blur(9px) saturate(0.75) brightness(0.7);
  backdrop-filter: blur(9px) saturate(0.75) brightness(0.7);
}
#menu[data-phase="over"] .af-m-blur {
  -webkit-backdrop-filter: blur(5px) saturate(0.45) brightness(0.55);
  backdrop-filter: blur(5px) saturate(0.45) brightness(0.55);
}
.af-m-shade {
  position: absolute; inset: 0; z-index: 2;
  background:
    linear-gradient(90deg, rgba(3, 6, 10, 0.9) 0%, rgba(3, 6, 10, 0.6) 40%, rgba(3, 6, 10, 0.12) 72%, rgba(3, 6, 10, 0.45) 100%),
    linear-gradient(180deg, rgba(2, 4, 8, 0.8) 0%, transparent 28%, transparent 66%, rgba(2, 4, 8, 0.92) 100%);
}
#menu[data-phase="paused"] .af-m-shade { background: rgba(4, 7, 12, 0.55); }
#menu[data-phase="over"] .af-m-shade { background: radial-gradient(ellipse at 50% 42%, rgba(60, 8, 6, 0.35), rgba(8, 2, 2, 0.88) 100%); }
.af-m-vin { position: absolute; inset: 0; z-index: 3; background: radial-gradient(ellipse at 50% 44%, transparent 52%, rgba(0, 0, 0, 0.6) 100%); }
.af-m-noise { position: absolute; inset: -20px; z-index: 3; opacity: 0.5; mix-blend-mode: overlay; animation: afGrain 0.9s steps(3) infinite; }
.af-m-scan {
  position: absolute; inset: 0; z-index: 3; opacity: 0.6;
  background: repeating-linear-gradient(180deg, rgba(255, 255, 255, 0.022) 0 1px, transparent 1px 3px);
}
@keyframes afGrain {
  0% { transform: translate(0, 0); } 33% { transform: translate(-14px, 8px); }
  66% { transform: translate(9px, -12px); } 100% { transform: translate(0, 0); }
}
.af-m-bar { position: absolute; left: 0; right: 0; height: 58px; background: #010306; z-index: 4; animation: afBar 1s cubic-bezier(0.19, 1, 0.22, 1) both; }
.af-m-bar.top { top: 0; transform-origin: 50% 0; }
.af-m-bar.bottom { bottom: 0; transform-origin: 50% 100%; }
@keyframes afBar { 0% { transform: scaleY(0); } 100% { transform: scaleY(1); } }
.af-m-foot {
  position: absolute; left: 0; right: 0; bottom: 21px; z-index: 6;
  display: flex; justify-content: space-between; gap: 12px; padding: 0 64px; /* 64px safe area */
  font-size: 10px; letter-spacing: 0.3em; color: rgba(233, 238, 244, 0.4); text-transform: uppercase;
}

/* ---- panels ----
   64px safe-area on every edge; children stack on a uniform 12px gap
   (no per-child margins) so nothing can clip or overlap. */
.af-panel { position: absolute; inset: 0; z-index: 5; display: none; flex-direction: column; gap: 12px; text-transform: uppercase; }
.af-panel.on { display: flex; }
.af-panel > * { max-width: 100%; }
.af-p-title { justify-content: center; align-items: flex-start; padding: 64px; }
.af-p-paused, .af-p-over { justify-content: center; align-items: center; text-align: center; padding: 64px; }
.af-p-over { --af-d: 0.65s; }
.af-panel.af-in > * { animation: afRise 0.7s cubic-bezier(0.19, 1, 0.22, 1) both; }
.af-p-over.af-in > * { animation-duration: 1s; }
.af-panel.af-in > :nth-child(1) { animation-delay: calc(var(--af-d, 0s) + 0s); }
.af-panel.af-in > :nth-child(2) { animation-delay: calc(var(--af-d, 0s) + 0.07s); }
.af-panel.af-in > :nth-child(3) { animation-delay: calc(var(--af-d, 0s) + 0.14s); }
.af-panel.af-in > :nth-child(4) { animation-delay: calc(var(--af-d, 0s) + 0.21s); }
.af-panel.af-in > :nth-child(5) { animation-delay: calc(var(--af-d, 0s) + 0.28s); }
.af-panel.af-in > :nth-child(6) { animation-delay: calc(var(--af-d, 0s) + 0.35s); }
.af-panel.af-in > :nth-child(7) { animation-delay: calc(var(--af-d, 0s) + 0.42s); }
.af-panel.af-in > :nth-child(8) { animation-delay: calc(var(--af-d, 0s) + 0.5s); }
@keyframes afRise {
  0% { opacity: 0; transform: translateY(26px); filter: blur(6px); }
  100% { opacity: 1; transform: none; filter: none; }
}

/* ---- typography ---- */
.af-eyebrow { font-size: 13px; letter-spacing: 0.5em; color: var(--af-accent); }
.af-eyebrow.af-e-red { color: var(--af-red); }
.af-title {
  font-family: "HelveticaNeue-CondensedBold", "Helvetica Neue Condensed", "Arial Narrow", "Helvetica Neue", "Segoe UI", Arial, sans-serif;
  font-stretch: condensed;
  font-size: clamp(64px, 10.5vw, 148px); font-weight: 800; letter-spacing: 0.02em; line-height: 0.94;
  background: linear-gradient(180deg, #ffffff 0%, #dbe4ee 55%, #93a3b5 100%);
  -webkit-background-clip: text; background-clip: text;
  -webkit-text-fill-color: transparent; color: transparent;
  filter: drop-shadow(0 2px 6px rgba(0, 0, 0, 0.6)) drop-shadow(0 0 22px rgba(150, 190, 255, 0.14));
}
.af-title.af-t-sm { font-size: clamp(48px, 7vw, 96px); letter-spacing: 0.06em; }
.af-title.af-t-red {
  background: none; -webkit-text-fill-color: var(--af-red); color: var(--af-red);
  filter: drop-shadow(0 0 26px rgba(255, 69, 58, 0.45)) drop-shadow(0 2px 2px rgba(0, 0, 0, 0.7));
}
.af-subtitle { display: flex; align-items: center; gap: 18px; font-size: clamp(15px, 1.6vw, 22px); letter-spacing: 0.62em; }
.af-subtitle::before, .af-subtitle::after { content: ""; height: 1px; width: 64px; }
.af-subtitle::before { background: linear-gradient(270deg, var(--af-line), transparent); }
.af-subtitle::after { background: linear-gradient(90deg, var(--af-line), transparent); }
.af-divider { width: min(420px, 40vw); height: 1px; background: linear-gradient(90deg, var(--af-accent), rgba(233, 238, 244, 0.25) 40%, transparent); }
.af-p-paused .af-divider, .af-p-over .af-divider { background: linear-gradient(90deg, transparent, rgba(233, 238, 244, 0.3), transparent); margin-left: auto; margin-right: auto; }
.af-hint { font-size: 11px; letter-spacing: 0.3em; color: var(--af-dim); }

/* ---- stats triplet ---- */
.af-stats { display: flex; gap: 56px; }
.af-stat { text-align: center; }
.af-stat-val { font-size: 44px; font-weight: 800; letter-spacing: 0.04em; text-shadow: var(--af-glow); font-variant-numeric: tabular-nums; }
.af-stat-lab { margin-top: 6px; font-size: 11px; letter-spacing: 0.38em; color: var(--af-dim); }

/* ---- buttons ---- */
.af-btn {
  pointer-events: auto; cursor: pointer; position: relative; display: inline-block;
  min-width: 280px; padding: 15px 34px;
  background: rgba(10, 14, 20, 0.45); border: 1px solid rgba(233, 238, 244, 0.35);
  color: var(--af-fg); font-family: inherit; font-size: 15px; font-weight: 700;
  letter-spacing: 0.42em; text-indent: 0.42em; text-transform: uppercase; text-align: center;
  -webkit-appearance: none; appearance: none;
  transition: background 0.15s, color 0.15s, border-color 0.15s, transform 0.15s;
}
.af-btn::before, .af-btn::after { content: ""; position: absolute; width: 10px; height: 10px; transition: transform 0.15s; }
.af-btn::before { left: -5px; top: -5px; border-left: 2px solid var(--af-accent); border-top: 2px solid var(--af-accent); }
.af-btn::after { right: -5px; bottom: -5px; border-right: 2px solid var(--af-accent); border-bottom: 2px solid var(--af-accent); }
.af-btn:hover { background: var(--af-fg); color: #0a0e14; border-color: var(--af-fg); }
.af-btn:hover::before { transform: translate(-3px, -3px); }
.af-btn:hover::after { transform: translate(3px, 3px); }
.af-btn:active { transform: scale(0.985); }
.af-btn.af-btn-red { border-color: rgba(255, 69, 58, 0.55); }
.af-btn.af-btn-red::before { border-color: var(--af-red); }
.af-btn.af-btn-red::after { border-color: var(--af-red); }
.af-btn.af-btn-red:hover { background: var(--af-red); border-color: var(--af-red); color: #14060a; }

/* ---- controls list ---- */
.af-controls {
  display: grid; grid-template-columns: auto auto auto auto;
  gap: 12px 22px; align-items: center;
  font-size: 11px; letter-spacing: 0.22em; color: var(--af-dim);
}
.af-keys { display: flex; gap: 5px; }
.af-key {
  min-width: 26px; padding: 4px 7px; text-align: center;
  border: 1px solid rgba(233, 238, 244, 0.3); border-bottom-width: 2px;
  font-size: 11px; letter-spacing: 0.08em; color: var(--af-fg); background: rgba(10, 14, 20, 0.4);
}
.af-act { margin-right: 22px; }

/* ---- shared keyframes ---- */
@keyframes afSpin { to { transform: rotate(360deg); } }
@keyframes afBlink { 0%, 55% { opacity: 1; } 56%, 100% { opacity: 0.25; } }
@keyframes afPulseTxt { 0%, 100% { opacity: 1; } 50% { opacity: 0.55; } }
@keyframes afDry { 0%, 100% { transform: none; } 25% { transform: translateX(3px); } 60% { transform: translateX(-3px); } }
`;
