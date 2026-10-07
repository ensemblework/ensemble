"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, ExternalLink, KeyRound, Plug, RefreshCw, Trash2, Zap } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import type { ModelProvider, Settings } from "@ensemble/shared-types";
import { api, type Complexity, type Connection, type ConnectorApp } from "@/lib/api";
import { dateTime, plural, relative } from "@/lib/format";
import { FetchGlyph } from "@/components/motion/slot";
import { useQuotaMarks } from "@/lib/model-quota";
import { useToast } from "../toast";
import { Dialog, InfoTip, SectionCard, SettingRow, Spinner, Tag, Toggle, cx } from "../ui";

export type Patch = (patch: Record<string, unknown>) => void;
type Props = { settings: Settings; patch: Patch };

function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="btn py-0.5 text-[12px]"
      onClick={() => {
        void navigator.clipboard.writeText(text);
        setDone(true);
        window.setTimeout(() => setDone(false), 1500);
      }}
    >
      {done ? <Check size={11} /> : <Copy size={11} />} {done ? "Copied" : label}
    </button>
  );
}

// ── model keys ─────────────────────────────────────────────────────────────

const KEY_PROVIDERS: Array<{ id: ModelProvider; label: string; where: string; url: string; note?: string }> = [
  { id: "google", label: "Google Gemini", where: "Google AI Studio → Get API key", url: "https://aistudio.google.com/apikey", note: "Cheapest to start. Has a free tier." },
  { id: "openai", label: "OpenAI", where: "platform.openai.com → API keys", url: "https://platform.openai.com/api-keys" },
  { id: "anthropic", label: "Claude", where: "console.anthropic.com → API keys", url: "https://console.anthropic.com/settings/keys" },
  { id: "mistral", label: "Mistral", where: "console.mistral.ai → API keys", url: "https://console.mistral.ai/api-keys" },
  { id: "kimi", label: "Kimi", where: "platform.moonshot.ai → API keys", url: "https://platform.moonshot.ai/console/api-keys", note: "Moonshot’s API. The cheap model is moonshot-v1-8k." },
  { id: "qwen", label: "Qwen", where: "Alibaba Model Studio → API keys", url: "https://modelstudio.console.alibabacloud.com/", note: "DashScope international endpoint. The cheap model is qwen-flash." },
  { id: "openrouter", label: "OpenRouter", where: "openrouter.ai → Keys", url: "https://openrouter.ai/keys", note: "One key, many vendors." },
  { id: "copilot", label: "GitHub Copilot", where: "A GitHub token on an account with Copilot", url: "https://github.com/settings/tokens" },
  { id: "cursor", label: "Cursor", where: "cursor.com → Dashboard → Integrations → API keys", url: "https://cursor.com/dashboard?tab=integrations", note: "For Assign to agent later. Cursor does not answer the Hub chat." },
];

