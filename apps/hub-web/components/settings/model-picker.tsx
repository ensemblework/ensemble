"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { INCLUDED_PROVIDER, includedModel, includedModelName, isSubscriptionProvider } from "@ensemble/shared-types";
import { relativeCost } from "@/lib/included";
import { ProviderLogo, ModelLogo } from "../connectors/provider-logo";
import { Check, ChevronsUpDown, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { EFFORT_LABEL, effortList, modelEfforts, type EffortLevel, type ModelMeta } from "@ensemble/shared-types";
import { Popover, cx } from "../ui";

/**
 * "plan": the person's own subscription, found on their computer; "plan-missing": not found or not signed in there.
 * "included": Ensemble's own models with credits to spend; "included-out": credits used, or paused for everyone.
 */
export type ProviderChoice = { id: string; label: string; status: "key" | "account" | "server" | "none" | "local" | "plan" | "plan-missing" | "included" | "included-out"; note?: string };

type SourceTab = "included" | "subscriptions" | "api";

const TAB_LABEL: Record<SourceTab, string> = { included: "Included", subscriptions: "AI app subscriptions", api: "API keys" };

const tabOf = (id: string): SourceTab => (id === INCLUDED_PROVIDER ? "included" : isSubscriptionProvider(id) ? "subscriptions" : "api");

const STATUS_DOT: Record<ProviderChoice["status"], string> = {
  key: "bg-ok",
  account: "bg-ok",
  server: "bg-accent",
  local: "bg-muted",
  none: "bg-line-strong",
  plan: "bg-ok",
  "plan-missing": "bg-warn",
  included: "bg-ok",
  "included-out": "bg-warn",
};

const STATUS_TEXT: Record<ProviderChoice["status"], string> = {
  key: "your key",
  account: "your account's key",
  server: "server key",
  local: "on this computer",
  none: "no key",
  plan: "your plan",
  "plan-missing": "not on your computer",
  included: "monthly credits",
  "included-out": "no credits left",
};

/** The provider of a tier: a menu with whether each one has a key. */
export function ProviderPicker({ value, choices, onPick, label }: { value: string; choices: ProviderChoice[]; onPick: (id: string) => void; label: string }) {
  const current = choices.find((choice) => choice.id === value);
  const client = useQueryClient();
  const prefs = useQuery({ queryKey: ["preferences"], queryFn: api.preferences });
  const saved = prefs.data?.preferences.find((row) => row.key === "ui.model-picker-tab")?.value;
  const [chosen, setChosen] = useState<SourceTab | null>(null);
  const tabs: SourceTab[] = choices.some((choice) => choice.id === INCLUDED_PROVIDER) ? ["included", "subscriptions", "api"] : ["subscriptions", "api"];
  const remembered = tabs.find((id) => id === saved);
  const tab = chosen ?? remembered ?? (tabs.includes(tabOf(value)) ? tabOf(value) : "api");
  const remember = useMutation({ mutationFn: (next: string) => api.putPreference("ui.model-picker-tab", next), onSuccess: () => client.invalidateQueries({ queryKey: ["preferences"] }) });
  useEffect(() => setChosen(null), [saved]);
  const shown = choices.filter((choice) => tabOf(choice.id) === tab);
  return (
    <Popover
      fill
      width={340}
      trigger={(open, toggle) => (
        <button type="button" className="picker-trigger" aria-haspopup="listbox" aria-expanded={open} aria-label={label} onClick={toggle} data-picker="provider">
          <span className={cx("size-1.5 shrink-0 rounded-full", STATUS_DOT[current?.status ?? "none"])} aria-hidden />
          <ProviderLogo id={value} size={15} /><span className="min-w-0 flex-1 truncate text-left">{current?.label ?? value}</span>
          <ChevronsUpDown size={13} className="shrink-0 text-faint" aria-hidden />
        </button>
      )}
    >
      {(close) => (
        <div>
          <div role="tablist" aria-label="Model source" className="m-1 flex rounded-lg bg-raised p-1">
            {tabs.map((id) => <button type="button" key={id} role="tab" aria-selected={tab === id} className={cx("flex-1 rounded-md px-2 py-2 text-[12px]", tab === id ? "bg-panel font-medium text-ink shadow-sm" : "text-muted")} onClick={() => { setChosen(id); remember.mutate(id); }}>{TAB_LABEL[id]}</button>)}
          </div>
          <div role="listbox" aria-label={label}>
          {shown.map((choice) => (
            <button
              key={choice.id}
              type="button"
              role="option"
              aria-selected={choice.id === value}
              className={cx("picker-option", choice.id === value && "is-current")}
              onClick={() => {
                onPick(choice.id);
                close();
              }}
            >
              <span className={cx("size-1.5 shrink-0 rounded-full", STATUS_DOT[choice.status])} aria-hidden />
              <ProviderLogo id={choice.id} size={15} /><span className="min-w-0 flex-1 truncate">{choice.label}</span>
              <span className="shrink-0 text-[11.5px] text-faint">{choice.note ?? STATUS_TEXT[choice.status]}</span>
              {choice.id === value ? <Check size={13} className="shrink-0 text-accent" aria-hidden /> : null}
            </button>
          ))}
          </div>
        </div>
      )}
    </Popover>
  );
}

/** "Low–Max" for a row, or nothing when the model has no thinking setting. */
export function levelRange(levels: readonly EffortLevel[]): string {
  if (!levels.length) return "";
  return levels.length === 1 ? EFFORT_LABEL[levels[0]!] : `${EFFORT_LABEL[levels[0]!]}–${EFFORT_LABEL[levels[levels.length - 1]!]}`;
}

/** `name`: an included model's name with its version, which is shown instead of the id. */
type ModelRow = { id: string; name: string | null; cheapest: boolean; levels: EffortLevel[]; unavailable: string | null };

/**
 * The model of a tier: the provider's list for this key, searchable, with the cheapest first and
 * each model's thinking levels. A name not in the list can still be typed and used.
 */
export function ModelPicker({
  value,
  provider,
  models,
  cheapest,
  meta,
  notes,
  hasKey,
  providerLabel,
  label,
  onPick,
}: {
  value: string;
  provider: string;
  models: string[];
  cheapest: string | null;
  meta?: Record<string, ModelMeta>;
  notes?: Record<string, { available: boolean; reason: string | null }>;
  hasKey: boolean;
  providerLabel: string;
  label: string;
  onPick: (model: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const included = provider === INCLUDED_PROVIDER;
  const rows = useMemo<ModelRow[]>(() => {
    const all = models.map((id) => ({
      id,
      name: provider === INCLUDED_PROVIDER ? includedModelName(id) : null,
      cheapest: id === cheapest,
      levels: modelEfforts(provider, id, meta?.[id]).levels,
      unavailable: notes?.[id]?.available === false ? notes[id]!.reason || "This key cannot use it." : null,
    }));
    return [...all.filter((row) => row.cheapest), ...all.filter((row) => !row.cheapest)];
  }, [models, cheapest, provider, meta, notes]);
  const needle = query.trim().toLowerCase();
  const shown = needle ? rows.filter((row) => row.id.toLowerCase().includes(needle) || Boolean(row.name?.toLowerCase().includes(needle))) : rows;
  // Included models are a fixed list: a typed name would only be refused.
  const custom = needle && !included && !rows.some((row) => row.id.toLowerCase() === needle) ? query.trim() : null;
  const count = shown.length + (custom ? 1 : 0);
  useEffect(() => setActive(0), [needle]);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [active]);
  const levels = modelEfforts(provider, value, meta?.[value]).levels;
  return (
    <Popover
      fill
      width={380}
      trigger={(open, toggle) => (
        <button type="button" className="picker-trigger" aria-haspopup="listbox" aria-expanded={open} aria-label={label} onClick={toggle} data-picker="model">
          <ModelLogo model={value} provider={provider} />
          {included && value ? <span className="min-w-0 flex-1 truncate text-left">{includedModelName(value)}</span> : <span className="min-w-0 flex-1 truncate text-left font-mono text-[12.5px]">{value || "Choose a model"}</span>}
          {levels.length ? <span className="hidden shrink-0 text-[11px] text-faint sm:inline">Thinking: {levelRange(levels)}</span> : null}
          <ChevronsUpDown size={13} className="shrink-0 text-faint" aria-hidden />
        </button>
      )}
    >
      {(close) => {
        const pick = (model: string) => {
          onPick(model);
          setQuery("");
          close();
        };
        return (
          <div className="flex flex-col" data-model-picker>
            <label className="picker-search">
              <Search size={13} className="shrink-0 text-faint" aria-hidden />
              <input
                autoFocus
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    setActive((index) => Math.min(count - 1, index + 1));
                  } else if (event.key === "ArrowUp") {
                    event.preventDefault();
                    setActive((index) => Math.max(0, index - 1));
                  } else if (event.key === "Enter") {
                    event.preventDefault();
                    const row = shown[active];
                    if (row) pick(row.id);
                    else if (custom) pick(custom);
                  }
                }}
                placeholder={rows.length ? `Search ${rows.length} ${providerLabel} models` : included ? "No included models" : "Type a model name"}
                aria-label="Search models"
                className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-faint"
              />
            </label>
            <div ref={list} role="listbox" aria-label={label} className="max-h-[260px] overflow-y-auto py-1">
              {!rows.length ? (
                <p className="px-2.5 py-2 text-[12.5px] text-muted">
                  {included
                    ? "Included models are not set up on this server. Use an API key or your AI plan instead."
                    : hasKey
                      ? `${providerLabel} listed no models for this key. Refresh the list, or type a model name.`
                      : `Add a ${providerLabel} key to see its models. You can still type a name.`}
                </p>
              ) : null}
              {shown.map((row, index) => (
                <button
                  key={row.id}
                  type="button"
                  role="option"
                  aria-selected={row.id === value}
                  data-index={index}
                  className={cx("picker-option", index === active && "is-active", row.id === value && "is-current")}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => pick(row.id)}
                >
                  {row.name ? <ModelLogo model={row.id} provider={provider} /> : null}
                  <span className="min-w-0 flex-1">
                    {row.name ? <span className="block truncate text-[12.5px]">{row.name}</span> : <span className="block truncate font-mono text-[12.5px]">{row.id}</span>}
                    {row.unavailable ? <span className="block truncate text-[11.5px] text-warn">{row.unavailable}</span> : null}
                  </span>
                  {row.name ? <CostBadge id={row.id} /> : row.cheapest ? <span className="picker-badge">cheapest</span> : null}
                  {row.levels.length ? <span className="shrink-0 text-[11px] text-faint">{levelRange(row.levels)}</span> : null}
                  {row.id === value ? <Check size={13} className="shrink-0 text-accent" aria-hidden /> : null}
                </button>
              ))}
              {custom ? (
                <button
                  type="button"
                  role="option"
                  aria-selected={false}
                  data-index={shown.length}
                  className={cx("picker-option", active === shown.length && "is-active")}
                  onMouseEnter={() => setActive(shown.length)}
                  onClick={() => pick(custom)}
                >
                  <span className="min-w-0 flex-1 truncate text-[12.5px]">
                    Use <span className="font-mono">{custom}</span>
                  </span>
                  <span className="shrink-0 text-[11px] text-faint">not in the list</span>
                </button>
              ) : null}
            </div>
          </div>
        );
      }}
    </Popover>
  );
}

