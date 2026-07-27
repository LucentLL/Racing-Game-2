/**
 * H1224: AUDIO LAB — engine-voice ear-test bench (audiolab.html entry).
 *
 * Drives the REAL audio pipeline (proceduralEngine + forcedInduction +
 * v8Engine + samples) with synthetic AudioFrameInputs from sliders, so
 * every one of the ~380 catalog voices can be auditioned in seconds —
 * per family, at any RPM/throttle, at any power stage, with the SC mod —
 * without driving across the city to find the car. Ships as a second
 * Vite page (unlinked from the game shell): /audiolab.html on Pages or
 * the dev server. The synth-voice iteration loop (H1225+ AudioWorklet
 * work) is judged through this bench.
 *
 * The frame inputs mirror the gameLoop call site (gameLoop ~6618):
 * gear is pinned to 3 so the launch-screech heuristics (gear<=2) never
 * fire, and drift/wheelspin/brake channels stay zeroed — this bench is
 * for ENGINE voices only.
 */

import { CAR_CATALOG, ALL_CAR_IDS, type CatalogCar } from '@/config/cars/catalog';
import { GT4_SPECS } from '@/config/cars/gt4Database';
import { getEffectiveCar } from '@/config/cars/upgradeHeadroom';
import { initAudio } from '@/engine/audio/init';
import { audio } from '@/engine/audio/state';
import { updateAudio, classifyEngine, resetEngineAudio } from '@/engine/audio/proceduralEngine';
import { computeEngineVoice, type EngineVoice } from '@/engine/audio/engineVoice';
import { carDisplacementCc, familyMedianCc, resolveEngineFamily } from '@/config/cars/engineFamily';
import { fiTurboEligible } from '@/engine/audio/forcedInduction';
import { ensureFreshBuild } from '@/engine/versionCheck';

// H1232: snap to the newest deployed build before anything else.
ensureFreshBuild();

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const FAMILY_LABELS: Record<string, string> = {
  i4: 'INLINE 4', i6: 'INLINE 6', v6: 'V6', v8: 'V8', v10: 'V10', v12: 'V12',
  f4: 'BOXER', rot: 'ROTARY', b2: 'BIKE 2CYL', b4: 'BIKE 4CYL', hd: 'HARLEY',
};

interface LabCar {
  id: string;
  car: CatalogCar;
  family: string;
  canSC: boolean;
}

const labCars: LabCar[] = ALL_CAR_IDS.map((id) => {
  const car = CAR_CATALOG[id];
  return {
    id,
    car,
    family: classifyEngine(car.name, car.isBike, car.eType || undefined),
    canSC: GT4_SPECS[car.name]?.canSC === 1,
  };
}).sort((a, b) => a.car.name.localeCompare(b.car.name));

const state = {
  cur: labCars.find((l) => /CIVIC TYPE R \(EK\)/i.test(l.car.name)) ?? labCars[0],
  rpm: 1200,
  thr: 0,
  stage: 0,
  scOn: false,
  gearFlip: false,
  sweep: null as null | { t0: number },
  /** H1234: DRIVE mode — replays GAME-style acceleration (WOT, rpm
   *  climbing, auto upshifts with the kinematic model's 0.45 dive) so
   *  "sounds different in the game" is reproducible on the bench. */
  drive: null as null | { gear: number },
  lastT: 0,
};

// ---- controls ----------------------------------------------------------

function fillFamilies(): void {
  const sel = $<HTMLSelectElement>('family');
  const fams = [...new Set(labCars.map((l) => l.family))].sort();
  sel.innerHTML = '<option value="">ALL</option>'
    + fams.map((f) => `<option value="${f}">${FAMILY_LABELS[f] ?? f.toUpperCase()}</option>`).join('');
  sel.onchange = fillCars;
}

