"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Zap } from "lucide-react";
import type { ModelProvider, Settings } from "@ensemble/shared-types";
import { api, type Complexity } from "@/lib/api";
import { dateTime } from "@/lib/format";
import { useQuotaMarks } from "@/lib/model-quota";
import { FetchGlyph } from "@/components/motion/slot";
import { useToast } from "../toast";
import { InfoTip, SectionCard, Tag } from "../ui";
import { Modal } from "./modal";
import { GitHubGitCard, KEY_PROVIDERS, ModelKeysCard } from "./setup";
import { navigateSettings, useSettingsLocation } from "./url-state";

type Patch = (patch: Record<string, unknown>) => void;
type Props = { settings: Settings; patch: Patch };

export const TIERS: Array<{ id: Complexity; label: string; hint: string }> = [
  { id: "easy", label: "Low model", hint: "Replies, triage, small edits. Also the default for the chat and for fetch triage." },
  { id: "medium", label: "Medium model", hint: "Most delegated tasks." },
  { id: "high", label: "High model", hint: "Refactors, investigations, multi-file changes." },
  { id: "max", label: "Max model", hint: "Architecture, migrations and skill mining. Slowest, best." },
];

const PROVIDERS: Array<{ id: ModelProvider; label: string }> = [
  { id: "google", label: "Gemini" },
  { id: "openai", label: "OpenAI" },
  { id: "anthropic", label: "Claude" },
  { id: "mistral", label: "Mistral" },
  { id: "kimi", label: "Kimi" },
  { id: "qwen", label: "Qwen" },
  { id: "openrouter", label: "OpenRouter" },
  { id: "copilot", label: "GitHub Copilot" },
  { id: "cursor", label: "Cursor (assign to agent)" },
  { id: "ollama", label: "Ollama (local)" },
];

const label = (id: string) => KEY_PROVIDERS.find((row) => row.id === id)?.label ?? PROVIDERS.find((row) => row.id === id)?.label ?? id;

/** "Gemini and Claude have keys" — the one line the Models card shows instead of the whole key list. */
export function keySummary(credentials: ReadonlyArray<{ provider: string; source: string }> | undefined): string {
  if (!credentials) return "Checking keys…";
  const named = credentials.filter((row) => row.source !== "none").map((row) => label(row.provider));
  if (!named.length) return "No keys yet. Add one so the assistant can answer.";
  if (named.length === 1) return `${named[0]} has a key.`;
  if (named.length <= 3) return `${named.slice(0, -1).join(", ")} and ${named[named.length - 1]} have keys.`;
  return `${named.slice(0, 2).join(", ")} and ${named.length - 2} more have keys.`;
}

