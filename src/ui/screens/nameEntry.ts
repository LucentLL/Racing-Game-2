/**
 * Name entry screen — DOM overlay (not canvas).
 *
 * The character creation surface: gender M/F selector, body-base preview
 * (Muscular / Lean / Overweight, switched at runtime by fitness band —
 * the picker is preview-only), name + racer-alias inputs (10 char max,
 * alphanumeric+space filter), age slider (21-60) with end-label
 * quick-jumps and ± step buttons, RANDOM CHARACTER button, NEXT.
 *
 * Why DOM: the picker has 5+ inputs that need IME / keyboard / mobile-
 * keyboard handling that canvas painting can't provide. canvas
 * draw/handle entry points are present but no-op (see drawNameEntry).
 *
 * Test-mode hatch: setting playerName='test' on commit unlocks all cars,
 * sets money to 999,999, maxes vehicle stats, enables FPS counter, and
 * sets LIFE._testMode=true. The age value is preserved (v8.99.38 fix —
 * earlier code rerolled age in test mode and silently discarded slider).
 *
 * Ported from monolith L44605-44930.
 *
 * H3 status: bodies live. Portrait preview is a placeholder until the
 * character-base sprite sheet ports (it shows a colored block with
 * build-name text — the structural plumbing is in place so the real
 * draw drops in cleanly). Test-mode side effects (car unlocks, money,
 * stat max) live on the commit object as `testMode: true`; downstream
 * deps decide how to apply them.
 */

import { RANDOM_NAMES } from '@/config/names';
import { GT2_COLORS } from '@/ui/gt2Chrome';

/** Caller-supplied callbacks the overlay invokes on commit / interaction.
 *  These bridge the DOM surface back to LIFE / gameState mutations that
 *  the screen module shouldn't know about directly. */
export interface NameEntryDeps {
  /** Called when NEXT is tapped with both fields valid. The overlay has
   *  already filtered + trimmed the strings and clamped the age. */
  onCommit(commit: NameEntryCommit): void;
  /** Notification toast for one-off messages (e.g., test-mode unlock). */
  showNotif(msg: string): void;
}

/** Final values committed when the player taps NEXT. */
export interface NameEntryCommit {
  /** Player real name (10 chars max, alphanumeric+space, trimmed). */
  playerName: string;
  /** Racer alias (10 chars max, alphanumeric+space, trimmed). */
  playerAlias: string;
  /** Selected age (21-60, clamped). */
  age: number;
  /** 'M' | 'F'. Skin tone is pinned to 1 (only tone shipped). */
  gender: 'M' | 'F';
  /** True when playerName.toLowerCase()==='test' — test-mode hatch. */
  testMode: boolean;
  /** H1166: Easy/Realistic game mode. Easy = every car shifts
   *  automatically + every car presents LHD UI (seeds autoShiftAssist +
   *  steeringOrientation=LHD at LIFE creation). Realistic = current
   *  behavior (manufacturer drive side, manual gearbox available).
   *  Stored on gameplaySettings.easyMode so future difficulty knobs can
   *  hang off the same identity. */
  easyMode: boolean;
}

/** Module-level handles so hideNameOverlay can find and remove the
 *  overlay, and so ensureNameOverlay is idempotent. */
let _overlayEl: HTMLDivElement | null = null;
let _nameInput: HTMLInputElement | null = null;
let _aliasInput: HTMLInputElement | null = null;

/** Build name preview names — one of the 3 fitness-band columns
 *  (Muscular / Lean / Overweight). Preview-only; runtime build follows
 *  live fitness. Default 1 (Lean) since starting fitness sits there. */
const BUILD_NAMES = ['Muscular (>80% fit)', 'Lean', 'Overweight (<20% fit)'] as const;
const BUILD_COLS = BUILD_NAMES.length;

const ALPHANUM_SPACE_FILTER = /[^a-zA-Z0-9 ]/g;
const NAME_MAX_LEN = 10;
const AGE_MIN = 21;
const AGE_MAX = 60;

