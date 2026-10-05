import assert from "node:assert/strict";
import test from "node:test";
import { crossOriginCookieProblem, domainCoversHost, normalizeCookieDomain, sharedCookieParent } from "./cookie-site.js";

test("a parent domain covers both hosts and a public suffix does not", () => {
  assert.equal(normalizeCookieDomain(".Example.com"), ".example.com");
  assert.equal(normalizeCookieDomain("example.com"), ".example.com");
  assert.equal(normalizeCookieDomain(".vercel.app"), null);
  assert.equal(normalizeCookieDomain("com"), null);
  assert.equal(normalizeCookieDomain("localhost"), null);
  assert.equal(sharedCookieParent("app.example.com", "api.example.com"), ".example.com");
  assert.equal(sharedCookieParent("app.vercel.app", "api.other.com"), null);
  assert.equal(sharedCookieParent("foo.vercel.app", "bar.vercel.app"), null);
  assert.equal(domainCoversHost(".example.com", "app.example.com"), true);
  assert.equal(domainCoversHost(".example.com", "example.com"), true);
  assert.equal(domainCoversHost(".api.example.com", "app.example.com"), false);
});

test("production refuses a split with no shareable parent", () => {
  const problem = crossOriginCookieProblem({
    webOrigin: "https://ensemble.vercel.app",
    apiOrigin: "https://api.example.com",
    cookieDomain: undefined,
  });
  assert.ok(problem);
  assert.match(problem, /do not share a parent domain/);
  assert.match(problem, /middleware/);
  assert.match(problem, /ENSEMBLE_COOKIE_DOMAIN/);
});

test("different hosts that share a parent require the cookie Domain", () => {
  const missing = crossOriginCookieProblem({
    webOrigin: "https://app.example.com",
    apiOrigin: "https://api.example.com",
    cookieDomain: undefined,
  });
  assert.match(missing ?? "", /ENSEMBLE_COOKIE_DOMAIN=\.example\.com/);
  assert.equal(
    crossOriginCookieProblem({
      webOrigin: "https://app.example.com",
      apiOrigin: "https://api.example.com",
      cookieDomain: ".example.com",
    }),
    null,
  );
});

test("the same host does not need a cookie Domain", () => {
  assert.equal(
    crossOriginCookieProblem({
      webOrigin: "https://hub.example",
      apiOrigin: "https://hub.example",
      cookieDomain: undefined,
    }),
    null,
  );
  assert.equal(crossOriginCookieProblem({ webOrigin: "https://hub.example", apiOrigin: undefined, cookieDomain: undefined }), null);
});
