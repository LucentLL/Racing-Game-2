/**
 * H645: mobile slider-pedal touch input.
 *
 * 1:1 port of monolith `addSliderPedal` (L23301-L23436) plus the shared
 * mouse-tracker state init at L23286-L23300. Each pedal is a 150px tall
 * touch slider; the analog amount (0..1) is computed from the finger's
 * Y position within the bar and pushed to a setter callback. The bar's
 * inner .ped-arm scaleY-shrinks toward its pivot, and the .ped-face
 * translates toward (or away from) the pivot — both GPU-composited via
 * transform, the user-tuned approach that smooths over the per-frame
 * reflow stutter the height-property variant produced on 120Hz S24+.
 *
 * Preserved constants (verbatim from monolith):
 *   ARM_REST_PX   = 60   .ped-arm CSS height
 *   ARM_TRAVEL_PX = 28   how many px the face translates at full press
 *   ARM_MIN_SCALE = 0.5333  arm's scaleY at full press
 *
 * Press direction:
 *   - .inverted CSS class on the bar = top-mount visual (base on top,
 *     face on bottom). This is the post-v123.79 monolith default — the
 *     HTML markup applies the class.
 *   - JS `inverted` flag = where the FACE end of the arm goes when
 *     pressed. true = face moves UP toward the top pivot (matches the
 *     .inverted CSS layout).
 *   - The touchFrac → amt mapping is controlled by `invertPedals`
 *     gameplaySetting (not yet wired in modular — defaults to false,
 *     which gives "press TOP of bar = max press", matching monolith
 *     default per L23388-L23393).
 *
 * The shared mouse listeners (registered once on first install) track
 * window-level mousemove / mouseup so a player who drags the mouse off
 * the bar still gets the slider following until release.
 *
 * Exported `getPedalGasAmount()` / `getPedalBrakeAmount()` return the
 * latest analog amount (0 when idle). gameLoop's mergeInputs reads them
 * and ORs into the boolean input.gas / input.brake fields so all
 * downstream physics that gate on the boolean (arcadeUpdate L101/L137,
 * phase0BAdapter, skidMarks) see the press.
 */

interface PedalState {
  id: string;
  el: HTMLElement;
  setter: (amt: number) => void;
  touchId: number;
  mouseDown: boolean;
  touchFrac?: number;
  ignoreInvert: boolean;
  _updateFill: (amt: number) => void;
  _setFromY: (clientY: number) => void;
}

const _list: PedalState[] = [];
let _installedShared = false;

function _installShared(): void {
  if (_installedShared) return;
  if (typeof window === 'undefined') return;
  _installedShared = true;
  window.addEventListener('mousemove', (e) => {
    for (const s of _list) {
      if (s.mouseDown) s._setFromY(e.clientY);
    }
  });
  window.addEventListener('mouseup', () => {
    for (const s of _list) {
      if (s.mouseDown) {
        s.mouseDown = false;
        s.setter(0);
        s._updateFill(0);
        s.el.classList.remove('active');
      }
    }
  });
}

/** Returns whether the user's gameplay setting wants bottom-mount
 *  (invertPedals=true). Stub for now — the OPT toggle hasn't ported
 *  to modular yet; reads false unconditionally so the default top-mount
 *  behavior fires (press TOP of bar = max, matching post-v123.79). */
function readInvertPedalsSetting(): boolean {
  // Placeholder. When OPT → Invert Pedals lands, read it from the
  // LIFE.gameplaySettings.invertPedals field exactly as the monolith
  // does at L23391-L23393.
  return false;
}

export interface SliderPedalOpts {
  /** When true, `inverted` is forced true regardless of the user's
   *  invertPedals setting (used by the e-brake pedal in H647 so it
   *  always reads "pull bottom = engage" like a real handbrake).
   *  Mirrors monolith opts.ignoreInvert at L23308. */
  ignoreInvert?: boolean;
}

/** Wire a slider pedal on the element with the given id. `setter`
 *  receives the analog amount (0..1) each touch update. Idempotent on
 *  the same id (reuses the existing state object). 1:1 port of monolith
 *  L23301-L23436. */
