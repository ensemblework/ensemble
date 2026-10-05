import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { DESKTOP_WEBVIEW_ORIGINS } from "./desktop-guard.js";
import { TERMINAL_DESKTOP_REFUSAL, humanOnlyRefusal, notLocalhostRefusal } from "./terminal-human.js";

// What origins() in routes/terminal.ts returns for the default HUB_WEB_ORIGIN (also the desktop sidecar's).
const WEB = ["http://localhost:3000", "http://localhost:3000"];
const NOT_THE_PAGE = "The terminal only accepts requests from the Ensemble page itself.";
const TOKENS_REFUSED = "The terminal only opens from a signed-in browser. Tokens and agents are refused.";

test("the desktop token from the desktop app's own window is refused, with a message that says why", () => {
  for (const origin of DESKTOP_WEBVIEW_ORIGINS) {
    for (const authVia of ["desktop", "session"]) {
      assert.equal(humanOnlyRefusal({ authVia, origin, webOrigins: WEB }), TERMINAL_DESKTOP_REFUSAL, `${authVia} ${origin}`);
    }
  }
});

test("lookalike webview origins and missing origins keep the old refusal", () => {
  for (const origin of [undefined, "", "null", "ensemble://localhost.evil.com", "tauri://localhost:1", "TAURI://localhost", "https://evil.example", "http://127.0.0.1:3000"]) {
    assert.equal(humanOnlyRefusal({ authVia: "desktop", origin, webOrigins: WEB }), NOT_THE_PAGE, String(origin));
  }
});

test("tokens, agents and internal calls are refused before the origin is looked at", () => {
  for (const authVia of ["token", "internal", "bypass", undefined]) {
    for (const origin of ["http://localhost:3000", ...DESKTOP_WEBVIEW_ORIGINS]) {
      assert.equal(humanOnlyRefusal({ authVia, origin, webOrigins: WEB }), TOKENS_REFUSED, `${authVia} ${origin}`);
    }
  }
});

test("the browser page on localhost still gets through to the passkey checks, and a raw IP is still told to use localhost", () => {
  assert.equal(humanOnlyRefusal({ authVia: "session", origin: "http://localhost:3000", webOrigins: WEB }), null);
  // Unchanged from before: humanOnly does not tell a real tab from a faked Origin header. The passkey is the human check.
  assert.equal(humanOnlyRefusal({ authVia: "desktop", origin: "http://localhost:3000", webOrigins: WEB }), null);
  const ipWeb = ["http://127.0.0.1:3000", "http://localhost:3000"];
  assert.match(humanOnlyRefusal({ authVia: "session", origin: "http://127.0.0.1:3000", webOrigins: ipWeb }) ?? "", /Open Ensemble at http:\/\/localhost/);
});

test("only the wording is new: the allow/refuse decision still follows the web-origin list exactly as before", () => {
  // Before this change, an origin was allowed only if it was in origins(); that is still the only way through.
  // (tauri://localhost has hostname "localhost", so this also pins that no webview origin is special-cased in.)
  assert.equal(humanOnlyRefusal({ authVia: "desktop", origin: "tauri://localhost", webOrigins: WEB }), TERMINAL_DESKTOP_REFUSAL);
  assert.equal(humanOnlyRefusal({ authVia: "desktop", origin: "tauri://localhost", webOrigins: ["tauri://localhost"] }), null);
});

test("a hosted deployment's own https page is still refused: the terminal unlocks only from localhost", () => {
  // origins() for HUB_WEB_ORIGIN=https://app.ensemblework.com. The page is on the list, but the hostname rule still refuses it,
  // so the hosted web app must not offer the passkey set-up (hub-web terminal-address.ts says so instead).
  const hosted = ["https://app.ensemblework.com", "https://app.ensemblework.com"];
  for (const authVia of ["session", "desktop"]) {
    assert.notEqual(humanOnlyRefusal({ authVia, origin: "https://app.ensemblework.com", webOrigins: hosted }), null, authVia);
  }
});

test("the hosted refusal names the right problem: a domain is not called an IP address", () => {
  // Each case is origins() for that HUB_WEB_ORIGIN, with the page calling from its own address.
  const refusal = (origin: string) => humanOnlyRefusal({ authVia: "session", origin, webOrigins: [origin, origin.replace("127.0.0.1", "localhost")] }) ?? "";

  const hosted = refusal("https://app.ensemblework.com");
  assert.equal(
    hosted,
    "The terminal is not available at app.ensemblework.com yet. It opens only on the computer running Ensemble, at its localhost address, where Touch ID can unlock it.",
  );
  assert.doesNotMatch(hosted, /IP address/);
  assert.doesNotMatch(refusal("http://ensemble.lan:3000"), /IP address/);

  // 127.0.0.1 points at localhost on the same port and scheme, never a hard-coded :3000.
  assert.equal(
    refusal("http://127.0.0.1:3100"),
    "Passkeys need a named, secure address and do not work on an IP address. Open Ensemble at http://localhost:3100 to use the terminal.",
  );
  assert.match(refusal("https://127.0.0.1:8443"), /Open Ensemble at https:\/\/localhost:8443 to use/);
  assert.match(refusal("http://[::1]:5173"), /Open Ensemble at http:\/\/localhost:5173 to use/);

  // A LAN or public IP: passkeys cannot work there, and there is no localhost URL to offer from another machine.
  for (const origin of ["http://192.168.1.20:3000", "https://20.40.60.80", "http://[fe80::1]:3000"]) {
    const message = refusal(origin);
    assert.match(message, /do not work on an IP address/, origin);
    assert.match(message, /only on the computer running Ensemble/, origin);
    assert.doesNotMatch(message, /https?:\/\/localhost/, origin);
  }
});

test("the server's wording matches what hub-web's terminal-address.ts shows for the same address", async () => {
  // terminal-address.ts has no imports, so it loads here as-is. Kept as a runtime import so hub-api's typecheck stays inside src/.
  const file = fileURLToPath(new URL("../../../hub-web/components/code/terminal-address.ts", import.meta.url));
  const web = (await import(pathToFileURL(file).href)) as {
    terminalAccess: (address: { protocol: string; hostname: string; port: string }, secure?: boolean) => { ok: boolean; message?: string };
  };
  for (const url of [
    "https://app.ensemblework.com/",
    "http://ensemble.lan:3000/",
    "http://127.0.0.1:3100/",
    "https://127.0.0.1:8443/",
    "http://[::1]:5173/",
    "http://192.168.1.20:3000/",
    "https://20.40.60.80/",
    "http://[fe80::1]:3000/",
  ]) {
    const { protocol, hostname, port } = new URL(url);
    const client = web.terminalAccess({ protocol, hostname, port });
    assert.equal(client.ok, false, url);
    assert.equal(notLocalhostRefusal({ protocol, hostname, port }), client.message, url);
  }
});