function fillCars(): void {
  const fam = $<HTMLSelectElement>('family').value;
  const sel = $<HTMLSelectElement>('car');
  const list = labCars.filter((l) => !fam || l.family === fam);
  sel.innerHTML = list.map((l) => `<option value="${l.id}">${l.car.name}</option>`).join('');
  if (!list.includes(state.cur)) pickCar(list[0]);
  else sel.value = state.cur.id;
  sel.onchange = () => {
    const found = labCars.find((l) => l.id === sel.value);
    if (found) pickCar(found);
  };
}

function pickCar(l: LabCar): void {
  state.cur = l;
  state.sweep = null;
  state.drive = null;
  // Kill in-flight ramps/loops so the new voice starts from idle clean.
  resetEngineAudio();
  const rpm = $<HTMLInputElement>('rpm');
  rpm.min = String(l.car.idleRPM);
  rpm.max = String(l.car.redline);
  state.rpm = l.car.idleRPM;
  rpm.value = String(state.rpm);
  if (state.scOn && !l.canSC) state.scOn = false;
  renderButtons();
  renderReadout();
}

function renderButtons(): void {
  const stages = $('stages');
  stages.innerHTML = '';
  for (let s = 0; s <= 4; s++) {
    const b = document.createElement('button');
    b.textContent = String(s);
    b.className = state.stage === s ? 'on' : '';
    b.onclick = () => { state.stage = s; renderButtons(); renderReadout(); };
    stages.appendChild(b);
  }
  const sc = $<HTMLButtonElement>('scBtn');
  sc.className = state.scOn ? 'on' : '';
  sc.disabled = !state.cur.canSC;
  sc.style.opacity = state.cur.canSC ? '1' : '0.35';
}

function effHpRatio(): number {
  const base = state.cur.car;
  const eff = getEffectiveCar(base, {
    power: state.stage, weight: 0, brakes: 0, suspension: 0, tires: 0,
  });
  return eff.hp / Math.max(1, base.hp);
}

/** The per-car voice the gameLoop derives (H1251 tone offsets, H1254 turbo
 *  kit). The bench was passing no voice at all, so every car auditioned as
 *  the neutral family recording — which is exactly the thing those two
 *  commits exist to stop. Built off the EFFECTIVE car so the stage buttons
 *  walk the turbo up the size ladder here the same way they do in game. */
function labVoice(): EngineVoice {
  const base = state.cur.car;
  const eff = getEffectiveCar(base, {
    power: state.stage, weight: 0, brakes: 0, suspension: 0, tires: 0,
  });
  return computeEngineVoice(
    {
      id: state.cur.id,
      name: base.name,
      redline: base.redline,
      hp: eff.hp,
      weight: eff.kg,
      aspiration: base.asp,
      // H1274: parity with the game's _engineVoiceFor — without these the lab
      // auditions a different voice than the one that actually plays.
      // NOTE resolveEngineFamily, not state.cur.family: the latter is the
      // SYNTH voice class ('i4'), which is not a recorded-family key at all
      // and would have looked up a median of 0.
      idleRPM: base.idleRPM,
      cc: carDisplacementCc(base.name),
      familyMedianCc: familyMedianCc(resolveEngineFamily(base)),
      eType: base.eType,
      modelYear: base.modelYear,
    },
    {
      exhaustLevel: Math.max(0, Math.min(1, state.stage / 4)),
      straightPipe: state.stage >= 4,
    },
  );
}

