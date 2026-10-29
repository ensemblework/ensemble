import assert from "node:assert/strict";
import { createDecipheriv, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, createHash } from "node:crypto";
import test from "node:test";
import { keptText, parseAllow, routeText, secretAnswer, targetFingerprint, type SecretTarget } from "./node-secret";

/** A computer's key, as the web is given it. */
function computerKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const spki = publicKey.export({ type: "spki", format: "der" });
  const kid = createHash("sha256").update(spki).digest("hex").slice(0, 16);
  return { privateKey, info: { kid, alg: "ECDH-P256+HKDF-SHA256+A256GCM", spki: spki.toString("base64url"), fingerprint: kid.toUpperCase().match(/.{4}/g)!.join(" ") } };
}

const target = (route: SecretTarget["route"]): SecretTarget => ({ id: "card-1", name: "STRIPE_KEY", status: "pending", computer: { id: "dev-1", name: "Mira's laptop", online: true }, route, ttlMs: 600_000, allow: [] });

test("the card's answer is sealed for the computer, bound to the card, the page and the name; only the computer's key opens it", async () => {
  const key = computerKey();
  const answer = await secretAnswer(target({ mode: "sealed", sealKey: key.info }), { id: "card-1" }, "sk_test_123", ["https://api.stripe.com"], "https://app.ensemblework.com");
  assert.ok("sealed" in answer);
  assert.ok(!JSON.stringify(answer).includes("sk_test_123"), "nothing in clear");
  const box = answer.sealed;
  const aad = JSON.parse(Buffer.from(box.aad, "base64url").toString("utf8"));
  assert.deepEqual([aad.deviceId, aad.decisionId, aad.name, aad.origin, aad.purpose], ["dev-1", "card-1", "STRIPE_KEY", "https://app.ensemblework.com", "secret"]);
  // Opened as the computer does (node:crypto), to check the browser's format end to end.
  const epk = Buffer.from(box.epk, "base64url");
  const shared = diffieHellman({ privateKey: key.privateKey, publicKey: createPublicKey({ key: { kty: "EC", crv: "P-256", x: epk.subarray(1, 33).toString("base64url"), y: epk.subarray(33).toString("base64url") }, format: "jwk" }) });
  const aesKey = Buffer.from(hkdfSync("sha256", shared, epk, Buffer.from(`ensemble-seal-v1|${key.info.kid}`), 32));
  const ct = Buffer.from(box.ct, "base64url");
  const decipher = createDecipheriv("aes-256-gcm", aesKey, Buffer.from(box.iv, "base64url"));
  decipher.setAAD(Buffer.from(box.aad, "base64url"));
  decipher.setAuthTag(ct.subarray(ct.length - 16));
  assert.deepEqual(JSON.parse(Buffer.concat([decipher.update(ct.subarray(0, ct.length - 16)), decipher.final()]).toString("utf8")), { value: "sk_test_123", allow: ["https://api.stripe.com"] });
  assert.equal(await targetFingerprint(target({ mode: "sealed", sealKey: key.info })), key.info.fingerprint);
});

test("an older computer gets the value over HTTPS, and the card says so; a changed key sends nothing", async () => {
  assert.deepEqual(await secretAnswer(target({ mode: "tls" }), { id: "card-1" }, "v", [], "https://app.ensemblework.com"), { value: "v" });
  await assert.rejects(secretAnswer(target({ mode: "pair_again" }), { id: "card-1" }, "v", [], "https://app.ensemblework.com"), /Pair it again/);
  assert.match(routeText(target({ mode: "tls" }), null), /^Sent over HTTPS to Ensemble's server, which passes it to Mira's laptop without keeping it\. Mira's laptop is too old for end-to-end encryption; update Ensemble there\.$/);
  const key = computerKey();
  assert.match(routeText(target({ mode: "sealed", sealKey: key.info }), key.info.fingerprint), new RegExp(`only Mira's laptop can read it.*Key ${key.info.fingerprint}: it should match \`ensemble secrets fingerprint\``));
  assert.match(keptText("STRIPE_KEY", "Mira's laptop", ["https://api.stripe.com"]), /by reference only.*never put in a run's environment/);
  assert.match(keptText("STRIPE_KEY", "Mira's laptop", []), /get it as \$STRIPE_KEY/);
  assert.deepEqual(parseAllow(" https://a.example, https://b.example\nhttps://a.example "), ["https://a.example", "https://b.example"]);
});
