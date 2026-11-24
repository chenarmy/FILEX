#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args = std::env::args().collect::<Vec<_>>();
    if args.iter().any(|arg| arg == "--mcp") {
        let code = filex_desktop_lib::run_mcp_stdio_bridge(&args);
        std::process::exit(code);
    }
    filex_desktop_lib::run();
}
