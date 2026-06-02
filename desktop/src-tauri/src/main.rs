// notesci desktop — entry point.
//
// Tauri 2 convention: keep main.rs minimal and put the actual app
// wiring in lib.rs::run(). That way the bulk of the app logic is in a
// library crate and can be exercised from tests / external callers
// (e.g. a future macOS bundle that calls notesci_lib::run() directly).

// On Windows, suppress the console window for the release build.
// Harmless on Linux/macOS.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    notesci_lib::run();
}
