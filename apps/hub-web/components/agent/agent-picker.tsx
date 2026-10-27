"use client";

/**
 * Who does the work, in one place: the agent (Ensemble's included models, the person's own AI
 * plans on their computer, or an API key), its model, and the model's thinking level, context
 * window and fast mode. Assign to agent, Settings → Models (one per task complexity) and Settings →
 * Run profiles all use it.
 */
import { Check, ChevronsUpDown, Search, Sparkles, Zap } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  claudeCodeModels,
  EFFORT_LABEL,
  ENGINE_LABELS,
  INCLUDED_LABEL,
  INCLUDED_PROVIDER,
  includedModelName,
  isCodeEngine,
  modelEfforts,
  orderLevels,
  parseSubscriptionAgents,
  SUBSCRIPTION_INFO,
  SUBSCRIPTION_PROVIDERS,
  type ContextTier,
  type EffortLevel,
  type ModelContext,
  type SubscriptionAgent,
  type UsageWindow,
} from "@ensemble/shared-types";
import type { ModelCatalog, SubscriptionComputer } from "@/lib/api";
import { relativeCost } from "@/lib/included";
import { contextChoice, contextSizes } from "@/lib/engine-models";
import { ProviderLogo, ModelLogo } from "../connectors/provider-logo";
import { Popover, Toggle, cx } from "../ui";

/** One choice of who does the work. `model` empty: the agent's own default. */
export type AgentChoice = { provider: string; model: string; effort: string; context?: ContextTier; fast?: boolean };

export type AgentSource = "included" | "plans" | "keys";

export type PickerModel = {
  id: string;
  label: string;
  /** Cost and context sizes, as the agent or catalog reports them. */
  hint: string | null;
  badge: string | null;
  levels: EffortLevel[];
  /** The level the model uses when none is chosen. */
  defaultEffort: EffortLevel | null;
  /** Context windows to choose from (more than one), else empty. */
  contexts: ModelContext[];
  fast: boolean;
  unavailable: string | null;
  isDefault: boolean;
};

export type PickerAgent = {
  id: string;
  label: string;
  source: AgentSource;
  /** Signed in and found, or a key that works. */
  ready: boolean;
  /** One short line: "signed in", "not signed in", "no key", "monthly credits"… */
  note: string;
  models: PickerModel[];
  /** A model name not in the list may be typed. */
  typed: boolean;
  limits?: UsageWindow[];
};

const SOURCE_LABEL: Record<AgentSource, string> = { included: "Included", plans: "Your AI plans", keys: "API keys" };

export const KEY_PROVIDER_LABEL: Record<string, string> = {
  google: "Gemini",
  openai: "OpenAI",
  anthropic: "Claude API",
  mistral: "Mistral",
  kimi: "Kimi",
  qwen: "Qwen",
  openrouter: "OpenRouter",
  copilot: "GitHub Copilot API",
  ollama: "Ollama",
};

const record = (value: unknown): Record<string, unknown> | null => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null);

function planModels(agent: SubscriptionAgent): PickerModel[] {
  return agent.models
    .filter((model) => model.id !== "default")
    .map((model) => ({
      id: model.id,
      label: model.label,
      hint: [model.cost, contextSizes(model.contexts)].filter(Boolean).join(" · ") || null,
      badge: null,
      levels: orderLevels(model.efforts ?? agent.efforts ?? []),
      defaultEffort: model.defaultEffort ? (orderLevels([model.defaultEffort])[0] ?? null) : null,
      contexts: model.contexts && model.contexts.length > 1 ? model.contexts : [],
      fast: Boolean(model.fast),
      unavailable: null,
      isDefault: Boolean(model.isDefault),
    }));
}

/**
 * Every agent the picker offers. `computer`: the computer whose AI plans are listed (the one the
 * run goes to, or the one tiers run on); `capabilities` stand in for a computer the subscriptions
 * list does not have yet.
 */
