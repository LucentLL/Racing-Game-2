# Capacitor mobile build — Driver City

Capacitor 7.x wraps the Vite-built `dist/` into a real Android
APK / AAB for Google Play distribution (and later iOS, when an
Apple Developer account lands).

## Prerequisites

- **Android Studio** (Hedgehog 2023.1.1 or newer)
- **JDK 17** (Capacitor 7 requires it — older JDKs fail at
  Gradle sync)
- **Android SDK** API 35+ (set `ANDROID_HOME` env var)
- **Node 18+** (Capacitor CLI requires it)

The Tauri toolchain (rustup + system deps) is NOT required for
the mobile build — those are independent ports of the same web
app. See `src-tauri/README.md` for the desktop side.

## First-time setup

```sh
# 1. Install JS deps (picks up @capacitor/* from package.json).
npm install

# 2. Generate the android/ project. Reads capacitor.config.ts.
npx cap add android

# 3. Build the web app + copy into android/.
npm run cap:build

# 4. Launch Android Studio with the generated project.
npm run cap:open:android
```

From Android Studio, hit Run to deploy to a connected device /
emulator. The first Gradle sync is slow (5-10 min); subsequent
incremental builds are fast.

## Workflow after frontend changes

```sh
# Re-vite-build + sync dist/ into android/.
npm run cap:build
```

`cap:build` runs `vite build && cap sync` — the typed build
catches errors before the slow Gradle step kicks off.

For pure native (Gradle / Java) edits, just hit Run in Android
Studio — no `cap:build` needed.

## Plugin notes

`capacitor.config.ts` reserves a `plugins.SplashScreen` block.
Add others (Haptics for H231, In-App Review for H232) by:

1. `npm install @capacitor/<plugin-name>`
2. Add a `plugins.<PluginName>` block to `capacitor.config.ts`
3. Re-run `npx cap sync`

## What's NOT yet here

- Splash + adaptive icons (the SplashScreen plugin reads
  `android/app/src/main/res/drawable/splash.png` — drop artwork
  when it lands).
- Haptics (H231 planned — mobile mirror of H229 rumble strips
  via `@capacitor/haptics`).
- In-App Review (H232 planned — Google Play Review API via
  `@capacitor-community/in-app-review`).
- iOS project (`npx cap add ios` once Apple Dev account is
  signed up).
