/**
 * Settings for the assistant: where a setting lives (with a link), the current values of the
 * settings it may change, and changing those.
 *
 * Only keys in ASSISTANT_SETTING_KEYS (packages/shared-types/src/settings-map.ts) can change,
 * and every change waits for Apply whatever the write policy (`alwaysHold`). A change saves
 * the way PATCH /api/settings does (`saveSettings`, then `mirrorSettings` when the person keeps
 * every space in sync) and a Features switch the way PUT /api/settings/modules does
 * (`setOwnModule`, this space only). Settings changes are journalled, so Undo puts them back.
 */
import { z } from "zod";
import {
  ASSISTANT_SETTING_KEYS,
  describeRule,
  findSettings,
  hasModule,
  parseSettingValue,
  SETTINGS_MAP,
  SETTINGS_MAP_TABS,
  settingsPlace,
  type OptionalModule,
  type Settings,
  type SettingRule,
  type SettingsMapEntry,
} from "@ensemble/shared-types";
import { loadSettings, saveSettings } from "../../lib/settings.js";
import { setOwnModule } from "../../lib/own-modules.js";
import { recordUndoInTransaction } from "../../lib/undo.js";
import { isGuestIn, keysFor } from "../../sharing/context.js";
import { mirrorSettings } from "../../spaces/store.js";
import { defineTool, inTransaction, toolOk, ToolBlockedError, type ToolContext } from "../types.js";
import { effortToSend } from "../../lib/model-meta.js";
import { sseHub } from "../../lib/sse.js";
import { assistantRequest } from "../request.js";

type Value = string | number | boolean | null;
type Changeable = SettingsMapEntry & { key: string; rule: SettingRule };
type Planned = { entry: Changeable; feature: OptionalModule | null; before: Value; after: Value };

const FEATURE = /^features\.([a-z]+)$/;

function read(settings: Settings, key: string): Value {
  const value = key.split(".").reduce<unknown>((node, part) => (node && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined), settings);
  return value === undefined ? null : (value as Value);
}

function nest(key: string, value: Value): Record<string, unknown> {
  return key
    .split(".")
    .reverse()
    .reduce<unknown>((inner, part) => ({ [part]: inner }), value) as Record<string, unknown>;
}

function merge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const current = out[key];
    out[key] = value && typeof value === "object" && current && typeof current === "object" ? merge(current as Record<string, unknown>, value as Record<string, unknown>) : value;
  }
  return out;
}

const shown = (value: Value) => (value === null ? "none" : typeof value === "string" ? value : String(value));

/** The map entry a model named: its key, its id or its label, in any case. */
function lookup(name: string): SettingsMapEntry | undefined {
  const wanted = name.trim().toLowerCase();
  const key = [...ASSISTANT_SETTING_KEYS.keys()].find((candidate) => candidate.toLowerCase() === wanted);
  if (key) return ASSISTANT_SETTING_KEYS.get(key);
  return SETTINGS_MAP.find((entry) => entry.id.toLowerCase() === wanted || entry.label.toLowerCase() === wanted);
}

async function moduleSet(ctx: ToolContext): Promise<string | null> {
  const row = await (ctx.tx ?? ctx.prisma).user.findUnique({ where: { id: ctx.userId }, select: { moduleSet: true } });
  return row?.moduleSet ?? null;
}

async function currentValue(ctx: ToolContext, entry: Changeable, settings: Settings, modules: string | null): Promise<Value> {
  const feature = FEATURE.exec(entry.key)?.[1];
  return feature ? hasModule(modules, feature as OptionalModule) : read(settings, entry.key);
}

