// H1319 diagnose: editor redraw cost + fragmentation on the CLT map.
//   node tools/uilab/osmeditperf.mjs
// Boots, switches to charlotte-osm, opens the editor, then at several zooms:
// forces a redraw, times it, screenshots.
import { writeFileSync } from 'node:fs';
import { bootToPlaying, sleep } from './boot.mjs';

const { send, evaluate, sessionId, kill } = await bootToPlaying({ port: 9233, profile: 'h1319-edge' });
try {
  await evaluate(`window.__dc.switchMap('charlotte-osm'); window.__dc.ctx.home.open = false; 'ok'`);
  await sleep(800);
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F9', bubbles: true })); 'ok'`);
  await sleep(1200);

  const views = [
    { name: 'overview', cx: 1250, cy: 750, zoom: 0.5 },
    { name: 'mid', cx: 1638, cy: 299, zoom: 2 },
    { name: 'close', cx: 1638, cy: 299, zoom: 8 },
  ];
  for (const v of views) {
    const r = await evaluate(`(() => {
      const we = window.__dc.ctx.worldEditor;
      we.view.cx = ${v.cx}; we.view.cy = ${v.cy}; we.view.zoom = ${v.zoom};
      we.needsRedraw = true;
      const t0 = performance.now();
      if (typeof window.__weForceRender === 'function') window.__weForceRender();
      const t1 = performance.now();
      // second redraw for a steady-state number
      we.needsRedraw = true;
      const t2 = performance.now();
      if (typeof window.__weForceRender === 'function') window.__weForceRender();
      const t3 = performance.now();
      return { active: we.active, gameRender: we.gameRender, first: +(t1 - t0).toFixed(0), second: +(t3 - t2).toFixed(0) };
    })()`);
    console.log(v.name, JSON.stringify(r));
    await sleep(400);
    const shot = await send('Page.captureScreenshot', { format: 'jpeg', quality: 85 }, sessionId);
    writeFileSync(new URL(`./osm_edit_${v.name}.jpg`, import.meta.url), Buffer.from(shot.data, 'base64'));
  }
} finally {
  kill();
}
