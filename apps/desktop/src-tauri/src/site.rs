//! Server URL and navigation rules shared by desktop and future mobile shells.
//!
//! Nothing in this file opens a window, talks to a tray, or calls a desktop-only API.

use serde::Serialize;
use url::Url;

pub const DEFAULT_SITE_URL: &str = "http://localhost:3000";

/// localStorage key for appearance. Motion is the JSON field `motion`, not a separate key.
pub const MOTION_THEME_KEY: &str = "ensemble.appearance";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SiteSource {
    Environment,
    Saved,
    Build,
    Default,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResolvedSite {
    pub url: String,
    pub source: SiteSource,
    pub error: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NavDecision {
    /// Stay inside the Ensemble window. This is the configured site, or the local shell.
    Allow,
    /// Hand the URL to the system browser.
    OpenExternal,
    /// Drop the navigation. `javascript:`, `file:`, and other schemes never leave the app.
    Block,
}

/// Pick the URL the shell opens.
///
/// Runtime `ENSEMBLE_SITE_URL`, then the saved first-run value, then the value baked
/// in at compile time, then <http://localhost:3000>. An invalid value is skipped
/// unless it is the runtime variable: that one is kept on screen with an error so
/// a typo in the environment is visible.
pub fn resolve_site_url(
    env_value: Option<&str>,
    saved: Option<&str>,
    compiled: Option<&str>,
) -> ResolvedSite {
    if let Some(value) = nonempty(env_value) {
        return match parse_site_url(value) {
            Ok(_) => ResolvedSite {
                url: value.to_string(),
                source: SiteSource::Environment,
                error: None,
            },
            Err(message) => ResolvedSite {
                url: value.to_string(),
                source: SiteSource::Environment,
                error: Some(message),
            },
        };
    }
    for (value, source) in [(saved, SiteSource::Saved), (compiled, SiteSource::Build)] {
        if let Some(value) = nonempty(value) {
            if parse_site_url(value).is_ok() {
                return ResolvedSite {
                    url: value.to_string(),
                    source,
                    error: None,
                };
            }
        }
    }
    ResolvedSite {
        url: DEFAULT_SITE_URL.to_string(),
        source: SiteSource::Default,
        error: None,
    }
}

pub fn parse_site_url(raw: &str) -> Result<Url, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err("Enter the Ensemble server URL.".into());
    }
    let url = Url::parse(raw)
        .map_err(|_| "Use a full URL, for example http://localhost:3000.".to_string())?;
    match url.scheme() {
        "http" | "https" => {}
        _ => return Err("Only http and https servers are supported.".into()),
    }
    if url.host_str().is_none() {
        return Err("The URL needs a host, for example http://localhost:3000.".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Remove the username and password from the URL.".into());
    }
    Ok(url)
}

pub fn is_shell(url: &Url) -> bool {
    url.host_str() == Some("tauri.localhost")
        || url.host_str() == Some("asset.localhost")
        || url.host_str() == Some("ensemble.localhost")
        || matches!(url.scheme(), "tauri" | "asset" | "ensemble")
}

/// Where the packaged UI is served. Windows serves custom protocols as http.
pub fn local_app_url() -> Url {
    // `/` is a Next redirect, which a static export cannot finish. Open Today directly.
    if cfg!(windows) {
        Url::parse("http://ensemble.localhost/today/").expect("app origin")
    } else {
        Url::parse("ensemble://localhost/today/").expect("app origin")
    }
}

pub fn decide(target: &Url, site: &Url) -> NavDecision {
    if is_shell(target) || matches!(target.scheme(), "about" | "blob") {
        return NavDecision::Allow;
    }
    if matches!(target.scheme(), "http" | "https") && target.origin() == site.origin() {
        return NavDecision::Allow;
    }
    match target.scheme() {
        "http" | "https" | "mailto" | "tel" => NavDecision::OpenExternal,
        _ => NavDecision::Block,
    }
}

fn nonempty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

/// Accept only the three brand styles. Anything else is ignored so a page cannot
/// store an arbitrary string in the shell.
pub fn parse_motion_theme(raw: Option<&str>) -> Option<&'static str> {
    match raw.map(str::trim) {
        Some("expressive") => Some("expressive"),
        Some("minimal-quiet") => Some("minimal-quiet"),
        Some("minimal-dot") => Some("minimal-dot"),
        _ => None,
    }
}

/// `target="_blank"` on Linux WebKit does not raise the new-window handler.
/// A click is turned into `window.open`, which does, and the shell applies the
/// same in-app versus browser rule. The listener does not write storage.
pub fn blank_target_script() -> &'static str {
    r#"(function(){document.addEventListener("click",function(event){if(event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;var node=event.target;if(!node||!node.closest)return;var link=node.closest("a[href]");if(!link)return;if((link.getAttribute("target")||"").toLowerCase()!=="_blank")return;event.preventDefault();window.open(link.href,"_blank");},true);})();"#
}

