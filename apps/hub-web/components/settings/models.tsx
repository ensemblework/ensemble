"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound } from "lucide-react";
import { isSubscriptionProvider, SUBSCRIPTION_INFO, SUBSCRIPTION_PROVIDERS, type ModelMeta, type ModelProvider, type Settings, type SubscriptionAgent } from "@ensemble/shared-types";
import { api, type Complexity, type ModelCatalog } from "@/lib/api";
import { relative } from "@/lib/format";
import { useQuotaMarks } from "@/lib/model-quota";
import { FetchGlyph } from "@/components/motion/slot";
import { useToast } from "../toast";
import { InfoTip, SectionCard, Tag } from "../ui";
import { ModelPicker, ProviderPicker, ThinkingPicker, effortFor, type ProviderChoice } from "./model-picker";
import { KEY_PROVIDERS } from "./setup";
import { ApiKeysDialog } from "./api-keys-dialog";
import { activeComputer, SubscriptionsCard, useSubscriptions } from "./subscriptions";
import { navigateSettings, useSettingsLocation } from "./url-state";

type Patch = (patch: Record<string, unknown>) => void;
type Props = { settings: Settings; patch: Patch };

export const TIERS: Array<{ id: Complexity; label: string; hint: string }> = [
  { id: "easy", label: "Low model", hint: "Replies, triage, small edits. Also the default for the chat and for fetch triage." },
  { id: "medium", label: "Medium model", hint: "Most delegated tasks." },
  { id: "high", label: "High model", hint: "Refactors, investigations, multi-file changes and learning skills from completed work." },
  { id: "max", label: "Max model", hint: "Architecture and migrations. Slowest, best." },
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

const label = (id: string) =>
  isSubscriptionProvider(id) ? `${SUBSCRIPTION_INFO[id].label} (your plan)` : (KEY_PROVIDERS.find((row) => row.id === id)?.label ?? PROVIDERS.find((row) => row.id === id)?.label ?? id);

/** A subscription's models as the tier pickers take them: ids, and each model's thinking levels. */
export function subscriptionModels(agent: SubscriptionAgent | null): { models: string[]; meta: Record<string, ModelMeta>; cheapest: string | null } {
  if (!agent) return { models: [], meta: {}, cheapest: null };
  const meta: Record<string, ModelMeta> = {};
  for (const model of agent.models) {
    const efforts = model.efforts ?? agent.efforts;
    if (efforts?.length) meta[model.id] = { efforts };
  }
  return { models: agent.models.map((model) => model.id), meta, cheapest: agent.models.find((model) => model.isDefault)?.id ?? agent.models[0]?.id ?? null };
}

/** "Gemini and Claude have keys" — the one line the Models card shows instead of the whole key list. */
export function keySummary(credentials: ReadonlyArray<{ provider: string; source: string }> | undefined): string {
  if (!credentials) return "Checking keys…";
  const named = credentials.filter((row) => row.source !== "none").map((row) => label(row.provider));
  if (!named.length) return "No keys yet. Add one so the assistant can answer.";
  if (named.length === 1) return `${named[0]} has a key.`;
  if (named.length <= 3) return `${named.slice(0, -1).join(", ")} and ${named[named.length - 1]} have keys.`;
  return `${named.slice(0, 2).join(", ")} and ${named.length - 2} more have keys.`;
}

/** Asks each provider with a key for its model list now, and puts the answer where the page reads it. */
export function useRefreshModels() {
  const client = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: () => api.refreshModels(),
    onSuccess: (catalog: ModelCatalog) => {
      client.setQueryData(["models"], catalog);
      void client.invalidateQueries({ queryKey: ["model-keys"] });
      void client.invalidateQueries({ queryKey: ["model-catalog"] });
      const count = catalog.providers.reduce((sum, row) => sum + (row.available ? row.models.length : 0), 0);
      toast(catalog.runtime ? `Model lists refreshed: ${count} models from your keys.` : (catalog.error ?? "The model runtime is not running."), { tone: catalog.runtime ? "ok" : "error" });
    },
    onError: (error) => toast((error as Error).message, { tone: "error" }),
  });
}

