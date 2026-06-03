// notesci desktop — entry point.
//
// Tauri 2 convention: keep main.rs minimal and put the actual app
// wiring in lib.rs::run(). That way the bulk of the app logic is in a
// library crate and can be exercised from tests / external callers
// (e.g. a future macOS bundle that calls notesci_lib::run() directly).

// Hide the console window on Windows so end users only see the GUI.
#![cfg_attr(windows, windows_subsystem = "windows")]

fn main() {
    notesci_lib::run();
}
