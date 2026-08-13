// H1318 verify: editor reference layer shows the OSM baseline on charlotte-osm.
// Boot -> switchMap -> F9 editor -> aim view at the I-485/W.T.Harris
// interchange -> screenshot.
//   node tools/uilab/osmeditshot.mjs
import { writeFileSync } from 'node:fs';
import { bootToPlaying, sleep } from './boot.mjs';

const { send, evaluate, sessionId, kill } = await bootToPlaying({ port: 9232, profile: 'h1318-edge' });
try {
  await evaluate(`window.__dc.switchMap('charlotte-osm'); window.__dc.ctx.home.open = false; 'ok'`);
  await sleep(800);
  await evaluate(`(() => {
    // window listener only — dispatching on document too would bubble up and
    // toggle the editor twice (on, then straight back off).
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F9', bubbles: true }));
    return 'ok';
  })()`);
  await sleep(1200);
  const st = await evaluate(`(() => {
    const we = window.__dc.ctx.worldEditor;
    if (!we) return { err: 'no editor' };
    we.view.cx = 1638; we.view.cy = 299; we.view.zoom = 4;
    we.needsRedraw = true;
    if (typeof window.__weForceRender === 'function') window.__weForceRender();
    return { editMapId: we.editMapId, open: !!we.open };
  })()`);
  console.log('editor:', JSON.stringify(st));
  await sleep(900);
  const shot = await send('Page.captureScreenshot', { format: 'jpeg', quality: 85 }, sessionId);
  writeFileSync(new URL('./osm_editor.jpg', import.meta.url), Buffer.from(shot.data, 'base64'));
  console.log('wrote tools/uilab/osm_editor.jpg');
} finally {
  kill();
}
