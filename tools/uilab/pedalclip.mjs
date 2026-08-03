// H1314 diagnostic: is the pedal's inner hardware clipped at HUD Size < 100%?
// .pedal-bar is calc(45px * --hud-scale) x calc(150px * --hud-scale) with
// overflow:hidden, but .ped-base / .ped-arm / .ped-face are FIXED px. Dump the
// bar box vs the face box at each HUD Size step and report the overflow.
// Usage: npm run dev, then  node tools/uilab/pedalclip.mjs
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { bootToPlaying, sleep } from './boot.mjs';

const OUT = process.argv[2] ?? '.';

const { evaluate, kill, send, sessionId } = await bootToPlaying();
try {
  await send('Emulation.setDeviceMetricsOverride',
    { width: 900, height: 500, deviceScaleFactor: 1, mobile: true }, sessionId);
  await evaluate(`(() => { const c = window.__dc.ctx; c.home.open = false; c.clock.timeOfDay = 0.5; return 'x'; })()`);
  await sleep(800);

  for (const hs of [1, 0.85, 0.7, 0.6, 0.55]) {
    await evaluate(`window.__dc.ctx.life.gameplaySettings.hudScale = ${hs}; 'x'`);
    await sleep(400);
    const out = await evaluate(`(() => {
      const bar = document.getElementById('gasBtn');
      if (!bar) return 'no gasBtn';
      const b = bar.getBoundingClientRect();
      const q = (s) => { const e = bar.querySelector(s); return e ? e.getBoundingClientRect() : null; };
      const face = q('.ped-face'); const arm = q('.ped-arm'); const base = q('.ped-base');
      const r = (x) => x ? [Math.round(x.top), Math.round(x.bottom), Math.round(x.width)] : null;
      const el2 = (id) => { const e = document.getElementById(id); return e ? e.getBoundingClientRect() : null; };
      const ebrk = el2('ebrkBtn');
      const shift = el2('shiftKnob');
      const faceFull = face ? face.height : 0;
      const faceVis = face ? Math.max(0, Math.min(face.bottom, b.bottom) - Math.max(face.top, b.top)) : 0;
      return JSON.stringify({
        bar: [Math.round(b.top), Math.round(b.bottom), Math.round(b.width), Math.round(b.height)],
        base: r(base), arm: r(arm), face: r(face),
        // THE assertions: the pad must be fully inside the bar (overflow:hidden
        // crops anything that isn't), the base must not be wider than the bar,
        // and the e-brake / shifter must sit in a clean stack above the pedal
        // (a double-scaled offset drops them onto it).
        padFullyVisible: Math.abs(faceVis - faceFull) < 0.5,
        baseFitsBar: !!base && base.width <= b.width + 0.5,
        stackGaps: ebrk && shift
          ? [Math.round(b.top - ebrk.bottom), Math.round(ebrk.top - shift.bottom)] : null,
      });
    })()`);
    console.log('hudScale ' + hs + ' -> ' + out);
    if (hs === 0.6) {
      // Union of the actual bars — the .pedal-zone box is 50%-wide and its
      // side flips with handedness, so it is the wrong thing to frame on.
      const clip = await evaluate(`(() => {
        let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
        for (const id of ['brkBtn','gasBtn','ebrkBtn','shiftKnob']) {
          const e = document.getElementById(id); if (!e) continue;
          const r = e.getBoundingClientRect(); if (r.width < 1) continue;
          x0 = Math.min(x0, r.left); y0 = Math.min(y0, r.top);
          x1 = Math.max(x1, r.right); y1 = Math.max(y1, r.bottom);
        }
        return { x: Math.max(0, x0 - 14), y: Math.max(0, y0 - 14), w: x1 - x0 + 28, h: y1 - y0 + 28 };
      })()`);
      const s = await send('Page.captureScreenshot', {
        format: 'png',
        clip: { x: clip.x, y: clip.y, width: clip.w, height: clip.h, scale: 3 },
      }, sessionId);
      writeFileSync(path.join(OUT, 'pedals_hud60.png'), Buffer.from(s.data, 'base64'));
      console.log('captured pedals_hud60');
    }
  }
} finally { kill(); }
