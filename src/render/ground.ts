/**
 * Ground-tile rendering. Walks the tile bounds in the FrameView and stamps
 * a per-tile visual for each map cell. The 18 tile types each have their
 * own micro-renderer — buildings, water, bridges, forest, dirt road,
 * canyon, canyon-edge road, curved roads (tile 15/16), grass (tile 6),
 * gas station pavement, gas pumps, and the remaining road/empty/sidewalk
 * tiles.
 *
 * Ported from render() L30099–30441 of the v8.99.126.89 monolith. The
 * road TILE_OVERLAY pass on top of this (smooth Catmull-Rom curves) lives
 * in render/roads.ts and runs in a later phase.
 *
 * Diagnostic gate: when deps.diagOffGround === true, the entire pass is
 * skipped (used by the in-game F2 perf overlay).
 */

import type { FrameView } from './types';

/** Output of getBldg(wtx,wty) — palette + per-building stable identity. The
 *  ground pass only reads pal[0]; building tops/details live elsewhere. */
export interface BuildingTile {
  pal: readonly string[];
}

export interface GroundDeps {
  /** World tile size in world-units (= TILE constant from viewport config). */
  TILE: number;
  /** Map dimensions (tile count). */
  MAP_W: number;
  MAP_H: number;
  /** Returns the tile id at the given wrapped tile coords AFTER world-editor
   *  overlays + I-277 grass conversion. */
  resolvedTile(wtx: number, wty: number): number;
  /** Returns the raw map[] tile id. Used for sidewalk-edge neighbor checks
   *  and the foreground water-shimmer pass. */
  getTile(wtx: number, wty: number): number;
  /** Building lookup keyed on tile coords (cells in the same 4×4 building
   *  block share a BuildingTile). */
  getBldg(wtx: number, wty: number): BuildingTile;
  /** Curve angles for tile-15/16 curved roads, keyed `"wtx,wty"`. Value is
   *  the road tangent in radians at the tile center. */
  curveData: Record<string, number>;
  /** Lazily-built pre-rendered canvases for the 8 grass variants. The
   *  renderer calls buildGrassVariantCanvases() once on first paint. */
  grassVariantCanvases: HTMLCanvasElement[] | null;
  buildGrassVariantCanvases(): void;
  /** Diagnostic gate (F2 ground toggle in the monolith). */
  diagOffGround?: boolean;
}

const ROAD_COLS: ReadonlyArray<readonly [string, string]> = [
  ['#1a2a1a', '#1e2e1e'], // 0 — empty (rendered as grass since v126.09)
  ['#1a2a1a', '#1e2e1e'], // 1 — horiz road
  ['#1a2a1a', '#1e2e1e'], // 2 — vert road
  ['#1a2a1a', '#1e2e1e'], // 3 — intersection
  ['', ''],                // 4 — building (handled above; never used here)
  ['#3a3a3a', '#383838'], // 5 — sidewalk
];

