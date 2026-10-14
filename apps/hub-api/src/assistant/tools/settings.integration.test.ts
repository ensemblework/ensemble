/**
 * The assistant's settings tools against PGlite: finding a setting, reading the values it may
 * change, and changing them through the same save path as PATCH /api/settings and
 * PUT /api/settings/modules. Unsafe keys are refused, the change is journalled for Undo, and a
 * second space of the same account is neither read nor changed (unless the person keeps every
 * space in sync, which the preview says).
 */
import assert from "node:assert/strict";
import test, { after } from "node:test";
import { hasModule, OPTIONAL_MODULES, serializeModules, Settings } from "@ensemble/shared-types";
import type { PrismaClient } from "@prisma/client";
import { createHttpHarness } from "../../test/http.js";
import type { AnyHubTool, ToolContext } from "../types.js";

const harness = await createHttpHarness();
after(() => harness.close());
const { getTool } = await import("../registry.js");
const { holdsAssistantWrite } = await import("../agent.js");
const { createSpaceUser } = await import("../../spaces/store.js");
const { loadSettings, saveSettings } = await import("../../lib/settings.js");
const { undoLast } = await import("../../lib/undo.js");
const { runInScope } = await import("../../sharing/context.js");
const db = harness.prisma as PrismaClient;

const ALL = serializeModules(OPTIONAL_MODULES);

function ctx(userId: string): ToolContext {
  return { app: harness.app, prisma: db, userId, actor: "agent", settings: Settings.parse({}), modules: ALL, conversationId: "chat-1" };
}

function tool(name: string): AnyHubTool {
  const found = getTool(name);
  assert.ok(found, name);
  return found;
}

async function call(name: string, context: ToolContext, input: unknown = {}) {
  const found = tool(name);
  return found.run(context, found.input.parse(input));
}

async function preview(name: string, context: ToolContext, input: unknown): Promise<string> {
  const found = tool(name);
  assert.ok(found.preview);
  return found.preview(context, found.input.parse(input));
}

const mira = await harness.asUser();
const sideId = await createSpaceUser(db, mira.id, { name: "Side", icon: null });
await db.user.update({ where: { id: sideId }, data: { moduleSet: ALL } });
await saveSettings(db, mira.id, { timezone: "Asia/Kolkata", quietHours: { from: "19:00" } });
await saveSettings(db, sideId, { timezone: "America/New_York", quietHours: { from: "22:30" } });

test("hub_update_settings always waits for Apply, outside the batch transaction", () => {
  const update = tool("hub_update_settings");
  assert.equal(update.isWrite, true);
  assert.equal(update.area, "context");
  assert.equal(update.alwaysHold, true);
  assert.equal(update.outsideTransaction, true);
  assert.equal(holdsAssistantWrite("immediate", update.name, false, update.area, update.alwaysHold), true);
  for (const name of ["hub_find_setting", "hub_get_settings"]) assert.equal(tool(name).isWrite, false, name);
});

test("hub_find_setting gives the link, and the key and current value when the assistant may change it", async () => {
  const quiet = await call("hub_find_setting", ctx(mira.id), { query: "quiet hours start" });
  const rows = (quiet.data as { settings: Array<{ label: string; link: string; where: string; change: { key: string; current: unknown } | string }> }).settings;
  const start = rows.find((row) => row.label === "Quiet hours start");
  assert.ok(start);
  assert.equal(start.link, "/settings?tab=assistant#jump-quiet-quiet-hours-start");
  assert.deepEqual(start.change, { key: "quietHours.from", values: "HH:MM (24-hour)", current: "19:00" });

  const keys = await call("hub_find_setting", ctx(mira.id), { query: "api key" });
  const first = (keys.data as { settings: Array<{ label: string; link: string; change: unknown }> }).settings[0]!;
  assert.equal(first.label, "API keys");
  assert.equal(first.link, "/settings?tab=assistant&dialog=keys");
  assert.match(String(first.change), /Only the person/);

  const nothing = await call("hub_find_setting", ctx(mira.id), { query: "zzqx" });
  assert.match(nothing.summary, /No setting matches/);
});

test("hub_get_settings reads this space's values only", async () => {
  const mine = await call("hub_get_settings", ctx(mira.id), { keys: ["quietHours", "timezone"] });
  assert.deepEqual((mine.data as { values: Record<string, unknown> }).values, { timezone: "Asia/Kolkata", "quietHours.enabled": true, "quietHours.from": "19:00", "quietHours.until": "08:00" });
  const all = (await call("hub_get_settings", ctx(mira.id))).data as { values: Record<string, unknown> };
  assert.equal(all.values["features.plots"], hasModule(ALL, "plots"));
  assert.ok(!("assistant.writePolicy" in all.values));
  assert.ok(!JSON.stringify(all).includes("America/New_York"), "never the other space's");
});

