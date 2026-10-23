import assert from "node:assert/strict";
import test from "node:test";
import { checkApiBase, hostedClient, registerDevice, remoteApiBase } from "./client.js";

test("a testing runner rejects production pairing, remote settings, claims and credentials before making a request", async () => {
  const before = process.env.ENSEMBLE_CLI_CHANNEL;
  const beforeApi = process.env.ENSEMBLE_REMOTE_API;
  const fetchBefore = globalThis.fetch;
  let calls = 0;
  process.env.ENSEMBLE_CLI_CHANNEL = "testing";
  globalThis.fetch = async () => { calls++; throw new Error("Unexpected request"); };
  try {
    assert.equal(checkApiBase("https://api-test.ensemblework.com/"), "https://api-test.ensemblework.com");
    for (const base of ["https://api.ensemblework.com", "https://api-test.ensemblework.com.evil.test", "http://api-test.ensemblework.com"]) {
      assert.throws(() => checkApiBase(base), /only/);
      assert.throws(() => hostedClient(base, "production-token"), /only/);
      await assert.rejects(() => registerDevice(base, { code: "TEST1234", name: "Test", platform: "linux", appVersion: "test", capabilities: {} }), /only/);
      process.env.ENSEMBLE_REMOTE_API = base;
      assert.throws(remoteApiBase, /only/);
    }
    assert.equal(calls, 0);
  } finally {
    if (before === undefined) delete process.env.ENSEMBLE_CLI_CHANNEL; else process.env.ENSEMBLE_CLI_CHANNEL = before;
    if (beforeApi === undefined) delete process.env.ENSEMBLE_REMOTE_API; else process.env.ENSEMBLE_REMOTE_API = beforeApi;
    globalThis.fetch = fetchBefore;
  }
});
