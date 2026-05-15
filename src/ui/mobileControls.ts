/**
 * Mobile on-screen drive controls — arcade-minimal stop-gap for H7.
 *
 * Two button clusters: steer (◀ ▶) bottom-left, pedals (GAS / BRAKE)
 * bottom-right. Buttons set the same InputState booleans the keyboard
 * listener writes, so arcadeUpdate doesn't care which device pressed
 * what. touchstart sets held=true; touchend / touchcancel / mouseup /
 * mouseleave clear it.
 *
 * Visibility tracked via a body class `mob-driving`, toggled by
 * setMobileControlsVisible from gameLoop's dispatch. Only renders
 * when gameState==='playing' so the title / start-flow screens stay
 * uncluttered. On PC the CSS hides the buttons via @media
 * (hover:hover) so a mouse user never sees them.
 *
 * NOT the final mobile control surface — the monolith ships a full
 * rotational steering wheel SVG with ±165° rotation tracking + multi-
 * tier pedal slider (L20429-20930, L23309-23800). That port lands when
 * the input pipeline scaffolds (src/input/touch + controlLayout) port
 * their bodies. This file scaffolds the arcade fallback so H6's
 * driving is testable on phone touchscreens right now.
 */

import type { InputState } from '@/state/input';

let _container: HTMLDivElement | null = null;

interface ButtonBinding {
  el: HTMLElement;
  set: (held: boolean) => void;
}

/** Build the DOM cluster + wire listeners. Idempotent — caller can
 *  invoke once at boot before any state transition. */
export function ensureMobileControls(input: InputState): void {
  if (_container) return;

  const root = document.createElement('div');
  root.id = 'mctrl';
  root.style.cssText = [
    'position:fixed',
    'left:0',
    'right:0',
    'bottom:0',
    'padding:18px',
    'z-index:50',
    'display:none',
    'justify-content:space-between',
    'pointer-events:none',
    'user-select:none',
    '-webkit-user-select:none',
    'touch-action:none',
  ].join(';');
  root.innerHTML = `
    <div class="mctrl-cluster mctrl-steer">
      <button class="mctrl-btn mctrl-steer-l" data-input="steerLeft">◀</button>
      <button class="mctrl-btn mctrl-steer-r" data-input="steerRight">▶</button>
    </div>
    <div class="mctrl-cluster mctrl-pedals">
      <button class="mctrl-btn mctrl-brake" data-input="brake">BRK</button>
      <button class="mctrl-btn mctrl-gas" data-input="gas">GAS</button>
    </div>
  `;
  document.body.appendChild(root);
  _container = root;

  const bindings: ButtonBinding[] = [];
  root.querySelectorAll<HTMLElement>('.mctrl-btn').forEach((el) => {
    const which = el.dataset.input as keyof InputState | undefined;
    if (!which) return;
    const set = (held: boolean): void => {
      // InputState boolean fields are typed individually; we know
      // which is a string in the keyof set and InputState[which]
      // is boolean. The cast keeps the assignment type-safe in
      // strict mode.
      (input as unknown as Record<string, boolean>)[which] = held;
      el.classList.toggle('mctrl-btn-held', held);
    };
    bindings.push({ el, set });

    el.addEventListener('touchstart', (e) => { e.preventDefault(); set(true); }, { passive: false });
    el.addEventListener('touchend', (e) => { e.preventDefault(); set(false); }, { passive: false });
    el.addEventListener('touchcancel', (e) => { e.preventDefault(); set(false); }, { passive: false });
    // Mouse fallback so PC users in mobile-emulation mode can verify
    // the buttons work. Hidden by CSS in the normal desktop path.
    el.addEventListener('mousedown', (e) => { e.preventDefault(); set(true); });
    el.addEventListener('mouseup', () => set(false));
    el.addEventListener('mouseleave', () => set(false));
  });

  // Page-blur / visibility-hide release-all so a backgrounded tab
  // doesn't leave a button stuck-held.
  window.addEventListener('blur', () => {
    for (const b of bindings) b.set(false);
  });
}

/** Toggle visibility based on state. Called from gameLoop's dispatch
 *  each frame — cheap because we only flip the display style when
 *  changing. */
export function setMobileControlsVisible(visible: boolean): void {
  if (!_container) return;
  const want = visible ? 'flex' : 'none';
  if (_container.style.display !== want) _container.style.display = want;
}
