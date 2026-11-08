//! How this computer uses Ensemble: `mode.json` in the data folder, written by the local runtime
//! (hub-api `src/desktop/mode.ts`) and read here to pick the first screen.
//!
//! `local`: the bundled Hub on this computer only. `account`: the person's Ensemble account in the
//! window, with this computer paired for tasks. No file yet: the first-run choice.

use std::path::Path;

use serde::Serialize;
use url::Url;

/// Where a local-only app looks for updates: the GitHub release marked latest, which is the newest
/// desktop release. No Ensemble server is asked.
pub const LOCAL_UPDATES_URL: &str = "https://github.com/ensemblework/ensemble/releases/latest/download/latest.json";

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    #[default]
    Unset,
    Local,
    Account,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ModeFile {
    pub mode: Mode,
    /// The account's web app origin, for `account`.
    pub app_url: Option<Url>,
}

pub fn read(data_dir: &Path) -> ModeFile {
    std::fs::read_to_string(data_dir.join("mode.json"))
        .ok()
        .map(|text| parse(&text))
        .unwrap_or_default()
}

pub fn parse(text: &str) -> ModeFile {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
        return ModeFile::default();
    };
    let mode = match value.get("mode").and_then(|mode| mode.as_str()) {
        Some("local") => Mode::Local,
        Some("account") => Mode::Account,
        _ => Mode::Unset,
    };
    let app_url = value
        .get("appUrl")
        .and_then(|url| url.as_str())
        .and_then(account_origin);
    ModeFile { mode, app_url }
}

/// An account web app origin: https, or http on loopback for a developer's own server.
pub fn account_origin(raw: &str) -> Option<Url> {
    let url = Url::parse(raw.trim()).ok()?;
    let host = url.host_str()?.to_string();
    let loopback = host == "127.0.0.1" || host == "localhost";
    if !(url.scheme() == "https" || (url.scheme() == "http" && loopback)) {
        return None;
    }
    if !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    Url::parse(&url.origin().ascii_serialization()).ok()
}

/// True when `target` is on the account's web app (the window may open it).
pub fn same_origin(target: &Url, app: &Url) -> bool {
    target.origin() == app.origin()
}

/// The page the browser approves a sign-in on: the account's `/link` page, or its API's.
pub fn is_sign_in_page(target: &Url) -> bool {
    let secure = target.scheme() == "https"
        || (target.scheme() == "http" && matches!(target.host_str(), Some("127.0.0.1") | Some("localhost")));
    secure && target.path() == "/link" && target.username().is_empty() && target.password().is_none()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_each_mode_and_ignores_the_rest() {
        assert_eq!(parse(r#"{"mode":"local"}"#).mode, Mode::Local);
        let account = parse(r#"{"mode":"account","appUrl":"https://app.ensemblework.com/today"}"#);
        assert_eq!(account.mode, Mode::Account);
        assert_eq!(account.app_url.unwrap().as_str(), "https://app.ensemblework.com/");
        assert_eq!(parse(r#"{"mode":"cloud"}"#).mode, Mode::Unset);
        assert_eq!(parse("not json"), ModeFile::default());
    }

    #[test]
    fn an_account_address_is_https_or_loopback() {
        assert!(account_origin("http://app.example.com").is_none());
        assert!(account_origin("https://user:pw@app.example.com").is_none());
        assert!(account_origin("javascript:alert(1)").is_none());
        assert_eq!(account_origin("http://localhost:3000/x").unwrap().as_str(), "http://localhost:3000/");
    }

    #[test]
    fn only_the_link_page_opens_for_sign_in() {
        assert!(is_sign_in_page(&Url::parse("https://app.ensemblework.com/link?code=ABCD-EFGH").unwrap()));
        assert!(!is_sign_in_page(&Url::parse("https://app.ensemblework.com/settings").unwrap()));
        assert!(!is_sign_in_page(&Url::parse("http://evil.example/link").unwrap()));
        assert!(!is_sign_in_page(&Url::parse("file:///link").unwrap()));
    }
}
