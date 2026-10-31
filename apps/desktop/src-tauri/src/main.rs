// Prevents an additional console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if std::env::args().any(|a| a == "--dump-sessions") {
        if let Err(e) = navarch_lib::dump_sessions() {
            eprintln!("navarch: {e}");
            std::process::exit(1);
        }
        return;
    }
    navarch_lib::run()
}
