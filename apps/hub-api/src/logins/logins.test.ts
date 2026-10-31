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

test("sign-in v2's page rules: fields from a clean browser's snapshot, steps of signing in, sites, codes and approvals asked for", async () => {
  const { fieldKinds, countFieldsOf, isSignInFlow, siteOf, cookieOfSite, sessionLike, codePrompt, approvalPrompt } = await import("./detect.js");
  assert.deepEqual(fieldKinds({ tag: "input", type: "password", autocomplete: "current-password" }), { password: true, newPassword: false, username: false, code: false, other: false });
  assert.equal(fieldKinds({ tag: "input", type: "email" }).username, true);
  assert.equal(fieldKinds({ tag: "input", name: "loginfmt" }).username, true, "Microsoft's email field");
  assert.equal(fieldKinds({ tag: "input", type: "hidden", name: "username" }).username, false);
  assert.equal(fieldKinds({ tag: "input", type: "tel", name: "totpPin" }).code, true, "Google's code field");
  assert.equal(fieldKinds({ tag: "input", name: "otc" }).code, true, "Microsoft's code field");
  assert.equal(fieldKinds({ tag: "input", type: "text", name: "zip" }).other, true);
  assert.deepEqual(countFieldsOf([{ tag: "input", type: "password", autocomplete: "new-password" }, { tag: "input", type: "email" }, { tag: "textarea" }]), { passwords: 1, newPasswords: 1, usernames: 1, codes: 0, others: 1 });
  assert.equal(isSignInFlow("https://app.example.com/forgot-password"), true);
  assert.equal(isSignInFlow("https://app.example.com/account/verify"), true);
  assert.equal(isSignInFlow("https://accounts.google.com/v3/signin/challenge/pwd"), true);
  assert.equal(isSignInFlow("https://app.example.com/dashboard"), false);
  assert.equal(siteOf("https://mail.google.com/mail/u/0/"), "google.com");
  assert.equal(siteOf("https://www.bbc.co.uk/news"), "bbc.co.uk");
  assert.equal(siteOf("http://127.0.0.1:3000/x"), "127.0.0.1:3000");
  assert.equal(siteOf("about:blank"), null);
  assert.ok(cookieOfSite(".google.com", "google.com") && cookieOfSite("accounts.google.com", "google.com") && !cookieOfSite("evilgoogle.com", "google.com"));
  assert.ok(sessionLike("SID") && sessionLike("session") && !sessionLike("_ga") && !sessionLike("cf_clearance") && !sessionLike("__cf_bm") && !sessionLike("OptanonConsent"));
  const none = { passwords: 0, newPasswords: 0, usernames: 0, codes: 0, others: 0 };
  assert.equal(codePrompt({ text: "2-Step Verification. Enter the 6-digit code from the Google Authenticator app", fields: { ...none, codes: 1 } }), "Enter the 6-digit code from your authenticator app.");
  assert.equal(codePrompt({ text: "We texted a code to your phone number ending in 42. Enter the code.", fields: { ...none, others: 1 } }), "Enter the code the site sent to your phone.");
  assert.equal(codePrompt({ text: "Check your email: we sent a verification code to m•••@example.com", fields: { ...none, others: 1 } }), "Enter the code the site emailed you.");
  assert.equal(codePrompt({ text: "Search our store", fields: { ...none, others: 1 } }), null, "a page without words of a code and no code field");
  assert.equal(codePrompt({ text: "Enter your password and the code", fields: { ...none, passwords: 1, others: 1 } }), null, "still the password step");
  assert.equal(approvalPrompt("Approve sign in request. Open your Authenticator app, and enter the number shown to sign in. 42"), "Approve the sign-in on your phone (tap 42); Ensemble sees it when you have.");
  assert.equal(approvalPrompt("Check your phone. Google sent a notification to your Pixel."), "Approve the sign-in on your phone; Ensemble sees it when you have.");
  assert.equal(approvalPrompt("Welcome back"), null);
});

