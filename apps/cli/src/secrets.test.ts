import assert from "node:assert/strict";
import test from "node:test";
import { formatKey, formatSecrets, modeLine } from "./secrets.js";

test("the list says how each secret is used, and labels `all` as compatibility mode", () => {
  const text = formatSecrets(
    [
      { name: "STRIPE_KEY", updatedAt: "2026-11-17T10:00:00.000Z", allow: ["https://api.stripe.com"] },
      { name: "NPM_TOKEN", updatedAt: "2026-11-16T10:00:00.000Z", allow: [] },
    ],
    "all",
  );
  assert.match(text, /STRIPE_KEY {2}2026-11-17 {2}by reference only, to https:\/\/api\.stripe\.com/);
  assert.match(text, /NPM_TOKEN {3}2026-11-16 {2}in run environments \(\$NAME\)/);
  assert.match(text, /Mode: all \(compatibility mode\)\. .*a program it runs can read them/);
  assert.match(modeLine("named", "ensemble-test"), /Mode: named\. A run gets only the secrets its run profile, task or node step names\. Back to compatibility mode: `ensemble-test secrets mode all`/);
  assert.match(formatSecrets([], "named"), /^No secrets on this computer\.[\s\S]*Mode: named/);
});

test("the fingerprint is shown as the web shows it, or why there is none", () => {
  assert.match(formatKey({ paired: true, sealKey: { kid: "7f985267e5fd5a05", fingerprint: "7F98 5267 E5FD 5A05" }, createdAt: "2026-11-17T10:00:00.000Z" }), /^Fingerprint 7F98 5267 E5FD 5A05\n.*same fingerprint\.\nMade 2026-11-17; a new pairing makes a new key\.$/s);
  assert.match(formatKey({ paired: false, sealKey: null, createdAt: null }, "ensemble-test"), /not paired.*`ensemble-test login`/);
  assert.match(formatKey({ paired: true, sealKey: null, createdAt: null }), /no key for encrypted secrets yet/);
});
