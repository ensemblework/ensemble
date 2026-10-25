/**
 * Claude Code's models as its `--model` flag takes them: for each, the thinking levels (`--effort`)
 * it takes and the one it uses by default, its context window (a fixed size, or 200K with a 1M
 * window chosen by the `[1m]` suffix), and the Claude Code version that first runs it. The Claude
 * tile, the Assign dialog and the CLI offer exactly these, and a run sends exactly these.
 *
 * The table follows T3 Code's model manifest (`apps/server/src/provider/model-manifest.json` in
 * pingdotgg/t3code, MIT License, Copyright (c) 2026 T3 Tools Inc.). T3 Code's prompt-word levels
 * (`ultrathink`, `ultracode`) are not offered.
 */
import type { EffortLevel } from "./model-efforts.js";
import type { ModelContext, SubscriptionModel } from "./subscriptions.js";

type ClaudeWindow = { fixed: number } | { standard: number; long: number };

type ClaudeProfile = {
  efforts: EffortLevel[];
  defaultEffort: EffortLevel | null;
  /** A level the menu shows that Claude Code takes under another name (`--effort`). */
  effortMap?: Partial<Record<EffortLevel, EffortLevel>>;
  window: ClaudeWindow;
  /** Has Claude Code's fast mode. */
  fast?: boolean;
};

const FIVE: EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];
const FOUR: EffortLevel[] = ["low", "medium", "high", "max"];
const ONE_M = 1_000_000;
const TWO_HUNDRED_K = 200_000;

const PROFILES: Record<string, ClaudeProfile> = {
  "fable-5": { efforts: FIVE, defaultEffort: "medium", window: { fixed: ONE_M } },
  "opus-5-5": { efforts: FIVE, defaultEffort: "medium", window: { fixed: ONE_M }, fast: true },
  "opus-5": { efforts: FIVE, defaultEffort: "high", window: { fixed: ONE_M }, fast: true },
  "opus-4-8": { efforts: FIVE, defaultEffort: "high", window: { fixed: ONE_M }, fast: true },
  "opus-4-7": { efforts: FIVE, defaultEffort: "xhigh", effortMap: { xhigh: "max" }, window: { fixed: ONE_M }, fast: true },
  "opus-4-6": { efforts: FOUR, defaultEffort: "high", window: { standard: TWO_HUNDRED_K, long: ONE_M }, fast: true },
  "opus-4-5": { efforts: FOUR, defaultEffort: "high", window: { fixed: TWO_HUNDRED_K }, fast: true },
  "sonnet-5": { efforts: FIVE, defaultEffort: "high", window: { fixed: ONE_M } },
  "sonnet-4-6": { efforts: FOUR, defaultEffort: "high", effortMap: { max: "high" }, window: { standard: TWO_HUNDRED_K, long: ONE_M } },
  "haiku-5-5": { efforts: FIVE, defaultEffort: "medium", window: { fixed: ONE_M } },
  "haiku-4-5": { efforts: [], defaultEffort: null, window: { fixed: TWO_HUNDRED_K } },
};

export type ClaudeModelEntry = {
  id: string;
  label: string;
  /** Other names Claude Code takes for it; `opus`, `sonnet`, `haiku` and `fable` follow the newest. */
  aliases: string[];
  /** The newest model of its family. */
  current: boolean;
  profile: keyof typeof PROFILES;
  /** The first Claude Code version that runs it. */
  minVersion?: string;
};

