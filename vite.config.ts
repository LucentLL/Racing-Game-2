import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

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
      __DEV__: JSON.stringify(!isProd)
    },
    esbuild: {
      pure: isProd ? ['console.log', 'console.info', 'console.debug'] : []
    },
    build: {
      outDir: 'dist',
      target: 'es2022',
      sourcemap: true,
      assetsInlineLimit: 0
    },
    server: {
      host: true,
      open: true,
      strictPort: false
    }
  };
});
