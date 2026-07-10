# Driver City — Terrain Tile Art Brief (Auto Modellista restyle)

> **Paste this whole document to your image AI (ChatGPT / GPT-image) as the art
> bible before asking for any tiles.** It is self-contained: the game's hard
> constraints, the exact look we want, the palette to stay inside, every tile to
> make, and a realistic step-by-step for producing them with an image model.
>
> Companion doc: [`TERRAIN_ART_SPEC.md`](./TERRAIN_ART_SPEC.md) is the earlier
> GBC→PSX version. This file keeps that doc's **technical foundation** (18px
> tiles, `public/terrain/` loader with procedural fallback, the hash-slot
> system, the LFS gotcha) and **replaces the style direction** with Auto
> Modellista. Where they disagree on *look*, this file wins.

---

## 0. How to use this brief (read first, AI)

You are producing **top-down terrain tiles for a pixel-art racing game**. You
**cannot** paint a finished 18×18-pixel seamless tile in one shot — no image
model can. So your job is one of these, and you should say which you're doing:

1. **Style reference** — a larger Auto-Modellista-styled top-down material swatch
   (grass field, water surface, dirt) that a human then reduces to 18px. *(best
   quality; default)*
2. **Big tileable swatch** — one material rendered large (e.g. 360×360) and
   *designed to tile*, to be nearest-neighbor downscaled to 18px + cleaned up.
3. **Coherent tilesheet** — several materials in one consistent pass so the
   family reads as one set.

The pixel-finishing pass (§7) is mandatory after any of these. Never hand back
a JPEG with soft edges and call it a tile.

---

## 1. What you're making & where it's seen