export function addSliderPedal(
  id: string,
  setter: (amt: number) => void,
  opts: SliderPedalOpts = {},
): void {
  if (typeof document === 'undefined') return;
  _installShared();
  const ignoreInvert = !!opts.ignoreInvert;
  const el = document.getElementById(id);
  if (!el) return;
  const fill = el.querySelector<HTMLElement>('.pfill');
  const thumb = el.querySelector<HTMLElement>('.pthumb');
  const arm = el.querySelector<HTMLElement>('.ped-arm');
  const face = el.querySelector<HTMLElement>('.ped-face');

  let st = _list.find((s) => s.id === id);
  if (!st) {
    st = {
      id,
      el,
      setter,
      touchId: -1,
      mouseDown: false,
      ignoreInvert,
      _updateFill: () => {},
      _setFromY: () => {},
    };
    _list.push(st);
  }
  st.el = el;
  st.setter = setter;
  st.touchId = -1;
  st.mouseDown = false;
  st.ignoreInvert = ignoreInvert;

  const ARM_REST_PX = 60;
  const ARM_TRAVEL_PX = 28;
  const ARM_MIN_SCALE = (ARM_REST_PX - ARM_TRAVEL_PX) / ARM_REST_PX;

  st._updateFill = (amt: number): void => {
    if (fill) fill.style.height = (amt * 100).toFixed(1) + '%';
    const tf = st!.touchFrac !== undefined ? st!.touchFrac : amt;
    if (thumb) thumb.style.top = (tf * 100).toFixed(1) + '%';
    const inverted = el.classList.contains('inverted');
    const armScale = (1 - amt * (1 - ARM_MIN_SCALE)).toFixed(4);
    const faceTr = (amt * ARM_TRAVEL_PX * (inverted ? -1 : 1)).toFixed(2);
    if (arm) arm.style.transform = 'translateX(-50%) scaleY(' + armScale + ')';
    if (face) face.style.transform = 'translateX(-50%) translateY(' + faceTr + 'px)';
    // Monolith L23354-L23362: also drive --ebrk-amt CSS var when this
    // is the e-brake bar. H647 ports the e-brake; for now this is a
    // no-op since H645 only wires gasBtn/brkBtn (neither has id ebrkBtn).
    if (id === 'ebrkBtn') {
      el.style.setProperty('--ebrk-amt', amt.toFixed(3));
    }
  };

  st._setFromY = (clientY: number): void => {
    const r = el.getBoundingClientRect();
    let touchFrac = (clientY - r.top) / r.height;
    if (touchFrac < 0) touchFrac = 0;
    else if (touchFrac > 1) touchFrac = 1;
    st!.touchFrac = touchFrac;
    const inverted = ignoreInvert ? true : readInvertPedalsSetting();
    const amt = inverted ? touchFrac : 1 - touchFrac;
    setter(amt);
    st!._updateFill(amt);
  };

  el.ontouchstart = (e: TouchEvent): void => {
    e.preventDefault();
    const t = e.changedTouches[0];
    st!.touchId = t.identifier;
    el.classList.add('active');
    st!._setFromY(t.clientY);
  };
  el.ontouchmove = (e: TouchEvent): void => {
    if (st!.touchId < 0) return;
    e.preventDefault();
    for (let i = 0; i < e.changedTouches.length; i++) {
      const t = e.changedTouches[i];
      if (t.identifier === st!.touchId) {
        st!._setFromY(t.clientY);
        break;
      }
    }
  };
  const endTouch = (e: TouchEvent): void => {
    if (st!.touchId < 0) return;
    let ended = false;
    for (let i = 0; i < e.changedTouches.length; i++) {
      if (e.changedTouches[i].identifier === st!.touchId) {
        ended = true;
        break;
      }
    }
    if (ended) {
      st!.touchId = -1;
      setter(0);
      st!._updateFill(0);
      el.classList.remove('active');
    }
  };
  el.ontouchend = endTouch;
  el.ontouchcancel = endTouch;
  el.onmousedown = (e: MouseEvent): void => {
    e.preventDefault();
    st!.mouseDown = true;
    el.classList.add('active');
    st!._setFromY(e.clientY);
  };
  st._updateFill(0);
}

// ---------------------------------------------------------------------
// Modular bridge — analog amounts exposed to gameLoop.mergeInputs so the
// boolean input.gas / input.brake fields fire while a pedal is held.
// ---------------------------------------------------------------------

let _gasAmount = 0;
let _brakeAmount = 0;
let _ebrkAmount = 0;

/** Wire the gas + brake + e-brake pedals to module-scoped amounts.
 *  Idempotent. H648: e-brake added with ignoreInvert so it always reads
 *  "pull bottom to engage" like a real handbrake, matching monolith
 *  L23445. The boolean coercion (v > 0) happens in mergeInputs. */
export function installPedals(): void {
  addSliderPedal('gasBtn', (v) => {
    _gasAmount = v;
  });
  addSliderPedal('brkBtn', (v) => {
    _brakeAmount = v;
  });
  addSliderPedal('ebrkBtn', (v) => {
    _ebrkAmount = v;
  }, { ignoreInvert: true });
}

/** Latest gas pedal amount, 0..1. 0 when no pedal touch is active. */
export function getPedalGasAmount(): number {
  return _gasAmount;
}

/** Latest brake pedal amount, 0..1. 0 when no pedal touch is active. */
export function getPedalBrakeAmount(): number {
  return _brakeAmount;
}

/** Latest e-brake pedal amount, 0..1. 0 when no touch active. The
 *  handbrake SVG rotation is driven separately by the --ebrk-amt CSS
 *  variable that addSliderPedal._updateFill writes — this getter is
 *  only for the boolean ctx.input.ebrk gate in mergeInputs. */
export function getPedalEbrkAmount(): number {
  return _ebrkAmount;
}
