/**
 * Build-time constants injected via Vite's `define` in vite.config.ts.
 *
 * `__DEV__` is `true` in `vite dev` / `vite preview` and `false` in
 * `vite build --mode production` (the default for `npm run build`).
 * Blocks gated on `if (__DEV__)` get dead-code-eliminated from the
 * production bundle, so diagnostic state, perf overlays, debug
 * keybindings, and verbose logging cost zero bytes in shipped builds.
 *
 * F36 convention: gate dev-only side effects with `if (__DEV__)`. For
 * pure expressions where the result feeds back into the program, use a
 * ternary (`const x = __DEV__ ? expensive() : cheap()`); the minifier
 * folds the conditional at build time.
 */
declare const __DEV__: boolean;

/** H959: git short SHA of the build, injected by vite (`define`). Shown in the
 *  editor status bar as "build <sha>" so a stale cached bundle is obvious. */
declare const __BUILD_ID__: string;