Driver City is a **top-down** (bird's-eye, straight-down) driving game set in
1999 Charlotte, NC. The world is a **2500×2500 grid of 18×18-pixel tiles**
(`TILE = 18`). The camera looks straight down at ~2–3× zoom, so a tile is only
~40–55 screen pixels. Terrain is the carpet the roads and cars sit on:

- **Grass** (8 hash-picked variants) is ~70% of what the player sees off-road.
- **Water** for rivers/lakes.
- A **secondary set** (forest, dirt road, canyon, bridge deck, gas pavement,
  parking lots, sidewalk) — see priority tiers in §5.

Roads, buildings, and lane markings are **not** tiles (they're drawn as smooth
vector geometry), so **do not** draw roads, cars, buildings, text, or lane
lines into a terrain tile. Terrain only.

---

## 2. HARD technical requirements (non-negotiable)

| Requirement | Value |
|---|---|
| **Final tile size** | **18 × 18 px**, exactly. |
| **Orientation** | **Top-down** (looking straight down). No horizon, no perspective, no cast side-shadows implying a light from the side. |
| **Seamless** | Must tile against **itself on all four edges** *and* against the other tiles in its family. Test by laying it out 3×3 — no visible seam line, no repeating "landmark." |
| **Anti-aliasing** | **None.** Hard pixel edges only. The engine renders with smoothing OFF (`imageSmoothingEnabled = false`, `image-rendering: pixelated`). Any soft/blurred pixel reads as a smear in-game. |
| **Colors per tile** | **4–8** for base ground; up to ~10 if it has a feature (rocks, flowers). One shared master ramp per **family** (all grasses share one green ramp, etc. — §4). |
| **15-bit-safe color** | Pick every channel value as a **multiple of 8** (the game sits on a PS1-flavoured substrate + a night-time tint that multiplies on top). |
| **No pure black / no pure white** | Darkest ≈ `#101410`, lightest stays under ≈ `#d8d8d0`. Night tint multiplies on top, so true black would crush and true white would blow out. |
| **Feature size** | **2–4 px minimum.** At 18px and 2–3× zoom, 1-px noise turns to mush. A rock is 3–5 px, a flower head 2–3 px, a shingle/blade cluster 2–3 px. |
| **Format** | PNG. Base ground tiles: **no alpha** (fully opaque). Overlay/decal tiles (shore edges, wear): alpha PNG, same 18×18. |
| **Variants** | Where noted, deliver **2 interchangeable versions** (e.g. `grass_std_a` + `grass_std_b`) so the 18-px grid doesn't visibly checkerboard. |

---

## 3. The look: Auto Modellista, at 18 pixels

**Auto Modellista** (Capcom, 2002) looks like a **living comic book**: flat
cel-shaded surfaces, **bold black ink outlines**, **manga screentone** (halftone
dot fills and hatching), a limited but punchy, slightly chalky palette, and
poster-clean shapes. It is *illustration*, not photography.

We are translating that language onto tiny top-down pixel tiles. The five
pillars and how each becomes a tile rule:

### The five pillars → tile rules

1. **Flat cel shading (hard tone bands).** Real AM surfaces are 2–3 *flat*
   tones with hard edges — never a smooth gradient. **Tile rule:** each material
   gets **2–3 flat tone zones** (a base mid, a shadow clump, a lit clump). The
   boundary between zones is a **hard 1-px step**, not a blend.

2. **Bold ink outlines.** AM draws heavy dark linework around forms and where
   planes meet. **Tile rule:** ink lives on **interior features only** (the edge
   of a rock, a dirt patch, a tree canopy, a shoreline) as deliberate **1-px
   near-black lines** (`#101410`, not pure black). **Never ink the tile border**
   — the border must wrap invisibly (§6).

3. **Screentone / halftone — the signature move.** AM fills mid-tones with
   **ordered dot patterns and hatching**, not gradients. This maps *beautifully*
   to pixels. **Tile rule:** represent a secondary tone as an **ordered 1-px dot
   pattern** (checker / Bayer) of a darker or lighter ramp color over the base —
   a *distinct flat texture*, with a **hard boundary** to the next zone.
   Different dot densities (≈25% vs ≈50% coverage) read as different tones.
   > ⚠ This is the key difference from the PSX doc. PSX = *dither a gradient*
   > (blend two steps to fake a ramp). AM = *screentone as a flat tone/texture*
   > with hard edges between zones. Use screentone **inside a zone**, hard steps
   > **between zones**. Do not smear a soft gradient across the whole tile.

4. **Punchy, chalky, limited palette.** Flatter and a touch more saturated /
   graphic than muddy realism, but still grounded (this is Carolina, not candy).
   4–8 colors, one family ramp, 15-bit-safe (§4).

5. **Poster legibility.** Clean shapes, low noise, no fine speckle. If a
   feature wouldn't read as a clear shape at 45 screen-px, cut it.

### Do / Don't

| Do | Don't |
|---|---|
| 2–3 flat tone zones, hard 1-px steps between them | Smooth gradients or soft blur |
| Screentone dots as a *texture fill* for a tone | Random per-pixel noise / TV static |
| 1-px near-black ink on interior feature edges | Ink or dark line on the tile border |
| Keep features 2–4 px, low-frequency | 1-px scatter that mushes at zoom |
| Multiples-of-8 channel values, one family ramp | Off-ramp one-off colors, pure #000/#fff |
| Chalky-punchy flat greens/earths | Photoreal texture, bevels, drop shadows |

---

## 4. Palette (stay inside this)

Keep new tiles **compatible with the un-restyled world during the transition**:
anchor to the game's current hues, then push them AM-flat (fewer steps, harder
edges, one ink tone, screentone instead of gradient). All values below are from
the live game; treat them as the ramp to *live inside*, snapping to
multiples-of-8 as you flatten.

**Global**
- Ink / outline: `#101410` (near-black green — never `#000000`)
- Brightest allowed: ≤ `#d8d8d0` (never `#ffffff`)

**Grass family** (one green ramp shared by std / dry / lush / tall)
- Shadow: `#0e200e` → mid-dark `#162a16` → **base** `#1e321e` → lit `#26402a`
- Dry variant shifts warm: base `#28401f`, lit `#324a26`, straw fleck `#5a5a20`
- Lush shifts deep/cool: base `#142e16`, lit `#1e4220`, fresh-leaf `#2a5a2a`
- Bush/foliage accent: `#0a3a0a` with `#1a5a1a` hilite