function CostBadge({ id }: { id: string }) {
  const cost = relativeCost(id);
  return cost ? <span className="picker-badge" title={cost.title} data-cost={cost.badge}>{cost.badge}</span> : null;
}

/**
 * How hard a tier's model thinks: exactly the levels that model takes, and the model's default.
 * What is chosen here is what the provider receives.
 */
export function ThinkingPicker({
  provider,
  providerLabel,
  model,
  meta,
  value,
  onChange,
  label,
}: {
  provider: string;
  providerLabel: string;
  model: string;
  meta?: ModelMeta | null;
  value: string;
  onChange: (value: string) => void;
  label: string;
}) {
  const known = modelEfforts(provider, model, meta);
  // An included model without levels still offers Auto, its one choice.
  const included = provider === INCLUDED_PROVIDER && Boolean(includedModel(model));
  if (!known.levels.length && !included) {
    return (
      <p className="text-[12px] text-faint" data-thinking="none" data-jump-label={label}>
        {known.source === "unknown" ? "No verified thinking options for this model. Its default is used." : model ? `${model} has no thinking setting.` : "Pick a model to see its thinking levels."}
        {value !== "default" ? " Nothing is sent for it." : ""}
      </p>
    );
  }
  const options: Array<{ id: string; label: string }> = [
    { id: "default", label: `${provider === INCLUDED_PROVIDER ? "Auto" : "Automatic"}${known.fallback ? ` (${EFFORT_LABEL[known.fallback]})` : ""}` },
    ...known.levels.map((level) => ({ id: level, label: EFFORT_LABEL[level] })),
  ];
  const offered = options.some((option) => option.id === value);
  return (
    <div className="space-y-1" data-thinking={known.source}>
      <div role="radiogroup" aria-label={label} className="thinking-levels">
        {options.map((option) => (
          <button key={option.id} type="button" role="radio" aria-checked={value === option.id} onClick={() => onChange(option.id)} className={cx("thinking-level", value === option.id && "is-on")}>
            {option.label}
          </button>
        ))}
      </div>
      {offered ? (
        null
      ) : known.levels.length ? (
        <p className="text-[12px] text-warn" role="status">
          {included ? includedModelName(model) : model} does not take “{EFFORT_LABEL[value as EffortLevel] ?? value}”, so calls on this tier are refused until you pick one of {effortList(known.levels)}.
        </p>
      ) : (
        <p className="text-[12px] text-faint" role="status">
          {includedModelName(model)} decides how much to think, so “{EFFORT_LABEL[value as EffortLevel] ?? value}” is not sent.
        </p>
      )}
    </div>
  );
}

/** A level the new model does not take goes back to the model's default. */
export function effortFor(provider: string, model: string, meta: ModelMeta | null | undefined, effort: string): string {
  if (effort === "default") return effort;
  return (modelEfforts(provider, model, meta).levels as string[]).includes(effort) ? effort : "default";
}
