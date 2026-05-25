/**
 * H647: mobile gear shifter touch input.
 *
 * 1:1 port of monolith `_bindShiftKnob` (L23577-L23675). Circular knob
 * inside a `.pedal-bar.shift` container — finger swipes up to upshift
 * (+1), down to downshift (-1). Past a 12-px swipe threshold the shift
 * fires once (fired-guard prevents repeats within a single drag).
 *
 * Visual feedback:
 *   - During drag: the .ped-face translates with the finger (clamped to
 *     ±53 px, the bar-half 75 - knob-half 22), via inline transform.
 *   - On shift fire: `.up` or `.down` class flashes for 180 ms which
 *     CSS .pedal-bar.shift.up / .down rules drive to translate the
 *     knob fully to its travel extent.
 *   - The .pthumb pip tracks the finger's Y position along the bar.
 *
 * Edge cases preserved from monolith:
 *   - On touchend without a swipe: shift in the direction of the
 *     starting touch location (upper half → upshift, lower half →
 *     downshift). Lets the player tap-shift without dragging.
 *   - mouseleave during drag cancels cleanly (no spurious shift).
 *
 * Caller wires `onShift(dir)` callback that takes ±1 and performs the
 * actual gearbox change (writes player.manualGear + manualGearTimer in
 * the modular tree). Decouples this module from ctx/CAR_CATALOG.
 */

const SWIPE_THRESHOLD = 12;
const MAX_TRAVEL_PX = 53;

let _installed = false;

function _getY(e: TouchEvent | MouseEvent): number {
  if ('touches' in e && e.touches.length > 0) return e.touches[0].clientY;
  if ('changedTouches' in e && e.changedTouches.length > 0) return e.changedTouches[0].clientY;
  return (e as MouseEvent).clientY;
}

/** Wire shifter touch + mouse handlers on the #shiftKnob element.
 *  Idempotent. `onShift` receives ±1 each time a shift fires. */
export function installShifter(onShift: (dir: 1 | -1) => void): void {
  if (_installed) return;
  if (typeof document === 'undefined') return;
  const knob = document.getElementById('shiftKnob');
  if (!knob) return;
  _installed = true;

  const face = knob.querySelector<HTMLElement>('.ped-face');
  const thumb = knob.querySelector<HTMLElement>('.pthumb');

  let startY: number | null = null;
  let startInUpper = false;
  let fired = false;

  function setFacePixelOffset(dy: number): void {
    const clamped = Math.max(-MAX_TRAVEL_PX, Math.min(MAX_TRAVEL_PX, dy));
    if (face) {
      face.classList.add('dragging');
      face.style.transform = 'translateX(-50%) translateY(-50%) translateY(' + clamped.toFixed(1) + 'px)';
    }
  }
  function clearFaceOffset(): void {
    if (face) {
      face.style.transform = '';
      face.classList.remove('dragging');
    }
  }
  function setThumbAt(clientY: number): void {
    if (!thumb) return;
    const r = knob!.getBoundingClientRect();
    let f = (clientY - r.top) / r.height;
    if (f < 0) f = 0;
    else if (f > 1) f = 1;
    thumb.style.opacity = '0.9';
    thumb.style.top = (f * 100).toFixed(1) + '%';
  }
  function clearThumb(): void {
    if (thumb) thumb.style.opacity = '';
  }
  function flash(dir: 1 | -1): void {
    const cls = dir > 0 ? 'up' : 'down';
    knob!.classList.add(cls);
    setTimeout(() => knob!.classList.remove(cls), 180);
  }
  function doKnobShift(dir: 1 | -1): void {
    if (fired) return;
    fired = true;
    flash(dir);
    onShift(dir);
  }
  function onDown(e: TouchEvent | MouseEvent): void {
    e.preventDefault();
    const r = knob!.getBoundingClientRect();
    const y = _getY(e);
    startY = y;
    startInUpper = (y - r.top) < (r.height / 2);
    fired = false;
    setThumbAt(y);
    setFacePixelOffset(0);
  }
  function onMove(e: TouchEvent | MouseEvent): void {
    if (startY === null) return;
    const y = _getY(e);
    const dy = y - startY;
    setThumbAt(y);
    setFacePixelOffset(dy);
    if (dy <= -SWIPE_THRESHOLD) doKnobShift(1);
    else if (dy >= SWIPE_THRESHOLD) doKnobShift(-1);
  }
  function onUp(): void {
    if (startY !== null && !fired) {
      doKnobShift(startInUpper ? 1 : -1);
    }
    startY = null;
    fired = false;
    clearFaceOffset();
    clearThumb();
  }

  knob.addEventListener('touchstart', onDown, { passive: false });
  knob.addEventListener('touchmove', onMove, { passive: true });
  knob.addEventListener('touchend', onUp, { passive: true });
  knob.addEventListener('touchcancel', onUp, { passive: true });
  knob.addEventListener('mousedown', onDown);
  knob.addEventListener('mousemove', (e: MouseEvent) => {
    if (startY !== null) onMove(e);
  });
  knob.addEventListener('mouseup', onUp);
  knob.addEventListener('mouseleave', () => {
    if (startY !== null) {
      startY = null;
      fired = false;
      clearFaceOffset();
      clearThumb();
    }
  });
}

/** Update the gear digit displayed in the shifter's #skGearText recess.
 *  Caller passes the canonical gear string ('1'..'6', 'R', 'N'). Per
 *  monolith L23623-L23627, also paint 'R' in orange so reverse stands
 *  out from forward gears. Dirty-checked — only writes when the value
 *  changes. */
let _lastGearText = '';
export function updateShifterGear(gearText: string): void {
  if (typeof document === 'undefined') return;
  if (gearText === _lastGearText) return;
  _lastGearText = gearText;
  const el = document.getElementById('skGearText');
  if (!el) return;
  el.textContent = gearText;
  el.setAttribute('fill', gearText === 'R' ? '#f80' : '#fff');
}
