import assert from "node:assert/strict";
import test from "node:test";
import { MISSING_HUB_API, resolveHubApi, resolveHubApiInternal } from "./hub-origin";

test("dev keeps the localhost default when NEXT_PUBLIC_HUB_API is unset", () => {
  assert.equal(resolveHubApi({ NODE_ENV: "development" }), "http://127.0.0.1:4000");
  assert.equal(resolveHubApi({}), "http://127.0.0.1:4000");
});

test("a set origin is used in dev and production", () => {
  assert.equal(resolveHubApi({ NEXT_PUBLIC_HUB_API: " https://hub.example ", NODE_ENV: "production" }), "https://hub.example");
  assert.equal(resolveHubApi({ NEXT_PUBLIC_HUB_API: "http://127.0.0.1:4000", NODE_ENV: "development" }), "http://127.0.0.1:4000");
});

test("a production build fails clearly when NEXT_PUBLIC_HUB_API is unset", () => {
  assert.throws(() => resolveHubApi({ NODE_ENV: "production" }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /NEXT_PUBLIC_HUB_API/);
    assert.equal(error.message, MISSING_HUB_API);
    return true;
  });
  assert.throws(() => resolveHubApi({ NEXT_PUBLIC_HUB_API: "  ", NODE_ENV: "production" }), /NEXT_PUBLIC_HUB_API/);
});

test("an internal origin is used only when it is set", () => {
  const pub = { NEXT_PUBLIC_HUB_API: "https://api.example", NODE_ENV: "production" };
  assert.equal(resolveHubApiInternal(pub), "https://api.example");
  assert.equal(resolveHubApiInternal({ ...pub, HUB_API_INTERNAL_URL: "  " }), "https://api.example");
  assert.equal(resolveHubApiInternal({ ...pub, HUB_API_INTERNAL_URL: "http://127.0.0.1:14000/" }), "http://127.0.0.1:14000");
});
