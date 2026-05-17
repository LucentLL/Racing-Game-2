// Driver City — Tauri desktop entry point.
//
// This is the absolute minimum Rust needed to launch a Tauri window
// pointing at the Vite-built frontend. No native bridges, no
// state — those land in H228+ commits as needed. The
// `windows_subsystem = "windows"` attribute hides the console
// window in release builds on Windows.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    driver_city_lib::run()
}