/** Newest first within the current models, then the earlier ones. */
export const CLAUDE_MODELS: ClaudeModelEntry[] = [
  { id: "claude-fable-5-1", label: "Claude Fable 5.1", aliases: ["fable", "fable-5.1", "claude-fable-5.1"], current: true, profile: "fable-5", minVersion: "2.1.257" },
  { id: "claude-opus-5-5", label: "Claude Opus 5.5", aliases: ["opus", "opus-5.5", "claude-opus-5.5"], current: true, profile: "opus-5-5", minVersion: "2.1.280" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", aliases: ["sonnet", "sonnet-5.5", "claude-sonnet-5.5"], current: true, profile: "sonnet-5", minVersion: "2.1.284" },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5", aliases: ["haiku", "haiku-5.5", "claude-haiku-5.5"], current: true, profile: "haiku-5-5", minVersion: "2.1.293" },
  { id: "claude-fable-5", label: "Claude Fable 5", aliases: [], current: false, profile: "fable-5", minVersion: "2.1.169" },
  { id: "claude-opus-5", label: "Claude Opus 5", aliases: ["opus-5", "claude-opus-5.0", "claude-opus-5-0"], current: false, profile: "opus-5", minVersion: "2.1.219" },
  { id: "claude-opus-4-8", label: "Claude Opus 4.8", aliases: ["opus-4.8", "claude-opus-4.8"], current: false, profile: "opus-4-8", minVersion: "2.1.154" },
  { id: "claude-opus-4-7", label: "Claude Opus 4.7", aliases: ["opus-4.7", "claude-opus-4.7"], current: false, profile: "opus-4-7", minVersion: "2.1.111" },
  { id: "claude-opus-4-6", label: "Claude Opus 4.6", aliases: ["opus-4.6", "claude-opus-4.6", "claude-opus-4-6-20251117"], current: false, profile: "opus-4-6" },
  { id: "claude-opus-4-5", label: "Claude Opus 4.5", aliases: [], current: false, profile: "opus-4-5" },
  { id: "claude-sonnet-5", label: "Claude Sonnet 5", aliases: ["sonnet-5", "claude-sonnet-5.0", "claude-sonnet-5-0"], current: false, profile: "sonnet-5" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", aliases: ["sonnet-4.6", "claude-sonnet-4.6", "claude-sonnet-4-6-20251117"], current: false, profile: "sonnet-4-6" },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", aliases: ["haiku-4.5", "claude-haiku-4.5", "claude-haiku-4-5-20251001"], current: false, profile: "haiku-4-5" },
];

const LONG_SUFFIX = "[1m]";

/** 2.1.304 against 2.1.280: negative when `a` is older. */
export function compareVersions(a: string, b: string): number {
  const left = a.split(/[.\-+]/).map((part) => Number.parseInt(part, 10));
  const right = b.split(/[.\-+]/).map((part) => Number.parseInt(part, 10));
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (Number.isFinite(left[index]) ? left[index]! : 0) - (Number.isFinite(right[index]) ? right[index]! : 0);
    if (difference) return difference;
  }
  return 0;
}

/** A model by its id or any alias, with or without the `[1m]` suffix. */
export function claudeModel(id: string | null | undefined): (ClaudeModelEntry & { spec: ClaudeProfile }) | null {
  const name = (id ?? "").trim().toLowerCase().replace(/\[1m\]$/, "");
  if (!name || name === "default") return null;
  const entry = CLAUDE_MODELS.find((row) => row.id === name || row.aliases.includes(name));
  return entry ? { ...entry, spec: PROFILES[entry.profile]! } : null;
}

const size = (tokens: number) => (tokens >= ONE_M ? `${tokens / ONE_M}M` : `${Math.round(tokens / 1000)}K`);

function contexts(window: ClaudeWindow): ModelContext[] {
  if ("fixed" in window) return [{ id: "default", label: size(window.fixed), tokens: window.fixed }];
  return [
    { id: "default", label: size(window.standard), tokens: window.standard },
    { id: "long_context", label: size(window.long), tokens: window.long },
  ];
}

/**
 * The models this Claude Code runs, as the menus show them: "Your plan's default" first, then each
 * model the installed version can run (an unknown version lists them all; the run reports one it
 * cannot use).
 */
export function claudeCodeModels(version: string | null): SubscriptionModel[] {
  const runs = (entry: ClaudeModelEntry) => !version || !entry.minVersion || compareVersions(version, entry.minVersion) >= 0;
  return [
    { id: "default", label: "Your plan's default", isDefault: true, description: "The model Claude Code picks for your plan." },
    ...CLAUDE_MODELS.filter(runs).map((entry): SubscriptionModel => {
      const spec = PROFILES[entry.profile]!;
      return {
        id: entry.id,
        label: entry.label,
        ...(entry.aliases.length ? { aliases: entry.aliases } : {}),
        efforts: spec.efforts,
        ...(spec.defaultEffort ? { defaultEffort: spec.defaultEffort } : {}),
        contexts: contexts(spec.window),
        vision: true,
        ...(spec.fast ? { fast: "on" } : {}),
        description: entry.current ? "Anthropic · newest" : "Anthropic · earlier model",
      };
    }),
  ];
}

/** One model as Claude Code's own `initialize` reply lists it for the signed-in plan. */
export type ClaudeCodeListed = {
  value?: string;
  resolvedModel?: string;
  displayName?: string;
  description?: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: string[];
  supportsFastMode?: boolean;
};

