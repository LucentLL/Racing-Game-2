/**
 * H1232: deployed-build freshness check — the Pages test loop's missing
 * piece. GitHub Pages serves index.html/audiolab.html with ~10min cache
 * (and mobile browsers hold HTML longer), so the user repeatedly tested
 * STALE builds under the impression they were current (ear-tests 5-7:
 * "wasn't updated", "vacuum cleaner again" = a fully cached pre-worklet
 * game). We can't control Pages' response headers, so the page verifies
 * itself: every build ships dist/version.json (vite plugin, H1232);
 * on boot we fetch it cache-bypassed, compare against the compiled-in
 * __BUILD_ID__, and if they differ, reload once onto a cache-busting
 * query URL. One sessionStorage guard prevents reload loops when the
 * CDN itself briefly lags.
 *
 * Call as early as possible at page boot (before the user invests any
 * interaction). No-op in dev (version.json only exists in builds).
 */

export function ensureFreshBuild(): void {
  if (!import.meta.env.PROD) return;
  const me = typeof __BUILD_ID__ !== 'undefined' ? __BUILD_ID__ : 'dev';
  fetch(import.meta.env.BASE_URL + 'version.json', { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : null))
    .then((j: { build?: string } | null) => {
      if (!j?.build || j.build === me) return;
      const guard = 'dc_ver_reload';
      if (sessionStorage.getItem(guard) === j.build) {
        // Already tried once for this target build — CDN lag, don't loop.
        console.warn(`[versionCheck] still on ${me} after reload; live is ${j.build}`);
        return;
      }
      sessionStorage.setItem(guard, j.build);
      console.warn(`[versionCheck] stale build ${me} -> reloading to ${j.build}`);
      // Query-busted URL forces a fresh HTML fetch past the cache.
      location.replace(location.pathname + '?v=' + j.build + location.hash);
    })
    .catch(() => { /* offline / no version.json — stay put */ });
}
