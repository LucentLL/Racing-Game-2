/**
 * H178: full-screen city-map overlay — F key toggle.
 *
 * Port of monolith L33927-34086. When ctx.fullMapOpen is true, draws
 * the entire Charlotte road network at city-centered zoom on top of
 * the HUD canvas. Map is centered on (MAP_W/2, MAP_H/2) — NOT on the
 * player — so the city stays visible regardless of where you stand
 * (the player marker moves around within the static map).
 *
 * H1063 GT-STYLE OVERHAUL (user report: "if I click anything the map
 * closes" + GT-map reference):
 *   - The map is now INTERACTIVE — plain taps do nothing. Close is
 *     explicit: the ✕ button, the F key, or Esc.
 *   - The legend is a category selector: tap a location type (gas /
 *     home / dealer / mechanic / …) to select it, tap it again (or
 *     the ‹ › arrows, or Left/Right keys) to cycle through that
 *     type's instances. The active instance gets a pulsing ring and
 *     a name callout; everything else dims.
 *   - The whole legend is ALWAYS on screen: right sidebar in
 *     landscape (uses the spare width — the world is square, the
 *     screen isn't), bottom tray in portrait; both size themselves
 *     from the row count (the old fixed 76px tray clipped its last
 *     row).
 *   - Player position is a heading arrow with a pulsing halo, always
 *     drawn on top and never dimmed.
 *   - Venue buildings placed in the editor (dealership / mechanic /
 *     junkyard / auto parts) surface as their own categories via
 *     PLACED_BUILDINGS.
 *
 * Sim-mode fast travel (H961) is unchanged: travel pins are still
 * tappable; the tap router checks map UI first, then travel pins.
 *
 * Pins implemented:
 *   - H (Home), W (Work / office)
 *   - A/B (Job pickup/dropoff) — H205 wired against life.job
 *   - F (Race finish) + opponent dot — H588 wired against
 *     life.race.{finishX/Y,oppX/Y} during ready/countdown/racing
 *     phases (result phase hides them so the dismiss modal doesn't
 *     compete with a now-meaningless F).
 */

import { TILE, MAP_W, MAP_H } from '@/config/world/tiles';
import { GAS_STATIONS } from '@/config/world/gasStations';
import type { PlayerState } from '@/state/player';
import type { LifeState } from '@/state/life';
import type { TravelPin } from '@/sim/fastTravel';
import { RENDER_ENTRIES } from './worldMap';
import { PLACED_BUILDINGS, placedBuildingLabel } from '@/world/placedBuildings';

/** Same per-road palette as the minimap (H176) — kept inline so the
 *  full-map can pick slightly different shades (darker minors on the
 *  larger surface for legibility). 1:1 port of monolith L33964-33969. */
function colorForRoad(name: string, isMajor: boolean): string {
  if (name.includes('I-485')) return '#0af';
  if (
    name.includes('I-77') ||
    name.includes('I-85') ||
    name.includes('US-74') ||
    name.includes('Brookshire')
  ) return '#f80';
  if (name.includes('I-277')) return '#fa0';
  if (name.includes('Exit') || name.includes('Ramp')) return '#0b0';
  if (isMajor) return '#666';
  return '#333';
}

/** Paper-map (1990s road atlas) palette — twin of the minimap's
 *  colorForRoadPaper but with slightly darker minor-street shades for
 *  legibility on the larger full-map surface. */
function colorForRoadPaper(name: string, isMajor: boolean): string {
  if (
    name.includes('I-485') ||
    name.includes('I-77') ||
    name.includes('I-85') ||
    name.includes('I-277') ||
    name.includes('US-74') ||
    name.includes('Brookshire')
  ) return '#1f5bbf';
  if (name.includes('Exit') || name.includes('Ramp')) return '#1f5bbf';
  if (isMajor) return '#2a2a2a';
  return '#555';
}

function widthForRoad(name: string, isMajor: boolean): number {
  if (isMajor) return 2;
  if (name.includes('Ramp')) return 1;
  return 0.8;
}

// ==== H1063: interactive map UI (module-scoped, GT-style) =============

/** Location categories the legend can select. */
export type MapCat =
  | 'YOU' | 'HOME' | 'WORK' | 'JOB' | 'RACE' | 'GAS' | 'PIN'
  | 'DEALER' | 'MECHANIC' | 'JUNKYARD' | 'PARTS';

interface MapMarker {
  cat: MapCat;
  sx: number; sy: number;
  wx: number; wy: number;
  label: string;
  color: string;
  letter: string;
  /** Marker dot radius. */
  r: number;
  /** Side text drawn next to the marker (HOME / WORK / pin labels). */
  sideText?: string;
}

