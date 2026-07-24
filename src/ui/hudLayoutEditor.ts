/**
 * H1220: HUD LAYOUT mode — the FFXIV-style placement editor.
 *
 * Entered from OPT → HUD LAYOUT (the pause menu closes first, so the
 * live gameplay screen stays visible with the drive HUD shown). A
 * full-viewport DOM overlay (z 300, above the #weEntryBtn z200 globe)
 * swallows every pointer event, so the real controls underneath are
 * inert while the mode is open — widgets are NOT movable during
 * regular gameplay by construction. Each movable widget gets a labeled
 * drag box tracking its live getBoundingClientRect; dragging writes
 * px offsets through hudLayoutStore (applied as composed transforms).
 *
 * SAVE runs a pairwise AABB overlap check over the visible widgets:
 * overlaps show an inline warning ("SAVE ANYWAY / GO BACK") the user
 * can override per their device — the FFXIV behavior the user asked
 * for. CANCEL (or Escape) restores the entry snapshot; RESET clears
 * offsets in working state only (SAVE commits, CANCEL undoes).
 */

import {
  HUD_WIDGETS,
  applyHudLayout,
  getHudOffsets,
  getWidgetOffsetPx,
  resetHudOffsets,
  saveHudLayout,
  setHudOffsets,
  setWidgetOffsetPx,
} from './hudLayoutStore';

let _open = false;
let _overlay: HTMLDivElement | null = null;
let _boxes = new Map<string, HTMLDivElement>();
let _entrySnapshot: ReturnType<typeof getHudOffsets> = {};
let _raf = 0;
let _warnRow: HTMLDivElement | null = null;
let _hintRow: HTMLDivElement | null = null;

export function isHudLayoutOpen(): boolean {
  return _open;
}

interface Box { x: number; y: number; w: number; h: number }

function rectsOverlap(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** Visible widget boxes in viewport px (skips hidden / zero-rect). */
function visibleWidgetBoxes(): Array<{ id: string; label: string; box: Box }> {
  const out: Array<{ id: string; label: string; box: Box }> = [];
  for (const def of HUD_WIDGETS) {
    const el = document.querySelector<HTMLElement>(def.sel);
    if (!el) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    out.push({ id: def.id, label: def.label, box: { x: r.left, y: r.top, w: r.width, h: r.height } });
  }
  return out;
}

function overlappingPairs(): Array<[string, string]> {
  const boxes = visibleWidgetBoxes();
  const pairs: Array<[string, string]> = [];
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      if (rectsOverlap(boxes[i].box, boxes[j].box)) {
        pairs.push([boxes[i].label, boxes[j].label]);
      }
    }
  }
  return pairs;
}

function mkBtn(label: string, cls: string, onTap: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `hlBtn ${cls}`;
  b.textContent = label;
  b.addEventListener('click', onTap);
  return b;
}

function buildOverlay(): HTMLDivElement {
  const ov = document.createElement('div');
  ov.id = 'hudLayoutOverlay';

  const bar = document.createElement('div');
  bar.className = 'hlToolbar';
  const title = document.createElement('div');
  title.className = 'hlTitle';
  title.textContent = 'HUD LAYOUT';
  bar.appendChild(title);

  _hintRow = document.createElement('div');
  _hintRow.className = 'hlHint';
  _hintRow.textContent = 'drag a widget to move it · positions save to THIS device';
  bar.appendChild(_hintRow);

  const btnRow = document.createElement('div');
  btnRow.className = 'hlBtnRow';
  btnRow.appendChild(mkBtn('SAVE', 'hlSave', trySave));
  btnRow.appendChild(mkBtn('RESET', 'hlReset', () => {
    resetHudOffsets();
    clearWarning();
  }));
  btnRow.appendChild(mkBtn('CANCEL', 'hlCancel', cancelAndClose));
  bar.appendChild(btnRow);

  // Overlap warning row — hidden until a SAVE finds collisions.
  _warnRow = document.createElement('div');
  _warnRow.className = 'hlWarn';
  _warnRow.style.display = 'none';
  bar.appendChild(_warnRow);

  ov.appendChild(bar);

  // Drag boxes.
  _boxes = new Map();
  for (const def of HUD_WIDGETS) {
    const box = document.createElement('div');
    box.className = 'hlBox';
    const lbl = document.createElement('div');
    lbl.className = 'hlBoxLabel';
    lbl.textContent = def.label;
    box.appendChild(lbl);
    installDrag(box, def.id);
    ov.appendChild(box);
    _boxes.set(def.id, box);
  }
  return ov;
}

