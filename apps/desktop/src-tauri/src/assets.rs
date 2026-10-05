//! Serves the static export of hub-web on the `ensemble` custom protocol.
//!
//! Dynamic routes are one placeholder file (`tasks/_/index.html`). A request
//! for `/tasks/abc` uses that file. The page then reads the real id from the
//! address bar. Unknown documents fall through to the in-shell 404.

use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};

use tauri::http::{header, Response};

// PathBuf::new is not a stable const fn, so the root is created on first use.
static WEB_ROOT: LazyLock<Mutex<PathBuf>> = LazyLock::new(|| Mutex::new(PathBuf::new()));

pub fn set_web_root(path: PathBuf) {
    if let Ok(mut guard) = WEB_ROOT.lock() {
        *guard = path;
    }
}

pub fn web_root() -> PathBuf {
    WEB_ROOT.lock().map(|guard| guard.clone()).unwrap_or_default()
}

pub fn respond(request_path: &str) -> Response<Vec<u8>> {
    let root = web_root();
    match resolve(&root, request_path) {
        Some(path) => file_response(&path),
        None => html(404, b"This page is not in the Ensemble desktop bundle.".to_vec()),
    }
}

fn resolve(root: &Path, request_path: &str) -> Option<PathBuf> {
    if root.as_os_str().is_empty() || !root.is_dir() {
        return None;
    }
    let mut rel = request_path.trim_start_matches('/');
    if let Some(query) = rel.find(['?', '#']) {
        rel = &rel[..query];
    }
    let rel = percent_decode(rel);
    if rel.split(['/', '\\']).any(|part| part == "..") {
        return None;
    }
    let rel = if rel.is_empty() { "index.html".to_string() } else { rel };
    let direct = root.join(&rel);
    if direct.is_file() {
        return Some(direct);
    }
    let index = root.join(&rel).join("index.html");
    if index.is_file() {
        return Some(index);
    }
    let parts: Vec<&str> = rel.trim_end_matches('/').split('/').filter(|part| !part.is_empty()).collect();
    if parts.len() == 2 {
        let placeholder = root.join(parts[0]).join("_").join("index.html");
        if placeholder.is_file() {
            return Some(placeholder);
        }
    }
    if !rel.contains('.') {
        let lost = root.join("lost").join("index.html");
        if lost.is_file() {
            return Some(lost);
        }
    }
    None
}

fn file_response(path: &Path) -> Response<Vec<u8>> {
    match std::fs::read(path) {
        Ok(bytes) => {
            let mime = mime_of(path);
            Response::builder()
                .status(200)
                .header(header::CONTENT_TYPE, mime)
                .header(header::CACHE_CONTROL, cache_of(path))
                .body(bytes)
                .unwrap_or_else(|_| html(500, b"Could not build a response.".to_vec()))
        }
        Err(_) => html(404, b"Missing file.".to_vec()),
    }
}

fn html(status: u16, body: Vec<u8>) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
        .body(body)
        .expect("html response")
}

fn mime_of(path: &Path) -> &'static str {
    match path.extension().and_then(|ext| ext.to_str()) {
        Some("html") => "text/html; charset=utf-8",
        Some("js" | "mjs") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json" | "map") => "application/json",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("ico") => "image/x-icon",
        Some("woff2") => "font/woff2",
        Some("woff") => "font/woff",
        Some("txt") => "text/plain; charset=utf-8",
        Some("webmanifest") => "application/manifest+json",
        _ => "application/octet-stream",
    }
}

fn cache_of(path: &Path) -> &'static str {
    let text = path.to_string_lossy();
    if text.contains("_next/static/") {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    }
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(high), Some(low)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                out.push((high << 4) | low);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
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
    use std::fs;

    #[test]
    fn dynamic_routes_use_the_placeholder_and_reject_traversal() {
        let root = std::env::temp_dir().join(format!("ensemble-assets-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("tasks/_")).unwrap();
        fs::create_dir_all(root.join("lost")).unwrap();
        fs::write(root.join("index.html"), "home").unwrap();
        fs::write(root.join("tasks/_/index.html"), "task").unwrap();
        fs::write(root.join("lost/index.html"), "lost").unwrap();
        assert_eq!(resolve(&root, "/").unwrap(), root.join("index.html"));
        assert_eq!(resolve(&root, "/tasks/abc").unwrap(), root.join("tasks/_/index.html"));
        assert_eq!(resolve(&root, "/tasks/abc/").unwrap(), root.join("tasks/_/index.html"));
        assert_eq!(resolve(&root, "/no/such/page").unwrap(), root.join("lost/index.html"));
        assert!(resolve(&root, "/../secret").is_none());
        assert!(resolve(&root, "/tasks/a/b").is_none() || resolve(&root, "/tasks/a/b").unwrap() == root.join("lost/index.html"));
        let _ = fs::remove_dir_all(&root);
    }
}