/// Read-only probe. It parses `localStorage["ensemble.appearance"].motion` and
/// reports a known style. It does not write storage, including on the app origin.
pub fn motion_probe_script(report_prefix: &str) -> String {
    let key = serde_json::to_string(MOTION_THEME_KEY).expect("key");
    let prefix = serde_json::to_string(report_prefix).expect("prefix");
    format!(
        r#"(function(){{var key={key};var prefix={prefix};var allowed={{expressive:1,"minimal-quiet":1,"minimal-dot":1}};function report(){{var raw;try{{raw=localStorage.getItem(key);}}catch(e){{return;}}var motion;try{{motion=JSON.parse(raw).motion;}}catch(e){{return;}}if(!allowed[motion])return;var img=new Image();img.src=prefix+encodeURIComponent(motion)+"?t="+Date.now();}}report();setTimeout(report,1000);setInterval(report,3000);}})();"#
    )
}

/// Points the bundled UI at the local API. The launch token stays in this closure.
///
/// `fetch` accepts a string, a `URL` or a `Request`. Next's router passes a `URL`
/// for route data (`/board/index.txt?_rsc=…`), so the wrapper reads its `href`.
/// A request that is not for the API goes through with the caller's own input
/// and options, so a `Request` keeps its method, body and signal.
pub fn desktop_init_script(api_base: &str, token: &str) -> String {
    let api = serde_json::to_string(api_base).expect("api");
    let token = serde_json::to_string(token).expect("token");
    format!(
        r##"(function(){{var api={api};var token={token};window.__ENSEMBLE_DESKTOP__={{apiBase:api}};var baked=["http://127.0.0.1:4000","http://localhost:4000"];function rewrite(input){{if(typeof input!=="string")return input;if(input.indexOf("/api")===0||input==="/health"||input.indexOf("/health?")===0)return api+input;for(var i=0;i<baked.length;i++){{if(input.indexOf(baked[i])===0)return api+input.slice(baked[i].length);}}return input;}}function target(input){{if(typeof input==="string")return input;if(typeof URL!=="undefined"&&input instanceof URL)return input.href;if(input&&typeof input.url==="string")return input.url;return String(input);}}var orig=window.fetch;window.fetch=function(input,init){{var raw=target(input);var url=rewrite(raw);if(!api||(url===raw&&url.indexOf(api)!==0))return orig.call(this,input,init);var isRequest=typeof Request!=="undefined"&&input instanceof Request;var next=isRequest?new Request(url,input):url;var headers=new Headers((init&&init.headers)||(isRequest?next.headers:undefined));if(token&&!headers.has("Authorization"))headers.set("Authorization","Bearer "+token);var options=Object.assign({{}},init||{{}});options.headers=headers;return orig.call(this,next,options);}};var OrigES=window.EventSource;if(OrigES){{var Wrapped=function(url,opts){{return new OrigES(rewrite(String(url)),opts);}};Wrapped.prototype=OrigES.prototype;window.EventSource=Wrapped;}}var xhr=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(method,url){{var next=rewrite(String(url));this.__ensembleUrl=next;var args=[method,next];for(var i=2;i<arguments.length;i++)args.push(arguments[i]);return xhr.apply(this,args);}};var send=XMLHttpRequest.prototype.send;XMLHttpRequest.prototype.send=function(){{try{{if(this.__ensembleUrl&&String(this.__ensembleUrl).indexOf(api)===0&&token)this.setRequestHeader("Authorization","Bearer "+token);}}catch(e){{}}return send.apply(this,arguments);}};document.addEventListener("click",function(event){{if(event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;var node=event.target;if(!node||!node.closest)return;var link=node.closest("a[href]");if(!link)return;var href=link.getAttribute("href")||"";if(!href||href.indexOf("://")!==-1)return;var path=href.split("?")[0].split("#")[0];if(path.charAt(0)!=="/"||path.indexOf("/_next/")===0)return;event.preventDefault();location.assign(link.href);}},true);}})();"##
    )
}

/// `motion://localhost/minimal-quiet` on macOS and Linux, `http://motion.localhost/...` on Windows.
pub fn motion_report_prefix() -> &'static str {
    if cfg!(any(windows, target_os = "android")) {
        "http://motion.localhost/"
    } else {
        "motion://localhost/"
    }
}

pub fn theme_from_motion_path(path: &str) -> Option<&'static str> {
    let path = path.trim_start_matches('/');
    let name = path.split(['?', '#']).next().unwrap_or("");
    let name = percent_decode(name);
    parse_motion_theme(Some(&name))
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(h), Some(l)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                out.push((h << 4) | l);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_default()
}

