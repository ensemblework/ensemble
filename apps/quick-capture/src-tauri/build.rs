fn main() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../release.json");
    println!("cargo:rerun-if-changed={}", path.display());
    let release: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).expect("release.json")).expect("release version");
    let version = release["version"].as_str().expect("release version");
    assert_eq!(version, env!("CARGO_PKG_VERSION"), "Synchronize release versions before building");
    println!("cargo:rustc-env=ENSEMBLE_VERSION={version}");
    tauri_build::build()
}
