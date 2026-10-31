import assert from "node:assert/strict";
import { createDecipheriv, createHash, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync } from "node:crypto";
import test from "node:test";
import { codeAnswer, loginFingerprint, loginOutcomeText, loginRouteText, typedLoginAnswer, type LoginTarget } from "./node-login";

function computerKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const spki = publicKey.export({ type: "spki", format: "der" });
  const kid = createHash("sha256").update(spki).digest("hex").slice(0, 16);
  return { privateKey, info: { kid, alg: "ECDH-P256+HKDF-SHA256+A256GCM", spki: spki.toString("base64url"), fingerprint: kid.toUpperCase().match(/.{4}/g)!.join(" ") } };
}

const target = (route: LoginTarget["route"]): LoginTarget => ({
  id: "card-1",
  status: "pending",
  origin: "https://ledger.example.com",
  loginId: "lg_0123456789abcdef0123456789abcdef",
  computer: { id: "dev-1", name: "Mira's laptop", online: true },
  route,
  saved: false,
  display: false,
  takeover: false,
  ttlMs: 600_000,
});

test("a login typed here is sealed for the computer, bound to the card, the sign-in and the page; the site travels inside", async () => {
  const key = computerKey();
  const answer = await typedLoginAnswer(target({ mode: "sealed", sealKey: key.info }), { id: "card-1" }, { username: " mira@example.com ", password: "pw-123456", code: " 123 456 ", save: true }, "https://app.ensemblework.com");
  assert.equal(answer.action, "typed");
  assert.ok(answer.action === "typed");
  assert.ok(!JSON.stringify(answer).includes("pw-123456") && !JSON.stringify(answer).includes("mira@example.com"), "nothing in clear");
  const box = answer.sealed;
  const aad = JSON.parse(Buffer.from(box.aad, "base64url").toString("utf8"));
  assert.deepEqual([aad.purpose, aad.deviceId, aad.decisionId, aad.name, aad.origin], ["login", "dev-1", "card-1", "lg_0123456789abcdef0123456789abcdef", "https://app.ensemblework.com"]);
  const epk = Buffer.from(box.epk, "base64url");
  const shared = diffieHellman({ privateKey: key.privateKey, publicKey: createPublicKey({ key: { kty: "EC", crv: "P-256", x: epk.subarray(1, 33).toString("base64url"), y: epk.subarray(33).toString("base64url") }, format: "jwk" }) });
  const aesKey = Buffer.from(hkdfSync("sha256", shared, epk, Buffer.from(`ensemble-seal-v1|${key.info.kid}`), 32));
  const ct = Buffer.from(box.ct, "base64url");
  const decipher = createDecipheriv("aes-256-gcm", aesKey, Buffer.from(box.iv, "base64url"));
  decipher.setAAD(Buffer.from(box.aad, "base64url"));
  decipher.setAuthTag(ct.subarray(ct.length - 16));
  assert.deepEqual(JSON.parse(Buffer.concat([decipher.update(ct.subarray(0, ct.length - 16)), decipher.final()]).toString("utf8")), { origin: "https://ledger.example.com", username: "mira@example.com", password: "pw-123456", code: "123 456", save: true });
  assert.equal(await loginFingerprint(target({ mode: "sealed", sealKey: key.info })), key.info.fingerprint);
});

test("nothing typed goes to a computer that cannot open it, and the card says why; settled cards say how", async () => {
  await assert.rejects(typedLoginAnswer(target({ mode: "pair_again" }), { id: "card-1" }, { username: "a", password: "b", save: false }, "https://app.ensemblework.com"), /Pair it again/);
  await assert.rejects(typedLoginAnswer(target({ mode: "unsupported" }), { id: "card-1" }, { username: "a", password: "b", save: false }, "https://app.ensemblework.com"), /Update it there/);
  assert.match(loginRouteText(target({ mode: "sealed", sealKey: computerKey().info }), "3F2A 9C01 77DE 4B10"), /^Encrypted in this browser for Mira's laptop: only Mira's laptop can read it.*Key 3F2A 9C01 77DE 4B10/);
  assert.equal(loginOutcomeText({ status: "signed_in", origin: "https://ledger.example.com", computer: "Mira's laptop", via: "saved" }), "Signed in to https://ledger.example.com on Mira's laptop with the saved login.");
  assert.equal(loginOutcomeText({ status: "signed_in", origin: "https://x.example", computer: "Studio", via: "typed", savedNow: true }), "Signed in to https://x.example on Studio with what you typed (encrypted for the computer). The login is saved there for next time.");
  assert.equal(loginOutcomeText({ status: "declined", origin: "https://x.example", computer: "Studio" }), "You chose not to sign in to https://x.example on Studio now.");
});

test("the code a site asks for is sealed like a typed login, with only the code and the site inside; a passed check says so", async () => {
  const key = computerKey();
  const answer = await codeAnswer({ ...target({ mode: "sealed", sealKey: key.info }), status: "needs_code", codeHint: "Enter the 6-digit code" }, { id: "card-1" }, " 424242 ", "https://app.ensemblework.com");
  assert.equal(answer.action, "code");
  assert.ok(answer.action === "code" && !JSON.stringify(answer).includes("424242"), "nothing in clear");
  const aad = JSON.parse(Buffer.from(answer.sealed.aad, "base64url").toString("utf8"));
  assert.deepEqual([aad.purpose, aad.decisionId, aad.name], ["login", "card-1", "lg_0123456789abcdef0123456789abcdef"]);
  await assert.rejects(codeAnswer(target({ mode: "pair_again" }), { id: "card-1" }, "1", "https://app.ensemblework.com"), /Pair it again/);
  assert.equal(loginOutcomeText({ status: "passed", origin: "https://www.walmart.com", computer: "Studio" }), "You passed the human check on https://www.walmart.com on Studio.");
});