interface MapUiRect {
  x: number; y: number; w: number; h: number;
  act: 'close' | 'prev' | 'next' | 'cat' | 'all';
  cat?: MapCat;
}

/** Legend display order + print-style colors for the paper sheet.
 *  Existing pin colors kept 1:1 (H178/H205 parity); the four venue
 *  categories (editor-placed buildings, H997) are new. */
const CAT_DEFS: ReadonlyArray<{
  cat: MapCat; color: string; letter: string; label: string;
}> = [
  { cat: 'YOU',      color: '#d0021b', letter: '▲', label: 'You' },
  { cat: 'HOME',     color: '#0ff',    letter: 'H', label: 'Home' },
  { cat: 'WORK',     color: '#08f',    letter: 'W', label: 'Work (office)' },
  { cat: 'JOB',      color: '#0f0',    letter: 'A', label: 'Job stop' },
  { cat: 'RACE',     color: '#f80',    letter: 'F', label: 'Race finish' },
  { cat: 'GAS',      color: '#0f0',    letter: 'G', label: 'Gas station' },
  { cat: 'DEALER',   color: '#b3402a', letter: 'D', label: 'Car dealer' },
  { cat: 'MECHANIC', color: '#6a45b8', letter: 'M', label: 'Mechanic' },
  { cat: 'JUNKYARD', color: '#6e5a20', letter: 'J', label: 'Junkyard' },
  { cat: 'PARTS',    color: '#2d6fb8', letter: 'P', label: 'Auto parts' },
  { cat: 'PIN',      color: '#f44',    letter: '•', label: 'Car pin' },
];

let _selCat: MapCat | null = null;
let _selIdx = 0;
/** Tap targets cached at paint time (same rect-cache pattern as the
 *  pause menu) — hit-tested by handleFullMapTap. */
let _uiRects: MapUiRect[] = [];
/** Categories that had instances last paint — keyboard cycle order. */
let _catsPresent: MapCat[] = [];

/** Route a tap while the map is open. Returns 'close' when the ✕ was
 *  hit, 'handled' when any legend control consumed the tap, 'none'
 *  otherwise (caller may then try sim-mode travel pins; a plain map
 *  tap does NOTHING — H1063 removed tap-anywhere-closes). */
export function handleFullMapTap(tx: number, ty: number): 'close' | 'handled' | 'none' {
  for (let i = _uiRects.length - 1; i >= 0; i--) {
    const r = _uiRects[i];
    if (tx < r.x || tx > r.x + r.w || ty < r.y || ty > r.y + r.h) continue;
    switch (r.act) {
      case 'close': return 'close';
      case 'all':   _selCat = null; _selIdx = 0; return 'handled';
      case 'prev':  _selIdx--; return 'handled';
      case 'next':  _selIdx++; return 'handled';
      case 'cat':
        if (_selCat === r.cat) _selIdx++;   // tap again = next instance
        else { _selCat = r.cat ?? null; _selIdx = 0; }
        return 'handled';
    }
  }
  return 'none';
}

/** Keyboard: ‹ › cycle within the selected category. */
export function cycleFullMapInstance(dir: number): void {
  if (_selCat) _selIdx += dir;
}

/** Keyboard: ↑ ↓ cycle through categories (wraps through SHOW ALL). */
export function cycleFullMapCategory(dir: number): void {
  const n = _catsPresent.length;
  if (n === 0) return;
  const i = _selCat ? _catsPresent.indexOf(_selCat) : n; // n = "all" slot
  const next = (((i + dir) % (n + 1)) + (n + 1)) % (n + 1);
  _selCat = next === n ? null : _catsPresent[next];
  _selIdx = 0;
}

/** Paint the full-map overlay onto hctx covering the full HUD canvas.
 *  Caller decides whether to call — gated on ctx.fullMapOpen in
 *  drawPlaying's HUD pass. */
// ---- H869: folded-paper road-map backdrop (light mode) ---------------
/** Manila road-map sheet — cream base + fibre grain + fold-line creases +
 *  aged edge — baked ONCE to a module-scoped offscreen canvas and blitted
 *  under the road strokes. NEVER regenerated per frame (perf: cost is GPU
 *  fill-call count, see project_perf_cost_model). Rebuilds only on resize. */
