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

/** Look up the touch in this event matching `id` (returns null if not
 *  present in `touches` or `changedTouches`). Used by the per-handler
 *  helpers to read the SHIFTER's own touch instead of touches[0] —
 *  critical when a second finger is already down on the gas pedal,
 *  because in that case touches[0] is the gas-pedal touch and the
 *  shifter would otherwise sample the wrong Y. */
function _findTouchById(e: TouchEvent, id: number): Touch | null {
  for (let i = 0; i < e.touches.length; i++) {
    if (e.touches[i].identifier === id) return e.touches[i];
  }
  for (let i = 0; i < e.changedTouches.length; i++) {
    if (e.changedTouches[i].identifier === id) return e.changedTouches[i];
  }
  return null;
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
  // Identifier of the touch that started on the shifter. -1 = mouse
  // or no active touch. Lets touchmove/touchend filter for THIS touch
  // even when a second finger is held down on another control (gas).
  let touchId = -1;

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
  function beginAt(y: number): void {
    const r = knob!.getBoundingClientRect();
    startY = y;
    startInUpper = (y - r.top) < (r.height / 2);
    fired = false;
    setThumbAt(y);
    setFacePixelOffset(0);
  }
  function moveTo(y: number): void {
    if (startY === null) return;
    const dy = y - startY;
    setThumbAt(y);
    setFacePixelOffset(dy);
    if (dy <= -SWIPE_THRESHOLD) doKnobShift(1);
    else if (dy >= SWIPE_THRESHOLD) doKnobShift(-1);
  }
  function endDrag(): void {
    if (startY !== null && !fired) {
      doKnobShift(startInUpper ? 1 : -1);
    }
    startY = null;
    fired = false;
    touchId = -1;
    clearFaceOffset();
    clearThumb();
  }

  knob.addEventListener('touchstart', (e: TouchEvent) => {
    e.preventDefault();
    // Capture only the touch that LANDED on the shifter (changedTouches[0])
    // by identifier — DON'T read e.touches[0] which is the page's first
    // active touch and would be the gas-pedal touch when the user is
    // already pressing gas.
    const t = e.changedTouches[0];
    touchId = t.identifier;
    beginAt(t.clientY);
  }, { passive: false });

  knob.addEventListener('touchmove', (e: TouchEvent) => {
    if (touchId < 0) return;
    const t = _findTouchById(e, touchId);
    if (!t) return;
    moveTo(t.clientY);
  }, { passive: true });

  const endTouch = (e: TouchEvent): void => {
    if (touchId < 0) return;
    // Only end when OUR tracked touch is among the changedTouches.
    let ourTouchEnded = false;
    for (let i = 0; i < e.changedTouches.length; i++) {
      if (e.changedTouches[i].identifier === touchId) {
        ourTouchEnded = true;
        break;
      }
    }
    if (!ourTouchEnded) return;
    endDrag();
  };
  knob.addEventListener('touchend', endTouch, { passive: true });
  knob.addEventListener('touchcancel', endTouch, { passive: true });

  knob.addEventListener('mousedown', (e: MouseEvent) => {
    e.preventDefault();
    beginAt(e.clientY);
  });
  knob.addEventListener('mousemove', (e: MouseEvent) => {
    if (startY !== null) moveTo(e.clientY);
  });
  knob.addEventListener('mouseup', () => endDrag());
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
