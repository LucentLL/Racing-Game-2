import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';
import { execSync } from 'node:child_process';

// H959: stamp the built bundle with the current git short SHA so the running
// build is identifiable in-app (the editor status bar shows "build <sha>").
// Lets the user confirm a fresh deploy actually loaded instead of a stale
// cached bundle. Falls back to 'dev' outside a git checkout.
let BUILD_ID = 'dev';
try {
  BUILD_ID = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
    .toString().trim() || 'dev';
} catch { /* not a git checkout — keep 'dev' */ }

/**
 * F36: production builds set `__DEV__` to `false` so any `if (__DEV__)`
 * block dead-code-eliminates in the output bundle. Dev / serve keeps
 * `__DEV__` `true` so diagnostic flags, perf overlays, and `console.log`
 * stay live for development.
 *
 * console.log / .info / .debug are marked PURE in production via
 * esbuild's `pure` list, which lets the minifier drop the call when
 * the result is unused (which it always is for these). console.warn
 * and console.error are NOT marked pure — they stay in prod so genuine
 * runtime diagnostics still surface in user logs / store cert reports.
 */
export default defineConfig(({ mode }) => {
  const isProd = mode === 'production';
  return {
    root: '.',
    publicDir: 'public',
    // H691: GitHub Pages serves the bundle under
    // https://<user>.github.io/Racing-Game-2/, so the production
    // build emits asset URLs relative to that subpath. Dev (Vite
    // server) keeps the root '/' so localhost / LAN URLs still work
    // verbatim. CI sets mode=production via `vite build`.
    base: isProd ? '/Racing-Game-2/' : '/',
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url))
      }
    },
    define: {
      __DEV__: JSON.stringify(!isProd),
      __BUILD_ID__: JSON.stringify(BUILD_ID)
    },
    esbuild: {
      pure: isProd ? ['console.log', 'console.info', 'console.debug'] : []
    },
    build: {
      outDir: 'dist',
      target: 'es2022',
      sourcemap: true,
      assetsInlineLimit: 0,
      // H1224: second page — the engine-audio ear-test bench. Unlinked
      // from the game shell; reachable at /audiolab.html on Pages/dev.
      rollupOptions: {
        input: {
          main: fileURLToPath(new URL('./index.html', import.meta.url)),
          audiolab: fileURLToPath(new URL('./audiolab.html', import.meta.url))
        }
      }
    },
    server: {
      host: true,
      // When launched by `tauri dev` (TAURI_DEV=1), bind a fixed port that
      // matches tauri.conf.json `devUrl` and fail loudly if it's taken, and
      // don't auto-open a browser tab (the native window is the target).
      // Plain `npm run dev` keeps its original behavior: default port with
      // auto-increment and browser auto-open.
      open: !process.env.TAURI_DEV,
      port: process.env.TAURI_DEV ? 5180 : undefined,
      strictPort: !!process.env.TAURI_DEV
    }
  };
});
