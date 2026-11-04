fn main() {
    for variable in [
        "FILEX_UPDATER_PUBLIC_KEY",
        "FILEX_UPDATER_STABLE_ENDPOINT",
        "FILEX_UPDATER_BETA_ENDPOINT",
    ] {
        println!("cargo:rerun-if-env-changed={variable}");
    }
    tauri_build::build()
}
