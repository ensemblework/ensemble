import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_SETTINGS, Settings } from "./assistant.js";
import { OPTIONAL_MODULES } from "./modules.js";
import { ASSISTANT_SETTING_KEYS, findSettings, parseSettingValue, SETTINGS_MAP, type SettingRule } from "./settings-map.js";

function sample(rule: SettingRule): unknown {
  switch (rule.type) {
    case "enum":
      return rule.values[rule.values.length - 1];
    case "boolean":
      return "false";
    case "int":
      return rule.values ? rule.values[rule.values.length - 1] : rule.max;
    case "time":
      return "7:05";
    case "timezone":
      return "Europe/London";
    case "color":
      return "#12AB9f";
  }
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  const parts = path.split(".");
  const out: Record<string, unknown> = {};
  let node = out;
  parts.forEach((part, index) => {
    if (index === parts.length - 1) node[part] = value;
    else node = node[part] = {} as Record<string, unknown>;
  });
  return { ...target, ...out };
}

test("ids are unique and every entry links into a Settings tab", () => {
  assert.equal(new Set(SETTINGS_MAP.map((entry) => entry.id)).size, SETTINGS_MAP.length);
  for (const entry of SETTINGS_MAP) {
    assert.ok(entry.href.startsWith(`/settings?tab=${entry.tab}`), entry.id);
    assert.ok(entry.about.length > 10 && entry.about.length <= 120, `${entry.id}: one short line`);
    assert.equal(Boolean(entry.key), Boolean(entry.rule), `${entry.id}: a key needs a rule`);
  }
});

test("every changeable key exists in Settings and a valid value saves", () => {
  const features = new Set(OPTIONAL_MODULES.map((id) => `features.${id}`));
  for (const [key, entry] of ASSISTANT_SETTING_KEYS) {
    if (features.has(key)) continue;
    const parsed = parseSettingValue(entry.rule, sample(entry.rule));
    assert.ok(parsed.ok, key);
    const next = Settings.parse(setPath(DEFAULT_SETTINGS as unknown as Record<string, unknown>, key, parsed.value));
    const stored = key.split(".").reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], next);
    assert.deepEqual(stored, parsed.value, key);
  }
  for (const id of OPTIONAL_MODULES) assert.ok(ASSISTANT_SETTING_KEYS.has(`features.${id}`), id);
});

test("secrets, permissions, sandbox, folders and retention are never changeable", () => {
  const keys = [...ASSISTANT_SETTING_KEYS.keys()];
  for (const forbidden of [/writePolicy/, /allowedWriteAreas/, /connectedAppWrites/, /^autonomy/, /sandbox|outsideAccess|defaultExecution|runWithoutAsking|dailyHighRiskLimit/, /^terminal/, /^code\./, /^connections/, /connectorProducts/, /^email$/, /retentionDays|undoDepth/, /runProfiles/, /ollamaUrl|embedding/, /\.model$|\.provider$/]) {
    assert.ok(!keys.some((key) => forbidden.test(key)), `${forbidden} must not be changeable`);
  }
});

test("values are parsed strictly", () => {
  const tz = ASSISTANT_SETTING_KEYS.get("timezone")!.rule;
  assert.equal(parseSettingValue(tz, "Mars/Olympus").ok, false);
  assert.equal(parseSettingValue(tz, "+05:30").ok, false);
  assert.deepEqual(parseSettingValue({ type: "time" }, "7:05"), { ok: true, value: "07:05" });
  assert.equal(parseSettingValue({ type: "time" }, "25:00").ok, false);
  assert.deepEqual(parseSettingValue({ type: "boolean" }, true), { ok: true, value: true });
  assert.deepEqual(parseSettingValue({ type: "color" }, "none"), { ok: true, value: null });
  assert.equal(parseSettingValue({ type: "int", min: 1, max: 30, values: [1, 2, 3, 7, 14, 30] }, 5).ok, false);
  assert.deepEqual(parseSettingValue({ type: "enum", values: ["dark", "light"] }, "Light"), { ok: true, value: "light" });
});

test("a few words find the right setting", () => {
  assert.equal(findSettings("quiet hours")[0]?.id, "quiet.enabled");
  assert.equal(findSettings("api key for openai")[0]?.id, "models.keys");
  assert.equal(findSettings("dark mode")[0]?.id, "appearance.theme");
  assert.equal(findSettings("time zone")[0]?.id, "account.timezone");
  assert.equal(findSettings("turn off plots")[0]?.id, "features.plots");
  assert.equal(findSettings("morning brief time")[0]?.id, "brief.time");
  assert.deepEqual(findSettings("the"), []);
  assert.ok(findSettings("connected apps", { guest: true }).every((entry) => !entry.ownerOnly));
});

 test("appearance settings are changeable without exposing permissions", () => { for (const key of ["appearance.theme", "appearance.font", "appearance.textScale", "appearance.reduceMotion"]) assert.ok(ASSISTANT_SETTING_KEYS.has(key), key); });
