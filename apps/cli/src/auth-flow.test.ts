import test from "node:test";
import assert from "node:assert/strict";
import { DeviceFlowError, pollDeviceToken } from "./auth-flow.js";
import type { FetchLike } from "./http.js";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("device polling handles pending, slow_down, then success", async () => {
  const waits: number[] = [];
  const responses = [
    json(400, { error: "authorization_pending" }),
    json(400, { error: "slow_down" }),
    json(200, { token: "ens_test", scopes: ["mcp"], account: { email: "mira@example.test" } }),
  ];
  const fetchImpl: FetchLike = async () => responses.shift()!;
  const token = await pollDeviceToken({
    apiBase: "https://api.example.test",
    deviceCode: "device",
    interval: 1,
    expiresIn: 60,
    fetchImpl,
    wait: async (ms) => void waits.push(ms),
  });
  assert.equal(token.token, "ens_test");
  assert.deepEqual(waits, [1000, 1000, 6000]);
});

test("device polling reports denied and expired codes", async () => {
  await assert.rejects(
    () =>
      pollDeviceToken({
        apiBase: "https://api.example.test",
        deviceCode: "device",
        interval: 1,
        expiresIn: 60,
        fetchImpl: async () => json(400, { error: "access_denied" }),
        wait: async () => undefined,
      }),
    (error) => error instanceof DeviceFlowError && error.code === "access_denied",
  );
  await assert.rejects(
    () =>
      pollDeviceToken({
        apiBase: "https://api.example.test",
        deviceCode: "device",
        interval: 1,
        expiresIn: 60,
        fetchImpl: async () => json(400, { error: "expired_token" }),
        wait: async () => undefined,
      }),
    (error) => error instanceof DeviceFlowError && error.code === "expired_token",
  );
});
