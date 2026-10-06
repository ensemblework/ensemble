import assert from "node:assert/strict";
import test from "node:test";
import { assertProductionSafe, formatProductionProblems, productionProblems } from "./production.js";

const good = {
  NODE_ENV: "production",
  ENSEMBLE_INTERNAL_TOKEN: "a".repeat(32),
  HUB_WEB_ORIGIN: "https://hub.example",
  ENSEMBLE_SERVER_RUNNER: "off",
};

test("hosted open signup cannot enable the server runner, including the default", () => {
  for (const mode of [undefined, "open", "unknown"]) {
    for (const runner of [undefined, "on"]) {
      assert.match(productionProblems({ ...good, ENSEMBLE_SIGNUP_MODE: mode, ENSEMBLE_SERVER_RUNNER: runner }).join("\n"), /ENSEMBLE_SERVER_RUNNER=off/);
    }
  }
  for (const mode of ["closed", "allowlist"]) {
    assert.deepEqual(productionProblems({ ...good, ENSEMBLE_SIGNUP_MODE: mode, ENSEMBLE_SERVER_RUNNER: "on" }), []);
  }
  assert.deepEqual(productionProblems({ ...good, ENSEMBLE_SIGNUP_ALLOWLIST: "operator@example.test", ENSEMBLE_SERVER_RUNNER: "on" }), []);
  assert.match(productionProblems({ ...good, ENSEMBLE_SIGNUP_MODE: "open", ENSEMBLE_SIGNUP_ALLOWLIST: "operator@example.test", ENSEMBLE_SERVER_RUNNER: "on" }).join("\n"), /ENSEMBLE_SERVER_RUNNER=off/);
  assert.match(productionProblems({ ...good, ENSEMBLE_SIGNUP_MODE: "unknown" }).join("\n"), /ENSEMBLE_SIGNUP_MODE must be/);
  assert.deepEqual(productionProblems({ ...good, ENSEMBLE_DESKTOP: "1", ENSEMBLE_SERVER_RUNNER: "on" }), []);
});

test("hosted startup refuses invalid quota configuration", () => {
  assert.match(productionProblems({ ...good, ENSEMBLE_MAX_JOBS_PER_DAY: "NaN" }).join("\n"), /ENSEMBLE_MAX_JOBS_PER_DAY/);
  assert.match(productionProblems({ ...good, ENSEMBLE_MAX_DOCUMENT_BYTES: "0" }).join("\n"), /ENSEMBLE_MAX_DOCUMENT_BYTES/);
});

test("dev does not refuse a default token or auth bypass", () => {
  assert.deepEqual(
    productionProblems({
      NODE_ENV: "development",
      ENSEMBLE_INTERNAL_TOKEN: "dev-internal-token",
      ENSEMBLE_DEV_AUTH_BYPASS: "true",
      ENSEMBLE_DEV_LOGIN: "1",
      ENSEMBLE_DEV_TOOLS: "1",
      HUB_WEB_ORIGIN: "http://localhost:3000",
    }),
    [],
  );
  assert.deepEqual(productionProblems({}), []);
});

test("production refuses the default and example internal token", () => {
  for (const token of [undefined, "", "dev-internal-token", "Change-Me", "example-token"]) {
    const problems = productionProblems({ ...good, ENSEMBLE_INTERNAL_TOKEN: token });
    assert.equal(problems.length, 1, String(token));
    assert.match(problems[0]!, /ENSEMBLE_INTERNAL_TOKEN/);
  }
  const unset = productionProblems({ ...good, ENSEMBLE_INTERNAL_TOKEN: undefined });
  assert.match(unset[0]!, /default value "dev-internal-token"/);
  const example = productionProblems({ ...good, ENSEMBLE_INTERNAL_TOKEN: "change-me" });
  assert.match(example[0]!, /example value "change-me"/);
});

test("production refuses auth-bypass and dev-login settings", () => {
  const problems = productionProblems({
    ...good,
    ENSEMBLE_DEV_AUTH_BYPASS: "true",
    ENSEMBLE_DEV_LOGIN: "on",
    ENSEMBLE_BRIDGE_ALLOW_DEFAULT_INTERNAL_TOKEN: "1",
    CUSTOM_AUTH_BYPASS: "yes",
  });
  const text = problems.join("\n");
  assert.match(text, /ENSEMBLE_DEV_AUTH_BYPASS/);
  assert.match(text, /ENSEMBLE_DEV_LOGIN/);
  assert.match(text, /ENSEMBLE_BRIDGE_ALLOW_DEFAULT_INTERNAL_TOKEN/);
  assert.match(text, /CUSTOM_AUTH_BYPASS/);
  assert.equal(problems.some((line) => line.includes("ENSEMBLE_DEV_USER_ID")), false);
});

test("hub production refuses developer tools and a non-https web origin", () => {
  const problems = productionProblems({
    ...good,
    ENSEMBLE_DEV_TOOLS: "1",
    HUB_WEB_ORIGIN: "http://localhost:3000",
  });
  assert.match(problems.join("\n"), /ENSEMBLE_DEV_TOOLS/);
  assert.match(problems.join("\n"), /HUB_WEB_ORIGIN/);
  assert.equal(productionProblems({ ...good, ENSEMBLE_DEV_TOOLS: "1" }, "agent").some((line) => line.includes("ENSEMBLE_DEV_TOOLS")), false);
  assert.equal(productionProblems(good, "hub").length, 0);
});

test("production refuses a site and API that cannot share the session cookie", () => {
  const split = productionProblems({
    ...good,
    HUB_WEB_ORIGIN: "https://ensemble.vercel.app",
    HUB_API_PUBLIC_URL: "https://api.example.com",
  });
  assert.match(split.join("\n"), /do not share a parent domain/);
  assert.match(split.join("\n"), /ENSEMBLE_COOKIE_DOMAIN/);
  const bare = productionProblems({
    ...good,
    HUB_WEB_ORIGIN: "https://app.example.com",
    HUB_API_PUBLIC_URL: "https://api.example.com",
  });
  assert.match(bare.join("\n"), /ENSEMBLE_COOKIE_DOMAIN=\.example\.com/);
  assert.equal(
    productionProblems({
      ...good,
      HUB_WEB_ORIGIN: "https://app.example.com",
      HUB_API_PUBLIC_URL: "https://api.example.com",
      ENSEMBLE_COOKIE_DOMAIN: ".example.com",
    }).length,
    0,
  );
  assert.equal(productionProblems({ ...good, HUB_API_PUBLIC_URL: "https://hub.example" }).length, 0);
});

test("the error names every problem", () => {
  assert.throws(() => assertProductionSafe({ NODE_ENV: "production", ENSEMBLE_INTERNAL_TOKEN: "dev-internal-token" }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /Refusing to start in production/);
    assert.match(error.message, /ENSEMBLE_INTERNAL_TOKEN/);
    assert.equal(error.message, formatProductionProblems(productionProblems({ NODE_ENV: "production", ENSEMBLE_INTERNAL_TOKEN: "dev-internal-token" })));
    return true;
  });
});
