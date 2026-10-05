//! Global capture chord. The bytes come from `packages/shared-types/src/capture-chord.json`.
//! Command (`mod`) becomes the platform Command key only on macOS. Windows and Linux
//! never receive the Super / Windows key.

use serde::Deserialize;
use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut};

const CHORD_JSON: &str = include_str!("../../../../packages/shared-types/src/capture-chord.json");

#[derive(Debug, Deserialize)]
struct ChordFile {
    key: String,
    darwin: Vec<String>,
    other: Vec<String>,
}

fn file() -> ChordFile {
    serde_json::from_str(CHORD_JSON).expect("capture-chord.json is valid")
}

fn is_mac(os: &str) -> bool {
    os == "macos" || os == "darwin"
}

fn tokens_for(os: &str) -> Vec<String> {
    let chord = file();
    if is_mac(os) {
        chord.darwin
    } else {
        chord.other
    }
}

pub fn modifiers_for(os: &str) -> Result<Modifiers, String> {
    let mac = is_mac(os);
    let mut mods = Modifiers::empty();
    for token in tokens_for(os) {
        match token.as_str() {
            "shift" => mods |= Modifiers::SHIFT,
            "ctrl" => mods |= Modifiers::CONTROL,
            "alt" => mods |= Modifiers::ALT,
            "mod" if mac => mods |= Modifiers::SUPER,
            "mod" => {
                return Err("mod means Command and is only valid on macOS. Windows and Linux list ctrl explicitly.".into());
            }
            "meta" | "super" => {
                return Err("The Super key is reserved and is not a Ensemble shortcut.".into());
            }
            other => return Err(format!("Unknown modifier {other} in capture-chord.json")),
        }
    }
    if mods.is_empty() {
        return Err("capture-chord.json needs at least one modifier".into());
    }
    Ok(mods)
}

fn key_code(key: &str) -> Result<Code, String> {
    match key {
        "a" => Ok(Code::KeyA),
        "b" => Ok(Code::KeyB),
        "c" => Ok(Code::KeyC),
        "d" => Ok(Code::KeyD),
        "e" => Ok(Code::KeyE),
        "f" => Ok(Code::KeyF),
        "g" => Ok(Code::KeyG),
        "h" => Ok(Code::KeyH),
        "i" => Ok(Code::KeyI),
        "j" => Ok(Code::KeyJ),
        "k" => Ok(Code::KeyK),
        "l" => Ok(Code::KeyL),
        "m" => Ok(Code::KeyM),
        "n" => Ok(Code::KeyN),
        "o" => Ok(Code::KeyO),
        "p" => Ok(Code::KeyP),
        "q" => Ok(Code::KeyQ),
        "r" => Ok(Code::KeyR),
        "s" => Ok(Code::KeyS),
        "t" => Ok(Code::KeyT),
        "u" => Ok(Code::KeyU),
        "v" => Ok(Code::KeyV),
        "w" => Ok(Code::KeyW),
        "x" => Ok(Code::KeyX),
        "y" => Ok(Code::KeyY),
        "z" => Ok(Code::KeyZ),
        other => Err(format!("capture-chord.json key {other:?} is not a letter")),
    }
}

pub fn capture_shortcut(os: &str) -> Result<Shortcut, String> {
    let chord = file();
    Ok(Shortcut::new(Some(modifiers_for(os)?), key_code(&chord.key)?))
}

pub fn chord_label(os: &str) -> String {
    let mac = is_mac(os);
    let tokens = tokens_for(os);
    let parts: Vec<&str> = tokens
        .iter()
        .map(|token| match token.as_str() {
            "mod" if mac => "Command",
            "mod" => "Ctrl",
            "ctrl" if mac => "Control",
            "ctrl" => "Ctrl",
            "alt" if mac => "Option",
            "alt" => "Alt",
            "shift" => "Shift",
            other => other,
        })
        .collect();
    let key = file().key.to_uppercase();
    if mac {
        format!("{}-{key}", parts.join("-"))
    } else {
        format!("{}+{key}", parts.join("+"))
    }
}

pub fn config_file(dir: &std::path::Path) -> std::path::PathBuf {
    dir.join("capture.json")
}

pub fn capture_endpoint(api: &str) -> Result<String, String> {
    let base = api.trim().trim_end_matches('/');
    if !(base.starts_with("http://") || base.starts_with("https://")) {
        return Err("The Hub address must start with http:// or https://.".into());
    }
    Ok(format!("{base}/api/capture"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn macos_is_command_control_shift_u() {
        let mods = modifiers_for("macos").unwrap();
        assert!(mods.contains(Modifiers::SUPER));
        assert!(mods.contains(Modifiers::CONTROL));
        assert!(mods.contains(Modifiers::SHIFT));
        assert!(!mods.contains(Modifiers::ALT));
        assert_eq!(chord_label("darwin"), "Command-Control-Shift-U");
        assert!(capture_shortcut("macos").is_ok());
    }

    #[test]
    fn windows_and_linux_never_use_super() {
        for os in ["windows", "linux"] {
            let mods = modifiers_for(os).unwrap();
            assert!(!mods.contains(Modifiers::SUPER), "{os}");
            assert!(mods.contains(Modifiers::CONTROL));
            assert!(mods.contains(Modifiers::ALT));
            assert!(mods.contains(Modifiers::SHIFT));
            assert_eq!(chord_label(os), "Ctrl+Alt+Shift+U");
        }
    }

    #[test]
    fn config_path_uses_the_platform_join() {
        let path = config_file(std::path::Path::new("config-dir"));
        assert_eq!(path.file_name().and_then(|name| name.to_str()), Some("capture.json"));
        assert!(capture_endpoint("http://127.0.0.1:4000/").unwrap().ends_with("/api/capture"));
        assert!(capture_endpoint("ftp://files").is_err());
    }
}
