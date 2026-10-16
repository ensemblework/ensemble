"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { ASSISTANT_UNAVAILABLE, assistantErrorText } from "@ensemble/shared-types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, Check, CircleAlert, CircleCheck, Eye, EyeOff, KeyRound, Search, SlidersHorizontal, Trash2, X, Zap } from "lucide-react";
import { useMemo, useState } from "react";
import type { ModelProvider, Settings } from "@ensemble/shared-types";
import { api, type Complexity, type ModelKey } from "@/lib/api";
import { dateTime } from "@/lib/format";
import { FetchGlyph } from "@/components/motion/slot";
import { useToast } from "../toast";
import { cx, SettingRow, Spinner, Tag, Toggle } from "../ui";
import { Modal } from "./modal";
import { GitHubGitCard, KEY_PROVIDERS } from "./setup";

type Patch = (patch: Record<string, unknown>) => void;
type Pane = ModelProvider | "more";

const TIERS: Array<{ id: Complexity; label: string }> = [
  { id: "easy", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "max", label: "Max" },
];

/** A provider's tile: its initial on a neutral chip (vendor logos are not used here). */
function Initial({ label, size = 30 }: { label: string; size?: number }) {
  return (
    <span className="inline-flex shrink-0 items-center justify-center rounded-lg border border-line bg-panel font-semibold text-ink" style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }} aria-hidden>
      {label.replace(/^(Google |GitHub )/, "").slice(0, 1)}
    </span>
  );
}

function keyState(key: ModelKey | undefined): { dot: string; text: string; tone: "green" | "blue" | "gray" } {
  if (key?.source === "you") return { dot: "bg-ok", text: `Your key ${key.hint}`, tone: "green" };
  if (key?.source === "account") return { dot: "bg-ok", text: `Account key ${key.hint}`, tone: "green" };
  if (key?.source === "env") return { dot: "bg-accent", text: "Server key", tone: "blue" };
  return { dot: "bg-line-strong", text: "No key", tone: "gray" };
}

function useKeyData(open: boolean) {
  const keys = useQuery({ queryKey: ["model-keys"], queryFn: api.modelKeys, retry: false, enabled: open });
  const catalog = useQuery({ queryKey: ["models"], queryFn: api.models, enabled: open });
  return { keys, catalog };
}