function providerChoices(catalog: ModelCatalog | undefined, agents: SubscriptionAgent[] | null, computerName: string | null): ProviderChoice[] {
  const plans: ProviderChoice[] = SUBSCRIPTION_PROVIDERS.map((id) => {
    const agent = agents?.find((row) => row.id === id) ?? null;
    const ready = Boolean(agent && agent.signedIn !== false && !agent.problem);
    return {
      id,
      label: `${SUBSCRIPTION_INFO[id].label} (your plan)`,
      status: ready ? "plan" : "plan-missing",
      note: !agent ? "not on your computer" : agent.signedIn === false ? "not signed in" : computerName ? `on ${computerName}` : "your plan",
    };
  });
  return [...plans, ...providerKeyChoices(catalog)];
}

function providerKeyChoices(catalog: ModelCatalog | undefined): ProviderChoice[] {
  return PROVIDERS.map((row) => {
    const entry = catalog?.providers.find((item) => item.provider === row.id);
    const status: ProviderChoice["status"] =
      row.id === "ollama" ? "local" : entry?.source === "you" ? "key" : entry?.source === "account" ? "account" : entry?.source === "env" || entry?.source === "cli" ? "server" : "none";
    return { id: row.id, label: row.label, status, ...(row.id === "ollama" ? { note: entry?.available ? `${entry.models.length} models` : "not running" } : {}) };
  });
}