let _mapPaper: HTMLCanvasElement | null = null;
let _mapPaperW = 0;
let _mapPaperH = 0;
function getRoadMapPaper(W: number, H: number): HTMLCanvasElement {
  if (_mapPaper && _mapPaperW === W && _mapPaperH === H) return _mapPaper;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const c = cv.getContext('2d');
  _mapPaper = cv; _mapPaperW = W; _mapPaperH = H;
  if (!c) return cv;
  c.fillStyle = '#ece5d2';                       // manila map cream
  c.fillRect(0, 0, W, H);
  const dots = Math.min(7000, Math.floor((W * H) / 700));
  for (let i = 0; i < dots; i++) {                // fibre grain
    c.fillStyle = Math.random() < 0.5 ? 'rgba(70,60,35,0.04)' : 'rgba(255,255,255,0.05)';
    c.fillRect(Math.random() * W, Math.random() * H, 1, 1);
  }
  // Fold creases — thirds grid, each a shadow valley + light ridge.
  const crease = (x0: number, y0: number, x1: number, y1: number): void => {
    c.strokeStyle = 'rgba(80,68,40,0.16)'; c.lineWidth = 2;
    c.beginPath(); c.moveTo(x0, y0); c.lineTo(x1, y1); c.stroke();
    c.strokeStyle = 'rgba(255,255,255,0.20)'; c.lineWidth = 1;
    c.beginPath(); c.moveTo(x0 + 1, y0 + 1); c.lineTo(x1 + 1, y1 + 1); c.stroke();
  };
  crease(Math.round(W / 3), 0, Math.round(W / 3), H);
  crease(Math.round(2 * W / 3), 0, Math.round(2 * W / 3), H);
  crease(0, Math.round(H / 3), W, Math.round(H / 3));
  crease(0, Math.round(2 * H / 3), W, Math.round(2 * H / 3));
  const g = c.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.34, W / 2, H / 2, Math.max(W, H) * 0.62);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(110,90,50,0.17)');      // aged edge
  c.fillStyle = g;
  c.fillRect(0, 0, W, H);
  return cv;
}

