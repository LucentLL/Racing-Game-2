/**
 * H794: session-decay perf-drain time-series logger.
 *
 * Extends the H793 forensics (diagKill.ts) from a single live HUD line
 * into a recorded time series so the monotonic FPS decay (144 → 40 over
 * a play session, with the rAF callback staying ~0.7 ms) can be captured
 * and shared. The rAF/JS cost stays flat while the FPS falls, so the
 * cost lives in the browser's raster/composite stage OUTSIDE the JS
 * window — this logger samples the things that could grow that stage
 * (redrawn collections, cached light-sprite canvases, DOM/canvas counts)
 * once per second and derives:
 *
 *   compMs = frameMs - jsMs   // per-frame time spent outside JS
 *
 * which is the number that actually rises as the session decays. Whatever
 * counter climbs in lock-step with compMs names the drain.
 *
 * Usage:
 *   - initPerfDrain() once at boot (installs the Alt+Shift+L copy hotkey).
 *   - recordPerfDrain({...}) every frame from drawPlaying — self-throttles
 *     to one sample/second.
 *   - Alt+Shift+L copies the full session CSV to the clipboard (and logs
 *     it) so it can be pasted back for analysis. window.__perfDump() does
 *     the same from the devtools console.
 *
 * Dev-only: every entry point no-ops unless __DEV__.
 */

import { perfSnapshot } from './perfHud';
import { diagForensicsRaw } from './diagKill';
import { headlightCacheStats } from '@/render/headlightShadows';

/** Live per-frame inputs the loop already has cheaply on hand. */
export interface PerfDrainInputs {
  traffic: number;
  particles: number;
  skid: number;
  trail: number;
  px: number;
  py: number;
  night: boolean;
}

interface Sample extends PerfDrainInputs {
  t: number;        // seconds since first sample
  fps: number;      // rAF callbacks/sec
  frameMs: number;  // 1000 / fps
  jsMs: number;     // TOTAL perf phase (rAF callback wall-clock)
  compMs: number;   // frameMs - jsMs — the drain metric
  cone: number;     // cached headlight cone canvases
  halo: number;     // cached taillight halo canvases
  cvDom: number;    // <canvas> elements in the DOM
  cvCreated: number;// canvases created since boot
  dom: number;      // total DOM nodes
  heapMB: number;
  ltMs: number;     // longtask ms in the last second
  phases: Record<string, number>;
}

const samples: Sample[] = [];
const MAX_SAMPLES = 1200; // ~20 min at 1/s
let startMs = 0;
let lastSampleMs = 0;
let prev: Sample | null = null;
let installed = false;

function delta(cur: number, p: number | undefined): string {
  if (p === undefined) return '';
  const d = cur - p;
  if (Math.abs(d) < 0.05) return '';
  return d >= 0 ? `(+${d.toFixed(1)})` : `(${d.toFixed(1)})`;
}

/** Sample once per second. Cheap; safe to call every frame. */
export function recordPerfDrain(inp: PerfDrainInputs): void {
  if (!__DEV__) return;
  const nowMs = performance.now();
  if (startMs === 0) startMs = nowMs;
  if (nowMs - lastSampleMs < 1000) return;
  lastSampleMs = nowMs;

  const phases = perfSnapshot();
  const diag = diagForensicsRaw();
  const hl = headlightCacheStats();
  const fps = diag.rafsPerSec || 0;
  const frameMs = fps > 0 ? 1000 / fps : 0;
  const jsMs = phases.TOTAL ?? 0;
  const compMs = Math.max(0, frameMs - jsMs);
  const dom = document.getElementsByTagName('*').length;

  const s: Sample = {
    t: Math.round((nowMs - startMs) / 1000),
    fps,
    frameMs: +frameMs.toFixed(1),
    jsMs: +jsMs.toFixed(2),
    compMs: +compMs.toFixed(1),
    cone: hl.cone,
    halo: hl.halo,
    cvDom: diag.cvDom,
    cvCreated: diag.cvCreated,
    dom,
    heapMB: diag.heapMB,
    ltMs: diag.ltMs,
    traffic: inp.traffic,
    particles: inp.particles,
    skid: inp.skid,
    trail: inp.trail,
    px: Math.round(inp.px),
    py: Math.round(inp.py),
    night: inp.night,
    phases,
  };
  samples.push(s);
  if (samples.length > MAX_SAMPLES) samples.shift();

  // One readable line per second — confirms it's recording and shows the
  // drain forming live. compMs is the number to watch; deltas flag what
  // is climbing alongside it.
  console.log(
    `[perf t=${s.t}s] fps=${s.fps} frame=${s.frameMs} js=${s.jsMs} ` +
    `comp=${s.compMs}${delta(s.compMs, prev?.compMs)} | ` +
    `traf=${s.traffic} part=${s.particles}${delta(s.particles, prev?.particles)} ` +
    `skid=${s.skid} trail=${s.trail} cone=${s.cone}${delta(s.cone, prev?.cone)} ` +
    `halo=${s.halo}${delta(s.halo, prev?.halo)} | ` +
    `cv=${s.cvDom}/${s.cvCreated}${delta(s.cvCreated, prev?.cvCreated)} ` +
    `dom=${s.dom}${delta(s.dom, prev?.dom)} heap=${s.heapMB}M lt=${s.ltMs} | ` +
    `pos=(${s.px},${s.py}) night=${s.night ? 1 : 0}`,
  );
  prev = s;
}

/** Full session as pasteable text: a CSV of every sample plus a sorted
 *  phase breakdown for the first and last sample (to spot a phase that
 *  grew). */
export function dumpPerfDrain(): string {
  const lines: string[] = [];
  lines.push(`=== PERF DRAIN LOG — ${samples.length} samples @ 1/s ===`);
  lines.push(
    't_s,fps,frameMs,jsMs,compMs,traffic,particles,skid,trail,cone,halo,cvDom,cvCreated,dom,heapMB,ltMs,px,py,night',
  );
  for (const s of samples) {
    lines.push(
      [s.t, s.fps, s.frameMs, s.jsMs, s.compMs, s.traffic, s.particles, s.skid,
        s.trail, s.cone, s.halo, s.cvDom, s.cvCreated, s.dom, s.heapMB, s.ltMs,
        s.px, s.py, s.night ? 1 : 0].join(','),
    );
  }
  const fmtPhases = (s: Sample): string =>
    Object.entries(s.phases)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}=${v.toFixed(2)}`)
      .join(' ');
  if (samples.length > 0) {
    lines.push('--- phases @first: ' + fmtPhases(samples[0]));
    lines.push('--- phases @last:  ' + fmtPhases(samples[samples.length - 1]));
  }
  return lines.join('\n');
}

/** Install the Alt+Shift+L "copy session to clipboard" hotkey. */
export function initPerfDrain(): void {
  if (!__DEV__ || installed) return;
  installed = true;
  (window as unknown as { __perfDump: () => string }).__perfDump = dumpPerfDrain;
  window.addEventListener('keydown', (e) => {
    if (!(e.altKey && e.shiftKey && e.code === 'KeyL')) return;
    e.preventDefault();
    const text = dumpPerfDrain();
    const done = (): void =>
      console.log(`[perf] copied ${samples.length} samples to clipboard — paste to share.`);
    navigator.clipboard?.writeText(text).then(done, () => console.log(text));
    // Always echo to console too, in case clipboard is blocked.
    console.log(text);
  });
}
