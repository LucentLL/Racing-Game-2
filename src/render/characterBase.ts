/**
 * Character-base portrait sprite-sheet loader + draw helper.
 *
 * Each sprite sheet is a 3×2 grid of 512×512 cells:
 *   - row 0 = male, row 1 = female
 *   - col 0 = muscular, col 1 = lean, col 2 = overweight
 *
 * Indexed by `skinTone - 1` — only Skin Tone 1 ships today, so the
 * sheets array has a single entry. Adding more skin tones is a
 * data-only change (drop a new PNG, push another URL).
 *
 * Ported from monolith L5840-5892. The CB_TILE=512 + 3 cols × 2 rows
 * layout matches exactly.
 *
 * SHEET-LOAD FALLBACK: when the sheet hasn't finished loading yet
 * (or fails to load), the renderer paints a dark placeholder rect at
 * the same x/y/size — matches monolith L5882-5884. Caller doesn't
 * have to await the load.
 */

const CB_TILE = 512;
const CB_COLS = 3; // muscular / lean / overweight
const CB_ROWS = 2; // male / female

/** Sheet URLs by skin-tone index (= skinTone - 1). Currently single
 *  sheet — additional skin tones land as new entries. */
const CHARACTER_BASE_URLS: readonly string[] = [
  '/ui/Character-Bases-1.png',
];

/** Lazy-loaded sheet images. Same length as CHARACTER_BASE_URLS;
 *  each slot fills in as the corresponding <img> finishes loading. */
const sheets: HTMLImageElement[] = [];

let initialised = false;

function ensureLoaded(): void {
  if (initialised) return;
  initialised = true;
  for (const url of CHARACTER_BASE_URLS) {
    const img = new Image();
    img.src = url;
    sheets.push(img);
  }
}

/** Map fitness 0..100 to the sprite-sheet column. 1:1 with monolith
 *  L5865-5869:
 *    fitness >= 80 → muscular (col 0)
 *    fitness <  20 → overweight (col 2)
 *    else          → lean (col 1)
 *  Muscular wins ties at 80 — inclusive ceiling for fit players. */
export function characterBaseColForFitness(fitness: number): 0 | 1 | 2 {
  if (fitness >= 80) return 0;
  if (fitness < 20) return 2;
  return 1;
}

/** Paint the appropriate character-base sprite into `ctx` at (x, y)
 *  with size s×s. 1:1 port of monolith L5877-5892.
 *
 *  - gender:   'M' picks row 0, 'F' picks row 1. Defaults to 'M'.
 *  - fitness:  0..100, drives the column via characterBaseColForFitness.
 *  - skinTone: 1-based index into the sheet array; falls back to
 *              sheet 0 when the requested tone hasn't shipped.
 *  - forcedCol: optional column override (used by the char-creator
 *               preview to show all three builds even before
 *               LIFE.fitness is set).
 *
 *  Paints a dark fallback rect when the sheet isn't ready yet. */
export function drawCharacterBase(
  ctx: CanvasRenderingContext2D,
  gender: 'M' | 'F',
  fitness: number,
  skinTone: number,
  x: number,
  y: number,
  s: number,
  forcedCol?: 0 | 1 | 2,
): void {
  ensureLoaded();
  const sheetIdx = Math.max(0, (skinTone || 1) - 1);
  const sheet = sheets[sheetIdx] || sheets[0];
  if (!sheet || !sheet.complete || !sheet.naturalWidth) {
    ctx.fillStyle = '#222';
    ctx.fillRect(x, y, s, s);
    ctx.strokeStyle = '#444';
    ctx.strokeRect(x + 0.5, y + 0.5, s - 1, s - 1);
    return;
  }
  const row = gender === 'F' ? 1 : 0;
  const col = typeof forcedCol === 'number' ? forcedCol : characterBaseColForFitness(fitness || 0);
  ctx.drawImage(
    sheet,
    col * CB_TILE, row * CB_TILE, CB_TILE, CB_TILE,
    x, y, s, s,
  );
}

/** Test-only export — lets unit tests pre-warm the sheet array
 *  without hitting the network. Not used by production code. */
export const __test = { sheets, CB_TILE, CB_COLS, CB_ROWS };