export function agentOptions(input: { catalog?: ModelCatalog | null; computer?: SubscriptionComputer | null; capabilities?: unknown; includedNote?: string | null; plans?: boolean; keys?: boolean }): PickerAgent[] {
  const agents: PickerAgent[] = [];
  const included = input.catalog?.providers.find((row) => row.provider === INCLUDED_PROVIDER && row.available && row.models.length);
  if (included) {
    agents.push({
      id: INCLUDED_PROVIDER,
      label: INCLUDED_LABEL,
      source: "included",
      ready: true,
      note: input.includedNote ?? "monthly credits",
      typed: false,
      models: included.models.map((id) => {
        const efforts = modelEfforts(INCLUDED_PROVIDER, id, included.meta?.[id]);
        return { id, label: includedModelName(id), hint: null, badge: relativeCost(id)?.badge ?? null, levels: efforts.levels, defaultEffort: efforts.fallback ?? null, contexts: [], fast: false, unavailable: null, isDefault: id === included.cheapest };
      }),
    });
  }
  if (input.plans !== false) {
    const reported = parseSubscriptionAgents(record(input.capabilities)?.agents);
    const where = input.computer?.name ?? null;
    for (const id of SUBSCRIPTION_PROVIDERS) {
      const found = input.computer?.agents.find((row) => row.id === id) ?? reported.find((row) => row.id === id) ?? null;
      // Claude Code's models are known before a computer reports them.
      const agent = found ?? (id === "claude-code" ? { id, via: "cli" as const, version: null, signedIn: null, models: claudeCodeModels(null), typedModels: true, checkedAt: "" } : null);
      const ready = Boolean(found && found.signedIn !== false && !found.problem);
      const note = !found
        ? where
          ? `not found on ${where}`
          : "not found yet"
        : found.problem
          ? "needs a look"
          : found.signedIn === false
            ? "not signed in"
            : [found.plan ? `${found.plan} plan` : null, found.account].filter(Boolean).join(" · ") || `${SUBSCRIPTION_INFO[id].label} plan`;
      agents.push({ id, label: ENGINE_LABELS[id], source: "plans", ready, note, models: agent ? planModels(agent) : [], typed: Boolean(agent?.typedModels) || !agent, limits: found?.limits });
    }
  }
  if (input.keys !== false) {
    for (const row of input.catalog?.providers ?? []) {
      if (row.provider === INCLUDED_PROVIDER || isCodeEngine(row.provider) || !row.chat || row.provider === "cursor" || row.provider === "mock") continue;
      const label = KEY_PROVIDER_LABEL[row.provider] ?? row.provider;
      const models = [...row.models].sort((a, b) => (a === row.cheapest ? -1 : b === row.cheapest ? 1 : 0)).slice(0, 80);
      agents.push({
        id: row.provider,
        label,
        source: "keys",
        ready: row.available,
        note: row.available ? (row.provider === "ollama" ? `${row.models.length} models here` : row.source === "account" ? "your account's key" : row.source === "env" || row.source === "cli" ? "server key" : "your key") : row.provider === "ollama" ? "not running" : "no key",
        typed: true,
        models: models.map((id) => {
          const efforts = modelEfforts(row.provider, id, row.meta?.[id]);
          const note = row.notes?.[id];
          return { id, label: id, hint: null, badge: id === row.cheapest ? "cheapest" : null, levels: efforts.levels, defaultEffort: efforts.fallback ?? null, contexts: [], fast: false, unavailable: note?.available === false ? note.reason || "This key cannot use it." : null, isDefault: false };
        }),
      });
    }
    // Providers the catalog did not list yet still show, so the person sees where a key would go.
    for (const [id, label] of Object.entries(KEY_PROVIDER_LABEL)) {
      if (agents.some((row) => row.id === id)) continue;
      agents.push({ id, label, source: "keys", ready: false, note: id === "ollama" ? "not running" : "no key: add one under Settings → Models", typed: true, models: [] });
    }
  }
  return agents;
}

/** The model a choice names, as the picker lists it; the agent's default when the choice names none. */
export function modelOf(agents: PickerAgent[], choice: Pick<AgentChoice, "provider" | "model"> | null): PickerModel | null {
  if (!choice) return null;
  const agent = agents.find((row) => row.id === choice.provider);
  if (!agent) return null;
  const id = choice.model.trim();
  if (!id || id === "default") return agent.models.find((row) => row.isDefault) ?? null;
  return agent.models.find((row) => row.id === id) ?? null;
}

