import assert from "node:assert/strict";
import test from "node:test";
import { Settings } from "@ensemble/shared-types";
import { parentChoice, profileChoice, resolveRole, roleForStep, rolesEnabled } from "./roles.js";
import { STEP_KINDS } from "./report.js";

test("Roles resolve a delegated run's agent and model in a fixed order, with a reason code, and never fall back silently", () => {
  const all = {
    explicit: { agent: "codex" },
    assignment: { model: "gpt-6.1-sol" },
    profileRoles: { review: { model: "sonnet" } },
    globalRoles: { review: { agent: "claude-code" as const, model: "opus" }, implementation: { model: "opus" } },
    parent: { agent: "claude-code", model: "haiku" },
    subscriptionDefault: { agent: "claude-code" },
  };
  const reasons: string[] = [];
  let sources: Parameters<typeof resolveRole>[1] = all;
  for (const drop of ["explicit", "assignment", "profileRoles", "globalRoles", "parent", "subscriptionDefault", null] as const) {
    const resolved = resolveRole("review", sources);
    reasons.push(resolved.ok ? resolved.reason : resolved.reason);
    if (drop) sources = { ...sources, [drop]: null };
  }
  assert.deepEqual(reasons, ["explicit_request", "assignment_override", "profile_role", "global_role", "parent_at_creation", "subscription_default", "unresolved"]);
  assert.deepEqual(resolveRole("review", { ...all, explicit: null, assignment: null }), { ok: true, role: "review", reason: "profile_role", choice: { model: "sonnet" } });
  assert.equal((resolveRole("security", { ...all, explicit: null, assignment: null }) as { reason: string }).reason, "parent_at_creation", "a role left out inherits");
  assert.equal(
    (resolveRole("review", { globalRoles: { review: { agent: "codex" as const, effort: "high" as const } }, subscriptionDefault: { agent: "claude-code" } }) as { reason: string }).reason,
    "subscription_default",
    "a role with no model is not on",
  );
  const none = resolveRole("docs", {});
  assert.ok(!none.ok && /No agent or model is set for docs work/.test(none.error));
});

test("a step's kind is its role; Roles are off unless turned on; the parent and the profile count only on an owner's agent", () => {
  // Every kind a plan step can have (node/report.ts): a verify step runs the checks, a review step is an independent review.
  assert.deepEqual([...STEP_KINDS, null].map(roleForStep), ["implementation", "test", "review", "writing", "research", "general", "general"]);
  const settings = Settings.parse({});
  assert.equal(rolesEnabled(settings, undefined), false);
  assert.equal(rolesEnabled(Settings.parse({ node: { roles: { enabled: true } } }), undefined), true);
  assert.equal(rolesEnabled(settings, "1"), true, "the server's beta switch");
  assert.deepEqual(parentChoice({ provider: "claude-code", model: "opus" }), { agent: "claude-code", model: "opus" });
  assert.equal(parentChoice({ provider: "included", model: "gpt-5-mini" }), null);
  assert.deepEqual(profileChoice({ engine: "codex", model: "" }), { agent: "codex" });
  assert.equal(profileChoice({ engine: "ensemble", model: "x" }), null);
});
