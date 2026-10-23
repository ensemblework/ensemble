import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createHttpHarness, HTTP_TEST_PASSWORD } from "../test/http.js";

process.env.ENSEMBLE_COOKIE_NAMESPACE = "testing";
const harness = await createHttpHarness();
after(() => harness.close());

test("test-site login and logout use only the namespaced cookies, even when a production cookie is present", async () => {
  const user = await harness.asUser();
  assert.match(user.cookie, /^ensemble_testing_session=/);
  const valid = await harness.app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: `ensemble_session=production; ${user.cookie}` } });
  assert.equal(valid.statusCode, 200);
  const productionOnly = await harness.app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: user.cookie.replace("ensemble_testing_session=", "ensemble_session=") } });
  assert.equal(productionOnly.statusCode, 401);
  const login = await harness.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: user.email, password: HTTP_TEST_PASSWORD } });
  assert.equal(login.statusCode, 200, login.body);
  const set = login.headers["set-cookie"];
  const cookies = Array.isArray(set) ? set : [String(set)];
  assert.ok(cookies.some((cookie) => cookie.startsWith("ensemble_testing_session=")));
  assert.ok(cookies.some((cookie) => cookie.startsWith("ensemble_testing_space=")));
  const logout = await user.inject({ method: "POST", url: "/api/auth/logout" });
  assert.equal(logout.statusCode, 204);
  const cleared = logout.headers["set-cookie"];
  for (const cookie of Array.isArray(cleared) ? cleared : [String(cleared)]) assert.match(cookie, /^ensemble_testing_(session|space)=/);
});