export function ModelKeysCard({ compact = false }: { compact?: boolean }) {
  const client = useQueryClient();
  const toast = useToast();
  const keys = useQuery({ queryKey: ["model-keys"], queryFn: api.modelKeys, retry: false });
  const [editing, setEditing] = useState<ModelProvider | null>(null);
  const [value, setValue] = useState("");
  const save = useMutation({
    mutationFn: () => api.saveModelKey(editing!, value),
    onSuccess: (result) => {
      toast(`Key works, ${result.models} models available.`, { tone: "ok" });
      setEditing(null);
      setValue("");
      void client.invalidateQueries({ queryKey: ["model-keys"] });
      void client.invalidateQueries({ queryKey: ["models"] });
    },
    onError: (error) => toast((error as Error).message, { tone: "error" }),
  });
  const remove = useMutation({
    mutationFn: (provider: string) => api.removeModelKey(provider),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["model-keys"] });
      void client.invalidateQueries({ queryKey: ["models"] });
    },
  });
  if (keys.error) {
    return <div className="rounded-md border border-warn/50 bg-panel px-3 py-2 text-[12.5px] text-muted">{(keys.error as Error).message}</div>;
  }
  const rows = compact ? KEY_PROVIDERS.slice(0, 3) : KEY_PROVIDERS;
  return (
    <div className="divide-y divide-[var(--line)]">
      {rows.map((provider) => {
        const key = keys.data?.credentials.find((row) => row.provider === provider.id);
        return (
          <div key={provider.id} className="flex items-center justify-between gap-4 py-2.5">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-[13.5px] font-medium">
                {provider.label}
                {key?.source === "you" ? <Tag tone="green">your key {key.hint}</Tag> : key?.source === "env" ? <Tag tone="blue">from server ({key.hint})</Tag> : <Tag tone="gray">no key</Tag>}
              </div>
              <div className="text-[12px] text-muted">
                {provider.note ? `${provider.note} ` : ""}
                <a href={provider.url} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                  {provider.where} ↗
                </a>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              {key?.source === "you" ? (
                <button type="button" className="btn-ghost py-0.5 text-[12px]" onClick={() => remove.mutate(provider.id)}>
                  <Trash2 size={11} /> Remove
                </button>
              ) : null}
              <button type="button" className="btn py-0.5 text-[12px]" onClick={() => setEditing(provider.id)}>
                <KeyRound size={11} /> {key?.source === "you" ? "Replace" : "Add key"}
              </button>
            </div>
          </div>
        );
      })}
      <Dialog open={editing !== null} onClose={() => setEditing(null)} title={`Add a ${KEY_PROVIDERS.find((row) => row.id === editing)?.label ?? ""} key`}>
        <div className="space-y-3 p-4 text-[13px]">
          <p className="text-muted">
            Paste it here. Ensemble checks it, then stores it encrypted on this computer. It is not written into a project file, and it is not shown again.
          </p>
          <input
            autoFocus
            type="password"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder="Paste the key"
            className="field w-full font-mono"
            onKeyDown={(event) => event.key === "Enter" && value.trim() && save.mutate()}
          />
          <div className="flex justify-end gap-2">
            <button type="button" className="btn-ghost" onClick={() => setEditing(null)}>
              Cancel
            </button>
            <button type="button" className="btn-primary" disabled={!value.trim() || save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? <Spinner size={12} /> : null} Check and save
            </button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}

// ── models by complexity ───────────────────────────────────────────────────