function renderReadout(): void {
  const { car } = state.cur;
  const spec = GT4_SPECS[car.name];
  const ratio = effHpRatio();
  $('readout').innerHTML =
    `<b>${car.name}</b><br>`
    + `ENGINE <b>${car.eType || '(no GT4 data)'}</b> · ASP <b>${spec?.asp ?? 'NA'}</b>`
    + ` · VOICE <b>${(FAMILY_LABELS[state.cur.family] ?? state.cur.family).toLowerCase()}</b><br>`
    + `IDLE <b>${car.idleRPM}</b> · REDLINE <b>${car.redline}</b>`
    + ` · HP <b>${car.hp}</b> → <b>${Math.round(car.hp * ratio)}</b> (stage ${state.stage})`
    + `${state.cur.canSC ? ' · SC-ELIGIBLE' : ''}${state.scOn ? ' · <b>SC ON</b>' : ''}`
    // H1254: which recorded turbo this car runs, so a kit that sounds wrong on
    // a car can be traced back to the ladder without digging through code.
    + (fiTurboEligible(spec?.asp, state.stage, state.scOn && state.cur.canSC)
      ? `<br>TURBO <b>${labVoice().turboKit}</b>`
      : '');
}

// ---- frame loop --------------------------------------------------------

const SWEEP_UP_S = 2.8;
const SWEEP_DOWN_S = 1.6;

function tickSweep(now: number): void {
  if (!state.sweep) return;
  const { car } = state.cur;
  const el = (now - state.sweep.t0) / 1000;
  const span = car.redline - car.idleRPM;
  if (el < SWEEP_UP_S) {
    state.thr = 100;
    state.rpm = car.idleRPM + span * (el / SWEEP_UP_S);
  } else if (el < SWEEP_UP_S + SWEEP_DOWN_S) {
    // Lift at the top — this is the blow-off moment on turbo cars.
    state.thr = 0;
    state.rpm = car.redline - span * ((el - SWEEP_UP_S) / SWEEP_DOWN_S);
  } else {
    state.thr = 0;
    state.rpm = car.idleRPM;
    state.sweep = null;
    $('sweepBtn').className = '';
  }
  $<HTMLInputElement>('rpm').value = String(Math.round(state.rpm));
  $<HTMLInputElement>('thr').value = String(state.thr);
}

function tickDrive(dt: number): void {
  if (!state.drive) return;
  const { car } = state.cur;
  state.thr = 100;
  // WOT pull: ~2.2s per gear, upshift near redline with the game's
  // kinematic dive (rpm × 0.55), six gears then lift.
  state.rpm += ((car.redline - car.idleRPM) / 2.2) * dt;
  if (state.rpm >= car.redline * 0.985) {
    if (state.drive.gear < 6) {
      state.drive.gear++;
      state.rpm = Math.max(car.idleRPM, state.rpm * 0.55);
    } else {
      state.drive = null;
      state.thr = 0;
      state.rpm = car.idleRPM;
      $('driveBtn').className = '';
    }
  }
  $<HTMLInputElement>('rpm').value = String(Math.round(state.rpm));
  $<HTMLInputElement>('thr').value = String(state.thr);
}

function frame(now: number): void {
  const dt = Math.min(0.05, state.lastT ? (now - state.lastT) / 1000 : 1 / 60);
  state.lastT = now;
  tickSweep(now);
  tickDrive(dt);

  const { car } = state.cur;
  const thr = state.thr / 100;
  const rpmNorm = Math.max(0, Math.min(1,
    (state.rpm - car.idleRPM) / Math.max(1, car.redline - car.idleRPM)));

  updateAudio({
    player: {
      speed: 5 + rpmNorm * 60,   // >3 so idle pops need actual idle RPM, not a stopped car
      rpm: state.rpm,
      gear: state.drive ? state.drive.gear : (state.gearFlip ? 4 : 3),
      drifting: false,
      slipAngle: 0,
      onRoad: true,
      wheelspinRatio: 0,
      wheelGap: 0,
    },
    controls: {
      gas: thr > 0.02,
      gasAmount: thr,
      braking: false,
      ebrk: false,
      brakeAmount: 0,
    },
    car: {
      name: car.name,
      isBike: car.isBike,
      idleRPM: car.idleRPM,
      redline: car.redline,
      eType: car.eType || undefined,
      asp: car.asp,
      powerStage: state.stage,
      supercharged: state.scOn && state.cur.canSC,
      hpRatio: effHpRatio(),
      voice: labVoice(),
    },
    uiOpen: false,
    dt,
  });

  $('rpmVal').textContent = `${Math.round(state.rpm)}`;
  $('thrVal').textContent = `${state.thr}%`;
  requestAnimationFrame(frame);
}

