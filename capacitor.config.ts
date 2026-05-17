/**
 * Capacitor 7.x configuration for Driver City Android (and future
 * iOS) builds. Wraps the Vite-built `dist/` into a native shell
 * with access to mobile-specific plugins (Haptics, Splash Screen,
 * App lifecycle, In-App Review).
 *
 * Phase G plan (per MIGRATION_PLAN.md L418-L420):
 *   H230 (this file): scaffold-only — defines the config the
 *                     `npx cap add android` step will read.
 *   H231 (planned):   Capacitor Haptics wiring (mobile mirror of
 *                     H229 web Gamepad rumble).
 *   H232 (planned):   in-app review prompt via @capacitor-community/
 *                     in-app-review (Google Play Review API).
 *
 * After running `npm install` to pick up the new devDeps, the
 * developer runs:
 *   npx cap add android       # generates android/ project
 *   npm run cap:build         # vite build → dist/
 *   npx cap sync              # copies dist/ into android/ assets
 *   npx cap open android      # launches Android Studio
 *
 * Subsequent edits: `npm run cap:build && npx cap sync` after each
 * frontend change to refresh the bundled webview content.
 */

import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  // Identifier shared with the Tauri shell so Play Store + Steam
  // listings reference the same package id.
  appId: 'com.lucentll.drivercity',
  appName: 'Driver City',
  // The Vite production build output — relative to the repo root.
  // `npm run cap:build` is wired in package.json to run
  // `vite build` first; `npx cap sync` then copies dist/ into
  // android/app/src/main/assets/public/.
  webDir: 'dist',
  // Capacitor 7+: bundled runtime is the default. Setting false
  // means the webview loads JS from webDir; no extra script
  // injection.
  bundledWebRuntime: false,

  server: {
    // 'https' allows cookies / localStorage to behave the same on
    // device as on the web build. Mixed-content blocking is on so
    // the bundled HTTPS shell can't load HTTP assets (we don't
    // need any — every asset is local / public/).
    androidScheme: 'https',
  },

  android: {
    // We don't load remote HTTP content. Block it explicitly so
    // any accidental http:// asset URL fails loudly in dev.
    allowMixedContent: false,
    // Touch-up the background while the webview boots so the
    // first frame isn't a flash of white between splash and game.
    backgroundColor: '#000000',
  },

  plugins: {
    // Splash + status bar are planned follow-ups. Keep the
    // sections in place so the H231/H232 commits just slot
    // their config in without restructuring this file.
    SplashScreen: {
      // launchShowDuration kept short — the splash is a brand
      // moment, not a content gate. Tune when artwork lands.
      launchShowDuration: 800,
      launchAutoHide: true,
      backgroundColor: '#000000',
      androidSplashResourceName: 'splash',
    },
  },
};

export default config;
