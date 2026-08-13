// H1319: CPU-profile the editor redraw at a given zoom; print top self-time.
//   node tools/uilab/osmeditprof.mjs [zoom] [cx] [cy]
import { bootToPlaying, sleep } from './boot.mjs';

const [zoom = '8', cx = '1638', cy = '299'] = process.argv.slice(2);
const { send, evaluate, sessionId, kill } = await bootToPlaying({ port: 9234, profile: 'h1319-prof' });
try {
  await evaluate(`window.__dc.switchMap('charlotte-osm'); window.__dc.ctx.home.open = false; 'ok'`);
  await sleep(600);
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F9', bubbles: true })); 'ok'`);
  await sleep(1000);
  await evaluate(`(() => {
    const we = window.__dc.ctx.worldEditor;
    we.view.cx = ${cx}; we.view.cy = ${cy}; we.view.zoom = ${zoom};
    we.needsRedraw = true; window.__weForceRender?.();
    return 'ok';
  })()`);
  await send('Profiler.enable', {}, sessionId);
  await send('Profiler.start', {}, sessionId);
  await evaluate(`(() => {
    const we = window.__dc.ctx.worldEditor;
    for (let i = 0; i < 5; i++) { we.needsRedraw = true; window.__weForceRender?.(); }
    return 'ok';
  })()`);
  const { profile } = await send('Profiler.stop', {}, sessionId);
  const nodes = new Map(profile.nodes.map((n) => [n.id, n]));
  const self = new Map();
  const dt = profile.timeDeltas ?? [];
  const samples = profile.samples ?? [];
  for (let i = 0; i < samples.length; i++) {
    const id = samples[i];
    self.set(id, (self.get(id) ?? 0) + (dt[i] ?? 0));
  }
  const rows = [...self.entries()]
    .map(([id, us]) => {
      const n = nodes.get(id);
      const f = n?.callFrame ?? {};
      return { fn: f.functionName || '(anon)', url: (f.url || '').split('/').pop()?.split('?')[0] ?? '', ms: Math.round(us / 1000) };
    })
    .filter((r) => r.ms > 5)
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 18);
  console.table(rows);
} finally {
  kill();
}