// ---- boot --------------------------------------------------------------

function boot(): void {
  $('buildId').textContent =
    'build ' + (typeof __BUILD_ID__ !== 'undefined' ? __BUILD_ID__ : 'dev');
  fillFamilies();
  fillCars();
  renderButtons();
  renderReadout();

  $<HTMLInputElement>('rpm').oninput = (e) => {
    state.rpm = Number((e.target as HTMLInputElement).value);
    state.sweep = null;
  };
  $<HTMLInputElement>('thr').oninput = (e) => {
    state.thr = Number((e.target as HTMLInputElement).value);
    state.sweep = null;
  };
  $('scBtn').onclick = () => {
    if (!state.cur.canSC) return;
    state.scOn = !state.scOn;
    renderButtons();
    renderReadout();
  };
  $('shiftBtn').onclick = () => { state.gearFlip = !state.gearFlip; };
  $('sweepBtn').onclick = () => {
    state.sweep = { t0: performance.now() };
    state.drive = null;
    $('sweepBtn').className = 'on';
    $('driveBtn').className = '';
  };
  $('driveBtn').onclick = () => {
    state.drive = { gear: 1 };
    state.sweep = null;
    state.rpm = state.cur.car.idleRPM;
    $('driveBtn').className = 'on';
    $('sweepBtn').className = '';
  };

  $('startBtn').onclick = () => {
    initAudio();
    $('start').style.display = 'none';
    requestAnimationFrame(frame);
  };

  // Headless-verify hook: ?autostart skips the gesture gate (the ctx
  // stays suspended without one — fine, params still schedule) and
  // ?sweep runs one full sweep, so a CDP run with virtual time can
  // assert the frame loop survived: #rpmVal ends non-empty, and after
  // a completed sweep it reads back at idle RPM.
  const qs = new URLSearchParams(location.search);
  if (qs.has('autostart')) {
    initAudio();
    $('start').style.display = 'none';
    requestAnimationFrame(frame);
    if (qs.has('sweep')) $('sweepBtn').click();
    // H1225: master-bus RMS probe so a CDP run can assert the graph is
    // actually producing signal — and that throttle changes it (load
    // axis) — without ears. Polled onto window.__labRms.
    // H1227: + spectral crest (peak/mean magnitude, ~90Hz-4kHz) — an
    // objective tonal-vs-static meter: broadband hash scores ~2-4, a
    // periodic engine note scores far higher. Polled onto __labCrest.
    if (audio.audioCtx && audio.masterGain) {
      const an = audio.audioCtx.createAnalyser();
      an.fftSize = 2048;
      audio.masterGain.connect(an);
      const buf = new Float32Array(an.fftSize);
      const spec = new Float32Array(an.frequencyBinCount);
      const binHz = audio.audioCtx.sampleRate / an.fftSize;
      const b0 = Math.max(1, Math.round(90 / binHz));
      const b1 = Math.min(an.frequencyBinCount - 1, Math.round(4000 / binHz));
      window.setInterval(() => {
        an.getFloatTimeDomainData(buf);
        let s = 0;
        for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
        const w = window as unknown as { __labRms?: number; __labCrest?: number };
        w.__labRms = Math.sqrt(s / buf.length);
        an.getFloatFrequencyData(spec);
        let peak = 0;
        let mean = 0;
        for (let i = b0; i <= b1; i++) {
          const mag = Math.pow(10, spec[i] / 20);
          if (mag > peak) peak = mag;
          mean += mag;
        }
        mean /= (b1 - b0 + 1);
        w.__labCrest = mean > 0 ? peak / mean : 0;
      }, 200);
    }
  }
}

boot();
