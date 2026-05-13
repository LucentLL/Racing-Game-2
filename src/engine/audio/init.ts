import { audio, type VolumeSettings } from './state';
import { loadAllSFX } from './sfx';

let pendingVolumes: VolumeSettings | null = null;

export function applyAudioVolumes(settings: VolumeSettings | null | undefined): void {
  if (!settings) return;
  if (!audio.audioStarted) {
    pendingVolumes = settings;
    return;
  }
  const clamp = (v: number | undefined): number =>
    v == null ? 1.0 : Math.max(0, Math.min(1, v));
  const vC = clamp(settings.volCarSfx);
  const vU = clamp(settings.volMenuSfx);
  const vM = clamp(settings.volMusic);
  if (audio.sfxGain) audio.sfxGain.gain.value = vC;
  if (audio.uiGain) audio.uiGain.gain.value = vU;
  if (audio.musicGain) audio.musicGain.gain.value = vM;
}

interface WebkitAudioWindow {
  AudioContext?: typeof AudioContext;
  webkitAudioContext?: typeof AudioContext;
}

export function initAudio(): void {
  if (audio.audioStarted) return;
  try {
    const w = window as WebkitAudioWindow;
    const Ctor = w.AudioContext ?? w.webkitAudioContext;
    if (!Ctor) return;
    const ac = new Ctor();
    audio.audioCtx = ac;
    void ac.resume();

    audio.masterGain = ac.createGain();
    audio.masterGain.gain.value = 0.7;
    audio.masterGain.connect(ac.destination);

    audio.sfxGain = ac.createGain();
    audio.sfxGain.gain.value = 1.0;
    audio.sfxGain.connect(audio.masterGain);
    audio.uiGain = ac.createGain();
    audio.uiGain.gain.value = 1.0;
    audio.uiGain.connect(audio.masterGain);
    audio.musicGain = ac.createGain();
    audio.musicGain.gain.value = 1.0;
    audio.musicGain.connect(audio.masterGain);

    const bufLen = ac.sampleRate * 2;
    const nBuf = ac.createBuffer(1, bufLen, ac.sampleRate);
    const nd = nBuf.getChannelData(0);
    for (let i = 0; i < bufLen; i++) nd[i] = Math.random() * 2 - 1;

    audio.engNoise = ac.createBufferSource();
    audio.engNoise.buffer = nBuf;
    audio.engNoise.loop = true;
    audio.engNoiseGain = ac.createGain();
    audio.engNoiseGain.gain.value = 0;
    audio.engNoise.connect(audio.engNoiseGain);

    audio.engRes1 = ac.createBiquadFilter();
    audio.engRes1.type = 'bandpass';
    audio.engRes1.Q.value = 6;
    audio.engRes1.frequency.value = 50;
    audio.engRes2 = ac.createBiquadFilter();
    audio.engRes2.type = 'bandpass';
    audio.engRes2.Q.value = 5;
    audio.engRes2.frequency.value = 100;
    audio.engRes3 = ac.createBiquadFilter();
    audio.engRes3.type = 'bandpass';
    audio.engRes3.Q.value = 3;
    audio.engRes3.frequency.value = 150;
    audio.engRes4 = ac.createBiquadFilter();
    audio.engRes4.type = 'bandpass';
    audio.engRes4.Q.value = 2;
    audio.engRes4.frequency.value = 200;

    audio.r1g = ac.createGain();
    audio.r1g.gain.value = 0.7;
    audio.r2g = ac.createGain();
    audio.r2g.gain.value = 1.0;
    audio.r3g = ac.createGain();
    audio.r3g.gain.value = 0.35;
    audio.r4g = ac.createGain();
    audio.r4g.gain.value = 0.2;
    audio.engNoiseGain.connect(audio.engRes1);
    audio.engRes1.connect(audio.r1g);
    audio.r1g.connect(audio.sfxGain);
    audio.engNoiseGain.connect(audio.engRes2);
    audio.engRes2.connect(audio.r2g);
    audio.r2g.connect(audio.sfxGain);
    audio.engNoiseGain.connect(audio.engRes3);
    audio.engRes3.connect(audio.r3g);
    audio.r3g.connect(audio.sfxGain);
    audio.engNoiseGain.connect(audio.engRes4);
    audio.engRes4.connect(audio.r4g);
    audio.r4g.connect(audio.sfxGain);
    audio.engNoise.start();

    audio.engBass = ac.createOscillator();
    audio.engBass.type = 'sawtooth';
    audio.engBass.frequency.value = 30;
    audio.engBassGain = ac.createGain();
    audio.engBassGain.gain.value = 0;
    const bassLP = ac.createBiquadFilter();
    bassLP.type = 'lowpass';
    bassLP.frequency.value = 90;
    bassLP.Q.value = 3;
    audio.engBass.connect(audio.engBassGain);
    audio.engBassGain.connect(bassLP);
    bassLP.connect(audio.sfxGain);
    audio.engBass.start();

    const exhNoise = ac.createBufferSource();
    exhNoise.buffer = nBuf;
    exhNoise.loop = true;
    audio.exhaust = ac.createBiquadFilter();
    audio.exhaust.type = 'bandpass';
    audio.exhaust.frequency.value = 2700;
    audio.exhaust.Q.value = 4;
    audio.exhaustGain = ac.createGain();
    audio.exhaustGain.gain.value = 0;
    exhNoise.connect(audio.exhaust);
    audio.exhaust.connect(audio.exhaustGain);
    audio.exhaustGain.connect(audio.sfxGain);
    exhNoise.start();

    const scrNoise = ac.createBufferSource();
    scrNoise.buffer = nBuf;
    scrNoise.loop = true;
    audio.bikeScream = ac.createBiquadFilter();
    audio.bikeScream.type = 'bandpass';
    audio.bikeScream.frequency.value = 5500;
    audio.bikeScream.Q.value = 3;
    audio.bikeScreamGain = ac.createGain();
    audio.bikeScreamGain.gain.value = 0;
    scrNoise.connect(audio.bikeScream);
    audio.bikeScream.connect(audio.bikeScreamGain);
    audio.bikeScreamGain.connect(audio.sfxGain);
    scrNoise.start();

    audio.tireNoise = ac.createBufferSource();
    audio.tireNoise.buffer = nBuf;
    audio.tireNoise.loop = true;
    audio.tireFilter = ac.createBiquadFilter();
    audio.tireFilter.type = 'bandpass';
    audio.tireFilter.frequency.value = 2200;
    audio.tireFilter.Q.value = 2;
    const tireHP = ac.createBiquadFilter();
    tireHP.type = 'highpass';
    tireHP.frequency.value = 1200;
    tireHP.Q.value = 0.7;
    const tireWS = ac.createWaveShaper();
    const curve = new Float32Array(256);
    for (let i = 0; i < 256; i++) {
      const x = i / 128 - 1;
      curve[i] = Math.tanh(x * 2);
    }
    tireWS.curve = curve;
    audio.tireGain = ac.createGain();
    audio.tireGain.gain.value = 0;
    audio.tireNoise.connect(audio.tireFilter);
    audio.tireFilter.connect(tireHP);
    tireHP.connect(tireWS);
    tireWS.connect(audio.tireGain);
    audio.tireGain.connect(audio.sfxGain);
    audio.tireNoise.start();

    audio.brakePadNoise = ac.createBufferSource();
    audio.brakePadNoise.buffer = nBuf;
    audio.brakePadNoise.loop = true;
    audio.brakePadFilter = ac.createBiquadFilter();
    audio.brakePadFilter.type = 'bandpass';
    audio.brakePadFilter.frequency.value = 350;
    audio.brakePadFilter.Q.value = 1.5;
    const brakePadLP = ac.createBiquadFilter();
    brakePadLP.type = 'lowpass';
    brakePadLP.frequency.value = 900;
    brakePadLP.Q.value = 0.7;
    audio.brakePadGain = ac.createGain();
    audio.brakePadGain.gain.value = 0;
    audio.brakePadNoise.connect(audio.brakePadFilter);
    audio.brakePadFilter.connect(brakePadLP);
    brakePadLP.connect(audio.brakePadGain);
    audio.brakePadGain.connect(audio.sfxGain);
    audio.brakePadNoise.start();

    audio.audioStarted = true;

    if (pendingVolumes) {
      applyAudioVolumes(pendingVolumes);
      pendingVolumes = null;
    }

    void loadAllSFX(ac);
  } catch (e) {
    console.log('Audio:', e);
  }
}

export function fireExhaustPop(): void {
  if (!audio.audioStarted || !audio.audioCtx || !audio.sfxGain) return;
  try {
    const t = audio.audioCtx.currentTime;
    const nb = audio.audioCtx.createBufferSource();
    const bl = (audio.audioCtx.sampleRate / 8) | 0;
    const b = audio.audioCtx.createBuffer(1, bl, audio.audioCtx.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < bl; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (bl * 0.15));
    nb.buffer = b;
    const pf = audio.audioCtx.createBiquadFilter();
    pf.type = 'lowpass';
    pf.frequency.value = 200 + Math.random() * 300;
    pf.Q.value = 5;
    const pg = audio.audioCtx.createGain();
    pg.gain.value = 0.6 + Math.random() * 0.3;
    nb.connect(pf);
    pf.connect(pg);
    pg.connect(audio.sfxGain);
    nb.start(t);
  } catch {
    /* ignore */
  }
}

export function installAudioAutostartHandlers(): void {
  document.addEventListener('touchstart', initAudio, { once: true });
  document.addEventListener('click', initAudio, { once: true });
  document.addEventListener('keydown', initAudio, { once: true });
}
