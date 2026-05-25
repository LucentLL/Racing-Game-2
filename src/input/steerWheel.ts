/**
 * H644: mobile steering wheel touch input.
 *
 * Rotational touch tracking on the #steerBar element — finger angle
 * around the wheel hub accumulates into a clamped rotation, written
 * back to the SVG transform and exposed via getWheelSteerAxis() so
 * gameLoop.mergeInputs can blend it into the analog steerAxis pipeline.
 *
 * Ported 1:1 from monolith L23062-L23264 (_swInitTouchState,
 * _updateSteerVisual, _resetSteerVisual, updateSteer, plus the
 * touchstart/move/end/cancel + mousedown handlers).
 *
 * Mechanics:
 *   - touchstart records the finger angle around the hub (deferred
 *     until the finger leaves the 15%-of-width hub deadband — atan2
 *     is too sensitive near the center and slides through 0 cause
 *     ±π wrap jumps that would snap the wheel to full lock).
 *   - touchmove accumulates per-frame angular deltas (unwrap-aware),
 *     adds them to the rotation that was active at touchstart, clamps
 *     to ±STEER_MAX_ROT (±165°), normalizes to -1..+1 and stores it.
 *   - touchend resets to neutral (steerInput → 0, wheel snaps back).
 *
 * Mouse handlers mirror the touch path so desktop browsers in mobile-
 * emulation mode can drive too.
 */

const STEER_MAX_ROT_DEG = 165;
const STEER_MAX_ROT_RAD = (STEER_MAX_ROT_DEG * Math.PI) / 180;
const HUB_DEADBAND_FRAC = 0.15;

let _wheelEl: HTMLElement | null = null;
let _svgEl: HTMLElement | null = null;
let _installed = false;

let _currentRot = 0;       // active wheel rotation, clamped to ±STEER_MAX_ROT_RAD
let _startRot = 0;         // rotation at touch-start (so drag continues from where it was)
let _prevAngle = 0;        // last touch sample's angle around the hub
let _cumDelta = 0;         // accumulated angular delta this drag (handles ±π wrap)
let _hasValidPrev = false; // false until at least one sample lands outside the deadband

let _touchID: number | null = null;
let _mouseDown = false;

let _wheelSteerAxis: number | null = null;
let _lastWrittenDeg = NaN;

function _angleAt(clientX: number, clientY: number): number {
  if (!_wheelEl) return 0;
  const r = _wheelEl.getBoundingClientRect();
  return Math.atan2(clientY - (r.top + r.height / 2), clientX - (r.left + r.width / 2));
}

function _initTouchState(clientX: number, clientY: number): void {
  if (!_wheelEl) return;
  const r = _wheelEl.getBoundingClientRect();
  const dx = clientX - (r.left + r.width / 2);
  const dy = clientY - (r.top + r.height / 2);
  const radius = Math.hypot(dx, dy);
  const minR = r.width * HUB_DEADBAND_FRAC;
  _startRot = _currentRot;
  _cumDelta = 0;
  if (radius >= minR) {
    _prevAngle = Math.atan2(dy, dx);
    _hasValidPrev = true;
  } else {
    _hasValidPrev = false;
  }
}

function _updateVisual(): void {
  if (!_svgEl) return;
  const deg = _currentRot * 180 / Math.PI;
  const qDeg = Math.round(deg * 100) / 100;
  if (qDeg === _lastWrittenDeg) return;
  _lastWrittenDeg = qDeg;
  _svgEl.style.transform = 'rotate(' + qDeg + 'deg) translateZ(0)';
}

function _resetVisual(): void {
  _currentRot = 0;
  _startRot = 0;
  _cumDelta = 0;
  _hasValidPrev = false;
  _wheelSteerAxis = null;
  if (_svgEl) {
    _svgEl.style.transform = 'rotate(0deg) translateZ(0)';
    _lastWrittenDeg = 0;
  }
  if (_wheelEl) _wheelEl.classList.remove('active');
}