test("what a sign-in's page says, now and over time: a human check is never signed in; a sign-in counts only after the page asked and the site's session changed", async () => {
  const { judge, Watch, storageFingerprint } = await import("./watch.js");
  const { forServer } = await import("./answer.js");
  const none = { passwords: 0, newPasswords: 0, usernames: 0, codes: 0, others: 0 };
  const signs = (over: Partial<{ url: string; title: string; text: string; frames: string[]; fields: typeof none; loaded: boolean }>) => ({ url: "https://app.example.com/home", title: "App", text: "Welcome", frames: [] as string[], fields: none, loaded: true, ...over });
  const origin = "https://app.example.com";
  assert.equal(judge(signs({}), { origin, purpose: "sign_in" }).ok, true);
  const challenge = judge(signs({ title: "Just a moment..." }), { origin, purpose: "sign_in" });
  assert.deepEqual([challenge.ok, challenge.asking, challenge.challenge], [false, true, "Cloudflare's check"], "a human-check page is never signed in");
  assert.equal(judge(signs({ title: "Just a moment..." }), { origin, purpose: "human_check" }).ok, false);
  assert.equal(judge(signs({}), { origin, purpose: "human_check" }).ok, true);
  assert.equal(judge(signs({ fields: { ...none, passwords: 1 } }), { origin, purpose: "sign_in" }).asking, true);
  assert.equal(judge(signs({ url: "https://accounts.google.com/v3/signin" }), { origin, purpose: "sign_in" }).asking, true, "another site asks");
  assert.equal(judge(signs({ url: "https://app.example.com/forgot-password" }), { origin, purpose: "sign_in", strict: true }).ok, false, "a step of signing in is not signed in yet");
  assert.equal(judge(signs({ url: "https://www.example.com/start" }), { origin, purpose: "sign_in" }).ok, true, "another address of the same site");
  // Asked now, too: an identity provider of the same site, a code or approval step, is not signed in.
  assert.equal(judge(signs({ url: "https://accounts.google.com/v3/signin/challenge/dp" }), { origin: "https://mail.google.com", purpose: "sign_in" }).ok, false);
  assert.equal(judge(signs({ url: "https://www.amazon.com/ap/mfa" }), { origin: "https://www.amazon.com", purpose: "sign_in" }).ok, false);
  assert.equal(judge(signs({ url: "https://app.example.com/account/verify" }), { origin, purpose: "sign_in" }).ok, false);
  assert.equal(judge(signs({ url: "https://myaccount.google.com/" }), { origin: "https://accounts.google.com", purpose: "sign_in" }).ok, true, "signing in to the provider itself lands on its site");

  // The watch: positive before asking is nothing; asking, then the site with a new session cookie, is done.
  let jar: Array<{ name: string; value: string; domain: string }> = [{ name: "_ga", value: "1", domain: ".example.com" }];
  let page = signs({});
  const probe = { signs: async () => page, visible: async () => false, storage: async () => storageFingerprint(jar, origin) };
  const watch = new Watch({ origin, purpose: "sign_in", condition: null, requireChallenge: false });
  assert.equal((await watch.observe(probe)).done, false, "it looked signed in before anything happened");
  page = signs({ url: "https://app.example.com/login", fields: { ...none, passwords: 1 } });
  assert.equal((await watch.observe(probe)).done, false);
  page = signs({ url: "https://app.example.com/help" });
  jar = [...jar, { name: "_ga", value: "2", domain: ".example.com" }];
  assert.equal((await watch.observe(probe)).done, false, "an analytics cookie is not a session");
  jar = [...jar, { name: "sid", value: "s3", domain: "app.example.com" }];
  assert.deepEqual(await watch.observe(probe).then((seen) => [seen.done, seen.status]), [true, "signed_in"]);
  // A popup on the identity provider asks; the site's page (with a sign-in key already in its storage) did not change: not done.
  let storage: Array<[string, string]> | null = [["ajs_user_traits", "{}"]];
  const root = { signs: async () => signs({ url: "https://app.example.com/" }), visible: async () => false, storage: async () => storageFingerprint(jar, origin, storage) };
  const popup = new Watch({ origin, purpose: "sign_in", condition: null, requireChallenge: false });
  const asideAsked = { signs: async () => signs({ url: "https://accounts.google.com/v3/signin/identifier", fields: { ...none, usernames: 1 } }), visible: async () => false, storage: async () => storageFingerprint(jar, origin, null) };
  assert.equal(await popup.observeAside(asideAsked), true);
  assert.equal((await popup.observe(root, true)).done, false, "the popup asking is no change on the site");
  assert.equal((await popup.observe(root)).done, false);
  storage = [["ajs_user_traits", "{}"], ["auth_token", "t1"]];
  assert.deepEqual(await popup.observe(root).then((seen) => [seen.done, seen.status]), [true, "signed_in"], "a sign-in key in its storage is");
  // A human check in the node's own tab: passed once the challenge was seen, then gone twice.
  const human = new Watch({ origin, purpose: "human_check", condition: null, requireChallenge: true });
  page = signs({});
  assert.equal((await human.observe(probe)).done, false, "never seen the challenge");
  page = signs({ title: "Robot or human?" });
  assert.equal((await human.observe(probe)).done, false);
  page = signs({});
  assert.equal((await human.observe(probe)).done, false, "seen clear once");
  assert.deepEqual(await human.observe(probe).then((seen) => [seen.done, seen.status]), [true, "passed"]);

  // A server before sign-ins 2 hears statuses it knows.
  assert.deepEqual(forServer({ status: "passed" }, undefined), { status: "signed_in" });
  assert.equal(forServer({ status: "needs_code", message: "Enter the code." }, 1).status, "failed");
  assert.deepEqual(forServer({ status: "needs_code", message: "Enter the code." }, 2), { status: "needs_code", message: "Enter the code." });
});