async function plan(ctx: ToolContext, changes: Array<{ key: string; value: string }>): Promise<Planned[]> {
  const guest = isGuestIn(ctx.userId);
  const settings = await loadSettings(ctx.tx ?? ctx.prisma, ctx.userId);
  const modules = await moduleSet(ctx);
  const problems: string[] = [];
  const planned = new Map<string, Planned>();
  for (const change of changes) {
    const entry = lookup(change.key);
    if (!entry) {
      problems.push(`${change.key}: no such setting. Call hub_find_setting with a few words to find it.`);
      continue;
    }
    if (!entry.key || !entry.rule) {
      problems.push(`${entry.label} is for the person to change in ${settingsPlace(entry)}: give them this link: ${entry.href}`);
      continue;
    }
    if (guest && entry.ownerOnly) {
      problems.push(`${entry.label}: in a space shared with you only its owner can change this.`);
      continue;
    }
    const parsed = parseSettingValue(entry.rule, change.value);
    if (!parsed.ok) {
      problems.push(`${entry.key}: ${parsed.error}`);
      continue;
    }
    const changeable = entry as Changeable;
    const feature = (FEATURE.exec(entry.key)?.[1] as OptionalModule | undefined) ?? null;
    planned.set(entry.key, { entry: changeable, feature, before: await currentValue(ctx, changeable, settings, modules), after: parsed.value });
  }
  if (problems.length) throw new ToolBlockedError(problems.join(" "));
  return [...planned.values()];
}

/** True when the account whose settings these are keeps every space's settings the same. */
async function syncedAcrossSpaces(ctx: ToolContext): Promise<boolean> {
  const db = ctx.tx ?? ctx.prisma;
  const owner = keysFor(ctx.userId);
  const me = await db.user.findUnique({ where: { id: owner }, select: { ownerId: true } });
  if (!me) return false;
  const account = await db.user.findUnique({ where: { id: me.ownerId ?? owner }, select: { spaceSettingsSync: true } });
  return Boolean(account?.spaceSettingsSync);
}

const line = (row: Planned) => `${row.entry.label}: ${shown(row.before)} → ${shown(row.after)}`;
const changed = (row: Planned) => row.before !== row.after;

const ChangeInput = z.object({
  key: z.string().min(1).max(80).describe("A key from hub_find_setting or hub_get_settings, such as quietHours.from."),
  value: z
    .preprocess((value) => (typeof value === "number" || typeof value === "boolean" ? String(value) : value === null ? "none" : value), z.string().max(64))
    .describe("The new value as text: true or false, a number, HH:MM, or one of the allowed values."),
});