export function ModelsSection({ settings, patch }: Props) {
  const quotas = useQuotaMarks();
  const location = useSettingsLocation();
  const catalog = useQuery({ queryKey: ["models"], queryFn: api.models });
  const keys = useQuery({ queryKey: ["model-keys"], queryFn: api.modelKeys, retry: false });
  const refresh = useRefreshModels();
  const subscriptions = useSubscriptions();
  const computer = activeComputer(subscriptions.data);
  const agents = computer?.online && computer.ready ? computer.agents : null;
  const choices = providerChoices(catalog.data, agents, computer?.name ?? null).map((choice) => isSubscriptionProvider(choice.id) && computer && !computer.online ? { ...choice, note: `${computer.name} is offline` } : choice);
  const available = (catalog.data?.providers ?? []).reduce((sum, row) => sum + (row.available ? row.models.length : 0), 0);
  const runtimeDown = catalog.data && !catalog.data.runtime;
  const noKeys = keys.data && !keys.data.credentials.some((row) => row.source !== "none");
  return (
    <SectionCard
      title="Models"
      info="A subscription runs on your own computer with your own sign-in. API keys are held by the model runtime, never by the web app. A provider that cannot answer is said, never swapped for another vendor."
      description="Power the assistant with the AI plan you already have, or with API keys. A task's complexity picks the tier, and the chat starts on the default preset above."
    >
      <SubscriptionsCard settings={settings} patch={patch} />
      <div className="row-tile mt-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-raised px-3 py-2.5" data-testid="model-keys-row">
        <div className="flex min-w-0 items-start gap-2.5">
          <KeyRound size={15} className="mt-0.5 shrink-0 text-muted" aria-hidden />
          <div className="min-w-0">
            <div className="text-[13.5px] font-medium">API keys</div>
            <div className={`text-[12.5px] ${noKeys || runtimeDown ? "text-warn" : "text-muted"}`}>
              {runtimeDown
                ? (catalog.data?.error ?? "The model runtime is not running.")
                : `${keySummary(keys.data?.credentials)}${catalog.data?.runtime && available ? ` ${available} models available.` : ""}`}
            </div>
          </div>
        </div>
        <button type="button" className="btn shrink-0" aria-haspopup="dialog" onClick={() => navigateSettings({ dialog: "keys" })}>
          Manage API keys
        </button>
      </div>
      <div className="mb-2 mt-5 flex flex-wrap items-end justify-between gap-2">
        <div>
          <h3 className="text-[13px] font-semibold">Which model each tier uses</h3>
          <p className="text-[12px] text-muted" data-testid="models-fetched">
            {catalog.data?.fetchedAt
              ? `Model lists from your keys, fetched ${relative(catalog.data.fetchedAt)}. They refresh every week.`
              : "Model lists come from your keys and refresh every week."}
          </p>
        </div>
        <button type="button" className="btn" onClick={() => refresh.mutate()} disabled={refresh.isPending || !catalog.data?.runtime}>
          <FetchGlyph active={refresh.isPending} size={12} /> Refresh model lists
        </button>
      </div>
      <div className="space-y-5">
        {TIERS.map((tier) => {
          const value = settings.models[tier.id];
          const plan = isSubscriptionProvider(value.provider);
          const agent = plan ? (agents?.find((row) => row.id === value.provider) ?? null) : null;
          const planModels = subscriptionModels(agent);
          const provider = plan ? undefined : catalog.data?.providers.find((row) => row.provider === value.provider);
          const meta = plan ? (planModels.meta[value.model] ?? null) : (provider?.meta?.[value.model] ?? null);
          const providerName = label(value.provider);
          return (
            <div key={tier.id} data-tier={tier.id}>
              <div className="flex flex-wrap items-center gap-1.5 text-[13px] font-medium">
                {tier.label} <InfoTip text={tier.hint} />
                {provider && !provider.available ? <Tag tone="orange">no key for {providerName}</Tag> : null}
                {provider && !provider.chat ? <Tag tone="orange">Cursor cannot run the chat</Tag> : null}
                {provider?.available && provider.models.length && !provider.models.includes(value.model) ? <Tag tone="orange">model not offered to your key</Tag> : null}
                {plan && subscriptions.data && !agent ? <Tag tone="orange">{computer ? `not on ${computer.name}` : "no computer paired"}</Tag> : null}
                {plan && agent?.signedIn === false ? <Tag tone="orange">not signed in</Tag> : null}
                {plan && computer && !computer.online ? <Tag tone="orange">{computer.name} is offline</Tag> : null}
              </div>
              <div className="mt-1.5 grid grid-cols-1 gap-2 sm:grid-cols-[190px_minmax(0,1fr)]">
                <ProviderPicker
                  label={`${tier.label} provider`}
                  value={value.provider}
                  choices={choices}
                  onPick={(next) => {
                    if (next === value.provider) return;
                    if (isSubscriptionProvider(next)) {
                      const nextAgent = agents?.find((row) => row.id === next) ?? null;
                      patch({ models: { [tier.id]: { provider: next, model: subscriptionModels(nextAgent).cheapest ?? "default", effort: "default" } } });
                      return;
                    }
                    const entry = catalog.data?.providers.find((row) => row.provider === next);
                    const model = entry?.cheapest ?? value.model;
                    patch({ models: { [tier.id]: { provider: next, model, effort: effortFor(next, model, entry?.meta?.[model], value.effort) } } });
                  }}
                />
                <ModelPicker
                  label={`${tier.label} model`}
                  value={value.model}
                  provider={value.provider}
                  providerLabel={providerName}
                  models={plan ? planModels.models : (provider?.models ?? [])}
                  cheapest={plan ? planModels.cheapest : (provider?.cheapest ?? null)}
                  meta={plan ? planModels.meta : provider?.meta}
                  notes={plan ? undefined : provider?.notes}
                  hasKey={plan ? Boolean(agent) : Boolean(provider?.available)}
                  onPick={(model) => {
                    if (model === value.model) return;
                    const modelMeta = plan ? planModels.meta[model] : provider?.meta?.[model];
                    patch({ models: { [tier.id]: { model, effort: effortFor(value.provider, model, modelMeta, value.effort) } } });
                  }}
                />
              </div>
              <div className="mt-2">
                <ThinkingPicker
                  label={`${tier.label} thinking`}
                  provider={value.provider}
                  providerLabel={providerName}
                  model={value.model}
                  meta={meta}
                  value={value.effort}
                  onChange={(effort) => patch({ models: { [tier.id]: { effort } } })}
                />
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
      <ApiKeysDialog open={location.dialog === "keys"} onClose={() => navigateSettings({ dialog: null })} settings={settings} patch={patch} />
    </SectionCard>
  );
}
