# ASHFALL PROTOCOL

A first-person shooter built entirely in ThreeJS — 100% procedural (zero asset files: every texture, model, and sound is generated in code). Built by a fleet of Claude sub-agents, each owning one engine subsystem, iterated through adversarial visual-critique rounds against real Call of Duty reference stills.

## Run

```bash
npm install
npm run dev        # http://localhost:5711
```

Node ≥ 20. `npm run build` produces a static bundle in `dist/`.

**Controls:** WASD move · Shift sprint · Space jump · C crouch · Mouse look · LMB fire · RMB aim · R reload

Append `#dev` to the URL to skip pointer-lock and expose `window.__game` (used by the screenshot/CI harness).

## Architecture

One system per module, integrated via a shared `ctx` (event bus + collision world + input) in `src/main.js`:

| Module | Owns |
|---|---|
| `atmosphere.js` | Sky, sun + shadow camera, PMREM environment (IBL), fog |
| `level.js` | Procedural ruined-city arena: buildings, props, PBR canvas textures, spawns |
| `player.js` | Camera rig, capsule collision, movement feel, health/regen |
| `weapons.js` | Procedural M4 viewmodel (hands included), springs for sway/recoil/ADS |
| `effects.js` | Pooled muzzle flash, tracers, casings, impacts, decals, smoke |
| `enemies.js` | Soldier models, procedural animation, combat AI state machine |
| `hud.js` | CoD-style DOM HUD: compass, minimap, ammo, hitmarkers, killfeed |
| `audio.js` | 100% synthesized WebAudio: layered gunshots, ambience, foley |
| `postfx.js` | pmndrs composer: N8AO, SMAA, bloom, ACES, split-tone grade, grain |

`scripts/shot.mjs` — headless screenshot harness (puppeteer-core + installed Chrome).
`scripts/record.mjs` — scripted-gameplay frame recorder (assemble with ffmpeg).