function installDrag(box: HTMLDivElement, id: string): void {
  let startX = 0;
  let startY = 0;
  let baseDx = 0;
  let baseDy = 0;
  let dragging = false;
  box.addEventListener('pointerdown', (e) => {
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    const cur = getWidgetOffsetPx(id);
    baseDx = cur.dx;
    baseDy = cur.dy;
    box.setPointerCapture(e.pointerId);
    box.classList.add('hlDragging');
    clearWarning(); // layout is changing — stale warning would mislead
    e.preventDefault();
  });
  box.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    setWidgetOffsetPx(id, baseDx + (e.clientX - startX), baseDy + (e.clientY - startY));
  });
  const end = (e: PointerEvent): void => {
    if (!dragging) return;
    dragging = false;
    box.classList.remove('hlDragging');
    try { box.releasePointerCapture(e.pointerId); } catch { /* already released */ }
  };
  box.addEventListener('pointerup', end);
  box.addEventListener('pointercancel', end);
}

function clearWarning(): void {
  if (_warnRow) _warnRow.style.display = 'none';
}

function trySave(): void {
  const pairs = overlappingPairs();
  if (pairs.length === 0) {
    commitAndClose();
    return;
  }
  // Inline DOM warning (the canvas confirm modal paints an opaque
  // backdrop that would hide the layout being judged).
  if (!_warnRow) return;
  _warnRow.innerHTML = '';
  const msg = document.createElement('div');
  msg.className = 'hlWarnMsg';
  const list = pairs.slice(0, 3).map(([a, b]) => `${a} × ${b}`).join(', ')
    + (pairs.length > 3 ? ` +${pairs.length - 3} more` : '');
  msg.textContent = `⚠ overlapping: ${list}`;
  _warnRow.appendChild(msg);
  const row = document.createElement('div');
  row.className = 'hlBtnRow';
  row.appendChild(mkBtn('SAVE ANYWAY', 'hlSave', commitAndClose));
  row.appendChild(mkBtn('GO BACK', 'hlCancel', clearWarning));
  _warnRow.appendChild(row);
  _warnRow.style.display = 'block';
}

function commitAndClose(): void {
  saveHudLayout();
  closeHudLayoutEditor();
}

function cancelAndClose(): void {
  setHudOffsets(_entrySnapshot);
  closeHudLayoutEditor();
}

function onKeyDown(e: KeyboardEvent): void {
  if (!_open) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    cancelAndClose();
  }
}

/** Per-frame box tracking: widget rects move as the user drags (and as
 *  the game's own sync fns reposition the SVG gauges), so mirror each
 *  live getBoundingClientRect onto its drag box. 8 rect reads/frame,
 *  only while the mode is open. */
function tick(): void {
  if (!_open) return;
  for (const def of HUD_WIDGETS) {
    const box = _boxes.get(def.id);
    const el = document.querySelector<HTMLElement>(def.sel);
    if (!box) continue;
    const r = el ? el.getBoundingClientRect() : null;
    if (!r || r.width < 2 || r.height < 2) {
      box.style.display = 'none';
      continue;
    }
    box.style.display = 'block';
    box.style.left = `${r.left}px`;
    box.style.top = `${r.top}px`;
    box.style.width = `${r.width}px`;
    box.style.height = `${r.height}px`;
  }
  _raf = requestAnimationFrame(tick);
}

export function openHudLayoutEditor(): void {
  if (_open) return;
  _open = true;
  _entrySnapshot = getHudOffsets();
  if (!_overlay) _overlay = buildOverlay();
  document.body.appendChild(_overlay);
  document.body.classList.add('hud-layout-mode');
  window.addEventListener('keydown', onKeyDown, true);
  clearWarning();
  applyHudLayout();
  _raf = requestAnimationFrame(tick);
}

export function closeHudLayoutEditor(): void {
  if (!_open) return;
  _open = false;
  cancelAnimationFrame(_raf);
  window.removeEventListener('keydown', onKeyDown, true);
  document.body.classList.remove('hud-layout-mode');
  if (_overlay && _overlay.parentElement) _overlay.parentElement.removeChild(_overlay);
}