const TIERS: Array<{ id: Complexity; label: string; hint: string }> = [
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

function GitHubGitCard() {
  const toast = useToast();
  const client = useQueryClient();
  const current = useQuery({ queryKey: ["github-git"], queryFn: api.githubGit });
  const [token, setToken] = useState("");
  const save = useMutation({
    mutationFn: () => api.saveGithubGit(token.trim()),
    onSuccess: () => {
      setToken("");
      toast("GitHub token saved. It stays on the server.", { tone: "ok" });
      void client.invalidateQueries({ queryKey: ["github-git"] });
    },
    onError: (error) => toast((error as Error).message, { tone: "error" }),
  });
  return (
    <div className="mt-4 rounded-lg border border-line bg-panel px-3 py-3">
      <div className="text-[13px] font-medium">GitHub token for private clones</div>
      <p className="mt-1 text-[12.5px] text-muted">
        Used when a workspace task has “Use my git sign-in”. Stored encrypted, like a model key. {current.data?.hint ? `Saved as ${current.data.hint}.` : "None saved."}
      </p>
      <div className="mt-2 flex gap-2">
        <input
          type="password"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          aria-label="GitHub token"
          placeholder="github_pat_…"
          className="field flex-1 font-mono"
        />
        <button type="button" className="btn-primary" disabled={token.trim().length < 8 || save.isPending} onClick={() => save.mutate()}>
          Save
        </button>
      </div>
    </div>
  );
}

export function ModelsSection({ settings, patch }: Props) {
  const client = useQueryClient();
  const toast = useToast();
  const quotas = useQuotaMarks();
  const catalog = useQuery({ queryKey: ["models"], queryFn: api.models });
  const test = useMutation({
    mutationFn: (tier: Complexity) => api.testModel(tier),
    onSuccess: (result) => toast(`${result.model} answered “${result.text}” in ${result.ms} ms (${result.tokensIn ?? "?"} in / ${result.tokensOut ?? "?"} out tokens).`, { tone: "ok" }),
    onError: (error) => toast((error as Error).message, { tone: "error" }),
  });
  const available = (catalog.data?.providers ?? []).reduce((sum, row) => sum + (row.available ? row.models.length : 0), 0);
  return (
    <SectionCard
      title="Models"
      info="Keys are held by the model runtime, never by the web app. A task's complexity picks the model; a provider without a key is skipped with a clear error, never swapped for another vendor."
      actions={
        <button type="button" className="btn" onClick={() => void client.invalidateQueries({ queryKey: ["models"] })}>
          <FetchGlyph active={catalog.isFetching} size={12} /> Refresh
        </button>
      }
      description={
        catalog.data
          ? catalog.data.runtime
            ? `${available} models available from your keys · Updated ${dateTime(catalog.data.updatedAt)}`
            : `The model runtime is not running: ${catalog.data.error ?? ""}`
          : "Checking providers…"
      }
    >
      <h3 className="mb-1 text-[13px] font-semibold">API keys</h3>
      <ModelKeysCard />
      <GitHubGitCard />
      <h3 className="mb-2 mt-5 text-[13px] font-semibold">Which model each tier uses</h3>
      <div className="space-y-4">
        {TIERS.map((tier) => {
          const value = settings.models[tier.id];
          const provider = catalog.data?.providers.find((row) => row.provider === value.provider);
          return (
            <div key={tier.id}>
              <div className="flex items-center gap-1.5 text-[13px] font-medium">
                {tier.label} <InfoTip text={tier.hint} />
                {provider && !provider.available ? <Tag tone="orange">no key for {value.provider}</Tag> : null}
                {provider && !provider.chat ? <Tag tone="orange">Cursor cannot run the chat</Tag> : null}
                {provider?.available && provider.models.length && !provider.models.includes(value.model) ? <Tag tone="orange">model not offered to your key</Tag> : null}
                <button type="button" className="btn-ghost ml-auto py-0 text-[12px]" disabled={test.isPending} onClick={() => test.mutate(tier.id)}>
                  <Zap size={11} /> Test
                </button>
              </div>
              <div className="mt-1.5 grid grid-cols-[170px_minmax(0,1fr)_200px] gap-2">
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
                  className="field"
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
        <label className="block text-[13px] font-medium">
          Ollama URL
          <input value={settings.models.ollamaUrl} onChange={(event) => patch({ models: { ollamaUrl: event.target.value } })} className="field mt-1.5 w-full" />
        </label>
      </div>
    </SectionCard>
  );
}

// ── connections ────────────────────────────────────────────────────────────

function AppSetup({ app, canEdit }: { app: ConnectorApp; canEdit: boolean }) {
  const client = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const save = useMutation({
    mutationFn: () => api.saveConnectorApp(app.provider, { clientId, clientSecret }),
    onSuccess: () => {
      toast("Saved. Press Connect to sign in.", { tone: "ok" });
      setOpen(false);
      void client.invalidateQueries({ queryKey: ["connector-apps"] });
      void client.invalidateQueries({ queryKey: ["connections"] });
    },
    onError: (error) => toast((error as Error).message, { tone: "error" }),
  });
  const name = app.provider === "google" ? "Google" : "GitHub";
  return (
    <>
      <button type="button" className="btn py-0.5 text-[12px]" onClick={() => setOpen(true)} disabled={!canEdit}>
        {app.provider === "google" ? (app.configured ? "Change Google setup" : "Set up once") : app.configured ? `Change ${name} app` : `Set up ${name} sign-in`}
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title={app.provider === "google" ? "Turn on Sign in with Google" : `One-time ${name} setup`} width={600}>
        <div className="space-y-3 p-4 text-[13px]">
          <p className="text-muted">
            {app.provider === "google"
              ? "You do this once, because you host Ensemble. After you save the client ID and secret, everyone else only sees Sign in with Google. They never open Google Cloud, and they never see these values."
              : `Whoever runs this Ensemble does this once. After that, everyone just presses Connect and approves ${name}'s consent screen. Nobody else sees these values.`}
          </p>
          <ol className="list-decimal space-y-1 pl-5 text-[12.5px]">
            {app.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          <div className="flex items-center gap-2 rounded-md bg-panel px-2 py-1.5 font-mono text-[12px]">
            <span className="min-w-0 flex-1 truncate">{app.redirectUri}</span>
            <CopyButton text={app.redirectUri} label="Copy redirect URI" />
          </div>
          {app.provider === "google" ? (
            <p className="rounded-md bg-panel px-2.5 py-2 text-[12.5px] text-muted">
              If Google says your Gmail is ineligible, Branding or Data Access is not saved yet. Save both, then add the test user again. Use the same Gmail shown in the top-right of Cloud Console.
            </p>
          ) : null}
          {app.console ? (
            <a href={app.console} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent hover:underline">
              {app.provider === "google" ? "Open Google Auth Platform" : `Open the ${name} console`} <ExternalLink size={11} />
            </a>
          ) : null}
          <input value={clientId} onChange={(event) => setClientId(event.target.value)} placeholder="Client ID" className="field w-full font-mono" />
          <input value={clientSecret} onChange={(event) => setClientSecret(event.target.value)} placeholder="Client secret" type="password" className="field w-full font-mono" />
          <div className="flex justify-end gap-2">
            <button type="button" className="btn-ghost" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button type="button" className="btn-primary" disabled={clientId.length < 8 || clientSecret.length < 8 || save.isPending} onClick={() => save.mutate()}>
              Save
            </button>
          </div>
        </div>
      </Dialog>
    </>
  );
}

function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 8 3.1l5.7-5.7C34.2 6.1 29.4 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.2-.1-2.3-.4-3.5z" />
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 16 19 12 24 12c3.1 0 5.8 1.2 8 3.1l5.7-5.7C34.2 6.1 29.4 4 24 4 16.3 4 9.6 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 10-2 13.6-5.2l-6.3-5.3C29.3 35.1 26.8 36 24 36c-5.3 0-9.7-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-1.1 3.2-3.5 5.7-6.6 7.1l6.3 5.3C37.4 38.4 44 33 44 24c0-1.2-.1-2.3-.4-3.5z" />
    </svg>
  );
}

function SignInWithGoogle({ pending, onClick }: { pending: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={pending}
      className="inline-flex h-10 items-center gap-3 rounded-md border border-[#747775] bg-white px-3 pr-4 text-[14px] font-medium text-[#1f1f1f] hover:bg-[#f8f9fa] disabled:cursor-not-allowed disabled:opacity-60"
    >
      <GoogleMark />
      {pending ? "Opening Google…" : "Sign in with Google"}
    </button>
  );
}

function GoogleAccountCard({
  mail,
  calendar,
  app,
  canEdit,
  settings,
  patch,
  pending,
  onConnect,
  onSync,
  onDisconnect,
}: {
  mail: Connection;
  calendar: Connection;
  app: ConnectorApp | undefined;
  canEdit: boolean;
  settings: Settings;
  patch: Patch;
  pending: boolean;
  onConnect: () => void;
  onSync: (id: string) => void;
  onDisconnect: () => void;
}) {
  const signedIn = mail.configured || calendar.configured;
  const account = mail.account ?? calendar.account;
  return (
    <div className="py-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 text-[15px] font-medium">
            Gmail and Calendar
            {signedIn ? <Tag tone="green">{account ?? "signed in"}</Tag> : <Tag tone="orange">not connected</Tag>}
          </div>
          <p className="mt-1 max-w-xl text-[13px] text-muted">
            {signedIn
              ? "Ensemble can read your mail and calendar. It cannot send mail or change events."
              : "One sign-in covers both. Google will ask you to allow read-only access. Allow it, and you're done."}
          </p>
        </div>
        {signedIn ? (
          account && mail.accountSource === "you" ? (
            <button type="button" className="btn-ghost py-0.5 text-[12px]" onClick={onDisconnect}>
              Disconnect
            </button>
          ) : null
        ) : app?.configured ? (
          <SignInWithGoogle pending={pending} onClick={onConnect} />
        ) : canEdit && app ? (
          <AppSetup app={app} canEdit={canEdit} />
        ) : (
          <span className="max-w-[220px] text-right text-[12.5px] text-faint">Sign in with Google is not turned on yet.</span>
        )}
      </div>
      {!signedIn && canEdit && !app?.configured ? (
        <p className="mt-2 max-w-xl text-[12.5px] text-faint">
          People who use Ensemble only press Sign in with Google. That button shows up after you turn it on once.
        </p>
      ) : null}
      {signedIn ? (
        <div className="mt-3 divide-y divide-[var(--line)] rounded-md border border-line">
          {[mail, calendar].map((row) => {
            const enabled = settings.connections[row.id as keyof Settings["connections"]]?.enabled ?? false;
            return (
              <div key={row.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
                <div className="min-w-0">
                  <div className="text-[13px] font-medium">{row.label}</div>
                  <div className="text-[12px] text-faint">
                    {plural(row.itemCount, "item")} · {row.lastSyncAt ? `synced ${relative(row.lastSyncAt)}` : "not synced yet"}
                  </div>
                  {row.lastError && enabled ? <div className="text-[12px] text-[#ffb4ae]">{row.lastError}</div> : null}
                </div>
                <div className="flex items-center gap-2">
                  <button type="button" className="btn py-0.5 text-[12px]" disabled={!enabled} onClick={() => onSync(row.id)}>
                    <RefreshCw size={11} /> Sync
                  </button>
                  <Toggle checked={enabled} onChange={(value) => patch({ connections: { [row.id]: { enabled: value } } })} label={`Read ${row.label}`} />
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function TokenConnect({ row }: { row: Connection }) {
  const client = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState("");
  const save = useMutation({
    mutationFn: () => api.connectToken(row.provider!, token),
    onSuccess: (result) => {
      toast(`Connected as ${result.account}.`, { tone: "ok" });
      setOpen(false);
      setToken("");
      void client.invalidateQueries({ queryKey: ["connections"] });
      void client.invalidateQueries({ queryKey: ["settings"] });
    },
    onError: (error) => toast((error as Error).message, { tone: "error" }),
  });
  return (
    <>
      <button type="button" className={cx(row.connect === "token" ? "btn-primary" : "btn", "py-0.5 text-[12px]")} onClick={() => setOpen(true)}>
        <KeyRound size={11} /> {row.connect === "token" ? `Connect ${row.label}` : "Paste a token"}
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title={`Connect ${row.label}`}>
        <div className="space-y-3 p-4 text-[13px]">
          <p className="text-muted">{row.setupHint}</p>
          <input autoFocus type="password" value={token} onChange={(event) => setToken(event.target.value)} placeholder="Paste the token" className="field w-full font-mono" />
          <div className="flex justify-end gap-2">
            <button type="button" className="btn-ghost" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button type="button" className="btn-primary" disabled={token.trim().length < 10 || save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? <Spinner size={12} /> : null} Check and connect
            </button>
          </div>
        </div>
      </Dialog>
    </>
  );
}

export function ConnectionsPanel({ settings, patch, returnTo = "/settings#connections" }: Props & { returnTo?: string }) {
  const client = useQueryClient();
  const toast = useToast();
  const connections = useQuery({ queryKey: ["connections"], queryFn: api.connections });
  const apps = useQuery({ queryKey: ["connector-apps"], queryFn: api.connectorApps });
  const sync = useMutation({
    mutationFn: (id: string) => api.syncConnection(id),
    onSuccess: (result) => {
      toast(result.message, { tone: result.ok ? "ok" : "error" });
      void client.invalidateQueries({ queryKey: ["connections"] });
      void client.invalidateQueries({ queryKey: ["tasks"] });
      void client.invalidateQueries({ queryKey: ["calendar"] });
    },
  });
  const connect = useMutation({
    mutationFn: async (provider: string) => (window.location.href = (await api.startConnect(provider, returnTo)).url),
    onError: (error) => toast((error as Error).message, { tone: "error" }),
  });
  const disconnect = useMutation({
    mutationFn: (provider: string) => api.disconnect(provider),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["connections"] });
      void client.invalidateQueries({ queryKey: ["settings"] });
    },
  });
  if (connections.isLoading) return <Spinner />;
  const rows = connections.data?.connections ?? [];
  const mail = rows.find((row) => row.id === "gmail");
  const calendar = rows.find((row) => row.id === "google_calendar");
  const googleApp = apps.data?.apps.find((entry) => entry.provider === "google");
  const seen = new Set<string>();
  return (
    <div className="divide-y divide-[var(--line)]">
      {mail && calendar ? (
        <GoogleAccountCard
          mail={mail}
          calendar={calendar}
          app={googleApp}
          canEdit={apps.data?.canEdit ?? false}
          settings={settings}
          patch={patch}
          pending={connect.isPending && connect.variables === "google"}
          onConnect={() => connect.mutate("google")}
          onSync={(id) => sync.mutate(id)}
          onDisconnect={() => disconnect.mutate("google")}
        />
      ) : null}
      {rows.filter((row) => row.id !== "gmail" && row.id !== "google_calendar").map((row) => {
        const enabled = row.connect === "builtin" || (settings.connections[row.id as keyof Settings["connections"]]?.enabled ?? false);
        const app = apps.data?.apps.find((entry) => entry.provider === row.provider);
        const firstOfAccount = row.provider ? !seen.has(row.provider) : true;
        if (row.provider) seen.add(row.provider);
        return (
          <div key={row.id} className={cx("flex items-start justify-between gap-4 py-3", row.connect === "later" && "opacity-60")}>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2 text-[13.5px] font-medium">
                {row.label}
                {row.connect === "later" ? (
                  <Tag tone="gray">coming later</Tag>
                ) : row.connect === "builtin" ? (
                  <Tag tone="green">built in</Tag>
                ) : !row.configured ? (
                  <Tag tone="orange">not connected</Tag>
                ) : row.lastError && enabled ? (
                  <Tag tone="red">error</Tag>
                ) : (
                  <Tag tone="green">{row.account ? row.account : "connected"}{row.accountSource === "env" ? " · server token" : row.accountSource === "cli" ? " · gh CLI" : ""}</Tag>
                )}
              </div>
              <div className="text-[12.5px] text-muted">{row.description}</div>
              {row.configured && row.connect !== "builtin" ? (
                <div className="mt-0.5 text-[12px] text-faint">
                  {plural(row.itemCount, "item")} · {row.lastSyncAt ? `synced ${relative(row.lastSyncAt)}` : "not synced yet"}
                </div>
              ) : row.connect !== "builtin" && row.connect !== "later" ? (
                <div className="mt-0.5 text-[12px] text-faint">{row.setupHint}</div>
              ) : null}
              {row.lastError && enabled && row.configured ? <div className="mt-0.5 text-[12px] text-[#ffb4ae]">{row.lastError}</div> : null}
              {row.id === "slack" && row.configured ? (
                <input
                  defaultValue={row.scope}
                  onBlur={(event) => patch({ connections: { slack: { scope: event.target.value } } })}
                  placeholder="Channels to read besides DMs, e.g. #eng, #oncall"
                  className="field mt-1.5 w-full max-w-sm text-[12.5px]"
                />
              ) : null}
            </div>
            <div className="flex shrink-0 flex-col items-end gap-2">
              {row.connect === "later" || row.connect === "builtin" ? null : row.configured ? (
                <div className="flex items-center gap-1.5">
                  <button type="button" className="btn py-0.5 text-[12px]" disabled={!enabled || sync.isPending} onClick={() => sync.mutate(row.id)}>
                    <FetchGlyph active={sync.isPending && sync.variables === row.id} slot="connector.sync" size={11} /> Sync
                  </button>
                  {firstOfAccount && row.accountSource === "you" ? (
                    <button type="button" className="btn-ghost py-0.5 text-[12px]" onClick={() => disconnect.mutate(row.provider!)}>
                      Disconnect
                    </button>
                  ) : null}
                </div>
              ) : firstOfAccount ? (
                <div className="flex flex-wrap items-center justify-end gap-1.5">
                  {row.connect === "oauth" || row.connect === "oauth_or_token" ? (
                    app?.configured ? (
                      <button type="button" className="btn-primary py-0.5 text-[12px]" onClick={() => connect.mutate(row.provider!)}>
                        <Plug size={11} /> Connect GitHub
                      </button>
                    ) : app ? (
                      <AppSetup app={app} canEdit={apps.data?.canEdit ?? false} />
                    ) : null
                  ) : null}
                  {row.connect === "token" || row.connect === "oauth_or_token" ? <TokenConnect row={row} /> : null}
                </div>
              ) : (
                <span className="text-[12px] text-faint">Uses the {row.provider} sign-in above</span>
              )}
              {row.connect !== "later" && row.connect !== "builtin" && row.configured ? (
                <Toggle checked={enabled} onChange={(value) => patch({ connections: { [row.id]: { enabled: value } } })} label={`Read ${row.label}`} />
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function ConnectionsSection(props: Props) {
  const client = useQueryClient();
  const toast = useToast();
  const syncAll = useMutation({
    mutationFn: api.fetchNow,
    onSuccess: (result) => {
      const failed = result.results.filter((row) => !row.ok);
      toast(result.message ?? (failed.length ? `${plural(failed.length, "source")} failed: ${failed[0]!.message}` : "Every switched-on source synced."), {
        tone: failed.length ? "error" : "ok",
      });
      void client.invalidateQueries();
    },
  });
  return (
    <div id="connections" className="scroll-mt-6">
      <SectionCard
        title="Sources"
        description="Sign in with Google for Gmail and Calendar. Switching a source off stops new reads immediately. What was already read stays until you delete it below."
        actions={
          <button type="button" className="btn" onClick={() => syncAll.mutate()} disabled={syncAll.isPending}>
            <FetchGlyph active={syncAll.isPending} slot="connector.sync" size={12} /> Sync now
          </button>
        }
      >
        <ConnectionsPanel {...props} />
      </SectionCard>
    </div>
  );
}

// ── editors & agents (decision router) ─────────────────────────────────────

const TARGETS = [
  { id: "cursor", label: "Cursor", detail: "Shell commands and MCP tool calls ask Ensemble before they run. Installs into ~/.cursor/hooks.json." },
  { id: "claude", label: "Claude Code", detail: "Every permission prompt comes to Ensemble. Installs into ~/.claude/settings.json." },
  { id: "vscode", label: "VS Code (GitHub Copilot agent)", detail: "Tool calls that change things ask Ensemble. Installs .github/hooks/ensemble.json in the project you run it from." },
] as const;

export function EditorsSection() {
  const client = useQueryClient();
  const toast = useToast();
  const setup = useQuery({ queryKey: ["editor-setup"], queryFn: api.editorSetup });
  const tokens = useQuery({ queryKey: ["tokens"], queryFn: api.tokens });
  const rules = useQuery({ queryKey: ["decision-rules"], queryFn: api.decisionRules });
  const [fresh, setFresh] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () => api.createToken(`Editors · ${new Date().toLocaleDateString()}`),
    onSuccess: (result) => {
      setFresh(result.token);
      void client.invalidateQueries({ queryKey: ["tokens"] });
    },
    onError: (error) => toast((error as Error).message, { tone: "error" }),
  });
  const revoke = useMutation({ mutationFn: api.revokeToken, onSuccess: () => client.invalidateQueries({ queryKey: ["tokens"] }) });
  const dropRule = useMutation({ mutationFn: api.deleteDecisionRule, onSuccess: () => client.invalidateQueries({ queryKey: ["decision-rules"] }) });
  const command = (target: string) =>
    setup.data ? `"${setup.data.node}" "${setup.data.script}" install --target ${target} --token ${fresh ?? "<create a token above>"} --url ${setup.data.apiUrl}` : "";
  return (
    <SectionCard
      title="Editors & agents"
      info="A hook in the editor holds the tool call open and asks Ensemble. Your answer on Needs me goes back to that exact call. If Ensemble is closed or nobody answers in 10 minutes, the editor shows its own prompt, the hook never allows by itself."
      description="Route “Allow this command?” prompts from Cursor, Claude Code and VS Code Copilot to Needs me, so you can answer from one place."
    >
      <p className="mb-3 text-[13px] leading-5 text-muted">
        Want an app to read your tasks and notes?{" "}
        <Link href="/settings#connect" className="font-medium text-accent hover:underline">
          Apps
        </Link>{" "}
        walks you through it and creates a read-only key.
      </p>
      <SettingRow title="Personal token" description="Hooks use this to reach your Ensemble. Shown once; revoke it here any time.">
        <button type="button" className="btn" onClick={() => create.mutate()} disabled={create.isPending}>
          Create token
        </button>
      </SettingRow>
      {fresh ? (
        <div className="mb-2 flex items-center gap-2 rounded-md border border-accent/50 bg-panel px-2 py-1.5 font-mono text-[12px]">
          <span className="min-w-0 flex-1 truncate">{fresh}</span>
          <CopyButton text={fresh} />
        </div>
      ) : null}
      {(tokens.data?.tokens ?? []).filter((token) => token.scope !== "device").map((token) => (
        <div key={token.id} className="flex items-center justify-between py-1 text-[12.5px]">
          <span>
            <span className="font-mono">{token.prefix}…</span> {token.name}{" "}
            {token.scope === "bridge" ? <Tag tone="blue">read-only</Tag> : null}{" "}
            <span className="text-faint">· {token.lastUsedAt ? `used ${relative(token.lastUsedAt)}` : "never used"}</span>
          </span>
          <button type="button" className="btn-ghost py-0 text-[12px]" onClick={() => revoke.mutate(token.id)}>
            Revoke
          </button>
        </div>
      ))}
      <div className="mt-3 space-y-3">
        {TARGETS.map((target) => (
          <div key={target.id}>
            <div className="text-[13px] font-medium">{target.label}</div>
            <div className="text-[12px] text-muted">{target.detail} Run once in a terminal, then restart the editor:</div>
            <div className="mt-1 flex items-center gap-2 rounded-md bg-panel px-2 py-1.5 font-mono text-[11.5px]">
              <span className="min-w-0 flex-1 break-all">{command(target.id)}</span>
              <CopyButton text={command(target.id)} />
            </div>
          </div>
        ))}
      </div>
      <div className="mt-4 text-[13px] font-medium">Standing answers</div>
      {(rules.data?.rules ?? []).length === 0 ? (
        <div className="text-[12.5px] text-muted">None yet. “Allow for this session” and “Always allow” on Needs me create them.</div>
      ) : (
        (rules.data?.rules ?? []).map((rule) => (
          <div key={rule.id} className="flex items-center justify-between py-1 text-[12.5px]">
            <span>
              <Tag tone={rule.decision === "allow" ? "green" : "red"}>{rule.decision}</Tag> {rule.source} · {rule.toolName}{" "}
              <span className="font-mono">{rule.pattern === "*" ? "(any input)" : rule.pattern}</span> {rule.sessionId ? <span className="text-faint">· this session only</span> : null}
            </span>
            <button type="button" className="btn-ghost py-0 text-[12px]" onClick={() => dropRule.mutate(rule.id)}>
              Remove
            </button>
          </div>
        ))
      )}
    </SectionCard>
  );
}