/** Builds the DOM overlay if it doesn't already exist, focuses the name
 *  input, and wires all listeners. Idempotent — repeat calls are no-ops.
 *  Ported from monolith L44605-44837. */
export function ensureNameOverlay(deps: NameEntryDeps): void {
  if (_overlayEl) return;

  const overlay = document.createElement('div');
  // H763: GT2 charcoal backdrop instead of the prior #0a0a12 arcade
  // dark — matches the rest of the new-game flow chrome.
  // H780: + GT2 blueprint-grid overlay (16-px cell) painted via
  // background-image so the DOM surface reads as the same family as
  // the canvas drawGt2Backdrop screens.
  overlay.style.cssText = `position:fixed;top:0;left:0;right:0;bottom:0;z-index:9999;background-color:${GT2_COLORS.bg};background-image:linear-gradient(to right,${GT2_COLORS.grid} 1px,transparent 1px),linear-gradient(to bottom,${GT2_COLORS.grid} 1px,transparent 1px);background-size:16px 16px;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:20px;box-sizing:border-box;font-family:monospace;overflow-y:auto;`;
  overlay.innerHTML = OVERLAY_HTML;
  document.body.appendChild(overlay);
  _overlayEl = overlay;

  // === Body-base picker logic (v8.99.122.46) ===
  // Preview column cycles 0/1/2 (Muscular/Lean/Overweight). Default 1
  // (Lean) since starting fitness sits in that band. The chosen value
  // is preview-only — fitness drives the column at runtime.
  let selGender: 'M' | 'F' = 'M';
  let previewCol = 1;

  const pCanvas = document.getElementById('portraitPreview') as HTMLCanvasElement;
  const pCtx = pCanvas.getContext('2d');
  const pLabel = document.getElementById('portraitIdx') as HTMLElement;

  function renderPortraitPreview(): void {
    if (!pCtx) return;
    // Placeholder portrait — colored block + build text. Real sprite
    // draw lands when the character-base sheet bodies port. H763:
    // glyph + label use GT2 amber on the gender-tinted background.
    pCtx.fillStyle = selGender === 'M' ? '#1a3a5a' : '#5a1a3a';
    pCtx.fillRect(0, 0, 96, 96);
    pCtx.fillStyle = GT2_COLORS.amber;
    pCtx.font = 'bold 11px monospace';
    pCtx.textAlign = 'center';
    pCtx.fillText(selGender === 'M' ? '♂' : '♀', 48, 48);
    pCtx.fillText(`Col ${previewCol}`, 48, 64);
    pCtx.textAlign = 'left';
    pLabel.textContent = 'Build preview: ' + BUILD_NAMES[previewCol] + ' (placeholder)';
    // Sync M/F button highlighting — GT2 amber for active, dim amber
    // border + muted text for idle.
    const mb = document.getElementById('genderMaleBtn');
    const fb = document.getElementById('genderFemaleBtn');
    if (mb && fb) {
      const on = 'rgba(247,166,35,0.18)';
      const off = 'rgba(38,38,38,0.6)';
      const onB = GT2_COLORS.amber;
      const offB = GT2_COLORS.amberDark;
      const onC = GT2_COLORS.amber;
      const offC = GT2_COLORS.textMute;
      mb.style.background = selGender === 'M' ? on : off;
      mb.style.borderColor = selGender === 'M' ? onB : offB;
      mb.style.color = selGender === 'M' ? onC : offC;
      fb.style.background = selGender === 'F' ? on : off;
      fb.style.borderColor = selGender === 'F' ? onB : offB;
      fb.style.color = selGender === 'F' ? onC : offC;
    }
  }
  renderPortraitPreview();

  // Arrows cycle preview column (Muscular ↔ Lean ↔ Overweight).
  let ppTouched = false;
  const ppPrev = (): void => {
    previewCol = (previewCol + BUILD_COLS - 1) % BUILD_COLS;
    renderPortraitPreview();
  };
  const ppNext = (): void => {
    previewCol = (previewCol + 1) % BUILD_COLS;
    renderPortraitPreview();
  };
  const prevBtn = document.getElementById('portraitPrev')!;
  const nextPBtn = document.getElementById('portraitNext')!;
  prevBtn.addEventListener('touchstart', (e) => { e.preventDefault(); ppTouched = true; ppPrev(); }, { passive: false });
  prevBtn.addEventListener('click', () => { if (!ppTouched) ppPrev(); ppTouched = false; });
  nextPBtn.addEventListener('touchstart', (e) => { e.preventDefault(); ppTouched = true; ppNext(); }, { passive: false });
  nextPBtn.addEventListener('click', () => { if (!ppTouched) ppNext(); ppTouched = false; });

  // M/F gender selectors
  const mBtn = document.getElementById('genderMaleBtn');
  const fBtn = document.getElementById('genderFemaleBtn');
  if (mBtn) mBtn.addEventListener('click', () => { selGender = 'M'; renderPortraitPreview(); });
  if (fBtn) fBtn.addEventListener('click', () => { selGender = 'F'; renderPortraitPreview(); });

  // H1166: EASY / REALISTIC game-mode pair. Defaults to REALISTIC (the
  // pre-H1166 behavior); deliberately NOT randomized by RANDOM — the
  // mode is a meaningful choice, not character flavor.
  let selEasy = false;
  const easyBtn = document.getElementById('modeEasyBtn');
  const realBtn = document.getElementById('modeRealisticBtn');
  const modeDesc = document.getElementById('modeDesc');
  function renderModeButtons(): void {
    if (!easyBtn || !realBtn || !modeDesc) return;
    const on = 'rgba(247,166,35,0.18)';
    const off = 'rgba(38,38,38,0.6)';
    const onB = GT2_COLORS.amber;
    const offB = GT2_COLORS.amberDark;
    const onC = GT2_COLORS.amber;
    const offC = GT2_COLORS.textMute;
    easyBtn.style.background = selEasy ? on : off;
    easyBtn.style.borderColor = selEasy ? onB : offB;
    easyBtn.style.color = selEasy ? onC : offC;
    realBtn.style.background = !selEasy ? on : off;
    realBtn.style.borderColor = !selEasy ? onB : offB;
    realBtn.style.color = !selEasy ? onC : offC;
    modeDesc.textContent = selEasy
      ? 'Automatic shifting · left-hand-drive layout in every car'
      : 'Manufacturer drive side · manual gearbox available';
  }
  if (easyBtn) easyBtn.addEventListener('click', () => { selEasy = true; renderModeButtons(); });
  if (realBtn) realBtn.addEventListener('click', () => { selEasy = false; renderModeButtons(); });
  renderModeButtons();

  _nameInput = document.getElementById('driverNameInput') as HTMLInputElement;
  _aliasInput = document.getElementById('driverAliasInput') as HTMLInputElement;
  const nextBtn = document.getElementById('driverNextBtn') as HTMLButtonElement;
  const randomBtn = document.getElementById('driverRandomBtn') as HTMLButtonElement;
  const ageSlider = document.getElementById('driverAgeSlider') as HTMLInputElement;
  const ageLabel = document.getElementById('driverAgeLabel') as HTMLElement;

  ageSlider.addEventListener('input', () => {
    ageLabel.textContent = ageSlider.value;
  });

  // v8.99.37: +/- step buttons + clickable end-labels.
  const ageMin = document.getElementById('driverAgeMin');
  const ageMax = document.getElementById('driverAgeMax');
  const ageMinus = document.getElementById('driverAgeMinus');
  const agePlus = document.getElementById('driverAgePlus');
  function setAge(v: number): void {
    const clamped = Math.max(AGE_MIN, Math.min(AGE_MAX, v | 0));
    ageSlider.value = String(clamped);
    ageLabel.textContent = String(clamped);
  }
  if (ageMin) ageMin.addEventListener('click', () => setAge(AGE_MIN));
  if (ageMax) ageMax.addEventListener('click', () => setAge(AGE_MAX));
  if (ageMinus) ageMinus.addEventListener('click', () => setAge(parseInt(ageSlider.value) - 1));
  if (agePlus) agePlus.addEventListener('click', () => setAge(parseInt(ageSlider.value) + 1));

  // RANDOM CHARACTER button — picks name + alias + age + gender + build col.
  // Skin tone NOT randomized (only Skin Tone 1 ships).
  randomBtn.addEventListener('click', () => {
    const nameList = RANDOM_NAMES[0];
    const aliasList = RANDOM_NAMES[1];
    const rn = nameList[Math.floor(Math.random() * nameList.length)];
    const ra = aliasList[Math.floor(Math.random() * aliasList.length)];
    const rAge = AGE_MIN + Math.floor(Math.random() * (AGE_MAX - AGE_MIN));
    _nameInput!.value = rn;
    _aliasInput!.value = ra;
    setAge(rAge);
    selGender = Math.random() < 0.5 ? 'M' : 'F';
    previewCol = Math.floor(Math.random() * BUILD_COLS);
    renderPortraitPreview();
    updateNext();
    // Flash to confirm — GT2 active orange.
    randomBtn.style.background = 'rgba(255,122,24,0.5)';
    setTimeout(() => { randomBtn.style.background = 'rgba(255,122,24,0.2)'; }, 200);
  });

  function updateInputStyles(): void {
    if (!_nameInput || !_aliasInput) return;
    _nameInput.style.borderColor = document.activeElement === _nameInput ? GT2_COLORS.amber : GT2_COLORS.amberDark;
    _aliasInput.style.borderColor = document.activeElement === _aliasInput ? GT2_COLORS.amber : GT2_COLORS.amberDark;
  }
  function readFiltered(inp: HTMLInputElement): string {
    return inp.value.replace(ALPHANUM_SPACE_FILTER, '').slice(0, NAME_MAX_LEN);
  }
  function updateNext(): void {
    const okName = readFiltered(_nameInput!).trim().length > 0;
    const okAlias = readFiltered(_aliasInput!).trim().length > 0;
    const ok = okName && okAlias;
    // GT2 amber for the active commit button; dim amber when waiting on input.
    nextBtn.style.borderColor = ok ? GT2_COLORS.amber : GT2_COLORS.amberDark;
    nextBtn.style.color = ok ? GT2_COLORS.amber : GT2_COLORS.textDim;
    nextBtn.style.background = ok ? 'rgba(247,166,35,0.15)' : 'rgba(38,38,38,0.4)';
  }
  function filterVal(inp: HTMLInputElement): void {
    const v = readFiltered(inp);
    if (inp.value !== v) inp.value = v;
    updateNext();
  }
  _nameInput.addEventListener('input', () => filterVal(_nameInput!));
  _aliasInput.addEventListener('input', () => filterVal(_aliasInput!));
  _nameInput.addEventListener('focus', updateInputStyles);
  _aliasInput.addEventListener('focus', updateInputStyles);
  _nameInput.addEventListener('blur', updateInputStyles);
  _aliasInput.addEventListener('blur', updateInputStyles);

  nextBtn.addEventListener('click', () => {
    const playerName = readFiltered(_nameInput!).trim();
    const playerAlias = readFiltered(_aliasInput!).trim();
    if (playerName.length === 0 || playerAlias.length === 0) return;
    const age = parseInt(ageSlider.value) || 25;
    const testMode = playerName.toLowerCase() === 'test';
    if (testMode) {
      deps.showNotif('TEST MODE — All cars unlocked! Age: ' + age);
    }
    deps.onCommit({ playerName, playerAlias, age, gender: selGender, testMode, easyMode: selEasy });
  });

  _nameInput.focus();
}

