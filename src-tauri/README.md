# src-tauri — Driver City desktop shell

The Tauri 2.x wrapper that bundles the Vite-built web app into a
native Windows / macOS / Linux binary for Steam distribution.

## Prerequisites

1. **Rust toolchain** — install via [rustup](https://rustup.rs/).
   Tauri 2.x targets the stable channel; `rustup default stable`.
2. **System dependencies** — see the
   [Tauri 2.x prerequisites guide](https://tauri.app/start/prerequisites/)
   for your OS (Windows: WebView2 + Microsoft C++ Build Tools;
   macOS: Xcode CLI tools; Linux: webkit2gtk + a handful of libs).
3. **Tauri CLI**:

   ```sh
   npm install -D @tauri-apps/cli
   ```

   (Listed as a `devDependency` in package.json; `npm install` at
   the repo root picks it up.)

## Workflow

```sh
# Dev mode — opens a native window pointed at vite dev server.
# Hot-reloads on src/ changes.
npm run tauri:dev

# Production build — bundles the dist/ output into a native
# installer in src-tauri/target/release/bundle/.
npm run tauri:build
```

## What's in the box

| File              | Purpose                                              |
|-------------------|------------------------------------------------------|
| `tauri.conf.json` | Window size, app metadata, dev/build hook config     |
| `Cargo.toml`      | Rust crate manifest                                  |
| `src/main.rs`     | Binary entry point (calls into lib)                  |
| `src/lib.rs`      | Tauri Builder + mobile entry point                   |
| `build.rs`        | Standard Tauri build script                          |

## What's NOT yet here

- App icons (TODO — Tauri expects `icons/32x32.png`,
  `icons/128x128.png`, `icons/icon.icns`, `icons/icon.ico` under
  `src-tauri/`). Run `npm run tauri icon path/to/source.png` once
  artwork lands.
- Save-file import/export bridge (H228 planned).
- Gamepad rumble parity (H229 planned).
- Steam-specific config (Steam Input passes through Tauri without
  extra wiring per the migration plan).
