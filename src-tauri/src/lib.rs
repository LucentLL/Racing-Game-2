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
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