function _updateFromTouch(clientX: number, clientY: number): void {
  if (!_wheelEl) return;
  const r = _wheelEl.getBoundingClientRect();
  const dx = clientX - (r.left + r.width / 2);
  const dy = clientY - (r.top + r.height / 2);
  const radius = Math.hypot(dx, dy);
  if (radius < r.width * HUB_DEADBAND_FRAC) {
    _hasValidPrev = false;
    return;
  }
  const angle = Math.atan2(dy, dx);
  if (!_hasValidPrev) {
    _prevAngle = angle;
    _hasValidPrev = true;
    return;
  }
  let frameDelta = angle - _prevAngle;
  if (frameDelta > Math.PI) frameDelta -= 2 * Math.PI;
  else if (frameDelta < -Math.PI) frameDelta += 2 * Math.PI;
  _cumDelta += frameDelta;
  _prevAngle = angle;
  let newRot = _startRot + _cumDelta;
  if (newRot > STEER_MAX_ROT_RAD) newRot = STEER_MAX_ROT_RAD;
  else if (newRot < -STEER_MAX_ROT_RAD) newRot = -STEER_MAX_ROT_RAD;
  _currentRot = newRot;
  _wheelSteerAxis = newRot / STEER_MAX_ROT_RAD;
  _updateVisual();
}

/** Wire touch + mouse handlers on the #steerBar element. Idempotent —
 *  safe to call before the DOM is ready (no-ops if elements absent). */
export function installSteerWheel(): void {
  if (_installed) return;
  if (typeof document === 'undefined') return;
  const wheel = document.getElementById('steerBar') as HTMLElement | null;
  const svg = document.getElementById('steerWheelSvg') as HTMLElement | null;
  if (!wheel || !svg) return;
  _wheelEl = wheel;
  _svgEl = svg;
  _installed = true;

  wheel.addEventListener('touchstart', (e: TouchEvent) => {
    e.preventDefault();
    const t = e.changedTouches[0];
    _touchID = t.identifier;
    wheel.classList.add('active');
    _initTouchState(t.clientX, t.clientY);
  }, { passive: false });

  wheel.addEventListener('touchmove', (e: TouchEvent) => {
    if (_touchID === null) return;
    e.preventDefault();
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier === _touchID) {
        _updateFromTouch(t.clientX, t.clientY);
        break;
      }
    }
  }, { passive: false });

  const endTouch = (e: TouchEvent): void => {
    if (_touchID === null) return;
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier === _touchID) {
        _touchID = null;
        _resetVisual();
        break;
      }
    }
  };
  wheel.addEventListener('touchend', endTouch);
  wheel.addEventListener('touchcancel', endTouch);

  // Mouse fallback for desktop testing (the wheel is only visible on
  // mobile per CSS, but a PC user in DevTools mobile-emulation can drive).
  wheel.addEventListener('mousedown', (e: MouseEvent) => {
    e.preventDefault();
    _mouseDown = true;
    wheel.classList.add('active');
    _initTouchState(e.clientX, e.clientY);
  });
  window.addEventListener('mousemove', (e: MouseEvent) => {
    if (_mouseDown) _updateFromTouch(e.clientX, e.clientY);
  });
  window.addEventListener('mouseup', () => {
    if (_mouseDown) {
      _mouseDown = false;
      _resetVisual();
    }
  });

  _resetVisual();
}

/** Returns the wheel's current steer axis (-1..+1) if a touch/mouse drag
 *  is active, or null when idle. Gameloop's mergeInputs reads this and
 *  uses it in priority above keyboard ◀ ▶ buttons but below the gamepad
 *  stick — so a player using both gets gamepad analog, while wheel-only
 *  players get the wheel's smooth rotation and keyboard-only players
 *  keep the boolean A/D behavior. */
export function getWheelSteerAxis(): number | null {
  return _wheelSteerAxis;
}
