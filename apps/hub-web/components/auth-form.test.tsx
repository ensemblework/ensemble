import { setTestUrl } from "./ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthForm, authRedirectTarget } from "./auth-form.js";
import { HUB_API } from "@/lib/api";

(globalThis as { React?: typeof React }).React = React;
Object.defineProperty(globalThis, "self", { configurable: true, value: window });

test("open registration offers configured social logins without connector scopes and email password signup", async () => {
  setTestUrl("http://localhost/signup");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { gcTime: 0 } } });
  client.setQueryData(["auth-status"], {
    hasAccounts: true, signup: "open", bypass: false,
    providers: ["google", "github", "microsoft"], emailConfigured: true, turnstileSiteKey: null,
  });

  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify(client.getQueryData(["auth-status"])), { headers: { "Content-Type": "application/json" } });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><AuthForm mode="signup" /></QueryClientProvider>));
    assert.match(host.textContent ?? "", /Create your account/);
    assert.doesNotMatch(host.textContent ?? "", /invite only/i);
    for (const provider of ["google", "github", "microsoft"]) {
      assert.ok(host.querySelector(`a[href="${HUB_API}/api/auth/oauth/${provider}/start"]`), provider);
    }
    assert.ok(host.querySelector("input[type=email]"));
    assert.equal(host.querySelector<HTMLInputElement>("input[type=password]")?.minLength, 8);
    assert.equal(host.querySelector<HTMLButtonElement>("button[type=submit]")?.disabled, false);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    client.clear();
    globalThis.fetch = realFetch;
    setTestUrl("http://localhost/");
  }
});

test("unconfigured hosted signup hides the unusable email form but keeps available providers", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const providers of [[], ["google"]]) {
      const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { gcTime: 0 } } });
      const status = { hasAccounts: true, signup: "open", bypass: false, providers, emailConfigured: false, emailSignupAvailable: false, turnstileSiteKey: null };
      client.setQueryData(["auth-status"], status);
      globalThis.fetch = async () => new Response(JSON.stringify(status), { headers: { "Content-Type": "application/json" } });
      const host = document.createElement("div");
      document.body.appendChild(host);
      const root = createRoot(host);
      try {
        await act(async () => root.render(<QueryClientProvider client={client}><AuthForm mode="signup" /></QueryClientProvider>));
        assert.equal(host.querySelector("input[type=email]"), null);
        assert.equal(host.querySelector("button[type=submit]"), null);
        assert.match(host.querySelector('[role="alert"]')?.textContent ?? "", providers.length ? /configured providers/ : /not available/);
        assert.equal(host.querySelectorAll(`a[href^="${HUB_API}/api/auth/oauth/"]`).length, providers.length);
      } finally {
        await act(async () => root.unmount());
        host.remove();
        client.clear();
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("signup with verification mail goes to the code page before onboarding", () => {
  assert.equal(authRedirectTarget("signup", { verificationSent: true }, null), "/verify?next=/start");
  assert.equal(authRedirectTarget("signup", { verificationSent: false }, null), "/start");
  assert.equal(authRedirectTarget("login", {}, "/context"), "/context");
  assert.equal(authRedirectTarget("login", {}, "https://evil.example"), "/today");
});

function typeInto(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function mountForm(mode: "login" | "signup", respond: (path: string) => Response) {
  setTestUrl(`http://localhost/${mode}`);
  const status = { hasAccounts: true, signup: "open", bypass: false, providers: [], emailConfigured: true, turnstileSiteKey: null };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { gcTime: 0, retry: false } } });
  client.setQueryData(["auth-status"], status);
  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input).replace(/^https?:\/\/[^/]+/, "");
    if (path === "/api/auth/status") return new Response(JSON.stringify(status), { headers: { "Content-Type": "application/json" } });
    calls.push(path);
    return respond(path);
  }) as typeof fetch;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(<QueryClientProvider client={client}><AuthForm mode={mode} /></QueryClientProvider>));
  return {
    host,
    calls,
    email: () => host.querySelector<HTMLInputElement>("input[type=email]")!,
    password: () => host.querySelector<HTMLInputElement>("input[autocomplete$=password]")!,
    submit: async () => {
      await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
      for (let i = 0; i < 4; i += 1) await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    },
    done: async () => {
      await act(async () => root.unmount());
      host.remove();
      client.clear();
      globalThis.fetch = realFetch;
      setTestUrl("http://localhost/");
    },
  };
}

test("a wrong sign-in is announced, marks both fields invalid, and clears when you type again", async () => {
  const view = await mountForm("login", () => new Response(JSON.stringify({ error: "Email or password is wrong." }), { status: 401, headers: { "Content-Type": "application/json" } }));
  try {
    await act(async () => {
      typeInto(view.email(), "mira@fieldnote.example");
      typeInto(view.password(), "not-the-password");
    });
    await view.submit();
    const alert = view.host.querySelector("#auth-error");
    assert.equal(alert?.getAttribute("role"), "alert");
    assert.match(alert?.textContent ?? "", /wrong/);
    for (const field of [view.email(), view.password()]) {
      assert.equal(field.getAttribute("aria-invalid"), "true");
      assert.match(field.getAttribute("aria-describedby") ?? "", /auth-error/);
    }
    await act(async () => typeInto(view.password(), "not-the-password2"));
    assert.equal(view.host.querySelector("#auth-error"), null);
    assert.equal(view.password().hasAttribute("aria-invalid"), false);
    assert.equal(view.email().hasAttribute("aria-invalid"), false);
  } finally {
    await view.done();
  }
});

test("sign-up shows the password rule first and refuses a password of spaces without asking the server", async () => {
  const view = await mountForm("signup", () => new Response(JSON.stringify({ user: { id: "u1" } }), { headers: { "Content-Type": "application/json" } }));
  try {
    assert.match(view.host.textContent ?? "", /At least 8 characters/);
    assert.match(view.password().getAttribute("aria-describedby") ?? "", /rule/);
    await act(async () => {
      typeInto(view.email(), "mira@fieldnote.example");
      typeInto(view.password(), "        ");
    });
    await view.submit();
    assert.deepEqual(view.calls, []);
    assert.equal(view.password().getAttribute("aria-invalid"), "true");
    assert.match(view.host.querySelector('[role="alert"]')?.textContent ?? "", /only spaces/);
    assert.ok(view.host.querySelector('button[aria-label="Show password"]'));
  } finally {
    await view.done();
  }
});
