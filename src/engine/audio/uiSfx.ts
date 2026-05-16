/**
 * UI sound effects routed through audio.uiGain (menu sfx volume).
 *
 * H153: ports the refuel ding + low-fuel beep off the arcadeAudio
 * stop-gap. Both are simple procedural envelope-shaped tones — no
 * sample assets needed. They share the engine/audio system's single
 * AudioContext (audio.audioCtx) and uiGain node so the audio thread
 * runs one graph end-to-end instead of two parallel contexts.
 *
 * Both functions silently no-op when the audio system hasn't been
 * initialized (no user gesture yet) — same pattern as
 * arcadeAudio.playRefuelDing / playLowFuelBeep.
 */

import { audio } from './state';

/** Two-tone triangle-wave chime fired once when the player enters
 *  refuel range. 880 Hz → 1320 Hz (perfect fifth up) 80ms apart.
 *  Each note has a 10ms attack and a ~150-200ms exponential release.
 *  Ported from arcadeAudio.playRefuelDing — same envelope/freq math. */
export function playRefuelDing(): void {
  if (!audio.audioStarted || !audio.audioCtx || !audio.uiGain) return;
  const ctx = audio.audioCtx;
  const ui = audio.uiGain;
  const now = ctx.currentTime;
  const playTone = (freq: number, startOffset: number, duration: number, peak: number): void => {
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = freq;
    const gain = ctx.createGain();
    const t0 = now + startOffset;
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(peak, t0 + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + duration);
    osc.connect(gain);
    gain.connect(ui);
    osc.start(t0);
    osc.stop(t0 + duration + 0.02);
  };
  playTone(880,  0,    0.16, 0.12);
  playTone(1320, 0.08, 0.20, 0.10);
}

/** Short square-wave beep fired by the gameLoop throttle while fuel
 *  is below 15%. 600 Hz, 120ms, sharp attack so it cuts through the
 *  engine drone. Ported from arcadeAudio.playLowFuelBeep — caller
 *  throttles at the 2-second cadence (LIFE.lastLowFuelBeepAtMs). */
export function playLowFuelBeep(): void {
  if (!audio.audioStarted || !audio.audioCtx || !audio.uiGain) return;
  const ctx = audio.audioCtx;
  const ui = audio.uiGain;
  const now = ctx.currentTime;
  const osc = ctx.createOscillator();
  osc.type = 'square';
  osc.frequency.value = 600;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(0.08, now + 0.005);
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.13);
  osc.connect(gain);
  gain.connect(ui);
  osc.start(now);
  osc.stop(now + 0.15);
}