test("hub_update_settings previews before → after, saves through the settings path, and Undo puts it back", async () => {
  const input = { changes: [{ key: "quietHours.from", value: "21:00" }, { key: "timezone", value: "Europe/London" }, { key: "morningBrief.enabled", value: false }] };
  const text = await preview("hub_update_settings", ctx(mira.id), input);
  assert.match(text, /Quiet hours start: 19:00 → 21:00/);
  assert.match(text, /Time zone: Asia\/Kolkata → Europe\/London/);
  assert.match(text, /Morning brief: true → false/);
  assert.match(text, /Undo in the app bar/);
  assert.doesNotMatch(text, /other spaces/);
  // Nothing is saved by a preview.
  assert.equal((await loadSettings(db, mira.id)).quietHours.from, "19:00");

  const result = await call("hub_update_settings", ctx(mira.id), input);
  assert.ok(result.undoEntryId);
  const saved = await loadSettings(db, mira.id);
  assert.equal(saved.quietHours.from, "21:00");
  assert.equal(saved.timezone, "Europe/London");
  assert.equal(saved.morningBrief.enabled, false);
  assert.equal(saved.quietHours.until, "08:00", "the rest of the section is kept");
  const other = await loadSettings(db, sideId);
  assert.equal(other.quietHours.from, "22:30");
  assert.equal(other.timezone, "America/New_York");

  const entry = await db.undoEntry.findUniqueOrThrow({ where: { id: result.undoEntryId! } });
  assert.equal(entry.actor, "agent");
  await undoLast(db, mira.id, result.undoEntryId);
  const back = await loadSettings(db, mira.id);
  assert.equal(back.quietHours.from, "19:00");
  assert.equal(back.timezone, "Asia/Kolkata");
  assert.equal(back.morningBrief.enabled, true);
});

test("unsafe, unknown and malformed changes are refused with the link instead", async () => {
  const refuse = async (key: string, value: unknown, pattern: RegExp) => {
    await assert.rejects(() => preview("hub_update_settings", ctx(mira.id), { changes: [{ key, value }] }), pattern, key);
    await assert.rejects(() => call("hub_update_settings", ctx(mira.id), { changes: [{ key, value }] }), pattern, key);
  };
  await refuse("assistant.write-policy", "immediate", /for the person to change in Settings → Assistant → The assistant: give them this link: \/settings\?tab=assistant#jump-assistant-write-policy/);
  await refuse("Email", "attacker@example.test", /for the person to change/);
  await refuse("API keys", "sk-123", /dialog=keys/);
  await refuse("orchestration.sandbox", false, /for the person to change/);
  await refuse("data.delete", true, /for the person to change/);
  await refuse("assistant.writePolicy", "immediate", /no such setting/);
  await refuse("models.easy.model", "gpt-9", /no such setting/);
  await refuse("terminal.enabled", false, /for the person to change/);
  await refuse("timezone", "Mars/Olympus", /IANA time zone/);
  await refuse("quietHours.from", "9pm", /HH:MM/);
  await refuse("appearance.theme", "light", /Kept in each browser|for the person to change/);
  // One bad change stops the whole batch.
  await assert.rejects(() => call("hub_update_settings", ctx(mira.id), { changes: [{ key: "timezone", value: "UTC" }, { key: "account.password", value: "x" }] }), /Change password/);
  const settings = await loadSettings(db, mira.id);
  assert.equal(settings.assistant.writePolicy, "preview");
  assert.equal(settings.timezone, "Asia/Kolkata");
  assert.equal(settings.email, "you@ensemble.local");
});

test("a Features switch changes this space only; other spaces keep theirs", async () => {
  const text = await preview("hub_update_settings", ctx(mira.id), { changes: [{ key: "features.plots", value: "off" }] });
  assert.match(text, /Plots feature: true → false/);
  assert.match(text, /switch Plots back in Settings → Account → Features/);
  await call("hub_update_settings", ctx(mira.id), { changes: [{ key: "features.plots", value: "off" }] });
  const [home, side] = await Promise.all([
    db.user.findUniqueOrThrow({ where: { id: mira.id }, select: { moduleSet: true } }),
    db.user.findUniqueOrThrow({ where: { id: sideId }, select: { moduleSet: true } }),
  ]);
  assert.equal(hasModule(home.moduleSet, "plots"), false);
  assert.equal(hasModule(side.moduleSet, "plots"), true);
  const sessions = await db.session.findMany({ where: { userId: mira.id } });
  assert.ok(sessions.every((row) => !hasModule(row.modules, "plots")), "the signed-in sessions follow");
  await call("hub_update_settings", ctx(mira.id), { changes: [{ key: "features.plots", value: true }] });
});

test("someone a space is shared with changes only their own settings, never the owner's features", async () => {
  const guest = await harness.asUser();
  const scope = { spaceId: mira.id, accountId: guest.id, access: { kind: "member" as const, role: "editor" as const, ownerId: mira.id } };
  await runInScope(scope, async () => {
    await assert.rejects(() => call("hub_update_settings", ctx(mira.id), { changes: [{ key: "features.code", value: false }] }), /only its owner/);
    const values = ((await call("hub_get_settings", ctx(mira.id))).data as { values: Record<string, unknown> }).values;
    assert.ok(!Object.keys(values).some((key) => key.startsWith("features.")));
    await call("hub_update_settings", ctx(mira.id), { changes: [{ key: "timezone", value: "Europe/Paris" }] });
  });
  assert.equal((await loadSettings(db, guest.id)).timezone, "Europe/Paris");
  assert.equal((await loadSettings(db, mira.id)).timezone, "Asia/Kolkata");
  assert.equal(hasModule((await db.user.findUniqueOrThrow({ where: { id: mira.id } })).moduleSet, "code"), true);
});

test("with every space kept in sync, the preview says so and the change reaches the other spaces", async () => {
  await db.user.update({ where: { id: mira.id }, data: { spaceSettingsSync: true } });
  try {
    const input = { changes: [{ key: "staleNudge.untouchedDays", value: 21 }] };
    assert.match(await preview("hub_update_settings", ctx(mira.id), input), /Keep every space in sync is on/);
    await call("hub_update_settings", ctx(mira.id), input);
    assert.equal((await loadSettings(db, mira.id)).staleNudge.untouchedDays, 21);
    assert.equal((await loadSettings(db, sideId)).staleNudge.untouchedDays, 21);
  } finally {
    await db.user.update({ where: { id: mira.id }, data: { spaceSettingsSync: false } });
  }
});