/**
 * The models as Claude Code itself lists them (its `initialize` reply: the plan's picks, each with
 * its thinking levels and whether it has fast mode), with the context window and default level from
 * the table, followed by the earlier models this version still runs. Without a list, the table.
 */
export function claudeCodeModelsFrom(listed: ClaudeCodeListed[] | null | undefined, version: string | null): SubscriptionModel[] {
  const table = claudeCodeModels(version);
  if (!listed?.length) return table;
  const out: SubscriptionModel[] = [];
  const covered = new Set<string>();
  for (const row of listed) {
    const id = (row.value ?? "").trim();
    if (!id || out.some((model) => model.id === id)) continue;
    const entry = claudeModel(row.resolvedModel) ?? claudeModel(id);
    if (entry && id !== "default") covered.add(entry.id);
    const efforts = row.supportsEffort === false ? [] : (row.supportedEffortLevels ?? entry?.spec.efforts ?? []).filter((level): level is EffortLevel => FIVE.includes(level as EffortLevel));
    out.push({
      id,
      label: (row.displayName ?? entry?.label ?? id).slice(0, 120),
      ...(id === "default" ? { isDefault: true } : {}),
      ...(entry && entry.id !== id ? { aliases: [entry.id] } : {}),
      ...(efforts.length ? { efforts } : {}),
      ...(entry?.spec.defaultEffort && efforts.includes(entry.spec.defaultEffort) ? { defaultEffort: entry.spec.defaultEffort } : {}),
      ...(entry ? { contexts: contexts(entry.spec.window) } : {}),
      vision: true,
      ...(row.supportsFastMode ? { fast: "on" } : {}),
      ...(row.description ? { description: row.description.slice(0, 240) } : {}),
    });
  }
  return [...out, ...table.filter((model) => model.id !== "default" && !covered.has(model.id))].slice(0, 120);
}

/** The newest model this Claude Code cannot run yet, as a sentence for the person. */
export function claudeUpdateNote(version: string | null): string | null {
  if (!version) return null;
  const missing = CLAUDE_MODELS.filter((entry) => entry.current && entry.minVersion && compareVersions(version, entry.minVersion) < 0);
  if (!missing.length) return null;
  const needed = missing.map((entry) => entry.minVersion!).sort(compareVersions).pop()!;
  return `Claude Code ${version} cannot run ${missing.map((entry) => entry.label).join(", ")}. Update it to ${needed} or newer (\`claude update\`).`;
}

/**
 * What a run passes to Claude Code for the chosen model, thinking level and context window:
 * `--model` (with `[1m]` for the long window where the model has one) and `--effort` under the name
 * Claude Code takes. A choice the model does not take is left out, with a note for the run.
 */
export function claudeLaunch(choice: { model?: string | null; effort?: string | null; context?: "long_context" | "default" | null; fast?: boolean }): { model: string | null; effort: string | null; fast?: true; notes: string[] } {
  const notes: string[] = [];
  const raw = (choice.model ?? "").trim();
  const named = raw && raw !== "default" ? raw.replace(/\[1m\]$/i, "") : "";
  const entry = claudeModel(named);
  const wantsLong = choice.context === "long_context" || /\[1m\]$/i.test(raw);
  let model: string | null = named || null;
  if (wantsLong) {
    if (entry && "long" in entry.spec.window) model = `${named}${LONG_SUFFIX}`;
    else if (entry && "fixed" in entry.spec.window) notes.push(`${entry.label} has one context window (${size(entry.spec.window.fixed)}); it runs with that.`);
    else if (named) model = `${named}${LONG_SUFFIX}`;
    else notes.push("The plan's default model runs with its own context window; pick a model to choose the 1M window.");
  }
  let effort: string | null = null;
  const level = (choice.effort ?? "").trim().toLowerCase();
  if (level && level !== "default") {
    if (!entry) effort = FIVE.includes(level as EffortLevel) ? level : null;
    else if (entry.spec.efforts.includes(level as EffortLevel)) effort = entry.spec.effortMap?.[level as EffortLevel] ?? level;
    if (!effort) notes.push(`${entry?.label ?? (named || "This model")} does not take thinking “${level}”; it runs at its default.`);
  }
  // Fast mode: Claude Code's `fastMode` setting, for a model that has it (the plan's default is checked by Claude Code).
  if (choice.fast && entry && !entry.spec.fast) notes.push(`${entry.label} has no fast mode; it runs at its usual speed.`);
  const fast = choice.fast === true && (!entry || entry.spec.fast === true);
  return { model, effort, ...(fast ? { fast: true as const } : {}), notes };
}
