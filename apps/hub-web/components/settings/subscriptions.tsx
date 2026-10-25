"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ExternalLink, Laptop, LogIn, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { claudeUpdateNote, SUBSCRIPTION_INFO, SUBSCRIPTION_PROVIDERS, type Settings, type SubscriptionAgent, type SubscriptionProvider, type UsageWindow } from "@ensemble/shared-types";
import { api, type SubscriptionComputer, type SubscriptionsView } from "@/lib/api";
import { relative, untilLabel } from "@/lib/format";
import { modelFacts } from "@/lib/engine-models";
import { useToast } from "../toast";
import { cx, Tag } from "../ui";
import { ConnectComputerButton } from "./connect-computer";
import { navigateSettings } from "./url-state";
import { modelBrand, ProviderLogo } from "../connectors/provider-logo";

type Patch = (patch: Record<string, unknown>) => void;
const TIER_IDS = ["easy", "medium", "high", "max"] as const;
const TIER_NAMES: Record<(typeof TIER_IDS)[number], string> = { easy: "Low", medium: "Medium", high: "High", max: "Max" };

export function SubscriptionMark({ id, size = 34 }: { id: SubscriptionProvider; size?: number }) {
  // A vendor without a published mark here (Grok) shows its initial.
  const mark = modelBrand(null, id) ? <ProviderLogo id={id} size={Math.round(size * .65)} /> : <span className="text-[15px] font-semibold text-ink" aria-hidden>{SUBSCRIPTION_INFO[id].label.slice(0, 1)}</span>;
  return <span className="inline-flex shrink-0 items-center justify-center rounded-xl border border-line bg-panel" style={{ width: size, height: size }}>{mark}</span>;
}

/** While a check or a sign-in is under way, ask more often; otherwise a calm refresh. */
export function useSubscriptions(fast = false) {
  return useQuery({ queryKey: ["subscriptions"], queryFn: api.subscriptions, refetchInterval: fast ? 3_000 : 30_000 });
}

/** The computer turns run on: the chosen one when it is online, else the most recently seen online one. */
export function activeComputer(view: SubscriptionsView | undefined): SubscriptionComputer | null {
  const computers = view?.computers ?? [];
  return computers.find((row) => row.id === view?.preferred && row.online) ?? computers.find((row) => row.online) ?? computers[0] ?? null;
}

const PROGRAM: Record<SubscriptionProvider, string> = {
  "claude-code": "Claude Code",
  codex: "the Codex CLI",
  "cursor-agent": "Cursor's agent",
  "copilot-cli": "Copilot CLI",
  "grok-cli": "Grok Build",
  opencode: "OpenCode",
  "gemini-cli": "Gemini CLI",
  antigravity: "Antigravity's agent, installed by Ensemble",
};
const viaText = (agent: SubscriptionAgent): string => {
  const program = agent.id === "claude-code" && agent.via === "app" ? "the Claude app" : agent.id === "codex" && agent.via === "app" ? "the ChatGPT app" : PROGRAM[agent.id];
  return `via ${program}${agent.version ? ` ${agent.version}` : ""}`;
};

function statusOf(agent: SubscriptionAgent | null): { tone: "green" | "orange" | "gray" | "blue"; text: string } {
  if (!agent) return { tone: "gray", text: "Not on this computer" };
  if (agent.problem) return { tone: "orange", text: "Needs a look" };
  if (agent.signedIn === false) return { tone: "orange", text: "Not signed in" };
  if (agent.signedIn === true) return { tone: "green", text: `${agent.account ? `Signed in as ${agent.account}` : "Signed in"}${agent.plan ? ` · ${agent.plan}` : ""}` };
  return { tone: "blue", text: "Found · sign-in checked on first message" };
}

/** Which tiers already use this subscription: "Low, Medium". */
export function tiersUsing(settings: Settings, provider: string): string[] {
  return TIER_IDS.filter((tier) => settings.models[tier].provider === provider).map((tier) => TIER_NAMES[tier]);
}

