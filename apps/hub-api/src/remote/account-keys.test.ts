/**
 * One set of keys: a paired computer uses the keys saved on the account for providers it has no
 * key of its own for, and none once the computer is removed.
 */
import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ??= "postgresql://ensemble:unused@127.0.0.1:1/ensemble_desktop";
const { setAccountKeySourceForTests, accountKeys } = await import("./account-keys.js");
const { RemoteError } = await import("./client.js");
const { listCredentials, resolveCredential, setCredentialStoreForTests } = await import("../runtime/credentials.js");
const { encrypt } = await import("../lib/secrets.js");

const local = new Map<string, string>();
setCredentialStoreForTests({
  async read(_userId, provider) {
    const secret = local.get(provider);
    return secret ? { secret: encrypt(secret), baseUrl: null } : null;
  },
  async list() {
    return [...local.keys()].map((provider) => ({ provider, hint: "…here", updatedAt: new Date("2026-10-13T00:00:00Z") }));
  },
  async upsert() {},
  async remove() {},
});

test.after(() => {
  setAccountKeySourceForTests(null);
  setCredentialStoreForTests(null);
});

test("keys saved on the account answer for providers this computer has no key for; a key here wins", async () => {
  let reads = 0;
  setAccountKeySourceForTests(async () => ({
    pairing: "paired",
    read: async () => {
      reads += 1;
      return { keys: [{ provider: "google", secret: "account-google-key", hint: "…r2Qw", updatedAt: "2026-10-13T09:27:00Z" }, { provider: "cursor", secret: "account-cursor-key", hint: "…4705", updatedAt: "" }] };
    },
  }));
  local.set("cursor", "this-computer-cursor-key");
  const google = await resolveCredential("local-user", "google");
  assert.deepEqual({ secret: google.secret, source: google.source }, { secret: "account-google-key", source: "account" });
  const cursor = await resolveCredential("local-user", "cursor");
  assert.deepEqual({ secret: cursor.secret, source: cursor.source }, { secret: "this-computer-cursor-key", source: "you" });
  const listed = await listCredentials("local-user");
  assert.deepEqual(listed.filter((row) => row.source !== "none").map((row) => [row.provider, row.source, row.hint]), [["google", "account", "…r2Qw"], ["cursor", "you", "…here"]]);
  await resolveCredential("local-user", "anthropic");
  assert.equal(reads, 1, "read once, then held in memory");
  local.clear();
});

test("a removed computer, or one that is not paired, uses no account keys", async () => {
  setAccountKeySourceForTests(async () => ({ pairing: "paired", read: async () => { throw new RemoteError(401, "This computer is no longer paired."); } }));
  assert.equal((await accountKeys()).size, 0);
  setAccountKeySourceForTests(async () => null);
  assert.equal((await accountKeys()).size, 0);
});
