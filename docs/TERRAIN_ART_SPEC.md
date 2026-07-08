# Terrain texture overhaul — asset spec (GBC → PSX)

Status: SPEC (H1068 era). The engine side is ready to receive artist
tiles; this doc is the exact shopping list. Written 2026-07-07 after
the GBC→PSX direction call.

## How terrain rendering works today (why this spec is shaped this way)

The world is an 18×18 px tile grid (`TILE = 18`, config/world/tiles.ts).
Off-road terrain is NOT texture files — `render/grass.ts` pre-bakes
eight 18×18 canvases procedurally at boot (standard/dry/lush grass,
dirt, clay, rocks, flowers, tall grass) and picks one per tile with a
deterministic hash (16 buckets), so the ground has variety at zero
per-frame cost. Roads/sidewalks are stroked geometry, not tiles.

**The upgrade path**: keep the exact same variant-slot + hash system,
but LOAD artist-made tiles from `public/terrain/` with the procedural
bake as fallback while slots are missing. Engine work (mine): loader +
fallback, new slot definitions, optional global PS1 post-pass. Art
(yours): the tiles below.

## What to create — phase 1 (the ground you see most)

All tiles: **18×18 px, seamless on all four edges against themselves
AND against the other tiles in their family** (test by tiling 3×3 in
Aseprite). PNG, no alpha on base tiles.

| File | Replaces | Notes |
|---|---|---|
| `grass_std_a.png`, `grass_std_b.png` | V0 standard grass | two interchangeable variants kill the checkerboard repeat |
| `grass_dry.png` | V1 dry | straw/yellow-green, Carolina summer |
| `grass_lush.png` | V2 lush | deep green, use sparingly-saturated darks |
| `dirt.png` | V3 | bare trodden dirt |
| `clay.png` | V4 | NC red clay — keep it, it's regional flavor |
| `rocks.png` | V5 | grass base + rock cluster |
| `flowers.png` | V6 | grass base + tiny blooms (2-3 px) |
| `grass_tall.png` | V7 | clumped blades, slightly darker base |

Phase 2 (after phase 1 looks right in-game): `sand.png`,
`gravel_lot.png`, water base + 4-edge shore transitions
(`water.png`, `shore_n/e/s/w.png`), and 2–3 asphalt/sidewalk wear
decal tiles (alpha PNGs overlaid on the stroked roads — roads stay
geometry).

## PSX look rules (what makes it read as PS1, not GBC)

1. **15-bit color**: pick every color as if channels only have 32
   levels (RGB values that are multiples of 8). Aseprite: work in an
   indexed palette you build once.
2. **8–16 colors per tile**, one shared master ramp per family
   (all grasses share a green ramp; dirt/clay share an earth ramp).
   I can generate the master ramp file from the game's existing
   world hues on request — say the word.
3. **Dither gradients, never band them**: 2×2 or 4×4 Bayer-pattern
   checker dither between ramp steps (the PS1 GPU did this in
   hardware; baked-in reads authentic).
4. **No pure black, no pure white** — darkest ~#101410, lightest
   stays under #d8d8d0. Night tinting multiplies on top.
5. **Low-frequency detail**: at 18 px and ~2.2× zoom, 1-px noise
   turns to mush. Feature size 2–4 px (a rock is 3–5 px, a flower
   2–3 px).
6. **Avoid symmetry/landmarks** in base tiles — anything distinctive
   repeats visibly on the hash grid. Save landmarks for decal tiles.

## Workflow + delivery

- Tool: Aseprite (indexed mode, tiled-view toggle for seamless check).
- Drop files in `public/terrain/` with the names above.
- ⚠ **LFS gotcha**: `public/**/*.png` is LFS-tracked. After committing,
  verify real bytes (`ls -la`, files should be KB not ~130 B pointer
  stubs) or sprites silently fail to load on the Pages build.
- I wire the loader with per-file graceful fallback, so tiles can land
  one at a time — the game mixes artist tiles + procedural fills until
  the set completes.

## Engine work I'll pair with it (no art needed from you)

- `public/terrain/` loader + hash-slot integration + fallback.
- Optional OPT toggle: **PS1 post-pass** on the world canvas
  (15-bit quantize + ordered dither + existing scanlines) — makes even
  the current procedural terrain read PSX while art lands.
- A preview harness page that tiles any PNG 8×8 with the night tint
  applied, so you can check seams/palette without booting the game.