function ProviderPane({ id, settings, patch }: { id: ModelProvider; settings: Settings; patch: Patch }) {
  const provider = KEY_PROVIDERS.find((row) => row.id === id)!;
  const client = useQueryClient();
  const toast = useToast();
  const { keys, catalog } = useKeyData(true);
  const key = keys.data?.credentials.find((row) => row.provider === id);
  const entry = catalog.data?.providers.find((row) => row.provider === id);
  const [value, setValue] = useState("");
  const [shown, setShown] = useState(false);
  const [checked, setChecked] = useState<{ ok: true; models: number } | { ok: false; message: string } | null>(null);
  const [filter, setFilter] = useState("");
  const state = keyState(key);
  const refresh = () => {
    void client.invalidateQueries({ queryKey: ["model-keys"] });
    void client.invalidateQueries({ queryKey: ["models"] });
  };
  const save = useMutation({
    mutationFn: () => api.saveModelKey(id, value.trim()),
    onSuccess: (result) => {
      setChecked({ ok: true, models: result.models });
      setValue("");
      refresh();
    },
    onError: (error) => setChecked({ ok: false, message: (error as Error).message }),
  });
  const remove = useMutation({
    mutationFn: () => api.removeModelKey(id),
    onSuccess: () => {
      setChecked(null);
      refresh();
      toast(`${provider.label} key removed.`, { tone: "ok" });
    },
    onError: (error) => toast((error as Error).message, { tone: "error" }),
  });
  const models = (entry?.available ? entry.models : []).filter((model) => model.toLowerCase().includes(filter.trim().toLowerCase()));
  return (
    <div className="pop-in space-y-4" data-pane={id}>
      <div className="flex items-start gap-3">
        <Initial label={provider.label} size={40} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-[17px] font-semibold">{provider.label}</h3>
            <Tag tone={state.tone}>{state.text}</Tag>
          </div>
          {provider.note ? <p className="mt-0.5 text-[12.5px] text-muted">{provider.note}</p> : null}
        </div>
      </div>

      <ol className="grid gap-2 sm:grid-cols-3" aria-label={`Getting a ${provider.label} key`}>
        {[
          <a key="open" href={provider.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent hover:underline">
            Open {provider.where.split(" → ")[0]} <ArrowUpRight size={12} aria-hidden />
          </a>,
          <span key="make">{provider.where.split(" → ").slice(1).join(" → ") || "Create a key"}</span>,
          <span key="paste">Paste it below. Ensemble checks it with {provider.label} first.</span>,
        ].map((body, index) => (
          <li key={index} className="flex items-start gap-2 rounded-lg border border-line bg-panel px-3 py-2.5 text-[12.5px]">
            <span className="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-[var(--accent-soft)] text-[11px] font-semibold text-accent">{index + 1}</span>
            <span className="min-w-0">{body}</span>
          </li>
        ))}
      </ol>

      <form
        className="rounded-xl border border-line bg-panel p-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (value.trim() && !save.isPending) save.mutate();
        }}
      >
        <label className="block text-[12.5px] font-medium" htmlFor={`key-${id}`}>
          {key?.source === "you" ? "Replace your key" : "Your API key"}
        </label>
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          <div className="flex min-w-0 flex-1 items-center rounded-lg border border-line bg-raised pr-1 focus-within:border-accent">
            <KeyRound size={13} className="ml-2.5 shrink-0 text-faint" aria-hidden />
            <input
              id={`key-${id}`}
              type={shown ? "text" : "password"}
              value={value}
              onChange={(event) => {
                setValue(event.target.value);
                setChecked(null);
              }}
              placeholder="Paste the key"
              autoComplete="off"
              spellCheck={false}
              aria-label={`${provider.label} API key`}
              className="min-w-0 flex-1 bg-transparent px-2 py-1.5 font-mono text-[13px] outline-none placeholder:text-faint"
            />
            <button type="button" className="icon-btn" onClick={() => setShown((now) => !now)} aria-label={shown ? "Hide the key" : "Show the key"}>
              {shown ? <EyeOff size={13} /> : <Eye size={13} />}
            </button>
          </div>
          <button type="submit" className="btn-primary" disabled={!value.trim() || save.isPending}>
            {save.isPending ? <Spinner size={12} /> : null} Check and save
          </button>
        </div>
        {checked ? (
          checked.ok ? (
            <p className="mt-2 flex items-center gap-1.5 text-[12.5px] text-ok" role="status">
              <CircleCheck size={13} aria-hidden /> The key works. {checked.models} models are available.
            </p>
          ) : (
            <p className="mt-2 flex items-center gap-1.5 text-[12.5px] text-warn" role="alert">
              <CircleAlert size={13} aria-hidden /> {checked.message}
            </p>
          )
        ) : (
          <p className="mt-2 text-[12px] text-muted">Stored encrypted and never shown again.</p>
        )}
        {key?.source === "you" ? (
          <div className="mt-3 flex items-center justify-between gap-2 border-t border-line pt-3 text-[12.5px]">
            <span className="text-muted">
              Saved key <span className="font-mono text-ink">{key.hint}</span>
              {key.updatedAt ? ` · ${dateTime(key.updatedAt)}` : ""}
            </span>
            <button type="button" className="btn-ghost text-[12px]" onClick={() => remove.mutate()} disabled={remove.isPending}>
              <Trash2 size={11} aria-hidden /> Remove
            </button>
          </div>
        ) : null}
      </form>

      <div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h4 className="text-[13px] font-semibold">Use {provider.label} for</h4>
          <span className="text-[11.5px] text-faint">Sets the tier to {provider.label}'s cheapest model; pick another in Models.</span>
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label={`Tiers that use ${provider.label}`}>
          {TIERS.map((tier) => {
            const on = settings.models[tier.id].provider === id;
            return (
              <button
                key={tier.id}
                type="button"
                aria-pressed={on}
                disabled={!entry?.available && !on}
                className={cx(
                  "inline-flex items-center gap-1 rounded-full border px-3 py-1 text-[12.5px] transition-colors disabled:cursor-not-allowed disabled:opacity-50",
                  on ? "border-accent bg-[var(--accent-soft)] text-ink" : "border-line text-muted hover:border-line-strong hover:text-ink",
                )}
                onClick={() => {
                  if (on) return;
                  const model = entry?.cheapest ?? entry?.models[0];
                  if (model) patch({ models: { [tier.id]: { provider: id, model, effort: "default" } } });
                }}
              >
                {on ? <Check size={11} aria-hidden /> : null} {tier.label}
              </button>
            );
          })}
        </div>
      </div>

      {entry?.available ? (
        <div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h4 className="text-[13px] font-semibold">{entry.models.length} models on this key</h4>
            {entry.models.length > 12 ? (
              <label className="picker-search mx-0 mt-0 w-full max-w-[220px]">
                <Search size={12} className="shrink-0 text-faint" aria-hidden />
                <input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filter" aria-label="Filter models" className="min-w-0 flex-1 bg-transparent text-[12.5px] outline-none" />
              </label>
            ) : null}
          </div>
          <div className="mt-2 flex max-h-[150px] flex-wrap gap-1 overflow-y-auto" data-testid="key-models">
            {models.map((model) => (
              <span key={model} className={cx("rounded-md border border-line bg-panel px-1.5 py-0.5 font-mono text-[11.5px]", model === entry.cheapest && "border-accent")}>
                {model}
              </span>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function MorePane({ settings, patch }: { settings: Settings; patch: Patch }) {
  const [results, setResults] = useState<Partial<Record<Complexity, { ok: boolean; text: string }>>>({});
  const test = useMutation({
    mutationFn: (tier: Complexity) => api.testModel(tier),
    onSuccess: (result, tier) => setResults((now) => ({ ...now, [tier]: { ok: true, text: `${result.model} answered in ${result.ms} ms` } })),
    onError: (error, tier) => setResults((now) => ({ ...now, [tier]: { ok: false, text: (error as Error).message } })),
  });
  return (
    <div className="pop-in space-y-5" data-pane="more">
      <div>
        <h3 className="text-[17px] font-semibold">Other settings</h3>
        <p className="mt-0.5 text-[12.5px] text-muted">Where keys are used, trying each tier, and local models.</p>
      </div>
      <SettingRow title="Use these keys on my computers" description="The Ensemble CLI and the desktop app, signed in to this account, use these keys for their own model calls. A key added on a computer stays on it and wins there.">
        <Toggle label="Use these keys on my computers" checked={settings.models.keysOnComputers !== false} onChange={(keysOnComputers) => patch({ models: { keysOnComputers } })} />
      </SettingRow>
      <div>
        <h4 className="text-[13px] font-semibold">Try each tier</h4>
        <p className="mt-0.5 text-[12.5px] text-muted">Sends a one-word prompt to the model the tier uses, key or subscription.</p>
        <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
          {TIERS.map((tier) => {
            const result = results[tier.id];
            const running = test.isPending && test.variables === tier.id;
            return (
              <div key={tier.id} className="flex min-w-0 items-center gap-2 rounded-lg border border-line bg-panel px-2.5 py-2">
                <button type="button" className="btn shrink-0 py-0.5 text-[12px]" disabled={test.isPending} onClick={() => test.mutate(tier.id)}>
                  {running ? <Spinner size={11} /> : <Zap size={11} aria-hidden />} {tier.label}
                </button>
                <span className={cx("min-w-0 flex-1 truncate text-[12px]", result ? (result.ok ? "text-ok" : "text-warn") : "text-faint")} title={result?.text}>
                  {result?.text ?? `${settings.models[tier.id].provider} · ${settings.models[tier.id].model}`}
                </span>
              </div>
            );
          })}
        </div>
      </div>
      <label className="block text-[13px] font-medium">
        Ollama URL
        <span className="block text-[12px] font-normal text-muted">Where a local Ollama answers, for the Ollama provider.</span>
        <input value={settings.models.ollamaUrl} onChange={(event) => patch({ models: { ollamaUrl: event.target.value } })} className="field mt-1.5 w-full" />
      </label>
      <GitHubGitCard />
    </div>
  );
}

/**
 * API keys, for the people who have them: a small page of its own. Each provider has its steps,
 * its key, the tiers that use it and its models; "Other settings" holds the rest. Most people use
 * their subscription instead (subscriptions.tsx).
 */
export function ApiKeysDialog({ open, onClose, settings, patch }: { open: boolean; onClose: () => void; settings: Settings; patch: Patch }) {
  const [pane, setPane] = useState<Pane>("google");
  const [query, setQuery] = useState("");
  const { keys, catalog } = useKeyData(open);
  const client = useQueryClient();
  const toast = useToast();
  const refresh = useMutation({
    mutationFn: () => api.refreshModels(),
    onSuccess: (next) => {
      client.setQueryData(["models"], next);
      void client.invalidateQueries({ queryKey: ["model-keys"] });
      toast(next.runtime ? "Model lists refreshed." : (assistantErrorText(next.error ?? ASSISTANT_UNAVAILABLE)), { tone: next.runtime ? "ok" : "error" });
    },
    onError: (error) => toast((error as Error).message, { tone: "error" }),
  });
  const providers = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return KEY_PROVIDERS.filter((row) => !needle || row.label.toLowerCase().includes(needle) || row.id.includes(needle));
  }, [query]);
  const withKeys = (keys.data?.credentials ?? []).filter((row) => row.source !== "none").length;
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="API keys"
      width={960}
      height="min(88dvh, 720px)"
      bodyClassName="p-0"
      scroll={false}
      testId="model-keys-dialog"
      header={
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-line px-5 py-3.5">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <KeyRound size={15} className="text-accent" aria-hidden />
              <span className="text-[15px] font-semibold">API keys</span>
              <Tag tone={withKeys ? "green" : "gray"}>{withKeys ? `${withKeys} with a key` : "none yet"}</Tag>
            </div>
            <p className="mt-0.5 text-[12.5px] text-muted">For people who have API keys. With a Claude, ChatGPT, Cursor or Copilot plan you don't need one: use Your AI subscriptions instead.</p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button type="button" className="btn" onClick={() => refresh.mutate()} disabled={refresh.isPending}>
              <FetchGlyph active={refresh.isPending || catalog.isFetching} size={12} /> {catalog.data?.runtime === false ? "Retry" : "Refresh model lists"}
            </button>
            <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
              <X size={15} />
            </button>
          </div>
        </div>
      }
    >
      <div className="flex h-full min-h-0 flex-col sm:flex-row">
        <nav className="flex shrink-0 flex-col border-b border-line bg-panel sm:w-[248px] sm:border-b-0 sm:border-r" aria-label="Providers">
          <label className="picker-search m-2.5 mb-1.5">
            <Search size={13} className="shrink-0 text-faint" aria-hidden />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find a provider" aria-label="Find a provider" className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-faint" />
          </label>
          <div className="flex min-h-0 gap-1 overflow-x-auto px-2 pb-2 sm:flex-1 sm:flex-col sm:overflow-y-auto sm:overflow-x-hidden">
            {providers.map((row) => {
              const state = keyState(keys.data?.credentials.find((item) => item.provider === row.id));
              const active = pane === row.id;
              return (
                <button
                  key={row.id}
                  type="button"
                  data-provider={row.id}
                  aria-current={active ? "page" : undefined}
                  onClick={() => setPane(row.id)}
                  className={cx("row-tile flex shrink-0 items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-[13px]", active && "bg-hover font-medium")}
                  data-active={active}
                >
                  <Initial label={row.label} size={24} />
                  <span className="min-w-0 flex-1 truncate">{row.label}</span>
                  <span className={cx("size-1.5 shrink-0 rounded-full", state.dot)} title={state.text} aria-label={state.text} />
                </button>
              );
            })}
            {!providers.length ? <p className="px-2 py-1 text-[12px] text-muted">No provider by that name.</p> : null}
            <div className="hidden flex-1 sm:block" />
            <button
              type="button"
              onClick={() => setPane("more")}
              aria-current={pane === "more" ? "page" : undefined}
              data-active={pane === "more"}
              className={cx("row-tile flex shrink-0 items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-[13px] sm:mt-1 sm:border-t sm:border-line", pane === "more" && "bg-hover font-medium")}
            >
              <SlidersHorizontal size={14} className="ml-1 text-muted" aria-hidden />
              <span>Other settings</span>
            </button>
          </div>
        </nav>
        <section className="min-h-0 flex-1 overflow-y-auto p-5" aria-live="polite">
          {pane === "more" ? <MorePane settings={settings} patch={patch} /> : <ProviderPane key={pane} id={pane} settings={settings} patch={patch} />}
          {catalog.data?.updatedAt ? <p className="mt-6 text-[11.5px] text-faint">Model lists updated {dateTime(catalog.data.updatedAt)}.</p> : null}
        </section>
      </div>
    </Modal>
  );
}