/** A thinking level, context window or fast mode the model does not take goes back to its default. */
export function fitChoice(choice: AgentChoice, model: PickerModel | null): AgentChoice {
  const effort = choice.effort !== "default" && model && (model.levels as string[]).includes(choice.effort) ? choice.effort : "default";
  const context = choice.context === "long_context" && model?.contexts.some((row) => row.id === "long_context") ? "long_context" : undefined;
  return { provider: choice.provider, model: choice.model, effort, ...(context ? { context } : {}), ...(choice.fast && model?.fast ? { fast: true } : {}) };
}

function agentName(agent: PickerAgent | undefined, provider: string): string {
  return agent?.label ?? (isCodeEngine(provider) ? ENGINE_LABELS[provider] : KEY_PROVIDER_LABEL[provider] ?? provider);
}

/** "Claude Code · Sonnet 4.6", or "Included · Gemini 3.5 Flash". */
export function choiceLabel(agents: PickerAgent[], choice: Pick<AgentChoice, "provider" | "model">): string {
  const agent = agents.find((row) => row.id === choice.provider);
  const model = modelOf(agents, choice);
  const name = choice.provider === INCLUDED_PROVIDER ? "Included" : agentName(agent, choice.provider);
  const modelName = model?.label ?? (choice.model && choice.model !== "default" ? (choice.provider === INCLUDED_PROVIDER ? includedModelName(choice.model) : choice.model) : "its default model");
  return `${name} · ${modelName}`;
}

/** "High · 1M · Fast", or "" when nothing is set beyond the model's defaults. */
export function tuningLabel(choice: AgentChoice, model: PickerModel | null): string {
  const effort = choice.effort !== "default" ? (EFFORT_LABEL[choice.effort as EffortLevel] ?? choice.effort) : model?.defaultEffort ? `${EFFORT_LABEL[model.defaultEffort]} (auto)` : model?.levels.length ? "Auto" : "";
  const context = choice.context === "long_context" ? model?.contexts.find((row) => row.id === "long_context")?.label.split(" ")[0] ?? "Long context" : "";
  return [effort, context, choice.fast ? "Fast" : ""].filter(Boolean).join(" · ");
}

function UsageLine({ windows }: { windows: UsageWindow[] }) {
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 px-2.5 pb-1 text-[11px] text-faint" data-testid="agent-usage">
      {windows.map((window) => (
        <span key={window.id} className="flex items-center gap-1.5">
          {window.label}
          <span className="relative h-1 w-14 overflow-hidden rounded-full bg-line" aria-hidden>
            <span className={cx("absolute inset-y-0 left-0 rounded-full", window.usedPercent > 85 ? "bg-warn" : "bg-accent")} style={{ width: `${Math.round(window.usedPercent)}%` }} />
          </span>
          {Math.round(window.usedPercent)}%
        </span>
      ))}
    </div>
  );
}

/**
 * The agent and model, as one button. The panel has the sources as tabs (Included, Your AI plans,
 * API keys), each plan or key as a chip with whether it is ready, and the chosen agent's models with
 * their cost and context sizes. `auto`: the first row follows the task's complexity tier.
 */
