/**
 * The computer's credential pieces on their own (credentials/): which sites it takes encrypted values
 * from, how an answer by reference hides the value however it is encoded, that a box is taken once
 * (also after a restart), the allowed destinations a secret may have, and its sealing key on disk
 * (encrypted, 0600, checked when read, gone when the computer is unpaired).
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const dir = mkdtempSync(join(homedir(), ".ensemble-credentials-"));
process.env.ENSEMBLE_REMOTE_STATE_DIR = dir;
process.env.ENSEMBLE_SECRET_KEY = randomBytes(32).toString("base64");
process.env.DATABASE_URL ??= "postgresql://localhost/unused";
after(() => rmSync(dir, { recursive: true, force: true }));

const { siteOrigins, trustedOrigins } = await import("./origins.js");
const { hideValue } = await import("./secret-http.js");
const { takeOnce } = await import("./replay.js");
const { allowedOrigin, secretRules } = await import("../lib/run-secrets.js");
const { ensureSealKey, loadSealKey, makeSealKey, resetSealKeyCacheForTests, saveSealKey, sealKeyCapability, sealKeyPath } = await import("./seal-key.js");
const { SEAL_KEY_FILE } = await import("../remote/store.js");

test("a computer takes encrypted values only from the web's own sites for the server it is paired with", () => {
  assert.deepEqual(siteOrigins("https://api.ensemblework.com"), ["https://app.ensemblework.com", "https://node.ensemblework.com"]);
  assert.deepEqual(siteOrigins("https://api-test.ensemblework.com"), ["https://test.ensemblework.com", "https://node-test.ensemblework.com"]);
  assert.deepEqual(siteOrigins("https://api-staging.example.org"), ["https://staging.example.org", "https://node-staging.example.org"]);
  assert.deepEqual(siteOrigins("https://ensemble.example.org/api"), ["https://ensemble.example.org"], "a server that serves its own pages");
  assert.ok(siteOrigins("http://localhost:4000").includes("http://localhost:3300"));
  assert.deepEqual(siteOrigins(null), []);
  assert.deepEqual(trustedOrigins("https://api.ensemblework.com", { ENSEMBLE_SEAL_ORIGINS: "https://hub.example.org/, nonsense, ftp://x" }), ["https://app.ensemblework.com", "https://node.ensemblework.com", "https://hub.example.org"]);
});

test("an answer by reference hides the value as written and as an answer would echo it", () => {
  const value = "sk_live_51HxYzAbCdEfGh+/=Ij";
  const hidden = (text: string) => hideValue(text, value, "STRIPE_KEY");
  for (const prefix of ["", "x", "xy", "Bearer ", "user:"]) {
    for (const encoding of ["base64", "base64url"] as const) {
      const encoded = Buffer.from(`${prefix}${value}:tail`).toString(encoding);
      const out = hidden(`{"echo":"${encoded}"}`);
      assert.ok(!out.includes(Buffer.from(value).toString(encoding).slice(4, -4)), `${encoding} after ${JSON.stringify(prefix)}`);
      assert.match(out, /\[STRIPE_KEY\]/);
    }
  }
  assert.equal(hidden(`key=${encodeURIComponent(value)}&x=1`), "key=[STRIPE_KEY]&x=1");
  assert.equal(hidden(`hex ${Buffer.from(`a${value}`).toString("hex").toUpperCase()}`), "hex 61[STRIPE_KEY]");
  assert.equal(hidden(JSON.stringify({ quoted: `"${value}"` })), '{"quoted":"\\"[STRIPE_KEY]\\""}');
});

test("each box is taken once, also after a restart; a failed save lets the owner type it again", async () => {
  const box = (nonce: string) => ({ decisionId: "card-1", nonce, expiresAt: new Date(Date.now() + 600_000).toISOString() });
  await assert.rejects(takeOnce(box("n1"), async () => Promise.reject(new Error("disk full"))), /disk full/);
  await assert.rejects(takeOnce(box("n1"), async () => "saved"), /already used/, "the same box, even after a failure");
  assert.equal(await takeOnce(box("n2"), async () => "saved"), "saved", "a new box for the request after a failure");
  await assert.rejects(takeOnce(box("n3"), async () => "saved"), /already answered/);
  // Two copies at once: one wins.
  const both = await Promise.allSettled([takeOnce({ ...box("n4"), decisionId: "card-2" }, async () => "a"), takeOnce({ ...box("n4"), decisionId: "card-2" }, async () => "b")]);
  assert.deepEqual(both.map((row) => row.status).sort(), ["fulfilled", "rejected"]);
  // The set is on disk, so a restart remembers it.
  const seen = JSON.parse(readFileSync(join(dir, "seal-seen.json"), "utf8"));
  assert.ok(seen.decisions["card-1"] && seen.nonces.n1);
  if (process.platform !== "win32") assert.equal(statSync(join(dir, "seal-seen.json")).mode & 0o777, 0o600);
});

test("allowed destinations are exact https origins (http only on this computer)", () => {
  assert.deepEqual(allowedOrigin("https://api.stripe.com/"), { origin: "https://api.stripe.com" });
  assert.deepEqual(allowedOrigin("http://127.0.0.1:8080"), { origin: "http://127.0.0.1:8080" });
  assert.match((allowedOrigin("http://api.example.com") as { problem: string }).problem, /not https/);
  assert.match((allowedOrigin("https://api.example.com/v1") as { problem: string }).problem, /origin only/);
  assert.match((allowedOrigin("https://user:pw@api.example.com") as { problem: string }).problem, /user name or password/);
  assert.match((allowedOrigin("stripe") as { problem: string }).problem, /not a web address/);
});

test("the sealing key is kept encrypted, readable only by its user, checked when read, and made once for a paired computer", () => {
  assert.equal(sealKeyCapability({ pairedAt: null, deviceId: null }), null, "an unpaired computer reports no key");
  const made = sealKeyCapability({ pairedAt: new Date().toISOString(), deviceId: "dev-1" })!;
  assert.match(made.fingerprint, /^[0-9A-F]{4}( [0-9A-F]{4}){3}$/);
  assert.equal(sealKeyCapability({ pairedAt: new Date().toISOString(), deviceId: "dev-1" })!.kid, made.kid, "made once");
  const raw = readFileSync(sealKeyPath(), "utf8");
  const stored = JSON.parse(raw);
  assert.match(stored.pkcs8, /^v1:/, "the private key is encrypted with the runtime's key");
  assert.ok(!raw.includes("PRIVATE KEY"));
  if (process.platform !== "win32") assert.equal(statSync(sealKeyPath()).mode & 0o777, 0o600);
  assert.equal(loadSealKey()!.deviceId, "dev-1");

  // A new pairing makes a new key.
  const next = saveSealKey(makeSealKey(), "dev-2");
  assert.notEqual(next.info.kid, made.kid);
  // A file whose public key does not match its private key is not used.
  writeFileSync(sealKeyPath(), JSON.stringify({ ...JSON.parse(readFileSync(sealKeyPath(), "utf8")), spki: made.spki, kid: made.kid }));
  resetSealKeyCacheForTests();
  assert.equal(loadSealKey(), null);
  assert.notEqual(ensureSealKey("dev-2").info.kid, made.kid, "a usable key is made again");
  assert.equal(SEAL_KEY_FILE, "seal-key.json");
  rmSync(sealKeyPath());
  assert.equal(existsSync(sealKeyPath()), false);
});

test("a run's brief names its secrets and where reference secrets may go, never Ensemble's git settings as secrets", () => {
  const [env, refs] = secretRules(["NPM_TOKEN", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0"], [{ name: "STRIPE_KEY", allow: ["https://api.stripe.com"] }]);
  assert.match(env!, /in your environment: \$NPM_TOKEN\. /);
  assert.ok(!env!.includes("GIT_CONFIG"));
  assert.match(refs!, /STRIPE_KEY \(only to https:\/\/api\.stripe\.com\)\. Call those addresses with the secret_http tool/);
  assert.match(refs!, /Git over https to those hosts signs in with it/);
  assert.ok(!secretRules([], [{ name: "STRIPE_KEY", allow: ["https://api.stripe.com"] }])[0]!.includes("Git over https"), "only when git was set up for the run");
});
