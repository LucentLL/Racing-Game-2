import { audio } from './state';
import { sfxFlags, tireSampleBuffers } from './sfx';

interface ActiveGrain {
  src: AudioBufferSourceNode;
  g: GainNode;
  endTime: number;
}

interface TireGrainState {
  idxA: number;
  idxB: number;
  vol: number;
  rate: number;
  grainStart: number;
  grainDur: number;
  crossfade: number;
  period: number;
  activeGrains: ActiveGrain[];
  scheduleTimer: ReturnType<typeof setInterval> | null;
  running: boolean;
  nextTime: number;
  grainCount: number;
}

let tireGrainState: TireGrainState | null = null;
let lastTireType = '';
let tireChirpCooldown = 0;

/** H1250: grip utilisation at which the tyres start to audibly complain.
 *  0.72 is "leaning on it" — clearly before the limit, which is the point. */
const SCRUB_START = 0.72;
/** Ceiling for the pre-limit scrub. Deliberately well under the drift
 *  branch's 0.5 so an actual slide is still a step up in urgency. */
const SCRUB_MAX_VOL = 0.30;

export function startTireGrain(idxA: number, idxB: number, vol: number, rate: number): void {
  if (!audio.audioStarted || !audio.audioCtx || !audio.sfxGain) return;
  const bufA = tireSampleBuffers[idxA];
  const bufB = idxB >= 0 ? tireSampleBuffers[idxB] : null;
  if (!bufA) return;
  stopTireGrain();
  const dur = bufA.duration;
  const grainStart = dur * 0.05;
  const grainEnd = dur * 0.95;
  const grainDur = grainEnd - grainStart;
  const crossfade = Math.min(0.35, grainDur * 0.35);
  const period = grainDur - crossfade;
  tireGrainState = {
    idxA,
    idxB: bufB ? idxB : idxA,
    vol,
    rate,
    grainStart,
    grainDur,
    crossfade,
    period,
    activeGrains: [],
    scheduleTimer: null,
    running: true,
    nextTime: audio.audioCtx.currentTime,
    grainCount: 0,
  };
  scheduleGrain(tireGrainState, audio.audioCtx.currentTime);
  scheduleGrain(tireGrainState, audio.audioCtx.currentTime + period / 2);
  tireGrainState.scheduleTimer = setInterval(grainScheduler, 50);
}

function scheduleGrain(st: TireGrainState, when: number): void {
  if (!st.running || !audio.audioCtx || !audio.sfxGain) return;
  const ac = audio.audioCtx;
  const useIdx = st.grainCount % 2 === 0 ? st.idxA : st.idxB;
  st.grainCount++;
  const buf = tireSampleBuffers[useIdx];
  if (!buf) return;
  const src = ac.createBufferSource();
  src.buffer = buf;
  src.playbackRate.value = st.rate + (Math.random() * 0.04 - 0.02);
  const g = ac.createGain();
  const cf = st.crossfade;
  g.gain.setValueAtTime(0, when);
  g.gain.linearRampToValueAtTime(st.vol, when + cf);
  g.gain.setValueAtTime(st.vol, when + st.grainDur - cf);
  g.gain.linearRampToValueAtTime(0, when + st.grainDur);
  src.connect(g);
  g.connect(audio.sfxGain);
  const randOff = Math.random() * 0.08 * st.grainDur;
  src.start(when, st.grainStart + randOff, st.grainDur - randOff);
  const entry: ActiveGrain = { src, g, endTime: when + st.grainDur - randOff };
  st.activeGrains.push(entry);
  src.onended = () => {
    const i = st.activeGrains.indexOf(entry);
    if (i >= 0) st.activeGrains.splice(i, 1);
  };
}

function grainScheduler(): void {
  if (!tireGrainState || !tireGrainState.running || !audio.audioCtx) return;
  const st = tireGrainState;
  const now = audio.audioCtx.currentTime;
  while (st.nextTime < now + 0.25) {
    scheduleGrain(st, st.nextTime);
    st.nextTime += st.period;
  }
  st.activeGrains = st.activeGrains.filter((g) => g.endTime > now - 0.5);
}

export function stopTireGrain(): void {
  if (!tireGrainState) return;
  tireGrainState.running = false;
  if (tireGrainState.scheduleTimer) clearInterval(tireGrainState.scheduleTimer);
  const now = audio.audioCtx ? audio.audioCtx.currentTime : 0;
  for (const g of tireGrainState.activeGrains) {
    try {
      g.g.gain.cancelScheduledValues(now);
      g.g.gain.setTargetAtTime(0, now, 0.06);
      g.src.stop(now + 0.3);
    } catch {
      /* ignore */
    }
  }
  tireGrainState = null;
}

