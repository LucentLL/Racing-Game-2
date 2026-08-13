// H1322 verify: merge bands built for imported ramps + clean screenshot.
//   node tools/uilab/osmmergecheck.mjs <tileX> <tileY> <name>
import { writeFileSync } from 'node:fs';
import { bootToPlaying, sleep } from './boot.mjs';

const [TX = '1642', TY = '306', NAME = 'osm_merge'] = process.argv.slice(2);
const { send, evaluate, sessionId, kill } = await bootToPlaying({ port: 9235, profile: 'h1322-edge' });
try {
  await evaluate(`window.__dc.switchMap('charlotte-osm'); window.__dc.ctx.home.open = false; window.__dc.ctx.clock.hour = 12; 'ok'`);
  await sleep(1000);
  const stats = await evaluate(`(() => {
    const es = window.__dcWorld.RENDER_ENTRIES;
    let merge = 0, withPaths = 0, dashed = 0, erase = 0;
    for (const e of es) {
      if (e.mergeType === undefined && e.mergeAlign === undefined) continue;
      merge++;
      if (e.mergePaths) {
        withPaths++;
        if (e.mergePaths.innerDashed) dashed++;
        if (e.mergePaths.eraseInner) erase++;
      }
    }
    return { entries: es.length, merge, withPaths, dashed, erase };
  })()`);
  console.log('merge stats:', JSON.stringify(stats));
  await evaluate(`(() => {
    const ctx = window.__dc.ctx;
    ctx.player.px = ${Number(TX)} * 18;
    ctx.player.py = ${Number(TY)} * 18;
    ctx.player.pSpeed = 0;
    return 'ok';
  })()`);
  await sleep(2000);
  const pos = await evaluate(`(() => {
    const p = window.__dc.ctx.player;
    return { px: Math.round(p.px / 18), py: Math.round(p.py / 18) };
  })()`);
  console.log('player at:', JSON.stringify(pos));
  const shot = await send('Page.captureScreenshot', { format: 'jpeg', quality: 85 }, sessionId);
  writeFileSync(new URL(`./${NAME}.jpg`, import.meta.url), Buffer.from(shot.data, 'base64'));
  console.log(`wrote tools/uilab/${NAME}.jpg`);
} finally {
  kill();
}
