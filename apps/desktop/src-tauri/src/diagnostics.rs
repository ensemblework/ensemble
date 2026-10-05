//! A text bundle of versions and log tails. Tokens and personal API keys are stripped.

use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

pub fn redact(text: &str, secrets: &[&str]) -> String {
    let mut out = text.to_string();
    for secret in secrets {
        if secret.len() >= 8 {
            out = out.replace(secret, "[redacted]");
        }
    }
    let mut cleaned = String::with_capacity(out.len());
    let mut rest = out.as_str();
    while let Some(index) = rest.find("ens_") {
        cleaned.push_str(&rest[..index]);
        cleaned.push_str("[redacted]");
        rest = &rest[index + 4..];
        let end = rest
            .find(|ch: char| !(ch.is_ascii_alphanumeric() || ch == '_' || ch == '-'))
            .unwrap_or(rest.len());
        rest = &rest[end..];
    }
    cleaned.push_str(rest);
    cleaned
}

pub fn write_report(dir: &Path, body: &str) -> Result<std::path::PathBuf, String> {
    fs::create_dir_all(dir).map_err(|error| error.to_string())?;
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let path = dir.join(format!("ensemble-diagnostics-{stamp}.txt"));
    fs::write(&path, body).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_the_launch_token_and_personal_keys() {
        let text = redact(
            "token=abcdef0123456789 and ens_live_key-1 and port=4000",
            &["abcdef0123456789"],
        );
        assert!(!text.contains("abcdef0123456789"));
        assert!(!text.contains("ens_live_key"));
        assert!(text.contains("port=4000"));
        assert!(text.contains("[redacted]"));
    }
}