fn hex(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(raw: &str) -> Url {
        Url::parse(raw).expect(raw)
    }

    #[test]
    fn defaults_to_local_dev_server() {
        let resolved = resolve_site_url(None, None, None);
        assert_eq!(resolved.url, DEFAULT_SITE_URL);
        assert_eq!(resolved.source, SiteSource::Default);
        assert!(resolved.error.is_none());
    }

    #[test]
    fn runtime_env_beats_saved_and_build() {
        let resolved = resolve_site_url(
            Some("https://hub.example.com"),
            Some("http://localhost:3000"),
            Some("https://build.example.com"),
        );
        assert_eq!(resolved.url, "https://hub.example.com");
        assert_eq!(resolved.source, SiteSource::Environment);
    }

    #[test]
    fn saved_beats_build_default() {
        let resolved = resolve_site_url(
            None,
            Some(" https://saved.example.com/app "),
            Some("https://build.example.com"),
        );
        assert_eq!(resolved.url, "https://saved.example.com/app");
        assert_eq!(resolved.source, SiteSource::Saved);
    }

    #[test]
    fn invalid_saved_url_falls_through() {
        let resolved = resolve_site_url(None, Some("not a url"), Some("https://build.example.com"));
        assert_eq!(resolved.source, SiteSource::Build);
        assert_eq!(resolved.url, "https://build.example.com");
    }

    #[test]
    fn invalid_runtime_env_is_shown() {
        let resolved =
            resolve_site_url(Some("localhost:3000"), Some("http://localhost:3000"), None);
        assert_eq!(resolved.source, SiteSource::Environment);
        assert!(resolved.error.is_some());
    }

    #[test]
    fn rejects_credentials_and_other_schemes() {
        assert!(parse_site_url("http://user:secret@localhost:3000").is_err());
        assert!(parse_site_url("javascript:alert(1)").is_err());
        assert!(parse_site_url("file:///etc/passwd").is_err());
    }

    #[test]
    fn in_app_paths_stay_and_other_origins_leave() {
        let site = url("http://localhost:3000");
        assert_eq!(
            decide(&url("http://localhost:3000/today"), &site),
            NavDecision::Allow
        );
        assert_eq!(
            decide(&url("http://localhost:3000/api/auth/me"), &site),
            NavDecision::Allow
        );
        assert_eq!(
            decide(&url("http://127.0.0.1:3000/"), &site),
            NavDecision::OpenExternal
        );
        assert_eq!(
            decide(&url("http://localhost:4000/health"), &site),
            NavDecision::OpenExternal
        );
        assert_eq!(
            decide(&url("https://localhost:3000/"), &site),
            NavDecision::OpenExternal
        );
        assert_eq!(
            decide(&url("https://github.com/ensemblework/ensemble"), &site),
            NavDecision::OpenExternal
        );
        assert_eq!(
            decide(&url("mailto:mira@fieldnote.dev"), &site),
            NavDecision::OpenExternal
        );
        assert_eq!(
            decide(&url("javascript:alert(1)"), &site),
            NavDecision::Block
        );
        assert_eq!(decide(&url("file:///tmp/x"), &site), NavDecision::Block);
        assert_eq!(
            decide(&url("http://tauri.localhost/"), &site),
            NavDecision::Allow
        );
        assert_eq!(
            decide(&url("https://tauri.localhost/index.html"), &site),
            NavDecision::Allow
        );
        assert_eq!(
            decide(&url("tauri://localhost/"), &site),
            NavDecision::Allow
        );
        assert_eq!(
            decide(&url("ensemble://localhost/today"), &site),
            NavDecision::Allow
        );
        assert_eq!(
            decide(&url("http://ensemble.localhost/tasks/abc"), &site),
            NavDecision::Allow
        );
        assert_eq!(decide(&url("about:blank"), &site), NavDecision::Allow);
    }

    #[test]
    fn motion_theme_is_a_closed_set() {
        assert_eq!(parse_motion_theme(Some(" expressive ")), Some("expressive"));
        assert_eq!(
            parse_motion_theme(Some("minimal-quiet")),
            Some("minimal-quiet")
        );
        assert_eq!(parse_motion_theme(Some("minimal-dot")), Some("minimal-dot"));
        assert_eq!(parse_motion_theme(Some("expressive;")), None);
        assert_eq!(parse_motion_theme(None), None);
        assert_eq!(parse_motion_theme(Some("")), None);
    }

    #[test]
    fn motion_probe_only_reads_the_one_key() {
        let script = motion_probe_script(motion_report_prefix());
        assert!(script.contains(MOTION_THEME_KEY));
        assert!(script.contains("JSON.parse"));
        assert!(script.contains(".motion"));
        assert!(!script.contains("ensemble:motion-theme"));
        assert!(script.contains("getItem"));
        assert!(!script.contains("setItem"));
        let init = desktop_init_script("http://127.0.0.1:54321", "token-value");
        assert!(init.contains("http://127.0.0.1:54321"));
        assert!(init.contains("__ENSEMBLE_DESKTOP__"));
        assert!(init.contains("location.assign"));
        assert!(!init.contains("tasks|projects"));
        assert!(!init.contains("setItem"));
        assert!(!script.contains("document.cookie"));
        let blanks = blank_target_script();
        assert!(blanks.contains("window.open"));
        assert!(blanks.contains("preventDefault"));
        assert!(!blanks.contains("setItem"));
        assert!(!blanks.contains("localStorage"));
        assert_eq!(theme_from_motion_path("/minimal-dot"), Some("minimal-dot"));
        assert_eq!(
            theme_from_motion_path("/minimal-dot?t=1"),
            Some("minimal-dot")
        );
        assert_eq!(theme_from_motion_path("/nope"), None);
        assert_eq!(theme_from_motion_path("/%2e%2e/expressive"), None);
    }
}