export function AgentPicker({
  value,
  onChange,
  agents,
  auto,
  label,
}: {
  value: AgentChoice | null;
  onChange: (value: AgentChoice | null) => void;
  agents: PickerAgent[];
  auto?: { text: string; choice: AgentChoice | null } | null;
  label: string;
}) {
  const shownChoice = value ?? auto?.choice ?? null;
  const current = shownChoice ? agents.find((row) => row.id === shownChoice.provider) : undefined;
  const sources = (["included", "plans", "keys"] as const).filter((source) => agents.some((row) => row.source === source));
  const [tab, setTab] = useState<AgentSource>(current?.source ?? sources[0] ?? "plans");
  const [browsing, setBrowsing] = useState<string>(current?.id ?? "");
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (current) {
      setTab(current.source);
      setBrowsing(current.id);
    }
  }, [current?.id, current?.source]);
  const inTab = agents.filter((row) => row.source === tab).sort((a, b) => Number(b.ready) - Number(a.ready));
  const agent = inTab.find((row) => row.id === browsing) ?? inTab.find((row) => row.ready) ?? inTab[0];
  const needle = query.trim().toLowerCase();
  const models = useMemo(() => (agent?.models ?? []).filter((row) => !needle || row.id.toLowerCase().includes(needle) || row.label.toLowerCase().includes(needle) || Boolean(row.hint?.toLowerCase().includes(needle))), [agent, needle]);
  const plan = agent?.source === "plans";
  const custom = agent && needle && agent.typed && !agent.models.some((row) => row.id.toLowerCase() === needle) ? query.trim() : null;
  const rows: Array<{ key: string; pick: () => AgentChoice | null }> = [
    ...(auto && !needle ? [{ key: "\0auto", pick: () => null }] : []),
    ...(plan && agent && !needle ? [{ key: "\0default", pick: () => ({ provider: agent.id, model: "", effort: "default" }) }] : []),
    ...models.map((row) => ({ key: row.id, pick: () => ({ provider: agent!.id, model: row.id, effort: shownChoice?.effort ?? "default", context: shownChoice?.context, fast: shownChoice?.fast }) })),
    ...(custom && agent ? [{ key: `\0custom:${custom}`, pick: () => ({ provider: agent.id, model: custom, effort: "default" }) }] : []),
  ];
  useEffect(() => setActive(0), [needle, agent?.id, tab]);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [active]);
  const chosenModel = modelOf(agents, shownChoice);
  const isCurrent = (provider: string, model: string) => value !== null && value.provider === provider && (value.model || "") === model;
  return (
    <Popover
      fill
      width={440}
      maxHeight={480}
      trigger={(open, toggle) => (
        <button type="button" className="picker-trigger h-10" aria-haspopup="listbox" aria-expanded={open} aria-label={label} onClick={toggle} data-picker="agent">
          {value === null && auto ? <Sparkles size={15} className="shrink-0 text-accent" aria-hidden /> : shownChoice ? <ProviderLogo id={shownChoice.provider} size={16} /> : null}
          <span className="min-w-0 flex-1 truncate text-left">
            {value === null && auto ? (
              <>
                <span className="font-medium">Auto</span> <span className="text-muted">· {auto.text}</span>
              </>
            ) : shownChoice ? (
              <span className="font-medium">{choiceLabel(agents, shownChoice)}</span>
            ) : (
              <span className="text-muted">Choose who does the work</span>
            )}
          </span>
          {current && value !== null ? <span className="hidden shrink-0 rounded-full bg-hover px-1.5 py-px text-[10.5px] text-muted sm:inline">{current.source === "plans" ? "your plan" : current.source === "included" ? "credits" : "API key"}</span> : null}
          {chosenModel?.hint && value !== null ? <span className="hidden max-w-[11rem] shrink-0 truncate text-[11px] text-faint md:inline">{chosenModel.hint}</span> : null}
          <ChevronsUpDown size={13} className="shrink-0 text-faint" aria-hidden />
        </button>
      )}
    >
      {(close) => {
        const choose = (next: AgentChoice | null) => {
          onChange(next === null ? null : fitChoice(next, modelOf(agents, next)));
          setQuery("");
          close();
        };
        return (
          <div className="flex flex-col" data-agent-picker>
            {sources.length > 1 ? (
              <div role="tablist" aria-label="Where the model comes from" className="m-1 flex rounded-lg bg-panel p-0.5">
                {sources.map((source) => (
                  <button
                    key={source}
                    type="button"
                    role="tab"
                    aria-selected={tab === source}
                    className={cx("flex-1 rounded-md px-2 py-1.5 text-[12px] transition-colors", tab === source ? "bg-raised font-medium text-ink shadow-sm" : "text-muted hover:text-ink")}
                    onClick={() => {
                      setTab(source);
                      setBrowsing("");
                    }}
                  >
                    {SOURCE_LABEL[source]}
                  </button>
                ))}
              </div>
            ) : null}
            {tab !== "included" && inTab.length > 1 ? (
              <div className="flex flex-wrap gap-1 px-1 pb-1" role="radiogroup" aria-label={tab === "plans" ? "AI plan" : "API key"}>
                {inTab.map((row) => (
                  <button
                    key={row.id}
                    type="button"
                    role="radio"
                    aria-checked={agent?.id === row.id}
                    title={row.note}
                    onClick={() => setBrowsing(row.id)}
                    className={cx(
                      "flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[12px] transition-colors",
                      agent?.id === row.id ? "border-accent bg-[var(--accent-soft)] text-ink" : "border-line text-muted hover:text-ink",
                      !row.ready && "opacity-60",
                    )}
                  >
                    <span className={cx("size-1.5 shrink-0 rounded-full", row.ready ? "bg-ok" : "bg-warn")} aria-hidden />
                    <ProviderLogo id={row.id} size={12} />
                    {row.label}
                  </button>
                ))}
              </div>
            ) : null}
            {agent ? (
              <div className="flex items-center justify-between gap-2 px-2.5 pb-1 text-[11.5px]">
                <span className={agent.ready ? "text-muted" : "text-warn"}>
                  {agent.label}: {agent.note}
                </span>
              </div>
            ) : null}
            {agent?.limits?.length ? <UsageLine windows={agent.limits} /> : null}
            <label className="picker-search">
              <Search size={13} className="shrink-0 text-faint" aria-hidden />
              <input
                autoFocus
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    setActive((index) => Math.min(rows.length - 1, index + 1));
                  } else if (event.key === "ArrowUp") {
                    event.preventDefault();
                    setActive((index) => Math.max(0, index - 1));
                  } else if (event.key === "Enter") {
                    event.preventDefault();
                    const row = rows[active];
                    if (row) choose(row.pick());
                  }
                }}
                placeholder={agent ? (agent.models.length ? `Search ${agent.models.length} ${agent.label} models` : agent.typed ? "Type a model name" : "No models") : "Search models"}
                aria-label="Search models"
                className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-faint"
              />
            </label>
            <div ref={list} role="listbox" aria-label={label} className="min-h-0 flex-1 overflow-y-auto py-1">
              {rows.map((row, index) => {
                if (row.key === "\0auto" && auto) {
                  return (
                    <button key="auto" type="button" role="option" aria-selected={value === null} data-index={index} className={cx("picker-option", index === active && "is-active", value === null && "is-current")} onMouseEnter={() => setActive(index)} onClick={() => choose(null)}>
                      <Sparkles size={14} className="shrink-0 text-accent" aria-hidden />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[12.5px] font-medium">Auto: match the task</span>
                        <span className="block truncate text-[11.5px] text-faint">{auto.text}</span>
                      </span>
                      {value === null ? <Check size={13} className="shrink-0 text-accent" aria-hidden /> : null}
                    </button>
                  );
                }
                if (row.key === "\0default" && agent) {
                  const fallback = agent.models.find((model) => model.isDefault);
                  return (
                    <button key="default" type="button" role="option" aria-selected={isCurrent(agent.id, "")} data-index={index} className={cx("picker-option", index === active && "is-active", isCurrent(agent.id, "") && "is-current")} onMouseEnter={() => setActive(index)} onClick={() => choose(row.pick())}>
                      <ProviderLogo id={agent.id} size={14} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[12.5px]">{agent.label} default</span>
                        <span className="block truncate text-[11.5px] text-faint">{fallback ? fallback.label : "The model set in the agent itself"}</span>
                      </span>
                      {isCurrent(agent.id, "") ? <Check size={13} className="shrink-0 text-accent" aria-hidden /> : null}
                    </button>
                  );
                }
                if (row.key.startsWith("\0custom:") && custom) {
                  return (
                    <button key={row.key} type="button" role="option" aria-selected={false} data-index={index} className={cx("picker-option", index === active && "is-active")} onMouseEnter={() => setActive(index)} onClick={() => choose(row.pick())}>
                      <span className="min-w-0 flex-1 truncate text-[12.5px]">
                        Use <span className="font-mono">{custom}</span>
                      </span>
                      <span className="shrink-0 text-[11px] text-faint">not in the list</span>
                    </button>
                  );
                }
                const model = models.find((item) => item.id === row.key)!;
                const selected = agent ? isCurrent(agent.id, model.id) : false;
                return (
                  <button key={row.key} type="button" role="option" aria-selected={selected} data-index={index} className={cx("picker-option", index === active && "is-active", selected && "is-current")} onMouseEnter={() => setActive(index)} onClick={() => choose(row.pick())}>
                    <ModelLogo model={model.id} provider={agent?.id} />
                    <span className="min-w-0 flex-1">
                      <span className={cx("block truncate text-[12.5px]", agent?.source === "keys" && "font-mono")}>{model.label}</span>
                      {model.unavailable ? <span className="block truncate text-[11.5px] text-warn">{model.unavailable}</span> : model.hint ? <span className="block truncate text-[11.5px] text-faint">{model.hint}</span> : null}
                    </span>
                    {model.fast ? <Zap size={11} className="shrink-0 text-faint" aria-label="Has fast mode" /> : null}
                    {model.badge ? <span className="picker-badge">{model.badge}</span> : null}
                    {model.levels.length ? <span className="shrink-0 text-[11px] text-faint">{model.levels.length === 1 ? EFFORT_LABEL[model.levels[0]!] : `${EFFORT_LABEL[model.levels[0]!]}–${EFFORT_LABEL[model.levels[model.levels.length - 1]!]}`}</span> : null}
                    {selected ? <Check size={13} className="shrink-0 text-accent" aria-hidden /> : null}
                  </button>
                );
              })}
              {!rows.length ? <p className="px-2.5 py-2 text-[12.5px] text-muted">{agent ? (agent.ready ? `${agent.label} listed no models here.` : `${agent.label}: ${agent.note}.`) : "Nothing to choose here yet."}</p> : null}
            </div>
          </div>
        );
      }}
    </Popover>
  );
}

