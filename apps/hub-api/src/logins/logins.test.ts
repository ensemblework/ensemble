/**
 * The pieces of B11 that need no browser: one-time codes (RFC 6238's own vectors), saved logins
 * encrypted at rest in a 0600 file and never listed with their passwords, the sites they are kept for,
 * the signed-in URL patterns, the identity providers and sign-in addresses the heuristics know, and
 * the data folder deny list that keeps `logins.json` from every run.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const scratch = mkdtempSync(join(homedir(), ".ensemble-logins-unit-"));
process.env.ENSEMBLE_REMOTE_STATE_DIR = scratch;
process.env.ENSEMBLE_SECRET_KEY = randomBytes(32).toString("base64");

const { hotp, normalizeTotpSeed, totpCode } = await import("./totp.js");
const { forgetLogin, hasLogin, listLogins, loginFor, loginOrigin, loginsPath, saveLogin } = await import("./store.js");
const { identityHostOf, isLoopbackOrigin, isSignInPath } = await import("./detect.js");
const { urlMatches } = await import("./fill.js");
const { ensembleDataDenies } = await import("../workspace/data-denies.js");

after(() => rmSync(scratch, { recursive: true, force: true }));

test("one-time codes: RFC 4226 and RFC 6238's vectors, from a base32 seed or an otpauth address", () => {
  const key = Buffer.from("12345678901234567890");
  assert.deepEqual([0, 1, 2, 9].map((counter) => hotp(key, counter)), ["755224", "287082", "359152", "520489"]);
  // RFC 6238, SHA-1, the same key as base32: 59 s → 94287082, 1111111109 s → 07081804 (8 digits).
  const seed = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  assert.equal(totpCode(seed, 59_000, 8), "94287082");
  assert.equal(totpCode(seed, 1_111_111_109_000, 8), "07081804");
  assert.equal(totpCode(seed, 59_000), "287082");
  assert.equal(normalizeTotpSeed("gezd gnbv gy3t qojq gezd gnbv gy3t qojq"), seed);
  assert.equal(normalizeTotpSeed(`otpauth://totp/Ledger:mira?secret=${seed}&issuer=Ledger`), seed);
  assert.throws(() => normalizeTotpSeed("not a seed!"), /base32/);
});

test("saved logins: encrypted at rest in a 0600 file, listed without passwords, one per site", () => {
  const password = `pw-${randomBytes(8).toString("hex")}`;
  const saved = saveLogin({ origin: "app.example.com/login?x=1", username: " mira@example.com ", password, totp: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ" });
  assert.deepEqual([saved.origin, saved.username, saved.totp], ["https://app.example.com", "mira@example.com", true]);
  const raw = readFileSync(loginsPath(), "utf8");
  assert.ok(!raw.includes(password) && !raw.includes("mira@example.com") && !raw.includes("GEZDGNBV"), "values are encrypted with the runtime's key");
  assert.ok(raw.includes("https://app.example.com"), "the site is kept in the clear, to find it");
  assert.equal(statSync(loginsPath()).mode & 0o777, 0o600);
  assert.equal(loginFor("https://app.example.com")?.password, password);
  assert.deepEqual(Object.keys(listLogins()[0]!).sort(), ["createdAt", "origin", "totp", "usedAt", "username"], "never the password or the seed");
  saveLogin({ origin: "https://app.example.com", username: "mira@example.com", password: "new" });
  assert.equal(listLogins().length, 1, "saving again replaces it");
  assert.equal(loginFor("https://app.example.com")?.password, "new");
  assert.equal(hasLogin("https://other.example.com"), false);
  assert.equal(forgetLogin("https://app.example.com/"), true);
  assert.equal(forgetLogin("https://app.example.com"), false);
  assert.equal(hasLogin("https://app.example.com"), false);
});

test("the sites logins are kept for: https, or this computer's own http address", () => {
  assert.equal(loginOrigin("https://app.example.com:8443/a/b"), "https://app.example.com:8443");
  assert.equal(loginOrigin("http://localhost:3000/login"), "http://localhost:3000");
  assert.equal(loginOrigin("http://127.0.0.1:5173"), "http://127.0.0.1:5173");
  assert.throws(() => loginOrigin("http://app.example.com"), /https sites/);
  assert.throws(() => loginOrigin("https://user:pw@app.example.com"), /without a user name/);
  assert.throws(() => loginOrigin("ftp://example.com"), /https sites/);
});

test("signed-in URL patterns: globs over the whole address, or a /regular expression/", () => {
  assert.equal(urlMatches("**/dashboard", "https://app.example.com/dashboard"), true);
  assert.equal(urlMatches("**/dashboard", "https://app.example.com/login?next=/dashboard"), false);
  assert.equal(urlMatches("https://app.example.com/*", "https://app.example.com/home"), true);
  assert.equal(urlMatches("https://app.example.com/*", "https://app.example.com/a/b"), false);
  assert.equal(urlMatches("/\\/inbox(\\/|$)/", "https://mail.example.com/inbox/1"), true);
  assert.equal(urlMatches("/[/", "https://x"), false, "a broken expression matches nothing");
});

test("what the heuristics know: identity providers, sign-in addresses, this computer's own addresses", () => {
  assert.equal(identityHostOf("https://accounts.google.com/v3/signin/identifier"), "accounts.google.com");
  assert.equal(identityHostOf("https://login.microsoftonline.com/common/oauth2"), "login.microsoftonline.com");
  assert.equal(identityHostOf("https://acme.okta.com/app/x"), "acme.okta.com");
  assert.equal(identityHostOf("https://github.com/login?return_to=x"), "github.com");
  assert.equal(identityHostOf("https://github.com/ensemblework/ensemble"), null, "GitHub only on its sign-in pages");
  assert.equal(isSignInPath("https://app.example.com/users/sign_in"), true);
  assert.equal(isSignInPath("https://app.example.com/auth/login"), true);
  assert.equal(isSignInPath("https://app.example.com/authors"), false);
  assert.equal(isSignInPath("https://app.example.com/blog/how-to-login-faster"), false);
  assert.equal(isLoopbackOrigin("http://localhost:3000"), true);
  assert.equal(isLoopbackOrigin("http://127.0.0.2:3000"), true);
  assert.equal(isLoopbackOrigin("http://[::1]:3000"), true);
  assert.equal(isLoopbackOrigin("https://app.example.com"), false);
});

test("logins.json is Ensemble's own data: denied to every run, named even before it exists", () => {
  const home = mkdtempSync(join(homedir(), ".ensemble-logins-deny-"));
  try {
    const denies = ensembleDataDenies({ env: { ENSEMBLE_REMOTE_STATE_DIR: join(home, "data"), ENSEMBLE_WORKSPACE_ROOT: join(home, "data", "workspace") }, home, platform: "linux" });
    for (const name of ["logins.json", "seal-key.json", "seal-seen.json"]) assert.ok(denies.includes(join(home, "data", name)), name);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