/** Removes the overlay from the DOM and clears cached input refs. Safe
 *  to call when the overlay is already absent. Ported from monolith
 *  L44838-44840. */
export function hideNameOverlay(): void {
  if (_overlayEl) {
    _overlayEl.remove();
    _overlayEl = null;
    _nameInput = null;
    _aliasInput = null;
  }
}

/** Focuses the name (idx=0) or alias (idx=1) input. */
export function focusNameField(idx: 0 | 1): void {
  const el = idx === 0 ? _nameInput : _aliasInput;
  if (el) el.focus();
}

/** Canvas no-op kept for the render() dispatcher symmetry — the DOM
 *  overlay covers the canvas while gameState==='nameEntry'. */
export function drawNameEntry(_ctx: CanvasRenderingContext2D): void {
  // Intentionally empty — DOM overlay handles the screen.
}

/** Canvas no-op kept for the tap dispatcher symmetry — the DOM overlay
 *  swallows all interaction while gameState==='nameEntry'. */
export function handleNameEntryClick(_tx: number, _ty: number): void {
  // Intentionally empty — DOM overlay handles all interaction.
}

// H763: GT2 amber-on-charcoal palette. Hex values mirror the day
// palette in gt2Chrome._dayPalette so the new-game flow visually
// matches the garage / dealer / pause-menu chrome.
//   amber   #f7a623   primary headers + active borders + typed text
//   amberDark #a36e15 idle borders
//   active  #ff7a18   RANDOM accent (orange-red)
//   text    #f4f4f4   not used directly here — DOM inherits from body
//   textMute #9a9a9a  subtitle / idle gender label
//   textDim #5e5e5e   subtitle / disabled commit text
//   bgDeep  #141414   panel face
//   panel   #262626   pressed/idle plate
const OVERLAY_HTML = `
  <div style="color:#f7a623;font-size:20px;font-weight:bold;margin-bottom:12px;font-family:monospace;letter-spacing:2px">NEW DRIVER</div>
  <div style="color:#f7a623;font-size:11px;font-weight:bold;margin-bottom:4px;font-family:monospace">CHOOSE YOUR LOOK</div>
  <div id="portraitPicker" style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
    <button id="portraitPrev" style="background:none;border:2px solid #a36e15;color:#f7a623;font-size:18px;padding:4px 10px;border-radius:4px;cursor:pointer;font-family:monospace">◀</button>
    <canvas id="portraitPreview" width="96" height="96" style="border:2px solid #f7a623;border-radius:4px;image-rendering:pixelated;width:96px;height:96px;background:#141414"></canvas>
    <button id="portraitNext" style="background:none;border:2px solid #a36e15;color:#f7a623;font-size:18px;padding:4px 10px;border-radius:4px;cursor:pointer;font-family:monospace">▶</button>
  </div>
  <div style="display:flex;gap:8px;margin-bottom:4px;">
    <button id="genderMaleBtn"   style="background:rgba(247,166,35,0.18);border:2px solid #f7a623;color:#f7a623;font-size:13px;font-weight:bold;font-family:monospace;letter-spacing:2px;padding:6px 18px;border-radius:4px;cursor:pointer;">♂ MALE</button>
    <button id="genderFemaleBtn" style="background:rgba(38,38,38,0.6);border:2px solid #a36e15;color:#9a9a9a;font-size:13px;font-weight:bold;font-family:monospace;letter-spacing:2px;padding:6px 18px;border-radius:4px;cursor:pointer;">♀ FEMALE</button>
  </div>
  <div id="portraitIdx" style="color:#9a9a9a;font-size:10px;font-family:monospace;margin-bottom:10px">Build shifts with fitness</div>
  <div style="color:#f7a623;font-size:13px;font-weight:bold;margin-bottom:6px;font-family:monospace;letter-spacing:1px">NAME (10 chars max)</div>
  <input id="driverNameInput" type="text" maxlength="10" placeholder="Enter name..."
    style="background:rgba(38,38,38,0.5);border:2px solid #a36e15;color:#f7a623;font-size:16px;font-weight:bold;padding:10px 16px;border-radius:4px;text-align:center;width:80%;max-width:300px;outline:none;font-family:monospace;letter-spacing:2px;margin-bottom:14px;direction:ltr;"
    autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">
  <div style="color:#9a9a9a;font-size:13px;font-weight:bold;margin-bottom:6px;font-family:monospace;letter-spacing:1px">RACER ALIAS (10 chars max)</div>
  <input id="driverAliasInput" type="text" maxlength="10" placeholder="Enter alias..."
    style="background:rgba(38,38,38,0.5);border:2px solid #a36e15;color:#f7a623;font-size:16px;font-weight:bold;padding:10px 16px;border-radius:4px;text-align:center;width:80%;max-width:300px;outline:none;font-family:monospace;letter-spacing:2px;margin-bottom:14px;direction:ltr;"
    autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">
  <div style="color:#f7a623;font-size:13px;font-weight:bold;margin-bottom:6px;font-family:monospace;letter-spacing:1px">AGE</div>
  <div style="display:flex;align-items:center;gap:10px;margin-bottom:4px;width:80%;max-width:300px;justify-content:center;">
    <span id="driverAgeMin" style="color:#f7a623;font-size:14px;font-family:monospace;cursor:pointer;padding:4px 8px;border:1px solid #f7a623;border-radius:3px;user-select:none;-webkit-user-select:none">21</span>
    <input id="driverAgeSlider" type="range" min="21" max="60" value="25"
      style="flex:1;accent-color:#f7a623;cursor:pointer;">
    <span id="driverAgeMax" style="color:#f7a623;font-size:14px;font-family:monospace;cursor:pointer;padding:4px 8px;border:1px solid #f7a623;border-radius:3px;user-select:none;-webkit-user-select:none">60</span>
  </div>
  <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;justify-content:center;">
    <button id="driverAgeMinus" style="background:rgba(38,38,38,0.5);border:2px solid #f7a623;color:#f7a623;font-size:18px;font-weight:bold;font-family:monospace;padding:2px 14px;border-radius:4px;cursor:pointer;min-width:34px;">−</button>
    <div id="driverAgeLabel" style="color:#f7a623;font-size:22px;font-weight:bold;font-family:monospace;min-width:50px;text-align:center;">25</div>
    <button id="driverAgePlus" style="background:rgba(38,38,38,0.5);border:2px solid #f7a623;color:#f7a623;font-size:18px;font-weight:bold;font-family:monospace;padding:2px 14px;border-radius:4px;cursor:pointer;min-width:34px;">+</button>
  </div>
  <div style="color:#5e5e5e;font-size:11px;margin-bottom:14px;font-family:monospace">Age affects starting conditions, fitness, and recovery</div>
  <div style="color:#f7a623;font-size:13px;font-weight:bold;margin-bottom:6px;font-family:monospace;letter-spacing:1px">GAME MODE</div>
  <div style="display:flex;gap:8px;margin-bottom:4px;">
    <button id="modeEasyBtn"      style="background:rgba(38,38,38,0.6);border:2px solid #a36e15;color:#9a9a9a;font-size:13px;font-weight:bold;font-family:monospace;letter-spacing:2px;padding:6px 18px;border-radius:4px;cursor:pointer;">EASY</button>
    <button id="modeRealisticBtn" style="background:rgba(247,166,35,0.18);border:2px solid #f7a623;color:#f7a623;font-size:13px;font-weight:bold;font-family:monospace;letter-spacing:2px;padding:6px 18px;border-radius:4px;cursor:pointer;">REALISTIC</button>
  </div>
  <div id="modeDesc" style="color:#9a9a9a;font-size:10px;font-family:monospace;margin-bottom:14px;text-align:center">Manufacturer drive side · manual gearbox available</div>
  <div style="display:flex;gap:10px;flex-wrap:wrap;justify-content:center;">
    <button id="driverRandomBtn" style="background:rgba(255,122,24,0.2);border:2px solid #ff7a18;color:#ff7a18;font-size:13px;font-weight:bold;font-family:monospace;letter-spacing:1px;padding:10px 18px;border-radius:4px;cursor:pointer;">🎲 RANDOM</button>
    <button id="driverNextBtn" style="background:rgba(38,38,38,0.4);border:2px solid #a36e15;color:#5e5e5e;font-size:16px;font-weight:bold;font-family:monospace;letter-spacing:2px;padding:10px 30px;border-radius:4px;cursor:pointer;">NEXT ▶</button>
  </div>
`;