export function drawFullMap(
  hctx: CanvasRenderingContext2D,
  hudWidth: number,
  hudHeight: number,
  player: PlayerState,
  life: LifeState | null,
): void {
  // H871: the full-screen survey map is ALWAYS the folded-paper sheet
  // now — per the user's "map when full screen should look like actual
  // paper for immersion." The big map is the immersive view, so it no
  // longer waits on the mapLight toggle. (The small HUD minimap still
  // reads gameplaySettings.mapLight independently, keeping its dark
  // style for at-a-glance legibility unless the player opts in.)
  const light = true;
  if (light) {
    // H869: folded-paper road-map sheet (baked once, blitted under roads).
    hctx.drawImage(getRoadMapPaper(hudWidth, hudHeight), 0, 0);
  } else {
    hctx.fillStyle = '#000';
    hctx.fillRect(0, 0, hudWidth, hudHeight);
  }

  // === H1063 layout: the whole legend always fits on screen ===
  // Landscape puts the legend in a right sidebar — the world is square
  // and the map is height-limited, so the side space was free anyway.
  // Portrait keeps a bottom tray, but sized from its ROW COUNT (the
  // old fixed 76px tray clipped its last legend row).
  const landscape = hudWidth > hudHeight * 1.25;
  // H1126: TRAFFIC COP is patrol-only, no A/B. H1128: FUEL TANKER
  // shows standard A/B (monolith parity). H1129: TOW shows the
  // standard A pin; once hooked its drop pin reads towJob.destX/Y
  // (may be the home junkyard, not the job's B point).
  const jobIsTow = life?.job?.type === 'TOW TRUCK';
  const towHooked = jobIsTow && !!life?.towJob?.hooked;
  const jobShowsAB = !!(life?.job
    && life.job.type !== 'TRAFFIC COP'
    && !(jobIsTow && life.job.pickedUp));
  const raceLive = !!(life?.race?.active
    && (life.race.phase === 'ready' || life.race.phase === 'countdown'
      || life.race.phase === 'racing'));
  const venueCount = (t: string): number => {
    let n = 0;
    for (const b of PLACED_BUILDINGS) if (b.type === t) n++;
    return n;
  };
  const counts: Record<MapCat, number> = {
    YOU: 1,
    HOME: life ? 1 : 0,
    WORK: life && life.officeX > 0 && life.officeY > 0
      && life.playerJob === 'OFFICE JOB' ? 1 : 0,
    JOB: (jobShowsAB
      ? ((!life!.job!.pickedUp && life!.job!.fromX != null ? 1 : 0)
        + (life!.job!.pickedUp && life!.job!.toX != null ? 1 : 0))
      : 0) + (towHooked ? 1 : 0),
    RACE: raceLive ? 1 : 0,
    GAS: GAS_STATIONS.length,
    PIN: life ? life.carPins.length : 0,
    DEALER: venueCount('dealership'),
    MECHANIC: venueCount('mechanic'),
    JUNKYARD: venueCount('junkyard'),
    PARTS: venueCount('autoparts'),
  };
  const present = CAT_DEFS.filter((d) => counts[d.cat] > 0);
  _catsPresent = present.map((d) => d.cat);
  // Stale selection (job finished, race over, pins cleared) → show all.
  if (_selCat && counts[_selCat] === 0) { _selCat = null; _selIdx = 0; }
  _uiRects = [];

  const ROW_H = 13;
  const ROAD_KEYS = 3;
  const legRows = 1 + present.length + ROAD_KEYS; // +1 = SHOW ALL row
  const LEG_W = 150;
  const legendH = landscape
    ? 0
    : 20 + Math.ceil(legRows / 2) * ROW_H + 8;
  const mapTop = 4;
  const mapBot = hudHeight - legendH - 4;
  const mapRight = landscape ? hudWidth - LEG_W - 8 : hudWidth;
  const mapH = mapBot - mapTop;
  const mapW = mapRight - 8;
  const mapCX = mapRight / 2;
  const mapCY = mapTop + mapH / 2;
  // Auto-fit: pad 5% so labels at the world edges don't get cropped.
  const fmScale = Math.min(mapW / (MAP_W * 1.05), mapH / (MAP_H * 1.05));
  // City-centered transform — fixed regardless of player position.
  const cityCXtile = MAP_W / 2;
  const cityCYtile = MAP_H / 2;
  const tileToX = (tx: number): number => mapCX + (tx - cityCXtile) * fmScale;
  const tileToY = (ty: number): number => mapCY + (ty - cityCYtile) * fmScale;
  const wxToX = (wx: number): number => tileToX(wx / TILE);
  const wyToY = (wy: number): number => tileToY(wy / TILE);

  // === Roads ===
  // Two-pass so major roads sit on top of minors regardless of
  // RENDER_ENTRIES source order. Mirrors the H176 minimap approach.
  hctx.lineCap = 'round';
  hctx.lineJoin = 'round';
  const passes: ReadonlyArray<(maj: number) => boolean> = [
    (maj) => maj !== 1,
    (maj) => maj === 1,
  ];
  for (const pred of passes) {
    for (const entry of RENDER_ENTRIES) {
      const maj = entry.row[1] as number;
      if (!pred(maj)) continue;
      const name = String(entry.row[2] ?? '');
      const pts = entry.smoothed;
      if (pts.length < 4) continue;
      hctx.lineWidth = widthForRoad(name, maj === 1);
      hctx.strokeStyle = light
        ? colorForRoadPaper(name, maj === 1)
        : colorForRoad(name, maj === 1);
      hctx.beginPath();
      hctx.moveTo(tileToX(pts[0]), tileToY(pts[1]));
      for (let i = 2; i + 1 < pts.length; i += 2) {
        hctx.lineTo(tileToX(pts[i]), tileToY(pts[i + 1]));
      }
      hctx.stroke();
    }
  }

  // H961: simulation-mode fast travel — every destination marker also
  // lands in travelPins (screen + world coords), cached on
  // life._mapTravelPins at the end of the paint so the gameLoop tap
  // router can hit-test taps against EXACTLY what the player sees.
  const simTravel = life?.gameplaySettings?.simulationMode === true;
  const travelPins: TravelPin[] = [];

  // === H1063: collect every marker, then draw by category ===========
  const markers: MapMarker[] = [];
  const catColor = (cat: MapCat): string =>
    CAT_DEFS.find((d) => d.cat === cat)?.color ?? '#f00';

  // Gas stations (tile coords — same placement as the pre-H1063 painter).
  for (const gs of GAS_STATIONS) {
    const sx = tileToX(gs.tx);
    const sy = tileToY(gs.ty);
    if (sx < -10 || sx > mapRight + 10 || sy < mapTop - 10 || sy > mapBot + 10) continue;
    markers.push({
      cat: 'GAS', sx, sy, wx: gs.tx * TILE, wy: gs.ty * TILE,
      label: gs.name || 'GAS STATION', color: '#0f0', letter: 'G', r: 3,
    });
  }

  // Editor-placed venues (H997 registry): dealer / mechanic / junkyard
  // / auto parts each get their own selectable category.
  const VENUE_CATS: ReadonlyArray<[string, MapCat]> = [
    ['dealership', 'DEALER'], ['mechanic', 'MECHANIC'],
    ['junkyard', 'JUNKYARD'], ['autoparts', 'PARTS'],
  ];
  for (const [type, cat] of VENUE_CATS) {
    const def = CAT_DEFS.find((d) => d.cat === cat)!;
    for (const b of PLACED_BUILDINGS) {
      if (b.type !== type) continue;
      const sx = tileToX(b.cx);
      const sy = tileToY(b.cy);
      markers.push({
        cat, sx, sy, wx: b.cx * TILE, wy: b.cy * TILE,
        label: placedBuildingLabel(b), color: def.color, letter: def.letter, r: 4,
      });
    }
  }

  // Car pins (H180 newspaper pin-picker).
  if (life && life.carPins.length > 0) {
    for (const pin of life.carPins) {
      markers.push({
        cat: 'PIN', sx: wxToX(pin.worldX), sy: wyToY(pin.worldY),
        wx: pin.worldX, wy: pin.worldY,
        label: pin.label || 'PINNED CAR', color: pin.color || '#f44',
        letter: '', r: 5, sideText: pin.label || '?',
      });
    }
  }

  // Work (H179: OFFICE JOB only).
  if (life && life.officeX > 0 && life.officeY > 0 && life.playerJob === 'OFFICE JOB') {
    markers.push({
      cat: 'WORK', sx: tileToX(life.officeX), sy: tileToY(life.officeY),
      wx: life.officeX * TILE, wy: life.officeY * TILE,
      label: 'WORK', color: '#08f', letter: 'W', r: 5, sideText: 'WORK',
    });
  }

  // Job A/B (H205).
  if (life?.job && jobShowsAB) {
    const job = life.job;
    if (!job.pickedUp && job.fromX != null && job.fromY != null) {
      markers.push({
        cat: 'JOB', sx: wxToX(job.fromX), sy: wyToY(job.fromY),
        wx: job.fromX, wy: job.fromY,
        label: 'PICKUP', color: '#0f0', letter: 'A', r: 5, sideText: 'PICKUP',
      });
    }
    if (job.pickedUp && job.toX != null && job.toY != null) {
      markers.push({
        cat: 'JOB', sx: wxToX(job.toX), sy: wyToY(job.toY),
        wx: job.toX, wy: job.toY,
        label: 'DELIVERY', color: '#ff0', letter: 'B', r: 5, sideText: 'DELIVER',
      });
    }
  }
  // H1129: hooked tow load — drop pin at towJob.dest (may be the
  // home junkyard, not the job's B point).
  if (towHooked && life?.towJob) {
    const tj = life.towJob;
    markers.push({
      cat: 'JOB', sx: wxToX(tj.destX), sy: wyToY(tj.destY),
      wx: tj.destX, wy: tj.destY,
      label: tj.destType === 'home' ? 'JUNKYARD' : 'OWNER',
      color: '#0f8', letter: 'T', r: 5, sideText: 'TOW DROP',
    });
  }

  // Home.
  if (life) {
    markers.push({
      cat: 'HOME', sx: tileToX(life.homeX), sy: tileToY(life.homeY),
      wx: life.homeX * TILE, wy: life.homeY * TILE,
      label: 'HOME', color: '#0ff', letter: 'H', r: 5, sideText: 'HOME',
    });
  }

  // Race finish (H588 — ready/countdown/racing only; result hides it).
  if (raceLive && life?.race) {
    markers.push({
      cat: 'RACE', sx: wxToX(life.race.finishX), sy: wyToY(life.race.finishY),
      wx: life.race.finishX, wy: life.race.finishY,
      label: 'RACE FINISH', color: '#f80', letter: 'F', r: 5, sideText: 'FINISH',
    });
  }

  // Player — always a marker so 'YOU' is selectable, but drawn
  // specially (heading arrow) after the generic pass.
  const pxS = wxToX(player.px);
  const pyS = wyToY(player.py);
  markers.push({
    cat: 'YOU', sx: pxS, sy: pyS, wx: player.px, wy: player.py,
    label: 'YOU', color: '#d0021b', letter: '', r: 5,
  });

  // Draw pass — when a category is selected, everything else dims
  // (GT-style focus). YOU never dims.
  const nowS = performance.now() / 1000;
  for (const m of markers) {
    if (m.cat === 'YOU') continue;
    const dim = _selCat !== null && _selCat !== m.cat;
    hctx.globalAlpha = dim ? 0.28 : 1;
    hctx.fillStyle = m.color;
    hctx.beginPath();
    hctx.arc(m.sx, m.sy, m.r, 0, Math.PI * 2);
    hctx.fill();
    if (m.cat === 'PIN') {
      hctx.strokeStyle = '#fff';
      hctx.lineWidth = 0.8;
      hctx.stroke();
    }
    if (m.letter) {
      hctx.fillStyle = '#000';
      hctx.font = m.r <= 3 ? 'bold 6px monospace' : 'bold 7px monospace';
      hctx.textAlign = 'center';
      hctx.fillText(m.letter, m.sx, m.sy + (m.r <= 3 ? 2 : 2.5));
      hctx.textAlign = 'left';
    }
    if (m.sideText && !dim) {
      hctx.fillStyle = m.cat === 'PIN' ? '#fff' : m.color;
      hctx.font = m.cat === 'PIN' ? 'bold 7px monospace' : '7px monospace';
      hctx.fillText(m.sideText, m.sx + 7, m.sy + 3);
    }
  }
  hctx.globalAlpha = 1;

  // Race opponent dot rides the RACE category's dim state.
  if (raceLive && life?.race) {
    hctx.globalAlpha = _selCat !== null && _selCat !== 'RACE' ? 0.28 : 1;
    hctx.fillStyle = '#f44';
    hctx.beginPath();
    hctx.arc(wxToX(life.race.oppX), wyToY(life.race.oppY), 3, 0, Math.PI * 2);
    hctx.fill();
    hctx.globalAlpha = 1;
  }

  // Sim-mode travel affordance: dashed halos on travelable markers.
  for (const m of markers) {
    if (m.cat === 'YOU' || m.cat === 'RACE') continue;
    travelPins.push({ sx: m.sx, sy: m.sy, wx: m.wx, wy: m.wy, label: m.label });
  }
  if (simTravel) {
    hctx.strokeStyle = 'rgba(0, 140, 200, 0.85)';
    hctx.lineWidth = 1.2;
    hctx.setLineDash([3, 2]);
    for (const tp of travelPins) {
      hctx.beginPath();
      hctx.arc(tp.sx, tp.sy, 9, 0, Math.PI * 2);
      hctx.stroke();
    }
    hctx.setLineDash([]);
  }
  if (life) {
    (life as { _mapTravelPins?: TravelPin[] | null })._mapTravelPins
      = simTravel ? travelPins : null;
  }

  // === Player: heading arrow + pulsing halo (H1063) ===
  hctx.save();
  hctx.translate(pxS, pyS);
  hctx.strokeStyle = 'rgba(208, 2, 27, 0.75)';
  hctx.lineWidth = 1.4;
  hctx.beginPath();
  hctx.arc(0, 0, 7 + Math.sin(nowS * 3.5) * 1.6, 0, Math.PI * 2);
  hctx.stroke();
  hctx.rotate(player.pAngle);
  hctx.fillStyle = '#d0021b';
  hctx.strokeStyle = '#fff';
  hctx.lineWidth = 1;
  hctx.beginPath();
  hctx.moveTo(7, 0);
  hctx.lineTo(-5, 4.5);
  hctx.lineTo(-2.5, 0);
  hctx.lineTo(-5, -4.5);
  hctx.closePath();
  hctx.fill();
  hctx.stroke();
  hctx.restore();

  // === H1063: selected-instance highlight + name callout ===
  if (_selCat) {
    const list = markers.filter((m) => m.cat === _selCat);
    if (list.length > 0) {
      const n = list.length;
      _selIdx = ((_selIdx % n) + n) % n;
      const m = list[_selIdx];
      // Pulsing focus ring (print blue over the pin color).
      hctx.strokeStyle = '#1f5bbf';
      hctx.lineWidth = 1.8;
      hctx.beginPath();
      hctx.arc(m.sx, m.sy, m.r + 5 + Math.sin(nowS * 4) * 1.5, 0, Math.PI * 2);
      hctx.stroke();
      hctx.strokeStyle = 'rgba(255,255,255,0.9)';
      hctx.lineWidth = 1;
      hctx.beginPath();
      hctx.arc(m.sx, m.sy, m.r + 2.5, 0, Math.PI * 2);
      hctx.stroke();
      // Callout cartouche: name + index, clamped to the map area.
      const title = (m.label || m.cat).toUpperCase();
      hctx.font = 'bold 9px monospace';
      const tw = hctx.measureText(title).width;
      const sub = n > 1 ? `${_selIdx + 1} OF ${n}` : '';
      const bw = Math.max(tw, 44) + 14;
      const bh = sub ? 28 : 18;
      let bx = m.sx + 11;
      let by = m.sy - bh - 7;
      if (bx + bw > mapRight - 4) bx = m.sx - bw - 11;
      if (by < mapTop + 2) by = m.sy + 9;
      hctx.fillStyle = 'rgba(236, 229, 210, 0.96)';
      hctx.fillRect(bx, by, bw, bh);
      hctx.strokeStyle = '#1f5bbf';
      hctx.lineWidth = 1.2;
      hctx.strokeRect(bx + 0.5, by + 0.5, bw - 1, bh - 1);
      hctx.fillStyle = '#2a2418';
      hctx.font = 'bold 9px monospace';
      hctx.fillText(title, bx + 7, by + 12);
      if (sub) {
        hctx.fillStyle = '#5a4f38';
        hctx.font = '7px monospace';
        hctx.fillText(sub, bx + 7, by + 22);
      }
    }
  }

  // === H869: title-block cartouche (light mode) ===
  // Drawn over the roads so it reads as an opaque printed corner block.
  if (light) {
    hctx.fillStyle = 'rgba(236, 229, 210, 0.94)';
    hctx.fillRect(8, 8, 196, 44);
    hctx.strokeStyle = 'rgba(60, 52, 32, 0.6)';
    hctx.lineWidth = 1.5;
    hctx.strokeRect(8.5, 8.5, 195, 43);
    hctx.textAlign = 'left';
    hctx.fillStyle = '#2a2418';
    hctx.font = "bold 15px Georgia, 'Times New Roman', serif";
    hctx.fillText('CHARLOTTE', 18, 30);
    hctx.font = "11px Georgia, 'Times New Roman', serif";
    hctx.fillStyle = '#5a4f38';
    hctx.fillText('METRO ROAD MAP', 18, 45);
  }

  // === H1063: interactive legend (whole key always on screen) ===
  // Landscape → right sidebar, single column. Portrait → bottom tray,
  // two columns. Rows are tap targets: tap a category to focus it, tap
  // again (or ‹ ›) to cycle instances. Printed-marginalia styling kept.
  const legX = landscape ? hudWidth - LEG_W - 4 : 4;
  const legY = landscape ? 4 : mapBot + 6;
  const legW = landscape ? LEG_W : hudWidth - 8;
  const legH = landscape ? hudHeight - 8 : legendH - 10;
  hctx.fillStyle = 'rgba(232, 232, 232, 0.95)';
  hctx.fillRect(legX, legY, legW, legH);
  hctx.strokeStyle = '#999';
  hctx.lineWidth = 1;
  hctx.strokeRect(legX, legY, legW, legH);
  hctx.fillStyle = '#1a1a1a';
  hctx.font = 'bold 8px monospace';
  hctx.textAlign = 'left';
  hctx.fillText('MAP KEY', legX + 6, legY + 11);

  // ✕ close button — the ONLY tap that closes the map (plus F / Esc).
  const cbS = 14;
  const cbX = legX + legW - cbS - 4;
  const cbY = legY + 3;
  hctx.fillStyle = '#d8d8d8';
  hctx.fillRect(cbX, cbY, cbS, cbS);
  hctx.strokeStyle = '#777';
  hctx.strokeRect(cbX + 0.5, cbY + 0.5, cbS - 1, cbS - 1);
  hctx.fillStyle = '#1a1a1a';
  hctx.font = 'bold 9px monospace';
  hctx.textAlign = 'center';
  hctx.fillText('✕', cbX + cbS / 2, cbY + 10);
  hctx.textAlign = 'left';
  _uiRects.push({ x: cbX - 4, y: cbY - 3, w: cbS + 8, h: cbS + 6, act: 'close' });

  // Row engine: single column (sidebar) or two columns (tray).
  const cols = landscape ? 1 : 2;
  const colW = (legW - 12) / cols;
  const rowsTop = legY + 18;
  let rowI = 0;
  const rowPos = (): { x: number; y: number } => {
    const col = cols === 1 ? 0 : rowI % cols;
    const row = cols === 1 ? rowI : Math.floor(rowI / cols);
    return { x: legX + 6 + col * colW, y: rowsTop + row * ROW_H };
  };

  // SHOW ALL row.
  {
    const { x, y } = rowPos(); rowI++;
    if (_selCat === null) {
      hctx.fillStyle = 'rgba(31, 91, 191, 0.16)';
      hctx.fillRect(x - 2, y - 2, colW - 4, ROW_H - 1);
    }
    hctx.fillStyle = _selCat === null ? '#1f5bbf' : '#3a3a3a';
    hctx.font = 'bold 8px monospace';
    hctx.fillText('SHOW ALL', x + 11, y + 7);
    _uiRects.push({ x: x - 2, y: y - 2, w: colW - 4, h: ROW_H, act: 'all' });
  }

  // Category rows (only categories with instances).
  for (const d of present) {
    const { x, y } = rowPos(); rowI++;
    const sel = _selCat === d.cat;
    if (sel) {
      hctx.fillStyle = 'rgba(31, 91, 191, 0.16)';
      hctx.fillRect(x - 2, y - 2, colW - 4, ROW_H - 1);
      hctx.strokeStyle = '#1f5bbf';
      hctx.lineWidth = 1;
      hctx.strokeRect(x - 1.5, y - 1.5, colW - 5, ROW_H - 2);
    }
    // Swatch.
    hctx.fillStyle = d.color;
    hctx.beginPath();
    hctx.arc(x + 4, y + 4, 4, 0, Math.PI * 2);
    hctx.fill();
    if (d.letter !== '▲' && d.letter !== '•') {
      hctx.fillStyle = '#000';
      hctx.font = 'bold 6px monospace';
      hctx.textAlign = 'center';
      hctx.fillText(d.letter, x + 4, y + 6);
      hctx.textAlign = 'left';
    }
    // Label + count / cycle arrows.
    hctx.fillStyle = sel ? '#1f5bbf' : '#1a1a1a';
    hctx.font = sel ? 'bold 8px monospace' : '8px monospace';
    hctx.fillText(d.label, x + 11, y + 7);
    const n = counts[d.cat];
    if (sel && n > 1) {
      // ‹ i/n › — arrows are their own tap targets.
      const az = 11;
      const ax2 = x + colW - 10 - az;
      const ax1 = ax2 - az - 22;
      hctx.font = 'bold 9px monospace';
      hctx.textAlign = 'center';
      hctx.fillStyle = '#1f5bbf';
      hctx.fillText('‹', ax1 + az / 2, y + 8);
      hctx.fillText('›', ax2 + az / 2, y + 8);
      hctx.font = '7px monospace';
      hctx.fillStyle = '#3a3a3a';
      const nn = counts[d.cat];
      const shownIdx = ((_selIdx % nn) + nn) % nn;
      hctx.fillText(`${shownIdx + 1}/${nn}`, (ax1 + az + ax2) / 2, y + 7);
      hctx.textAlign = 'left';
      _uiRects.push({ x: ax1 - 3, y: y - 3, w: az + 6, h: ROW_H + 4, act: 'prev' });
      _uiRects.push({ x: ax2 - 3, y: y - 3, w: az + 6, h: ROW_H + 4, act: 'next' });
      _uiRects.push({ x: x - 2, y: y - 2, w: ax1 - x - 2, h: ROW_H, act: 'cat', cat: d.cat });
    } else {
      if (n > 1) {
        hctx.fillStyle = '#777';
        hctx.font = '7px monospace';
        hctx.textAlign = 'right';
        hctx.fillText(String(n), x + colW - 12, y + 7);
        hctx.textAlign = 'left';
      }
      _uiRects.push({ x: x - 2, y: y - 2, w: colW - 4, h: ROW_H, act: 'cat', cat: d.cat });
    }
  }

  // Road-key rows (print colors; not interactive).
  const roadKeys: ReadonlyArray<[string, string]> = [
    ['#1f5bbf', 'I-485 ring'],
    ['#1f5bbf', 'I-77 / I-85 / US-74'],
    ['#1f5bbf', 'I-277 inner loop'],
  ];
  for (const [color, text] of roadKeys) {
    const { x, y } = rowPos(); rowI++;
    hctx.strokeStyle = color;
    hctx.lineWidth = 2;
    hctx.beginPath();
    hctx.moveTo(x, y + 4);
    hctx.lineTo(x + 8, y + 4);
    hctx.stroke();
    hctx.fillStyle = '#555';
    hctx.font = '8px monospace';
    hctx.fillText(text, x + 11, y + 7);
  }

  // Hint line — bottom of the sidebar / right of the tray header.
  hctx.fillStyle = '#3a3a3a';
  hctx.font = 'bold 7px monospace';
  if (landscape) {
    const hy = legY + legH - 6;
    hctx.fillText('TAP TYPE TO CYCLE', legX + 6, hy - 9);
    hctx.fillText(simTravel ? 'TAP PIN = TRAVEL · F/✕ CLOSE' : 'F / ESC / ✕ TO CLOSE', legX + 6, hy);
  } else {
    hctx.textAlign = 'right';
    hctx.fillText(
      simTravel ? 'TAP PIN = TRAVEL · F/✕ CLOSE' : 'TAP TYPE TO CYCLE · F/✕ CLOSE',
      cbX - 6, legY + 11,
    );
    hctx.textAlign = 'left';
  }
}
