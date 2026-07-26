/**
 * H1267 — painted START/FINISH LINES and STARTING-GRID BOXES on the racing
 * surface.
 *
 * The user tested the tracks and reported, twice, that they have no
 * start/finish line and no indicator lines for starting positions. They had
 * neither: nothing in src/render has ever drawn a checker or a grid box, and
 * the H1249 "Starting grid" was a parking-lot polygon that its own placement
 * search pushed OFF the track onto the grass verge (see config/world/startGrid
 * for the numbers). This paints the real thing, on the asphalt:
 *
 *   - circuits / oval : a two-row checkered band across the full pavement with
 *                       yellow edging (the Nürburgring reference), then eight
 *                       staggered L-corner grid boxes behind it
 *   - drag / car meet : a solid white start line, two staging boxes plus a
 *                       pre-stage bracket pair, and a checkered FINISH band a
 *                       true quarter mile down the strip
 *   - touge sprint    : a start band at the summit and a finish band at the base
 *
 * All the geometry lives in world/startLine (pure quads, shared with the sim
 * and the maplab SVG harness). This module's whole job is to bake those quads
 * into Path2Ds and fill them: ~110 quads drawn immediate-mode would be ~110 GPU
 * calls, which this project's cost model prices at 5-11 ms/frame; as subpaths
 * of three Path2Ds they cost three fills. Same bake-once idiom as the H650
 * mainPath / dividerPaths caches.
 *
 * Structured like render/crosswalks.ts otherwise — world pixels, camera
 * composite already applied by the caller, squared-distance cull.
 */

import { asphaltHalfPx } from './roads/crossingGeom';
import { getMapDef } from '@/world/mapRegistry';
import { getActiveMapId } from '@/world/mapRuntime';
import { buildStartDecals, trackEntryFor, trackPathFor } from '@/world/startLine';

/** Edge margin so a band ends at the curb line rather than overhanging the
 *  pavement. The same 1.5 world px crosswalks.ts uses. */
export const EDGE_MARGIN = 1.5;

const WHITE = 'rgba(236, 236, 232, 0.94)';
const DARK = 'rgba(18, 18, 20, 0.92)';
const YELLOW = 'rgba(214, 178, 40, 0.88)';

interface Baked {
  cx: number; cy: number; r: number;
  white: Path2D;
  dark: Path2D;
  yellow: Path2D;
}
interface Plan { mapId: string; groups: Baked[] }

let _plan: Plan | null = null;

/** Drop the baked paths — the next draw re-bakes from the active map's
 *  RENDER_ENTRIES. Called by switchMap once the entries are rebuilt. */
export function resetStartGrid(): void {
  _plan = null;
}

function buildPlan(): Plan {
  const mapId = getActiveMapId();
  const def = getMapDef(mapId);
  const plan: Plan = { mapId, groups: [] };
  if (!def.race) return plan;                 // the city, and anything unraced
  const entry = trackEntryFor(def);
  const path = trackPathFor(def);
  if (!entry || !path) return plan;
  const hw = asphaltHalfPx(String(entry.row[2] ?? ''), entry.row[0] as number) - EDGE_MARGIN;
  for (const g of buildStartDecals(def, path, hw)) {
    const baked: Baked = {
      cx: g.cx, cy: g.cy, r: g.r,
      white: new Path2D(), dark: new Path2D(), yellow: new Path2D(),
    };
    for (const q of g.quads) {
      const p = q.ink === 'dark' ? baked.dark : q.ink === 'yellow' ? baked.yellow : baked.white;
      p.moveTo(q.pts[0], q.pts[1]);
      p.lineTo(q.pts[2], q.pts[3]);
      p.lineTo(q.pts[4], q.pts[5]);
      p.lineTo(q.pts[6], q.pts[7]);
      p.closePath();
    }
    plan.groups.push(baked);
  }
  return plan;
}

/** Bake lazily on first draw — never at module init, so Path2D is not touched
 *  in a headless/unit context — and re-bake when the active map changes. */
function activePlan(): Plan {
  const id = getActiveMapId();
  if (!_plan || _plan.mapId !== id) _plan = buildPlan();
  return _plan;
}

/** Paint the start/finish markings for the active map. The caller has applied
 *  the camera transform; coordinates are world px. Three GPU fills per visible
 *  group, behind a squared-distance cull. */
export function drawStartGrid(
  ctx: CanvasRenderingContext2D,
  centerX: number,
  centerY: number,
  cullR?: number,
): void {
  const p = activePlan();
  if (!p.groups.length) return;
  const base = cullR !== undefined ? cullR : 600;
  for (const g of p.groups) {
    const dx = g.cx - centerX, dy = g.cy - centerY;
    const rr = base + g.r;
    if (dx * dx + dy * dy > rr * rr) continue;
    ctx.fillStyle = DARK;
    ctx.fill(g.dark);
    ctx.fillStyle = WHITE;
    ctx.fill(g.white);
    ctx.fillStyle = YELLOW;
    ctx.fill(g.yellow);
  }
}

/**
 * Night lift for the white paint. The drag strip, oval and car meet all set
 * forceNight, and the midnight tint (rgba(0,5,35,0.78)) drags white paint down
 * to rgb(56,60,83) — legible, but dull for the one marking the player has to
 * line up on. Re-drawn additively AFTER the tint, the same emissive-copy pattern
 * the tail glow (H1148) and emergency lamps (H1197) use. The caller has set
 * globalCompositeOperation = 'lighter', so this brightens the painted pixels
 * only and leaves the asphalt alone.
 */
export function drawStartGridGlow(
  ctx: CanvasRenderingContext2D,
  centerX: number,
  centerY: number,
  cullR: number | undefined,
  alpha: number,
): void {
  if (!(alpha > 0.01)) return;
  const p = activePlan();
  if (!p.groups.length) return;
  const base = cullR !== undefined ? cullR : 600;
  ctx.fillStyle = `rgba(150, 150, 158, ${Math.min(0.5, alpha).toFixed(3)})`;
  for (const g of p.groups) {
    const dx = g.cx - centerX, dy = g.cy - centerY;
    const rr = base + g.r;
    if (dx * dx + dy * dy > rr * rr) continue;
    ctx.fill(g.white);
  }
}