export function drawGround(
  ctx: CanvasRenderingContext2D,
  view: FrameView,
  deps: GroundDeps,
): void {
  if (deps.diagOffGround) return;
  const { TILE, MAP_W, MAP_H, resolvedTile, getTile, getBldg, curveData } = deps;
  const { minTX, maxTX, minTY, maxTY } = view;

  for (let ty = minTY; ty <= maxTY; ty++) {
    for (let tx = minTX; tx <= maxTX; tx++) {
      const wtx = ((tx % MAP_W) + MAP_W) % MAP_W;
      const wty = ((ty % MAP_H) + MAP_H) % MAP_H;
      const tile = resolvedTile(wtx, wty);
      const wx = tx * TILE;
      const wy = ty * TILE;
      const alt = ((wtx + wty) % 2 === 0) ? 0 : 1;

      if (tile === 4) {
        // Standard building footprint (palette-tinted floor tile).
        const b = getBldg(wtx, wty);
        ctx.fillStyle = b.pal[0];
        ctx.fillRect(wx, wy, TILE, TILE);
      } else if (tile === 17) {
        // v8.99.124.20: user-placed building (World Editor Phase 3). Same
        // visual as tile 4, but bypasses the I-277 grass conversion check so
        // users can place buildings in the suburbs.
        const b = getBldg(wtx, wty);
        ctx.fillStyle = b.pal[0];
        ctx.fillRect(wx, wy, TILE, TILE);
      } else if (tile === 18 || tile === 19) {
        // H693 (tile=18 asphalt) + H695 (tile=19 concrete) parking-lot
        // pavement. H697 removed the baked stall stripes here — the
        // procedural stall overlay now draws actual oriented stall
        // rectangles + drive aisles + ADA cells on top of this base.
        // The tile pass just paints the flat pavement color.
        const isConcrete = tile === 19;
        if (isConcrete) {
          ctx.fillStyle = alt ? '#bcb6a8' : '#bab4a6';
        } else {
          ctx.fillStyle = alt ? '#4a4a48' : '#48484a';
        }
        ctx.fillRect(wx, wy, TILE, TILE);
      } else if (tile === 9) {
        // v8.99.56: GBC-style pixel water. 4-color palette, no RGB gradient.
        // Base fill with checker-dithered alt shade + 3 horizontal scanline
        // ripples that scroll with Date.now() for gentle surface motion.
        const wFrame = Math.floor(Date.now() / 220);
        ctx.fillStyle = alt ? '#143858' : '#0a2038';
        ctx.fillRect(wx, wy, TILE, TILE);
        const wSeed = (wtx * 7 + wty * 11) & 7;
        for (let wr = 0; wr < 3; wr++) {
          const wy2 = wy + ((wSeed + wr * 5 + wFrame) % TILE);
          ctx.fillStyle = (wr === 1) ? '#4088c8' : '#2058a0';
          for (let wxp = 0; wxp < TILE; wxp += 3) {
            if (((wxp + wFrame + wSeed) & 3) !== 0) {
              ctx.fillRect(wx + wxp, wy2, 2, 1);
            }
          }
        }
      } else if (tile === 10) {
        // Bridge deck: wood/concrete tones + railings + posts + a hint of
        // water peeking through the slats.
        ctx.fillStyle = alt ? '#3a3530' : '#383028';
        ctx.fillRect(wx, wy, TILE, TILE);
        ctx.fillStyle = '#665';
        ctx.fillRect(wx, wy, TILE, 2);
        ctx.fillRect(wx, wy + TILE - 2, TILE, 2);
        if (wtx % 2 === 0) {
          ctx.fillStyle = '#776';
          ctx.fillRect(wx + 2, wy, 2, 3);
          ctx.fillRect(wx + 2, wy + TILE - 3, 2, 3);
          ctx.fillRect(wx + TILE - 4, wy, 2, 3);
          ctx.fillRect(wx + TILE - 4, wy + TILE - 3, 2, 3);
        }
        ctx.fillStyle = 'rgba(20,50,90,0.3)';
        ctx.fillRect(wx + 1, wy + 3, TILE - 2, 1);
        ctx.fillRect(wx + 1, wy + TILE - 4, TILE - 2, 1);
      } else if (tile === 11) {
        // v8.99.56: GBC-style pixel forest. Fixed 4-color palette,
        // rect-only trees (canopy is a 5-rect cross/blob, no ctx.arc).
        ctx.fillStyle = alt ? '#0e240e' : '#0a1c0a';
        ctx.fillRect(wx, wy, TILE, TILE);
        const fSeed = (wtx * 31 + wty * 17) & 0xFF;
        ctx.fillStyle = '#143214';
        for (let fi = 0; fi < 3; fi++) {
          const fx = (fSeed + fi * 7) % TILE;
          const fy = (fSeed + fi * 13) % TILE;
          ctx.fillRect(wx + fx, wy + fy, 1, 1);
        }
        const trees = 1 + (fSeed % 3);
        for (let ti = 0; ti < trees; ti++) {
          const tx2 = wx + 3 + ((fSeed * (ti + 1) * 7) % 10);
          const ty2 = wy + 2 + ((fSeed * (ti + 1) * 11) % 11);
          const tsz = 2 + ((fSeed + ti) % 2);
          ctx.fillStyle = 'rgba(0,0,0,0.35)';
          ctx.fillRect(tx2 + 1, ty2 + tsz + 1, tsz * 2 - 1, 1);
          const cDark = ((fSeed + ti * 5) % 3 === 0) ? '#1a4a1a' : '#0c2e0c';
          const cMid  = ((fSeed + ti * 5) % 3 === 0) ? '#2a6a2a' : '#1a4a1a';
          ctx.fillStyle = cDark;
          ctx.fillRect(tx2 - tsz, ty2 - tsz + 1, tsz * 2, tsz * 2 - 1);
          ctx.fillRect(tx2 - tsz + 1, ty2 - tsz, tsz * 2 - 2, tsz * 2 + 1);
          ctx.fillStyle = cMid;
          ctx.fillRect(tx2 - tsz + 1, ty2 - tsz + 1, 2, 1);
          ctx.fillRect(tx2 - tsz + 1, ty2 - tsz + 2, 1, 1);
          ctx.fillStyle = '#3a2a1a';
          ctx.fillRect(tx2, ty2 + tsz, 1, 2);
        }
      } else if (tile === 12) {
        // v8.99.56: GBC-style dirt road. Dither + dashed vertical tire ruts.
        ctx.fillStyle = alt ? '#352c1e' : '#2a2418';
        ctx.fillRect(wx, wy, TILE, TILE);
        const gs2 = (wtx * 13 + wty * 7) & 0xFF;
        ctx.fillStyle = '#4a3d28';
        for (let gi = 0; gi < 4; gi++) {
          const gx = (gs2 + gi * 5) % TILE;
          const gy = (gs2 * 3 + gi * 11) % TILE;
          ctx.fillRect(wx + gx, wy + gy, 1, 1);
        }
        ctx.fillStyle = '#5a4830';
        for (let gi = 0; gi < 2; gi++) {
          const gx = (gs2 * 7 + gi * 13) % TILE;
          const gy = (gs2 * 5 + gi * 17) % TILE;
          ctx.fillRect(wx + gx, wy + gy, 1, 1);
        }
        if (wty % 3 === 0) {
          ctx.fillStyle = '#1e1810';
          for (let rk = 0; rk < TILE; rk += 3) {
            ctx.fillRect(wx + 4, wy + rk, 1, 2);
            ctx.fillRect(wx + TILE - 5, wy + rk, 1, 2);
          }
        }
      } else if (tile === 13) {
        // Canyon wall (deep). Shade by depth, rock texture, crevice shadows.
        const depth = (wtx + wty) % 3;
        const cShade = Math.max(10, 25 - depth * 6);
        ctx.fillStyle = `rgb(${cShade + 15},${cShade + 5},${cShade})`;
        ctx.fillRect(wx, wy, TILE, TILE);
        ctx.fillStyle = 'rgba(60,40,30,0.3)';
        if ((wtx + wty * 7) % 5 === 0) ctx.fillRect(wx + 2, wy + 4, TILE - 4, 3);
        if ((wtx * 3 + wty) % 4 === 0) ctx.fillRect(wx + 5, wy + 1, 3, TILE - 2);
        ctx.fillStyle = 'rgba(0,0,0,0.3)';
        if ((wtx + wty) % 7 === 0) ctx.fillRect(wx + 1, wy, 1, TILE);
      } else if (tile === 14) {
        // Canyon edge road. Stamps a brown rail on every edge adjacent to
        // a canyon-wall tile (13).
        ctx.fillStyle = alt ? '#2e2822' : '#2a2520';
        ctx.fillRect(wx, wy, TILE, TILE);
        const hasCliffR = wtx < MAP_W - 1 && getTile(wtx + 1, wty) === 13;
        const hasCliffD = wty < MAP_H - 1 && getTile(wtx, wty + 1) === 13;
        const hasCliffL = wtx > 0 && getTile(wtx - 1, wty) === 13;
        const hasCliffU = wty > 0 && getTile(wtx, wty - 1) === 13;
        ctx.fillStyle = '#664422';
        if (hasCliffR) ctx.fillRect(wx + TILE - 3, wy, 3, TILE);
        if (hasCliffL) ctx.fillRect(wx, wy, 3, TILE);
        if (hasCliffD) ctx.fillRect(wx, wy + TILE - 3, TILE, 3);
        if (hasCliffU) ctx.fillRect(wx, wy, TILE, 3);
        if ((wtx + wty * 5) % 3 === 0) {
          ctx.fillStyle = 'rgba(80,60,40,0.3)';
          ctx.fillRect(wx + 6, wy + 8, 2, 1);
        }
      } else if (tile === 15 || tile === 16) {
        // Curved road (tile 15) / curved dirt road (tile 16). Per-tile
        // tangent angle from curveData; quadratic curve through tile center
        // with edge-intersection entry/exit points. Asphalt grain + oil +
        // crack details for tile 15; tile 16 stays clean.
        const isDirt = tile === 16;
        ctx.fillStyle = alt ? '#1a2a1a' : '#1e2e1e';
        ctx.fillRect(wx, wy, TILE, TILE);
        const ca = curveData[wtx + ',' + wty] || 0;
        const T = TILE;
        const roadW = isDirt ? T * 0.55 : T * 0.85;
        const roadCol = isDirt ? (alt ? '#3a3020' : '#352c1e') : (alt ? '#2a2a2e' : '#282830');

        // Edge-intersection helper. Returns the world-space point where
        // a ray from the tile center at angle `a` hits the tile edge.
        const edgePt = (a: number): [number, number] => {
          const cx = wx + T / 2;
          const cy = wy + T / 2;
          const dx = Math.cos(a);
          const dy = Math.sin(a);
          let best = 1e9;
          let bx = cx;
          let by = cy;
          if (Math.abs(dx) > 0.01) {
            const t = dx > 0 ? (wx + T - cx) / dx : (wx - cx) / dx;
            const iy = cy + t * dy;
            if (t > 0 && t < best && iy >= wy - 1 && iy <= wy + T + 1) {
              best = t;
              bx = dx > 0 ? wx + T : wx;
              by = iy;
            }
          }
          if (Math.abs(dy) > 0.01) {
            const t = dy > 0 ? (wy + T - cy) / dy : (wy - cy) / dy;
            const ix = cx + t * dx;
            if (t > 0 && t < best && ix >= wx - 1 && ix <= wx + T + 1) {
              best = t;
              bx = ix;
              by = dy > 0 ? wy + T : wy;
            }
          }
          return [bx, by];
        };

        const exit = edgePt(ca);
        const entry = edgePt(ca + Math.PI);
        const cpx = wx + T / 2;
        const cpy = wy + T / 2;

        ctx.save();
        ctx.beginPath();
        ctx.rect(wx, wy, T, T);
        ctx.clip();
        ctx.lineWidth = roadW;
        ctx.lineCap = 'butt';
        ctx.lineJoin = 'round';
        ctx.strokeStyle = roadCol;
        ctx.beginPath();
        ctx.moveTo(entry[0], entry[1]);
        ctx.quadraticCurveTo(cpx, cpy, exit[0], exit[1]);
        ctx.stroke();

        if (!isDirt) {
          // Asphalt grain — light + dark flecks near road center.
          const seed = (wtx * 73 + wty * 137) & 0xFF;
          const rcx = cpx;
          const rcy = cpy;
          const hw2 = roadW * 0.35;
          ctx.fillStyle = 'rgba(255,255,255,0.06)';
          for (let gi = 0; gi < 4; gi++) {
            const gx = rcx - hw2 + ((seed * (gi + 1) * 13) % (hw2 * 2));
            const gy = rcy - hw2 + ((seed * (gi + 1) * 17) % (hw2 * 2));
            ctx.fillRect(gx, gy, 1.5, 1.5);
          }
          ctx.fillStyle = 'rgba(0,0,0,0.12)';
          for (let gi = 0; gi < 4; gi++) {
            const gx = rcx - hw2 + ((seed * (gi + 3) * 11) % (hw2 * 2));
            const gy = rcy - hw2 + ((seed * (gi + 3) * 19) % (hw2 * 2));
            ctx.fillRect(gx, gy, 1.5, 1.5);
          }
          if (seed % 4 === 0) {
            ctx.fillStyle = 'rgba(10,8,5,0.2)';
            const ox = rcx - 3 + (seed % 6);
            const oy = rcy - 3 + ((seed >> 3) % 6);
            ctx.beginPath();
            ctx.ellipse(ox, oy, 2 + seed % 2, 1.5 + seed % 2, seed * 0.1, 0, Math.PI * 2);
            ctx.fill();
          }
          if (seed % 8 === 0) {
            ctx.strokeStyle = 'rgba(0,0,0,0.15)';
            ctx.lineWidth = 0.5;
            ctx.beginPath();
            ctx.moveTo(rcx - 3 + (seed % 6), rcy - 4 + ((seed >> 2) % 4));
            ctx.lineTo(rcx + 2 + (seed % 4), rcy + 3 + ((seed >> 4) % 4));
            ctx.stroke();
          }
          // Center line.
          ctx.lineWidth = 1;
          ctx.strokeStyle = '#aa8800';
          ctx.beginPath();
          ctx.moveTo(entry[0], entry[1]);
          ctx.quadraticCurveTo(cpx, cpy, exit[0], exit[1]);
          ctx.stroke();
        }
        ctx.restore();
      } else if (tile === 6) {
        // v8.99.125.00: PSX-tier grass — 8 cached variants, hash-selected.
        // Single drawImage from a pre-baked variant canvas (replaces
        // v8.99.56's 10+ fillRects/tile speckle).
        if (!deps.grassVariantCanvases) deps.buildGrassVariantCanvases();
        const canvases = deps.grassVariantCanvases;
        if (canvases) {
          let gH = (((wtx | 0) * 73856093) ^ ((wty | 0) * 19349663)) | 0;
          gH = (gH ^ (gH >>> 13)) | 0;
          gH = Math.imul(gH, 1274126177) | 0;
          gH = (gH ^ (gH >>> 16)) >>> 0;
          const gPick = gH & 0xF;
          // v8.99.126.07: V3 (dirt) and V4 (clay) remapped to V0 (standard)
          // per user feedback — those tones read as "random asphalt" next to
          // roads. Canvases stay built so a future revival just re-enables
          // the lookup.
          let gVar: number;
          if (gPick < 4)         gVar = 0;       // standard (25%)
          else if (gPick < 7)    gVar = 1;       // dry      (19%)
          else if (gPick < 11)   gVar = 2;       // lush     (25%)
          else if (gPick === 11) gVar = 0;       // was dirt → standard
          else if (gPick === 12) gVar = 0;       // was clay → standard
          else if (gPick === 13) gVar = 5;       // rocks    (6%)
          else if (gPick === 14) gVar = 6;       // flowers  (6%)
          else                   gVar = 7;       // tall grass (6%)
          ctx.drawImage(canvases[gVar], wx, wy);
          // Decorative bushes — PRESERVED from v8.99.56. Renders additively
          // over the variant so existing placements are unchanged.
          if ((wtx + wty * 3) % 5 === 0) {
            const bx2 = wx + TILE / 2 - 2;
            const by2 = wy + TILE / 2 - 2;
            ctx.fillStyle = '#0a3a0a';
            ctx.fillRect(bx2, by2 + 1, 4, 2);
            ctx.fillRect(bx2 + 1, by2, 2, 4);
            ctx.fillStyle = '#1a5a1a';
            ctx.fillRect(bx2 + 1, by2 + 1, 1, 1);
          }
        }
      } else if (tile === 7) {
        // Gas station pavement + dashed lane lines.
        ctx.fillStyle = alt ? '#3a3a32' : '#383830';
        ctx.fillRect(wx, wy, TILE, TILE);
        if ((wtx + wty) % 3 === 0) {
          ctx.fillStyle = '#555';
          ctx.fillRect(wx + 2, wy + TILE / 2, TILE - 4, 1);
        }
      } else if (tile === 8) {
        // Gas pump (red box with a white face, dark hose).
        ctx.fillStyle = alt ? '#3a3a32' : '#383830';
        ctx.fillRect(wx, wy, TILE, TILE);
        ctx.fillStyle = '#c00';
        ctx.fillRect(wx + 4, wy + 3, TILE - 8, TILE - 6);
        ctx.fillStyle = '#fff';
        ctx.fillRect(wx + 6, wy + 5, TILE - 12, 4);
        ctx.fillStyle = '#222';
        ctx.fillRect(wx + TILE / 2 - 1, wy + TILE - 5, 2, 4);
      } else {
        // tile 0=empty, 1=horiz road, 2=vert road, 3=intersection,
        // 4=building (handled above), 5=sidewalk.
        //
        // v8.99.126.09: ROAD TILES (1, 2, 3) NOW RENDER AS GRASS at the
        // ground layer. They used to paint asphalt and rely on the smooth
        // road overlay to cover them — but the rasterized rectangles
        // didn't perfectly align with the curve overlay, so asphalt-colored
        // squares would poke out at corners. The smooth overlay is now the
        // single source of truth for what a road looks like; the underlying
        // tile rasterization is invisible. game logic (collision, AI pathing)
        // still reads tile types unchanged.
        const cols = ROAD_COLS[tile] || ROAD_COLS[0];
        ctx.fillStyle = cols[alt] || cols[0];
        ctx.fillRect(wx, wy, TILE, TILE);

        if (tile === 5) {
          // Sidewalk curb-edge dabs where the neighbor is a road tile (1-3).
          ctx.fillStyle = '#555';
          const lx = wtx;
          const ly = wty;
          const wrapW = (n: number) => ((n % MAP_W) + MAP_W) % MAP_W;
          const wrapH = (n: number) => ((n % MAP_H) + MAP_H) % MAP_H;
          const nL = getTile(wrapW(lx - 1), ly);
          const nR = getTile(wrapW(lx + 1), ly);
          const nU = getTile(lx, wrapH(ly - 1));
          const nD = getTile(lx, wrapH(ly + 1));
          if (nL >= 1 && nL <= 3) ctx.fillRect(wx, wy, 1, TILE);
          if (nR >= 1 && nR <= 3) ctx.fillRect(wx + TILE - 1, wy, 1, TILE);
          if (nU >= 1 && nU <= 3) ctx.fillRect(wx, wy, TILE, 1);
          if (nD >= 1 && nD <= 3) ctx.fillRect(wx, wy + TILE - 1, TILE, 1);
        }
      }
    }
  }
}