export const settingsTools = [
  defineTool({
    name: "hub_find_setting",
    area: "context",
    description:
      "Find where a setting lives from a few words (\"dark mode\", \"api key\", \"quiet hours\", \"turn off plots\"). Returns up to 5 matches with a link to give the person and, when you may change it, its key, allowed values and current value for hub_update_settings.",
    input: z.object({ query: z.string().min(2).max(120) }),
    isWrite: false,
    risk: "low",
    async run(ctx, input) {
      const matches = findSettings(input.query, { guest: isGuestIn(ctx.userId) });
      if (!matches.length) {
        const tabs = Object.entries(SETTINGS_MAP_TABS).map(([tab, label]) => ({ tab: label, link: `/settings?tab=${tab}` }));
        return toolOk(`No setting matches “${input.query}”. Try other words, or point the person to a Settings tab.`, { settings: [], tabs }, { href: "/settings" });
      }
      const settings = await loadSettings(ctx.prisma, ctx.userId);
      const modules = await moduleSet(ctx);
      const rows = await Promise.all(
        matches.map(async (entry) => ({
          label: entry.label,
          where: settingsPlace(entry),
          about: entry.about,
          link: entry.href,
          change:
            entry.key && entry.rule
              ? { key: entry.key, values: describeRule(entry.rule), current: await currentValue(ctx, entry as Changeable, settings, modules) }
              : "Only the person can change this, in Settings: give them the link.",
        })),
      );
      return toolOk(`Found ${rows.length} setting(s) for “${input.query}”.`, { settings: rows }, { href: matches[0]!.href });
    },
  }),
  defineTool({
    name: "hub_get_settings",
    area: "context",
    description:
      "Current values of the settings you may change (time zone, quiet hours, morning brief, nudges, accent colour, assistant tone and preset, model thinking, features). Pass keys or prefixes such as quietHours to narrow it.",
    input: z.object({ keys: z.array(z.string().min(1).max(80)).max(20).optional().describe("Keys or prefixes; leave out for all.") }),
    isWrite: false,
    risk: "low",
    async run(ctx, input) {
      const guest = isGuestIn(ctx.userId);
      const settings = await loadSettings(ctx.prisma, ctx.userId);
      const modules = await moduleSet(ctx);
      const wanted = (input.keys ?? []).map((key) => key.trim().toLowerCase()).filter(Boolean);
      const values: Record<string, Value> = {};
      for (const [key, entry] of ASSISTANT_SETTING_KEYS) {
        if (guest && entry.ownerOnly) continue;
        if (wanted.length && !wanted.some((prefix) => key.toLowerCase().startsWith(prefix))) continue;
        values[key] = await currentValue(ctx, entry, settings, modules);
      }
      const count = Object.keys(values).length;
      if (!count) return toolOk("No setting you may change matches those keys. Call hub_find_setting with a few words.", { values });
      return toolOk(`Read ${count} setting(s).`, { values, note: "Change them with hub_update_settings. Anything else: hub_find_setting gives the link." }, { href: "/settings" });
    },
  }),
  defineTool({
    name: "hub_update_settings",
    area: "context",
    description:
      "Change settings the person asked for: a list of {key, value} with keys from hub_find_setting or hub_get_settings. Always waits for the person's Apply. API keys, passwords, sign-in, sharing, connections, the assistant's permissions, sandbox, folders and deletion are refused: give the link from hub_find_setting instead.",
    input: z.object({ changes: z.array(ChangeInput).min(1).max(8) }),
    isWrite: true,
    risk: "medium",
    alwaysHold: true,
    // Saving can copy settings into the account's other spaces (Keep every space in sync), after the save commits.
    outsideTransaction: true,
    undoable: true,
    async preview(ctx, input) {
      const rows = await plan(ctx, input.changes);
      const moving = rows.filter(changed);
      if (!moving.length) return `Already set: ${rows.map((row) => `${row.entry.label} is ${shown(row.after)}`).join("; ")}. Nothing to change.`;
      const features = moving.filter((row) => row.feature);
      const lines = moving.map((row) => `- ${line(row)}`);
      const back = [
        moving.some((row) => !row.feature) ? "Undo in the app bar puts the settings back" : "",
        features.length ? `switch ${features.map((row) => row.entry.label.replace(/ feature$/, "")).join(", ")} back in Settings → Account → Features` : "",
      ]
        .filter(Boolean)
        .join("; ");
      const synced = moving.some((row) => !row.feature) && (await syncedAcrossSpaces(ctx)) ? "\nKeep every space in sync is on, so your other spaces get the same settings." : "";
      return `Change ${moving.length === 1 ? "a setting" : `${moving.length} settings`}:\n${lines.join("\n")}${synced}\nTo change it back: ${back}.`;
    },
    async run(ctx, input) {
      const rows = (await plan(ctx, input.changes)).filter(changed);
      if (!rows.length) return toolOk("Nothing changed: those settings already had those values.");
      const settingsRows = rows.filter((row) => !row.feature);
      const featureRows = rows.filter((row) => row.feature);
      let undoEntryId: string | undefined;
      if (settingsRows.length) {
        const patch = settingsRows.reduce<Record<string, unknown>>((out, row) => merge(out, nest(row.entry.key, row.after)), {});
        const owner = keysFor(ctx.userId);
        const entry = await inTransaction(ctx, async (tx) => {
          const before = await tx.preference.findFirst({ where: { userId: owner, key: "hub.settings", deletedAt: null }, select: { id: true, value: true } });
          await saveSettings(tx, ctx.userId, patch);
          const after = await tx.preference.findFirst({ where: { userId: owner, key: "hub.settings", deletedAt: null }, select: { id: true, value: true, updatedAt: true } });
          if (!before || !after) return undefined;
          return recordUndoInTransaction(tx, {
            userId: ctx.userId,
            label: `Settings: ${settingsRows.map(line).join("; ")}`,
            kind: "update",
            actor: "agent",
            subject: "settings",
            href: settingsRows[0]!.entry.href,
            inverse: { op: "update", model: "preference", id: after.id, before: { value: after.value }, after: { value: before.value } },
            forward: { op: "update", model: "preference", id: after.id, before: { value: before.value }, after: { value: after.value, updatedAt: after.updatedAt } },
          });
        });
        if (entry && entry !== "grouped") undoEntryId = entry;
        // As PATCH /api/settings: in a space shared with you, your own account's settings and spaces.
        if (!ctx.tx) await mirrorSettings(ctx.prisma, owner);
      }
      for (const row of featureRows) {
        if (isGuestIn(ctx.userId)) throw new ToolBlockedError("In a space shared with you only its owner can switch features.");
        await setOwnModule(ctx.prisma, ctx.userId, row.feature!, row.after === true);
      }
      const appearance = Object.fromEntries(settingsRows.filter(row => row.entry.key.startsWith("appearance.")).map(row => [row.entry.key.slice("appearance.".length), row.after]));
      if (Object.keys(appearance).length) sseHub.publish(ctx.userId, { event: "assistant.acted", data: { keys: ["settings"], appearance } });
      return toolOk(
        `Changed ${rows.map(line).join("; ")}.${undoEntryId ? " Undo in the app bar puts the settings back." : ""}`,
        { changed: rows.map((row) => ({ key: row.entry.key, from: row.before, to: row.after })) },
        { href: rows[0]!.entry.href, ...(undoEntryId ? { undoEntryId } : {}), invalidate: ["settings", "shell"] },
      );
    },
  }),
  defineTool({ name: "hub_list_model_choices", area: "context", description: "List the person's available model IDs/providers for settings, including included Ensemble models. Does not reveal keys or invoke a model. Use before hub_choose_model.", input: z.object({ provider: z.string().max(40).optional(), query: z.string().max(100).default("") }), isWrite: false, risk: "low", async run(ctx, input) {
    const result = await assistantRequest(ctx, "GET", "/api/models");
    const providers = (result.providers ?? []).filter((row: any) => !input.provider || row.provider === input.provider).map((row: any) => ({ provider: row.provider, available: row.available !== false, models: (row.models ?? []).filter((model: string) => model.toLowerCase().includes(input.query.toLowerCase())).slice(0, 50), error: row.error }));
    return toolOk("Read available model choices.", { providers, current: ctx.settings.models });
  } }),
  defineTool({ name: "hub_choose_model", area: "context", description: "Set a model tier to an exact provider/model from hub_list_model_choices. Uses existing keys or included credits; changes no credentials or permissions. Resets thinking to Automatic unless an effort is supplied. Always waits for Apply.", input: z.object({ tier: z.enum(["easy", "medium", "high", "max"]), provider: z.string().max(40), model: z.string().min(1).max(240), effort: z.string().max(30).default("default") }), isWrite: true, risk: "low", alwaysHold: true, outsideTransaction: true,
    preview(_ctx, input) { return `Use ${input.provider} / ${input.model} for ${input.tier} (${input.effort}).`; },
    async run(ctx, input) {
      const catalog = await assistantRequest(ctx, "GET", "/api/models");
      const provider = catalog.providers?.find((row: any) => row.provider === input.provider);
      if (!provider?.models?.includes(input.model)) throw new Error("That model is not available. Read hub_list_model_choices again.");
      await effortToSend(ctx.userId, input.provider, input.model, input.effort);
      await assistantRequest(ctx, "PATCH", "/api/settings", { models: { [input.tier]: { provider: input.provider, model: input.model, effort: input.effort } } });
      return toolOk(`Updated the ${input.tier} model.`, input, { href: "/settings?tab=assistant", invalidate: ["settings", "models"] });
    }
  }),
];
