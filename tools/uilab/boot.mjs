// Shared headless-Edge boot: dev build -> real new-game walk -> 'playing'.
// Exports { send, evaluate, sessionId, kill } bound to a live CDP session.
import { spawn, execSync } from 'node:child_process';
import { rmSync } from 'node:fs';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function bootToPlaying({ port = 9224, profile = 'h1281-edge' } = {}) {
  const PROFILE = process.env.TEMP + '/' + profile;
  try { rmSync(PROFILE, { recursive: true, force: true }); } catch { /* in use */ }
  const proc = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${port}`,
    '--user-data-dir=' + PROFILE, '--no-first-run', '--window-size=420,900', 'about:blank'], { stdio: 'ignore' });
  const kill = () => { try { execSync(`taskkill /PID ${proc.pid} /T /F`, { stdio: 'ignore' }); } catch { /* gone */ } };

  let ws; let msgId = 0; const pending = new Map();
  const send = (method, params = {}, sessionId) => {
    const id = ++msgId;
    ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((res, rej) => pending.set(id, { res, rej }));
  };

  for (let i = 0; i < 60; i++) {
    try { const v = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); if (v.webSocketDebuggerUrl) break; } catch { /* boot */ }
    await sleep(250);
  }
  const ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((res) => { ws.onopen = res; });
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id);
      if (m.error) p.rej(new Error(m.error.message)); else p.res(m.result); } };

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error('page threw: ' + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
    return r.result?.value;
  };

  await send('Page.enable', {}, sessionId);
  await send('Runtime.enable', {}, sessionId);
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true }, sessionId);
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }, sessionId);
  await send('Page.navigate', { url: 'http://localhost:5173/' }, sessionId);
  await sleep(3500);

  const gameState = () => evaluate(`window.__dc?.ctx?.gameState ?? 'boot'`);
  const canvasClick = (cxExpr, cyExpr) => evaluate(`(() => {
    const c = window.__dc.hudCanvas; const r = c.getBoundingClientRect();
    const cx = r.left + (${cxExpr}) * (r.width / c.width);
    const cy = r.top + (${cyExpr}) * (r.height / c.height);
    c.dispatchEvent(new MouseEvent('click', { clientX: cx, clientY: cy, bubbles: true }));
    return 'ok';
  })()`);

  await evaluate(`localStorage.clear(); 'x'`);
  for (let i = 0; i < 30 && (await gameState()) !== 'title'; i++) await sleep(300);
  await canvasClick('c.width/2', 'c.height*0.73 + 14');
  for (let i = 0; i < 10 && (await gameState()) !== 'nameEntry'; i++) await sleep(300);
  await evaluate(`(document.getElementById('driverRandomBtn')?.click(), document.getElementById('modeRealisticBtn')?.click(), 'x')`);
  await sleep(300);
  await evaluate(`(document.getElementById('driverNextBtn').click(), 'x')`);
  for (let i = 0; i < 10 && (await gameState()) !== 'jobSelect'; i++) await sleep(300);

  // retrying click-ladders: choices are randomized per run, some rows are
  // locked/unaffordable, so sweep the column up to 4 times per screen.
  const ladder = async (fromState) => {
    for (let sweep = 0; sweep < 4; sweep++) {
      for (let frac = 0.15; frac < 0.92; frac += 0.05) {
        if ((await gameState()) !== fromState) return;
        await canvasClick('c.width/2', `c.height*${frac.toFixed(2)}`);
        await sleep(250);
      }
    }
  };
  await ladder('jobSelect');
  // start-car choices are randomized and some rolls leave every visible card
  // locked/unaffordable — unlock them all so any card click advances (test
  // fixture only; the walk still exercises the real click router).
  await evaluate(`(() => {
    const cs = window.__dc.ctx.carSelect;
    (cs.payload?.choices ?? []).forEach((c) => { c.canAfford = true; c.locked = false; });
    cs.scrollY = 0;
    return 'unlocked ' + (cs.payload?.choices?.length ?? 0);
  })()`).then((r) => console.log(r));
  await ladder('carSelect');
  const final = await gameState();
  if (final !== 'playing') { kill(); throw new Error('boot walk stuck at ' + final); }
  return { send, evaluate, sessionId, kill, gameState, canvasClick };
}