/**
 * The model's thinking level, context window and fast mode, as one small button beside the agent.
 * Renders nothing for a model with none of them.
 */
export function TuningPicker({ value, model, onChange, allowFast = true, label }: { value: AgentChoice; model: PickerModel | null; onChange: (value: AgentChoice) => void; allowFast?: boolean; label: string }) {
  const levels = model?.levels ?? [];
  const contexts = model?.contexts ?? [];
  const fast = allowFast && Boolean(model?.fast);
  if (!levels.length && !contexts.length && !fast) return null;
  const text = tuningLabel(value, model) || "Default";
  return (
    <Popover
      width={300}
      maxHeight={420}
      align="right"
      trigger={(open, toggle) => (
        <button type="button" className="picker-trigger h-10 w-auto shrink-0" aria-haspopup="dialog" aria-expanded={open} aria-label={label} onClick={toggle} data-picker="tuning">
          <span className="text-[11.5px] text-faint">Thinking</span>
          <span className="max-w-[10rem] truncate font-medium">{text}</span>
          <ChevronsUpDown size={13} className="shrink-0 text-faint" aria-hidden />
        </button>
      )}
    >
      {() => (
        <div className="space-y-3 p-2" data-tuning-picker>
          {levels.length ? (
            <div>
              <div className="mb-1.5 text-[12px] font-medium text-muted">Thinking</div>
              <div role="radiogroup" aria-label={`${label}: thinking`} className="thinking-levels">
                {[{ id: "default", text: `Auto${model?.defaultEffort ? ` (${EFFORT_LABEL[model.defaultEffort]})` : ""}` }, ...levels.map((level) => ({ id: level as string, text: EFFORT_LABEL[level] }))].map((option) => (
                  <button key={option.id} type="button" role="radio" aria-checked={value.effort === option.id} onClick={() => onChange({ ...value, effort: option.id })} className={cx("thinking-level", value.effort === option.id && "is-on")}>
                    {option.text}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          {contexts.length ? (
            <div>
              <div className="mb-1.5 text-[12px] font-medium text-muted">Context window</div>
              <div role="radiogroup" aria-label={`${label}: context window`} className="thinking-levels">
                {contexts.map((row) => {
                  const on = (value.context ?? "default") === row.id;
                  return (
                    <button key={row.id} type="button" role="radio" aria-checked={on} onClick={() => onChange({ ...value, context: row.id === "long_context" ? "long_context" : undefined })} className={cx("thinking-level", on && "is-on")}>
                      {contextChoice(row)}
                    </button>
                  );
                })}
              </div>
              <p className="mt-1 text-[11px] text-faint">Long fits more files and conversation, and may use more of your plan.</p>
            </div>
          ) : null}
          {fast ? (
            <div className="flex items-center justify-between gap-3" data-testid="engine-fast">
              <span>
                <span className="block text-[12.5px] font-medium">Fast mode</span>
                <span className="block text-[11px] text-faint">Faster output; uses more of your plan.</span>
              </span>
              <Toggle checked={value.fast === true} onChange={(on) => onChange({ ...value, fast: on || undefined })} label="Fast mode" />
            </div>
          ) : null}
        </div>
      )}
    </Popover>
  );
}
