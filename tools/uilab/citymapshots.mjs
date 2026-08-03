// H1313 visual verify: the HUD city map (icon + SOLID panel + CLEAR panel).
// Boots the dev build headless (tools/uilab/boot.mjs), parks the car on open
// ground in daylight, then captures the left HUD column in each of the three
// states — and exercises the real tap router rather than poking the flags, so
// the icon's hit box is verified along with its paint.
// Usage: npm run dev, then  node tools/uilab/citymapshots.mjs [outDir]
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { bootToPlaying, sleep } from './boot.mjs';

const OUT = process.argv[2] ?? '.';

const { send, evaluate, sessionId, kill, canvasClick } = await bootToPlaying();
try {
  await evaluate(`(() => {
    const ctx = window.__dc.ctx;
    ctx.home.open = false;
    ctx.clock.timeOfDay = 0.5;
    ctx.player.pSpeed = 0; ctx.player.pAngle = 0;
    if (ctx.life) ctx.life.engineOff = false;
    ctx.life.gameplaySettings.hudMapOpen = false;
    ctx.life.gameplaySettings.hudMapClear = false;
    // A fresh life arrives with a page already popping, and the ~7s pop-in
    // occupies the icon's slot (the icon stands down for exactly that reason).
    // Retire it so the shots capture the steady state instead of the overlap.
    ctx.life._pagerPopFrames = 0;
    return 'ok';
  })()`);
  await sleep(700);

  // Left column only — the icon + panel live against the left edge under the
  // tach. Full viewport height so the panel's bottom clearance over the wheel
  // is visible in the same frame.
  const clip = await evaluate(`(() => {
    const r = window.__dc.hudCanvas.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width * 0.66, h: r.height * 0.46 };
  })()`);
  const shot = async (name) => {
    const s = await send('Page.captureScreenshot', {
      format: 'png',
      clip: { x: clip.x, y: clip.y, width: clip.w, height: clip.h, scale: 1 },
    }, sessionId);
    writeFileSync(path.join(OUT, `citymap_${name}.png`), Buffer.from(s.data, 'base64'));
    console.log('captured', name);
  };

  // Where the router thinks the icon and the style chip are.
  const geo = await evaluate(`(() => {
    const c = window.__dc.hudCanvas;
    const a = Math.max(60, Math.min(400, c.width * 0.5 - 24, c.height * 0.42));
    const iy = Math.round(4 + a * (78 / 110) + 14 + 16);
    return { iconX: 8 + 22, iconY: iy + 13, W: c.width, H: c.height };
  })()`);
  console.log('hud canvas', geo.W + 'x' + geo.H, 'icon at', geo.iconX, geo.iconY);

  await shot('1_icon');

  // Tap the icon through the real router.
  await canvasClick(String(geo.iconX), String(geo.iconY));
  await sleep(500);
  console.log('open after icon tap =', await evaluate(`window.__dc.ctx.life.gameplaySettings.hudMapOpen === true`));
  await shot('2_solid');

  // Tap the SOLID/CLEAR chip: panel right edge, header row.
  const chip = await evaluate(`(() => {
    const c = window.__dc.hudCanvas;
    const a = Math.max(60, Math.min(400, c.width * 0.5 - 24, c.height * 0.42));
    const iy = Math.round(4 + a * (78 / 110) + 14 + 16);
    const w = Math.round(Math.max(140, Math.min(c.width * 0.22, c.width * 0.45)));
    return { x: 8 + w - 3 - 13 - 3 - 17, y: iy + 7 };
  })()`);
  await canvasClick(String(chip.x), String(chip.y));
  await sleep(500);
  console.log('clear after chip tap =', await evaluate(`window.__dc.ctx.life.gameplaySettings.hudMapClear === true`));
  await shot('3_clear');

  // Paper palette (OPT -> Map: Light) applied to the SOLID sheet.
  await evaluate(`(() => {
    const gp = window.__dc.ctx.life.gameplaySettings;
    gp.hudMapClear = false; gp.mapLight = true; return 'ok';
  })()`);
  await sleep(500);
  await shot('4_solid_light');

  // Landscape — the layout the request came from. What matters here is that
  // the panel's DOM-measured floor keeps it clear of the steering wheel /
  // pedal row, whichever side handedness put them on.
  await send('Emulation.setDeviceMetricsOverride',
    { width: 880, height: 420, deviceScaleFactor: 2, mobile: true }, sessionId);
  await sleep(1200);
  // LHD + the smaller HUD Size, which is the layout the request came from:
  // wheel bottom-left, shifter/pedals bottom-right, leaving the left column
  // clear from under the tach down to the CRUISE button.
  const land = await evaluate(`(() => {
    const gp = window.__dc.ctx.life.gameplaySettings;
    gp.mapLight = false; gp.hudMapClear = false;
    gp.steeringOrientation = 1; gp.hudScale = 0.55;
    const c = window.__dc.hudCanvas;
    return c.width + 'x' + c.height;
  })()`);
  console.log('landscape hud canvas', land);
  await sleep(900);
  // What the panel's floor probe actually sees in this layout.
  console.log('left-column obstacles', await evaluate(`(() => {
    const c = window.__dc.hudCanvas, r = c.getBoundingClientRect();
    const sy = c.height / r.height, sx = c.width / r.width;
    return ['steerBar','cruiseBtn','brkBtn','gasBtn','ebrkBtn','shiftKnob'].map((id) => {
      const e = document.getElementById(id); if (!e) return id + ':none';
      const b = e.getBoundingClientRect();
      if (b.width <= 1) return id + ':hidden';
      return id + ':x' + Math.round((b.left - r.left) * sx) + '-' + Math.round((b.right - r.left) * sx)
        + ' top' + Math.round((b.top - r.top) * sy);
    }).join('  ');
  })()`));
  const lclip = await evaluate(`(() => {
    const r = window.__dc.hudCanvas.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  })()`);
  for (const [name, clearMode] of [['5_land_solid', false], ['6_land_clear', true]]) {
    await evaluate(`window.__dc.ctx.life.gameplaySettings.hudMapClear = ${clearMode}; 'x'`);
    await sleep(500);
    const s = await send('Page.captureScreenshot', {
      format: 'png',
      clip: { x: lclip.x, y: lclip.y, width: lclip.w, height: lclip.h, scale: 1 },
    }, sessionId);
    writeFileSync(path.join(OUT, `citymap_${name}.png`), Buffer.from(s.data, 'base64'));
    console.log('captured', name);
  }

  // OPT tab — the inserted HUD Map row plus the rows below it, which all
  // shifted 28px. Portrait, so the DISPLAY block is legible in one frame.
  await send('Emulation.setDeviceMetricsOverride',
    { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, sessionId);
  await sleep(900);
  await evaluate(`(() => {
    const ctx = window.__dc.ctx;
    ctx.life.gameplaySettings.hudScale = 1;
    ctx.menu.open = true; ctx.menu.tab = 'opt';
    ctx.life._menuTabScrollY = 0;
    return 'ok';
  })()`);
  await sleep(700);
  const mclip = await evaluate(`(() => {
    const r = window.__dc.hudCanvas.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height * 0.62 };
  })()`);
  const ms = await send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: mclip.x, y: mclip.y, width: mclip.w, height: mclip.h, scale: 1 },
  }, sessionId);
  writeFileSync(path.join(OUT, 'citymap_7_opt.png'), Buffer.from(ms.data, 'base64'));
  console.log('captured 7_opt');
} finally { kill(); }
console.log('done ->', OUT);