export function updateTireGrainParams(vol: number, rate: number): void {
  if (!tireGrainState || !tireGrainState.running || !audio.audioCtx) return;
  tireGrainState.vol = vol;
  tireGrainState.rate = rate;
  const now = audio.audioCtx.currentTime;
  for (const g of tireGrainState.activeGrains) {
    if (g.endTime > now + 0.1) {
      g.src.playbackRate.setTargetAtTime(rate, now, 0.05);
    }
  }
}

export function playTireChirp(vol: number, rate: number): void {
  if (!audio.audioStarted || !audio.audioCtx || !audio.sfxGain) return;
  const buf = tireSampleBuffers[3];
  if (!buf) return;
  const src = audio.audioCtx.createBufferSource();
  src.buffer = buf;
  src.playbackRate.value = rate;
  const g = audio.audioCtx.createGain();
  g.gain.value = vol;
  src.connect(g);
  g.connect(audio.sfxGain);
  src.start();
}

export function stopAllTireSamples(): void {
  stopTireGrain();
}

export function updateTireSFX(
  absSpd: number,
  isDrifting: boolean,
  slipAngle: number,
  isBraking: boolean,
  isEbrk: boolean,
  isHardAccel: boolean,
  dt: number,
  pSpeedSigned: number,
  brakeAmt: number,
  onRoadFlag: boolean,
  /** H1250: grip utilisation 0..1.6 (sim/tireLoad). 1 = at the limit. */
  gripUse = 0,
): void {
  if (tireChirpCooldown > 0) tireChirpCooldown -= dt;
  let wantType = '';
  let wantVol = 0;
  let wantRate = 1;

  const lockThresh = onRoadFlag ? 0.80 : 0.40;
  const movingFwd = pSpeedSigned > 0;
  const footLockup = isBraking && !isEbrk && movingFwd && absSpd > 35 && brakeAmt >= lockThresh;
  const ebrkLockup = isEbrk && absSpd > 15;

  if (isDrifting && absSpd > 8 && Math.abs(slipAngle) > 0.15) {
    wantType = 'drift';
    wantVol = Math.min(0.5, (Math.abs(slipAngle) - 0.15) * 2) * Math.min(1, absSpd / 40);
    wantRate = 0.8 + absSpd * 0.005;
  } else if (gripUse > SCRUB_START && absSpd > 26 && onRoadFlag) {
    // H1250: CORNERING SCRUB — the sound of tyres working near the limit,
    // BEFORE they let go. This is the branch the user was missing: everything
    // else here needs a drift, a locked brake or a launch, so ordinary hard
    // cornering was silent right up to the slide.
    //
    // Reuses the drift grain pair, but quiet and pitched down, so a scrub that
    // develops into a slide crossfades into the existing drift sound instead
    // of cutting to it. Volume is the fraction of the way from SCRUB_START to
    // the limit, so it builds as you lean on the car and eases as you unwind.
    wantType = 'drift';
    const t = Math.min(1, (gripUse - SCRUB_START) / (1 - SCRUB_START));
    wantVol = SCRUB_MAX_VOL * t * t;   // squared: barely there early, urgent late
    wantRate = 0.72 + absSpd * 0.004;  // faster corner = higher-pitched scrub
  } else if (footLockup || ebrkLockup) {
    wantType = 'brake';
    wantVol = Math.min(0.4, absSpd / 100);
    wantRate = 0.9 + absSpd * 0.003;
  } else if (isHardAccel && absSpd < 15 && absSpd > 2 && tireChirpCooldown <= 0) {
    wantType = 'chirp';
    wantVol = 0.25;
    wantRate = 1.2;
  }

  if (!sfxFlags.tireSamplesLoaded) {
    lastTireType = '';
    return;
  }

  if (wantType !== lastTireType) {
    if (tireGrainState) stopTireGrain();
    if (wantType === 'drift') {
      startTireGrain(0, 1, wantVol, wantRate);
    } else if (wantType === 'brake') {
      startTireGrain(2, -1, wantVol, wantRate);
    } else if (wantType === 'chirp') {
      playTireChirp(wantVol, wantRate);
      tireChirpCooldown = 1.5;
    }
    lastTireType = wantType;
  } else if (wantType === 'drift' || wantType === 'brake') {
    updateTireGrainParams(wantVol, wantRate);
  } else if (!wantType && tireGrainState) {
    stopTireGrain();
    lastTireType = '';
  }
}