export function ModelsSection({ settings, patch }: Props) {
  const quotas = useQuotaMarks();
  const location = useSettingsLocation();
  const catalog = useQuery({ queryKey: ["models"], queryFn: api.models });
  const keys = useQuery({ queryKey: ["model-keys"], queryFn: api.modelKeys, retry: false });
  const available = (catalog.data?.providers ?? []).reduce((sum, row) => sum + (row.available ? row.models.length : 0), 0);
  const runtimeDown = catalog.data && !catalog.data.runtime;
  const noKeys = keys.data && !keys.data.credentials.some((row) => row.source !== "none");
  return (
    <SectionCard
      title="Models"
      info="Keys are held by the model runtime, never by the web app. A task's complexity picks the model; a provider without a key is skipped with a clear error, never swapped for another vendor."
      description="Which model each tier uses. A task's complexity picks the tier, and the chat starts on the default preset above."
    >
      <div className="row-tile flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-raised px-3 py-2.5" data-testid="model-keys-row">
        <div className="flex min-w-0 items-start gap-2.5">
          <KeyRound size={15} className="mt-0.5 shrink-0 text-muted" aria-hidden />
          <div className="min-w-0">
            <div className="text-[13.5px] font-medium">Model providers & keys</div>
            <div className={`text-[12.5px] ${noKeys || runtimeDown ? "text-warn" : "text-muted"}`}>
              {runtimeDown
                ? (catalog.data?.error ?? "The model runtime is not running.")
                : `${keySummary(keys.data?.credentials)}${catalog.data?.runtime && available ? ` ${available} models available.` : ""}`}
            </div>
          </div>
        </div>
        <button type="button" className="btn shrink-0" aria-haspopup="dialog" onClick={() => navigateSettings({ dialog: "keys" })}>
          Manage keys
        </button>
      </div>
      <h3 className="mb-2 mt-5 text-[13px] font-semibold">Which model each tier uses</h3>
      <div className="space-y-4">
        {TIERS.map((tier) => {
          const value = settings.models[tier.id];
          const provider = catalog.data?.providers.find((row) => row.provider === value.provider);
          return (
            <div key={tier.id}>
              <div className="flex flex-wrap items-center gap-1.5 text-[13px] font-medium">
                {tier.label} <InfoTip text={tier.hint} />
                {provider && !provider.available ? <Tag tone="orange">no key for {label(value.provider)}</Tag> : null}
                {provider && !provider.chat ? <Tag tone="orange">Cursor cannot run the chat</Tag> : null}
                {provider?.available && provider.models.length && !provider.models.includes(value.model) ? <Tag tone="orange">model not offered to your key</Tag> : null}
              </div>
              <div className="mt-1.5 grid grid-cols-1 gap-2 sm:grid-cols-[150px_minmax(0,1fr)_190px]">
                <select
                  value={value.provider}
                  onChange={(event) => {
                    const next = catalog.data?.providers.find((row) => row.provider === event.target.value);
                    patch({ models: { [tier.id]: { provider: event.target.value, ...(next?.cheapest ? { model: next.cheapest } : {}) } } });
                  }}
                  className="field"
                  aria-label={`${tier.label} provider`}
                >
                  {PROVIDERS.map((row) => (
                    <option key={row.id} value={row.id}>
                      {row.label}
                    </option>
                  ))}
                </select>
                <input
                  list={`models-${tier.id}`}
                  key={`${tier.id}-${value.model}`}
                  defaultValue={value.model}
                  aria-label={`${tier.label} model`}
                  onBlur={(event) => {
                    if (event.target.value.trim() && event.target.value !== value.model) {
                      patch({ models: { [tier.id]: { model: event.target.value.trim() } } });
                    }
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                  }}
                  className="field min-w-0"
                />
                <datalist id={`models-${tier.id}`}>
                  {(provider?.models ?? []).map((model) => (
                    <option key={model} value={model} />
                  ))}
                </datalist>
                <select aria-label={`${tier.label} thinking`} value={value.effort} onChange={(event) => patch({ models: { [tier.id]: { effort: event.target.value } } })} className="field">
                  <option value="default">Thinking: provider default</option>
                  <option value="minimal">Thinking: minimal</option>
                  <option value="low">Thinking: low</option>
                  <option value="medium">Thinking: medium</option>
                  <option value="high">Thinking: high</option>
                </select>
              </div>
              {(() => {
                const mark = quotas.get(value.model);
                if (mark && Date.parse(mark.resetsAt) > Date.now()) {
                  return <p className="mt-1 text-[12px] text-warn">{mark.message}</p>;
                }
                return provider?.notes?.[value.model] && provider.notes[value.model]?.available === false ? (
                  <p className="mt-1 text-[12px] text-warn">{provider.notes[value.model]?.reason || "This key cannot use that model."}</p>
                ) : null;
              })()}
            </div>
          );
        })}
      </div>
      <ModelKeysDialog open={location.dialog === "keys"} onClose={() => navigateSettings({ dialog: null })} settings={settings} patch={patch} />
    </SectionCard>
  );
}

export function ModelKeysDialog({ open, onClose, settings, patch }: Props & { open: boolean; onClose: () => void }) {
  const client = useQueryClient();
  const toast = useToast();
  const catalog = useQuery({ queryKey: ["models"], queryFn: api.models, enabled: open });
  const test = useMutation({
    mutationFn: (tier: Complexity) => api.testModel(tier),
    onSuccess: (result) => toast(`${result.model} answered “${result.text}” in ${result.ms} ms (${result.tokensIn ?? "?"} in / ${result.tokensOut ?? "?"} out tokens).`, { tone: "ok" }),
    onError: (error) => toast((error as Error).message, { tone: "error" }),
  });
  const available = (catalog.data?.providers ?? []).reduce((sum, row) => sum + (row.available ? row.models.length : 0), 0);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Model providers & keys"
      description={
        catalog.data
          ? catalog.data.runtime
            ? `${available} models available from your keys · Updated ${dateTime(catalog.data.updatedAt)}`
            : (catalog.data.error ?? "The model runtime is not running.")
          : "Checking providers…"
      }
      width={720}
      testId="model-keys-dialog"
      footer={
        <div className="flex flex-wrap items-center justify-between gap-2">
          <button type="button" className="btn" onClick={() => void client.invalidateQueries({ queryKey: ["models"] })}>
            <FetchGlyph active={catalog.isFetching} size={12} /> Refresh models
          </button>
          <button type="button" className="btn-primary" onClick={onClose}>
            Done
          </button>
        </div>
      }
    >
      <ModelKeysCard />
      <div className="mt-5">
        <h3 className="text-[13px] font-semibold">Try each tier</h3>
        <p className="mt-0.5 text-[12.5px] text-muted">Sends a one-word prompt to the model the tier uses and shows how long it took.</p>
        <div className="mt-2 flex flex-wrap gap-2">
          {TIERS.map((tier) => (
            <button key={tier.id} type="button" className="btn" disabled={test.isPending} onClick={() => test.mutate(tier.id)}>
              <Zap size={11} /> Test {tier.label.replace(" model", "")}
              {test.isPending && test.variables === tier.id ? "…" : ""}
            </button>
          ))}
        </div>
      </div>
      <label className="mt-5 block text-[13px] font-medium">
        Ollama URL
        <span className="block text-[12px] font-normal text-muted">Where a local Ollama answers, for the Ollama provider.</span>
        <input value={settings.models.ollamaUrl} onChange={(event) => patch({ models: { ollamaUrl: event.target.value } })} className="field mt-1.5 w-full" />
      </label>
      <GitHubGitCard />
    </Modal>
  );
}
