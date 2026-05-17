// Driver City — Tauri shared library entry.
//
// Tauri 2.x's mobile + desktop pipelines share this lib; main.rs
// calls `run()` for the desktop binary, and the mobile entry
// (generated when Tauri Mobile is added) does the same. Keeping
// the actual app construction in lib.rs is the standard 2.x
// pattern.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // H228: register the dialog + fs plugins so the JS-side
        // src/platform/desktop.ts can invoke `plugin:dialog|save`,
        // `plugin:dialog|open`, `plugin:fs|write_text_file`, and
        // `plugin:fs|read_text_file`. Default scope of fs allows
        // user-selected paths only (no auto-write to arbitrary
        // locations); the user picks the file in the dialog and
        // that path becomes the only allowed write target.
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