function defaultModel(agent: SubscriptionAgent): string {
  return agent.models.find((model) => model.isDefault)?.id ?? agent.models[0]?.id ?? "default";
}

/** The plan's usage windows as the agent reported them: how much is used, and when each starts over. */
export function UsageBars({ windows, label }: { windows: UsageWindow[]; label: string }) {
  return (
    <div className="space-y-1.5" aria-label={`${label} usage`} data-testid="subscription-limits">
      {windows.map((window) => {
        const used = Math.round(window.usedPercent);
        return (
          <div key={window.id}>
            <div className="flex items-baseline justify-between gap-2 text-[11.5px]">
              <span className="text-muted">{window.label}</span>
              <span className={used >= 90 ? "text-warn" : "text-faint"}>
                {used}% used{window.resetsAt ? ` · resets in ${untilLabel((Date.parse(window.resetsAt) - Date.now()) / 1000)}` : ""}
              </span>
            </div>
            <div className="mt-0.5 h-1.5 overflow-hidden rounded-full bg-panel" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={used} aria-label={window.label}>
              <div className={cx("h-full rounded-full", used >= 90 ? "bg-[var(--warn)]" : "bg-accent")} style={{ width: `${used}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function SubscriptionTile({
  id,
  agent,
  computer,
  settings,
  patch,
  onSignIn,
  signingIn,
}: {
  id: SubscriptionProvider;
  agent: SubscriptionAgent | null;
  computer: SubscriptionComputer | null;
  settings: Settings;
  patch: Patch;
  onSignIn: () => void;
  signingIn: boolean;
}) {
  const info = SUBSCRIPTION_INFO[id];
  const status = statusOf(agent);
  const using = tiersUsing(settings, id);
  const [model, setModel] = useState<string>(() => (agent ? defaultModel(agent) : "default"));
  useEffect(() => {
    if (agent && !agent.models.some((row) => row.id === model)) setModel(defaultModel(agent));
  }, [agent, model]);
  const usable = Boolean(agent && computer?.online && computer.ready && agent.signedIn !== false && !agent.problem);
  const chosen = agent?.models.find((row) => row.id === model) ?? null;
  // Cost and context sizes, where the agent reports them (GitHub Copilot).
  const facts = chosen && (chosen.cost || chosen.contexts?.length) ? modelFacts(chosen) : "";
  return (
    <div className="tile flex min-w-0 flex-col gap-3 rounded-xl bg-raised p-3.5" data-subscription={id} data-state={agent ? (agent.signedIn === false ? "signed-out" : "found") : "missing"}>
      <div className="flex items-start gap-3">
        <SubscriptionMark id={id} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[14px] font-semibold">{info.label}</span>
            <Tag tone={status.tone}>{status.text}</Tag>
          </div>
          <div className="mt-0.5 truncate text-[12px] text-muted">{agent ? viaText(agent) : info.plan}</div>
        </div>
      </div>
      {agent?.problem ? <p className="text-[12px] text-warn">{agent.problem}</p> : null}
      {agent && id === "claude-code" && claudeUpdateNote(agent.version) ? <p className="text-[12px] text-muted" data-testid="subscription-update-note">{claudeUpdateNote(agent.version)}</p> : null}
      {agent?.limits?.length ? <UsageBars windows={agent.limits} label={info.label} /> : null}
      {agent ? (
        <div className="flex flex-wrap gap-1" aria-label={`${info.label} models`}>
          {agent.models.slice(0, 6).map((row) => (
            <button
              key={row.id}
              type="button"
              title={modelFacts(row) || row.id}
              onClick={() => setModel(row.id)}
              aria-pressed={row.id === model}
              className={cx(
                "rounded-full border px-2 py-0.5 text-[11.5px] transition-colors",
                row.id === model ? "border-accent bg-[var(--accent-soft)] text-ink" : "border-line text-muted hover:border-line-strong hover:text-ink",
              )}
            >
              {row.label}
            </button>
          ))}
          {agent.models.length > 6 ? <span className="px-1 py-0.5 text-[11.5px] text-faint">+{agent.models.length - 6} more in the tier pickers</span> : null}
          {facts ? <p className="w-full px-0.5 text-[11.5px] text-faint" data-testid="subscription-model-facts">{chosen!.label}: {facts}</p> : null}
        </div>
      ) : (
        <p className="text-[12px] text-muted">Needs {info.program}.</p>
      )}
      <div className="mt-auto flex flex-wrap items-center justify-between gap-2">
        <span className="text-[11.5px] text-faint">{using.length ? `In use: ${using.join(", ")}` : ""}</span>
        <div className="flex flex-wrap items-center gap-1.5">
          {!agent && id === "antigravity" ? (
            // Antigravity has nothing to install by hand: Sign in installs Google's agent, then opens Google's sign-in.
            <button type="button" className="btn py-0.5 text-[12px]" onClick={onSignIn} disabled={signingIn || !computer?.online || !computer.ready} data-testid="antigravity-install">
              <LogIn size={11} aria-hidden /> {signingIn ? "Setting up…" : "Install and sign in"}
            </button>
          ) : !agent ? (
            <a className="btn py-0.5 text-[12px]" href={info.install.url} target="_blank" rel="noreferrer">
              {info.install.label} <ExternalLink size={11} aria-hidden />
            </a>
          ) : agent.signedIn !== true ? (
            <button type="button" className={agent.signedIn === false ? "btn-primary py-0.5 text-[12px]" : "btn py-0.5 text-[12px]"} onClick={onSignIn} disabled={signingIn || !computer?.online || !computer.ready}>
              <LogIn size={11} aria-hidden /> {signingIn ? "Opening…" : "Sign in"}
            </button>
          ) : null}
          {agent ? (
            <button
              type="button"
              className={agent.signedIn === false ? "btn py-0.5 text-[12px]" : "btn-primary py-0.5 text-[12px]"}
              disabled={!usable}
              onClick={() => patch({ models: Object.fromEntries(TIER_IDS.map((tier) => [tier, { provider: id, model, effort: "default", ...(settings.models[tier].context === "long_context" ? { context: "default" } : {}) }])) })}
            >
              {using.length === TIER_IDS.length && TIER_IDS.every((tier) => settings.models[tier].model === model) ? <Check size={11} aria-hidden /> : null} Use for everything
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * The person's own AI subscriptions, first among the ways to power the assistant (docs/30 §8).
 * They run on the person's computer with the vendor's own sign-in; Ensemble never pays for them
 * and never sees the sign-in.
 */
export function SubscriptionsCard({ settings, patch }: { settings: Settings; patch: Patch }) {
  const toast = useToast();
  const client = useQueryClient();
  const [busyUntil, setBusyUntil] = useState(0);
  const fast = busyUntil > Date.now();
  const view = useSubscriptions(fast);
  useEffect(() => {
    if (!busyUntil) return;
    const timer = setTimeout(() => setBusyUntil(0), Math.max(0, busyUntil - Date.now()));
    return () => clearTimeout(timer);
  }, [busyUntil]);
  const computer = activeComputer(view.data);
  const check = useMutation({
    mutationFn: () => api.checkSubscriptions(computer!.id),
    onSuccess: () => {
      setBusyUntil(Date.now() + 45_000);
      void client.invalidateQueries({ queryKey: ["subscriptions"] });
    },
    onError: (error) => toast((error as Error).message, { tone: "error" }),
  });
  const signIn = useMutation({
    mutationFn: (agent: SubscriptionProvider) => api.signInSubscription(computer!.id, agent),
    onSuccess: (result) => {
      toast(result.message, { tone: "ok" });
      setBusyUntil(Date.now() + 6 * 60_000);
    },
    onError: (error) => toast((error as Error).message, { tone: "error" }),
  });
  const computers = view.data?.computers ?? [];
  return (
    <div className="rounded-xl border border-line bg-panel p-4" data-testid="subscriptions-card">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-[14.5px] font-semibold" data-jump-label="Your AI subscriptions">Your AI subscriptions</h3>
          <p className="mt-0.5 max-w-[620px] text-[12.5px] leading-[18px] text-muted">
            Use the Claude, ChatGPT, Cursor or Copilot plan you already pay for. It runs on your own computer with your own sign-in, so the assistant, @ensemble on pages and the rest of Ensemble's AI cost you nothing extra here.
          </p>
        </div>
        {computer ? (
          <button type="button" className="btn shrink-0" onClick={() => check.mutate()} disabled={check.isPending || !computer.online || !computer.ready}>
            <RefreshCw size={12} className={cx((check.isPending || fast) && "animate-spin")} aria-hidden /> Check again
          </button>
        ) : null}
      </div>
      {view.isLoading ? <div className="mt-4 h-24 animate-pulse rounded-xl bg-raised" /> : null}
      {view.error ? <p className="mt-3 text-[12.5px] text-warn">{(view.error as Error).message}</p> : null}
      {view.data && !computers.length ? (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-dashed border-line-strong p-4" data-testid="subscriptions-no-computer">
          <div className="flex min-w-0 items-start gap-3">
            <Laptop size={18} className="mt-0.5 shrink-0 text-muted" aria-hidden />
            <div className="min-w-0 text-[12.5px] text-muted">
              <div className="text-[13.5px] font-medium text-ink">Connect your computer first</div>
              Install Ensemble on the computer that has the Claude or ChatGPT app and sign in with this account. Its subscriptions then show up here.
            </div>
          </div>
          <ConnectComputerButton className="btn-primary" />
        </div>
      ) : null}
      {computer ? (
        <>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-[12.5px]">
            <span className="text-muted">Runs on</span>
            {computers.length > 1 ? (
              <select
                className="field py-1 text-[12.5px]"
                aria-label="Computer that runs your subscriptions"
                value={settings.models.computer ?? ""}
                onChange={(event) => patch({ models: { computer: event.target.value || null } })}
              >
                <option value="">The computer online most recently</option>
                {computers.map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.name}
                    {row.online ? "" : " (offline)"}
                  </option>
                ))}
              </select>
            ) : null}
            <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-raised px-2 py-0.5">
              <span className={cx("size-1.5 rounded-full", computer.online ? "bg-ok" : "bg-line-strong")} aria-hidden />
              {computer.name}
              <span className="text-faint">{computer.online ? "online" : computer.lastSeenAt ? `last seen ${relative(computer.lastSeenAt)}` : "offline"}</span>
            </span>
          </div>
          {!computer.online ? (
            <p className="mt-2 text-[12.5px] text-warn">{computer.name} is offline. Open Ensemble on it (the desktop app, or `ensemble` in a terminal) so the assistant can use your subscriptions.</p>
          ) : !computer.ready ? (
            <p className="mt-2 text-[12.5px] text-warn">Update Ensemble on {computer.name} to use your subscriptions (the CLI 0.3.10 or the desktop app 0.3.7, or newer).</p>
          ) : null}
          <div className="mt-3 grid grid-cols-1 gap-2.5 md:grid-cols-2" data-testid="subscriptions-grid">
            {SUBSCRIPTION_PROVIDERS.map((id) => (
              <SubscriptionTile
                key={id}
                id={id}
                agent={computer.agents.find((row) => row.id === id) ?? null}
                computer={computer}
                settings={settings}
                patch={patch}
                signingIn={signIn.isPending && signIn.variables === id}
                onSignIn={() => signIn.mutate(id)}
              />
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}