**Earth family** (dirt / clay / dirt-road, shared brown ramp)
- Dirt: `#2a2418` → `#352c1e` → fleck `#4a3d28` → `#5a4830`, rut ink `#1e1810`
- Clay (NC red — keep it, it's regional flavor): `#3a1f12` → `#4a2818` →
  `#6a3825` → hilite `#7a4530`

**Water family**
- Base: `#0a2038` / `#143858` (2-tone) · ripple lights `#2058a0`, `#4088c8`
- (Shore transition tiles blend the water base into the grass base — §5.)

**Stone / paved family**
- Rock cluster: `#3a3a3a` body, `#5a5a5a` lit face, ink `#101410`
- Sidewalk / concrete lot: `#383838`/`#3a3a3a`, curb `#555`, concrete
  `#bab4a6`/`#bcb6a8`
- Asphalt lot: `#48484a`/`#4a4a48`
- Bridge deck (wood): `#383028`/`#3a3530`, rail `#665`/`#776`
- Gas pavement: `#383830`/`#3a3a32`

If you want, generate a single **master ramp strip PNG** (all families,
dark→light) first and paste every subsequent tile's palette from it — that
guarantees family cohesion.

---

## 5. Tile catalog

Each tile is **18×18 px**, top-down, per the rules above. "Edges" tells you what
must wrap. Priority tiers: build **P1 first**, get it approved in-game, then P2/P3.

### P1 — the ground you see most (do these first)

| File (`public/terrain/…`) | Art-dump ref | What it is | Cel/screentone treatment | Edges |
|---|---|---|---|---|
| `grass_std_a.png`, `grass_std_b.png` | `grass_v0_standard` | Standard mown grass | Base green + one shadow-screentone clump + a few 2-px lit tufts. Two variants so the grid doesn't checker. | wrap all 4 |
| `grass_dry.png` | `grass_v1_dry` | Dry/straw summer grass | Warmer base, sparse straw flecks (2-px), light screentone | wrap all 4 |
| `grass_lush.png` | `grass_v2_lush` | Deep lush grass | Darker cooler base, denser shadow screentone, small fresh-leaf hilites | wrap all 4 |
| `grass_tall.png` | `grass_v7_tallgrass` | Clumped tall blades | Slightly darker base + 8–10 vertical 1×2 blade clusters, inked bases | wrap all 4 |
| `dirt.png` | `grass_v3_dirt` | Bare trodden dirt | Earth base, 2–3 flat tone zones, subtle screentone, no grass | wrap all 4 |
| `clay.png` | `grass_v4_clay` | NC red clay patch | Red-earth ramp, harder cel bands, 1-px ink at patch cracks | wrap all 4 |
| `rocks.png` | `grass_v5_rocks` | Grass base + rock cluster | Grass base (as std) + 3–4 inked rocks (3–5 px), each = body tone + one lit face + 1-px ink outline | wrap all 4; keep rocks ≥2px from edge |
| `flowers.png` | `grass_v6_flowers` | Grass base + tiny blooms | Grass base + 4–5 blooms (2–3 px, red/yellow/white/violet) on 1-px green stems | wrap all 4; blooms interior |
| `water.png` | `water_8x8` | Open water surface | 2 flat blue tones + screentone ripple *bands* (hard-edged horizontal dot rows), no smooth gradient | wrap all 4 |
| `shore_n/e/s/w.png` | — (new) | Water→grass edge, 4 rotations | Grass on one side, water on the other, an **inked shoreline** between; alpha PNG overlaid on water | one edge = grass, opposite = water |

### P2 — paved & special surfaces (after P1 reads right)

| File | Art-dump ref | What it is | Notes |
|---|---|---|---|
| `sidewalk.png` | `t05_sidewalk` | Concrete sidewalk | Flat concrete + faint expansion-joint line (screentone, not a hard black grid) |
| `lot_asphalt.png` | `t18_lot_asphalt` | Parking-lot asphalt | Flat dark grey, sparse screentone grain |
| `lot_concrete.png` | `t19_lot_concrete` | Parking-lot concrete | Flat light grey, subtle joints |
| `gas_pavement.png` | `t07_gas_pavement` | Fuel-station apron | Flat grey-green, one dashed lane hint |
| `bridge_deck.png` | `t10_bridge_deck` | Wood/concrete deck | Plank bands (hard cel steps), inked plank seams, rail dabs on 2 edges |

### P3 — nature & terrain drama (optional / only if we revive the tile pass)

> These live in the currently-**dormant** `render/ground.ts` pass (not drawn
> today). Paint them for completeness / a future revival, but P1+P2 ship value
> first. Ask before investing heavily.

| File | Art-dump ref | What it is |
|---|---|---|
| `forest.png` | `t11_forest` | Dense canopy — 1–3 inked tree blobs (canopy = 2 flat greens + ink rim), top-down |
| `dirt_road.png` | `t12_dirt_road` | Trodden dirt road w/ 2 faint tire ruts (inked) |
| `canyon_wall.png` | `t13_canyon_wall` | Rock face top-down — flat stone bands + inked crevices |
| `canyon_edge.png` | `t14_canyon_edge_road` | Dirt shoulder with an inked cliff rail on the canyon side |

---

## 6. Seamless tiling — the rules that make or break it

A terrain tile that doesn't wrap ruins the whole field. Follow all of these:

1. **Edge continuity.** The **left column** of pixels must flow into the **right
   column**, and the **top row** into the **bottom row**, as if the tile were
   repeated. The easiest way: design on a canvas, then **offset by half
   (9,9)** and fix the seam that appears in the middle, so the *original* edges
   are guaranteed continuous.
2. **No border ink.** Ink outlines are for interior features only. A dark line
   touching the tile edge becomes a grid of dark lines across the whole map.
3. **Keep features interior.** A rock/flower/blade cluster should sit ≥2 px from
   every edge (or be deliberately wrapped). Otherwise it clips at the seam.
4. **No landmarks, no symmetry.** Anything distinctive (a bright rock, a
   symmetric blob) repeats visibly on the grid. Base tiles = even, low-frequency
   texture. Save "a thing you notice" for decal/feature tiles used sparsely.
5. **Family cohesion.** Grass variants must tile against *each other* too (they
   sit side by side via the hash), so keep the same base green and lighting
   direction across all grasses. Same for the earth family, etc.
6. **Test 3×3.** Always preview a 3×3 lay-up. If your eye catches a seam or a
   repeat rhythm, it's not done.

---

## 7. Producing these with an image model (the real workflow)

An image model can't emit a finished 18×18 seamless indexed PNG. Here's what
actually works.

### Why not "just make an 18px tile"
At 18px every pixel is a deliberate art decision; models paint soft, off-palette,
non-tiling raster. So we generate **big + styled**, then **reduce + snap +
seam-fix** by hand (or I can do the pixel pass — hand me the big swatches).

### Route A — style reference (default, best quality)
Ask the model for a **large top-down material swatch** (1024×1024) of one
material in the Auto Modellista language, following §3–§4. Use it as the *look
target*; a pixel artist redraws the 18px tile to match its palette and cel/
screentone feel. This yields the truest AM read.

### Route B — big tileable swatch (fast, for simple materials)
Ask for the material rendered at **360×360 (= 20× a tile), explicitly seamless
and tileable, flat colors**. Then: nearest-neighbor downscale to 18×18 → snap to
the family palette → hand-fix the four edges. Good for grass/dirt/asphalt; rocks
& flowers usually still need a manual redraw.

### Route C — coherent tilesheet
Ask for a **single labeled sheet** with all P1 materials as large flat swatches
in **one consistent pass**, so the family reads as one set. Then extract and
reduce each. Best for keeping greens/earths cohesive.

### The pixel-finishing pass (mandatory, in Aseprite or similar)
1. **Downscale** the AI art with **nearest-neighbor** to 18×18 (never bilinear).
2. **Index / palette-snap** to the family ramp (§4). Build the indexed palette
   once; map every pixel to it. Kill off-ramp colors.
3. **Flatten to cel zones** — merge near-tones into 2–3 flat zones with hard
   1-px steps; convert any surviving gradient into a **screentone dot zone**.
4. **Ink pass** — add/clean 1-px `#101410` outlines on interior features; strip
   any ink from the border.
5. **Seam-fix** — offset (9,9), repair the middle, confirm the original edges
   wrap. Preview 3×3.
6. **Check at scale** — view at 2× and 3×; anything that mushes gets bigger or
   gets cut.

### Copy-paste prompt blocks

**Global style preamble (paste once, then a material line):**
```
Top-down (straight bird's-eye) terrain material for a pixel-art game, in the
art style of Capcom's Auto Modellista: flat cel shading with 2–3 hard-edged
tone bands (NO gradients), bold near-black ink outlines on interior shapes only,
manga screentone (ordered halftone dot fills / hatching) used as flat texture
for mid-tones, a limited punchy slightly-chalky palette, poster-clean low-noise
shapes. No perspective, no horizon, no cast side shadows. No roads, cars,
buildings, text, or lane lines — terrain only. Seamless and tileable on all four
edges. Flat, graphic, comic-book look. Render large and clean for later pixel
reduction.
```

**Per-material lines (append one to the preamble):**
- Grass: `Material: mown Carolina grass, deep green base (#1e321e) with a darker screentone shadow clump and a few lighter lit tufts; even, low-frequency, seamless.`
- Dry grass: `Material: dry straw-green summer grass, warm base (#28401f), sparse straw flecks, light screentone; seamless.`
- Lush grass: `Material: deep lush grass, cool dark base (#142e16), dense shadow screentone, small fresh-leaf highlights; seamless.`
- Dirt: `Material: bare trodden brown dirt (#352c1e), 2–3 flat earth tone zones, subtle screentone, inked cracks; seamless.`
- Red clay: `Material: North-Carolina red clay (#6a3825), hard cel bands, 1-px ink at cracks; seamless.`
- Water: `Material: calm water surface, two flat blues (#0a2038 / #143858), hard-edged screentone ripple bands (rows of dots), no smooth gradient; seamless.`
- Rocks: `Grass base as above with 3–4 grey rocks (#3a3a3a body, #5a5a5a lit face) each with a 1-px near-black ink outline; rocks kept away from tile edges; seamless.`

---

## 8. Delivery & naming

- Deliver final tiles as **18×18 PNG** into **`public/terrain/`** using the
  filenames in §5. (The engine loader — when wired — reads this folder slot by
  slot and falls back to the current procedural bake for any missing file, so we
  can land tiles **one at a time**.)
- Also keep the **large source art** (the 360px / 1024px swatches) somewhere out
  of `public/` (e.g. `art-src/terrain/`) so we can re-derive.
- ⚠ **LFS gotcha:** `public/**/*.png` is Git-LFS-tracked. After committing,
  confirm the files are **real bytes** (`ls -la` shows KB, not ~130-byte pointer
  stubs) or they load as blank/broken on the web build. If you see 130-byte
  files, the LFS filter didn't run — re-add after `git lfs install`.

---

## 9. Acceptance checklist (per tile)

- [ ] Exactly **18×18 px**, PNG, opaque (or alpha for shore/decal only).
- [ ] **Top-down**, no perspective / horizon / side shadow.
- [ ] **No anti-aliasing** — every pixel hard-edged.
- [ ] **4–8 colors**, all on the family ramp, all channels multiples of 8.
- [ ] No pure black (`#000`) or pure white (`#fff`); darkest ≥ `#101410`.
- [ ] **Cel zones with hard steps**; screentone used as flat texture, not a blur.
- [ ] Ink on **interior features only**; **border is clean** and wraps.
- [ ] Features **2–4 px+**, low-frequency, no landmark/symmetry.
- [ ] **Tiles 3×3** with no visible seam and no obvious repeat rhythm.
- [ ] Reads clearly at **2–3× zoom** (that's how it's seen in-game).
- [ ] Filename + folder match §5/§8.
