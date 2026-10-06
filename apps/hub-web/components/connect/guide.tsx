"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, ExternalLink } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useDesktopParam } from "@/lib/desktop-param";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { appById } from "@/lib/connect/catalog";
import {
  EDITORS,
  INSTALL_CHANNELS,
  METHOD_LABELS,
  buildCommand,
  claudeCodeCommand,
  connectHubUrl,
  claudeDesktopConfig,
  claudeDesktopPath,
  clineConfig,
  clinePath,
  codexCommand,
  codexPath,
  codexToml,
  continueYaml,
  copilotCliCommand,
  copilotCliConfig,
  copilotPath,
  cursorConfig,
  cursorInstallUrl,
  envCommand,
  envCommandCmd,
  httpClineConfig,
  httpMcpConfig,
  httpStartCommand,
  httpVsCodeConfig,
  hostedMcpUrl,
  hostedSnippet,
  localCliSnippet,
  jetbrainsConfig,
  osFromPlatform,
  pretty,
  primaryInstallCommand,
  setupOneLiner,
  tokenValue,
  vscodeCliCommand,
  vscodeInstallUrl,
  vscodeUserConfig,
  windsurfConfig,
  windsurfPath,
  zedSnippet,
  type ConnectFacts,
  type ConnectMethod,
  type ConnectOs,
} from "@/lib/connect/configs";
import { stepsFor, troubleFor, type GuideStep } from "@/lib/connect/guides";
import { useBridgeToken } from "@/lib/connect/session-token";
import { PageHeader, cx } from "../ui";
import { BridgeKey } from "./bridge-key";
import { CopyBlock, OsTabs, StatusPill } from "./bits";
import { AppMark } from "./logos";
import { Stage } from "./stage";

const PLACEHOLDER: ConnectFacts = {
  repoRoot: "/ABSOLUTE/PATH/TO/ensemble",
  bridgeScript: "/ABSOLUTE/PATH/TO/ensemble/apps/context-bridge/dist/index.js",
  node: "node",
  hubApiUrl: "http://127.0.0.1:4000",
  httpUrl: "http://127.0.0.1:4010/mcp",
  token: null,
};

export default function Guide() {
  const params = useParams<{ app: string }>();
  const id = useDesktopParam(params.app);
  const app = appById(id);
  const bridge = useQuery({ queryKey: ["connect-bridge"], queryFn: api.connectBridge, refetchInterval: 20_000, staleTime: 10_000 });
  const token = useBridgeToken();
  const [osPick, setOsPick] = useState<ConnectOs | null>(null);
  const [method, setMethod] = useState<ConnectMethod>("cli");
  const os = osPick ?? (bridge.data ? osFromPlatform(bridge.data.platform) : "linux");
  const facts: ConnectFacts = bridge.data
    ? {
        repoRoot: bridge.data.repoRoot,
        bridgeScript: bridge.data.bridgeScript,
        node: bridge.data.node,
        hubApiUrl: connectHubUrl({ hubApiUrl: bridge.data.hubApiUrl, publicApiUrl: bridge.data.publicApiUrl }),
        publicApiUrl: bridge.data.publicApiUrl,
        httpUrl: bridge.data.httpUrl,
        token,
      }
    : { ...PLACEHOLDER, token };
  const steps = app ? stepsFor(app.id, bridge.data?.built ?? false) : [];
  const [index, setIndex] = useState(0);
  const [tested, setTested] = useState(false);
  const safeIndex = Math.min(index, Math.max(steps.length - 1, 0));
  const step = steps[safeIndex];
  const passed =
    tested &&
    (Boolean(token) || (bridge.data?.tokens.length ?? 0) > 0) &&
    (bridge.data?.built ?? false) &&
    (!step?.requiresHttp || (bridge.data?.httpUp ?? false));

  useEffect(() => {
    setIndex(0);
    setTested(false);
    setMethod("cli");
  }, [id]);

  if (!app || !step) {
    return (
      <div className="mx-auto max-w-[720px] px-6 pt-10">
        <PageHeader title="That app isn’t listed" description="Pick one of the apps on the Connect page." />
        <Link href="/connect" className="btn-primary">
          All apps
        </Link>
      </div>
    );
  }

  const last = safeIndex === steps.length - 1;
  const scene = step.kind === "test" && passed ? "success" : step.scene;

  return (
    <div className="mx-auto max-w-[1040px] px-6 pb-24 pt-6 md:px-10">
      <Link href="/connect" className="mb-4 inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-ink">
        <ArrowLeft size={14} /> All apps
      </Link>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <AppMark id={app.id} size={36} />
          <div>
            <h1 className="text-[22px] font-semibold tracking-tight">{app.name}</h1>
            <p className="text-[13.5px] text-muted">{app.get}</p>
          </div>
        </div>
        {method === "source" ? <StatusPill state={bridge.isLoading ? "loading" : (bridge.data?.state ?? "not_running")} /> : null}
      </div>

      <div className="mb-6 grid gap-2 md:grid-cols-3" role="tablist" aria-label="Connection method">
        {(["cli", "hosted", "source"] as const).map((item) => (
          <button
            key={item}
            type="button"
            role="tab"
            aria-selected={method === item}
            className={cx(
              "rounded-xl border p-3 text-left transition-colors",
              method === item ? "border-accent bg-[var(--accent-soft)]" : "border-line bg-panel hover:border-line-strong",
            )}
            onClick={() => setMethod(item)}
          >
            <span className="block text-[13.5px] font-semibold">{METHOD_LABELS[item].title}</span>
            <span className="mt-1 block text-[12.5px] leading-5 text-muted">{METHOD_LABELS[item].description}</span>
          </button>
        ))}
      </div>

      {method !== "source" ? (
        <MethodGuide app={app} method={method} os={os} onOsChange={setOsPick} facts={facts} tokens={bridge.data?.tokens ?? []} />
      ) : (
      <>
      <div className="mb-5" aria-label="Progress">
        <ol className="flex gap-1.5">
          {steps.map((item, itemIndex) => (
            <li key={`${item.kind}-${itemIndex}`} className="min-w-0 flex-1">
              <button
                type="button"
                className="flex h-6 w-full items-center"
                aria-current={itemIndex === safeIndex ? "step" : undefined}
                aria-label={`Step ${itemIndex + 1}: ${item.title}`}
                disabled={itemIndex > safeIndex}
                onClick={() => setIndex(itemIndex)}
              >
                <span
                  className={cx(
                    "h-1.5 w-full rounded-full",
                    itemIndex <= safeIndex ? "bg-accent" : "bg-line-strong",
                  )}
                />
              </button>
            </li>
          ))}
        </ol>
        <p className="mt-2 text-[12.5px] text-muted">
          Step {safeIndex + 1} of {steps.length}
        </p>
      </div>

      <div className="sr-only" aria-live="polite">
        Step {safeIndex + 1} of {steps.length}: {step.title}
      </div>

      <div key={`${id}-${safeIndex}`} className="connect-rise grid items-start gap-6 lg:grid-cols-2">
        <section aria-labelledby="step-title">
          <h2 id="step-title" className="text-[18px] font-semibold tracking-tight">
            {step.title}
          </h2>
          <p className="mt-2 text-[14px] leading-6 text-muted">{step.body}</p>
          <div className="mt-4 space-y-3">
            {step.os ? <OsTabs value={os} onChange={setOsPick} /> : null}
            <StepAction
              step={step}
              facts={facts}
              os={os}
              tokens={bridge.data?.tokens ?? []}
              hasKey={Boolean(token) || (bridge.data?.tokens.length ?? 0) > 0}
              built={bridge.data?.built ?? false}
              httpUp={bridge.data?.httpUp ?? false}
              state={bridge.data?.state}
              onTested={() => setTested(true)}
            />
          </div>
          <div className="mt-6 flex items-center justify-between gap-3">
            <button type="button" className="btn" disabled={safeIndex === 0} onClick={() => setIndex((value) => Math.max(0, value - 1))}>
              <ArrowLeft size={14} /> Back
            </button>
            {last ? null : (
              <button type="button" className="btn-primary" onClick={() => setIndex((value) => value + 1)}>
                Next <ArrowRight size={14} />
              </button>
            )}
          </div>
        </section>
        <Stage scene={scene} hotspot={passed ? "Connected" : step.hotspot} />
      </div>

      <TroubleList appId={app.id} />
      </>
      )}
    </div>
  );
}

function MethodGuide({
  app,
  method,
  os,
  onOsChange,
  facts,
  tokens,
}: {
  app: NonNullable<ReturnType<typeof appById>>;
  method: Exclude<ConnectMethod, "source">;
  os: ConnectOs;
  onOsChange: (os: ConnectOs) => void;
  facts: ConnectFacts;
  tokens: Array<{ id: string; name: string; prefix: string; lastUsedAt: string | null; createdAt: string }>;
}) {
  const origin = typeof window === "undefined" ? undefined : window.location.origin;
  const editor = EDITORS[app.id];
  const snippet = method === "cli" ? localCliSnippet(app.id, os) : hostedSnippet(app.id, facts, os, origin);
  const hostedUrl = hostedMcpUrl({ publicApiUrl: facts.publicApiUrl, origin });
  const headerText = `Authorization: ${["Bearer", facts.token ?? "KEY"].join(" ")}`;
  return (
    <div className="connect-rise grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
      <section className="tile rounded-xl bg-panel p-4 md:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-[18px] font-semibold tracking-tight">{METHOD_LABELS[method].title}</h2>
            <p className="mt-1 text-[13.5px] leading-5 text-muted">{METHOD_LABELS[method].description}</p>
          </div>
          <OsTabs value={os} onChange={onOsChange} />
        </div>

        {method === "cli" ? (
          <div className="mt-5 space-y-4">
            <div>
              <h3 className="text-[13px] font-semibold">1. Install the CLI</h3>
              <CopyBlock label={INSTALL_CHANNELS[os][0]?.label ?? "Install command"} text={primaryInstallCommand(os)} />
              <details className="mt-2 text-[13px] text-muted">
                <summary className="cursor-pointer font-medium text-ink">Other install channels</summary>
                <div className="mt-2 grid gap-2">
                  {INSTALL_CHANNELS[os].slice(1).map((channel) => (
                    <CopyBlock
                      key={channel.id}
                      label={`${channel.label}${channel.status === "coming-soon" ? " · coming soon" : ""}`}
                      text={channel.commands.join("\n")}
                    />
                  ))}
                </div>
              </details>
            </div>
            <div>
              <h3 className="text-[13px] font-semibold">2. Sign in and configure Ensemble</h3>
              <CopyBlock
                label="Run after install"
                text={["ensemble login", "ensemble folders add ~/code/my-repo", "ensemble keys set google", "ensemble runner install"].join("\n")}
              />
              <p className="mt-2 text-[12.5px] leading-5 text-faint">Use `ensemble runner start` instead of `ensemble runner install` if you do not want it to start at login.</p>
            </div>
            <div>
              <h3 className="text-[13px] font-semibold">3. Add {app.name}</h3>
              <CopyBlock label={editor.printOnly ? "Print setup snippet" : "One-line setup"} text={editor.printOnly ? `${setupOneLiner(app.id)} --print` : setupOneLiner(app.id)} />
            </div>
          </div>
        ) : (
          <div className="mt-5 space-y-4">
            <BridgeKey tokens={tokens} compact />
            <div className="rounded-lg border border-line bg-bg/60 px-3 py-2 text-[13px] leading-5 text-muted">
              Hosted URL: <span className="font-mono text-ink">{hostedUrl}</span>
              <br />
              Header: <span className="font-mono text-ink">{headerText}</span>
            </div>
          </div>
        )}

        <div className="mt-5 space-y-2">
          <h3 className="text-[13px] font-semibold">{method === "cli" ? "Config written by the CLI" : "Hosted config"}</h3>
          {snippet.path ? <p className="text-[12.5px] text-faint">File: {snippet.path}</p> : null}
          {snippet.note ? <p className="text-[12.5px] leading-5 text-muted">{snippet.note}</p> : null}
          <CopyBlock label={snippet.label} text={snippet.text} />
        </div>
      </section>

      <aside className="tile rounded-xl bg-panel p-4">
        <h2 className="text-[15px] font-semibold">What this allows</h2>
        <ul className="mt-3 space-y-2 text-[13px] leading-5 text-muted">
          <li>• MCP access is read-only: editors can read your Ensemble context but cannot change it.</li>
          <li>• Hosted MCP uses <span className="font-mono">https://api.ensemblework.com/mcp</span> with an <span className="font-mono">ens_</span> bridge key.</li>
          <li>• CLI runner tasks only run in folders you add with <span className="font-mono">ensemble folders add</span>.</li>
          <li>• Check setup with <span className="font-mono">ensemble status</span> and <span className="font-mono">ensemble doctor</span>.</li>
        </ul>
      </aside>
    </div>
  );
}

function StepAction({
  step,
  facts,
  os,
  tokens,
  hasKey,
  built,
  httpUp,
  state,
  onTested,
}: {
  step: GuideStep;
  facts: ConnectFacts;
  os: ConnectOs;
  tokens: Array<{ id: string; name: string; prefix: string; lastUsedAt: string | null; createdAt: string }>;
  hasKey: boolean;
  built: boolean;
  httpUp: boolean;
  state: "connected" | "running" | "not_running" | undefined;
  onTested: () => void;
}) {
  if (step.kind === "key") return <BridgeKey tokens={tokens} compact />;
  if (step.kind === "build") return <CopyBlock label="Copy command" text={buildCommand(facts, os)} />;
  if (step.kind === "env") {
    return (
      <div className="space-y-2">
        <CopyBlock label={os === "windows" ? "Copy for PowerShell" : "Copy command"} text={envCommand(facts, os)} />
        {os === "windows" ? <CopyBlock label="Or Command Prompt" text={envCommandCmd(facts)} /> : null}
      </div>
    );
  }
  if (step.kind === "vscode-install") {
    return (
      <div className="space-y-3">
        <div className="flex flex-wrap gap-2">
          <a className="btn-primary" href={vscodeInstallUrl(facts)}>
            Add to VS Code <ExternalLink size={13} />
          </a>
          <a className="btn" href={vscodeInstallUrl(facts, true)}>
            VS Code Insiders
          </a>
        </div>
        <CopyBlock label="Or copy user settings" text={vscodeUserConfig(facts)} />
        <details className="text-[13px] text-muted">
          <summary className="cursor-pointer font-medium text-ink">Using the terminal instead</summary>
          <div className="mt-2">
            <CopyBlock label="Official command-line install" text={vscodeCliCommand(facts, os)} />
          </div>
        </details>
      </div>
    );
  }
  if (step.kind === "cursor-install") {
    return (
      <div className="space-y-3">
        <a className="btn-primary" href={cursorInstallUrl(facts)}>
          Add to Cursor <ExternalLink size={13} />
        </a>
        <CopyBlock label="Or copy Cursor settings" text={cursorConfig(facts)} />
      </div>
    );
  }
  if (step.kind === "copilot") {
    return (
      <div className="space-y-3">
        <p className="text-[12.5px] text-faint">File: {copilotPath(os)}</p>
        <CopyBlock label="Copy Copilot CLI settings" text={copilotCliConfig(facts)} />
        <details className="text-[13px] text-muted">
          <summary className="cursor-pointer font-medium text-ink">Prefer a command</summary>
          <div className="mt-2">
            <CopyBlock label="Copy command" text={copilotCliCommand(facts, os)} />
          </div>
        </details>
      </div>
    );
  }
  if (step.kind === "claude-code") return <CopyBlock label="Copy command" text={claudeCodeCommand(facts, os)} />;
  if (step.kind === "claude-desktop") {
    return (
      <div className="space-y-3">
        <p className="text-[12.5px] text-faint">File: {claudeDesktopPath(os)}</p>
        <CopyBlock label="Copy Claude Desktop settings" text={claudeDesktopConfig(facts)} />
      </div>
    );
  }
  if (step.kind === "codex") return <CopyBlock label="Copy command" text={codexCommand(facts, os)} />;
  if (step.kind === "codex-app") {
    return (
      <div className="space-y-3">
        <p className="text-[12.5px] text-faint">Merge into {codexPath(os)}. Don’t replace the rest of the file.</p>
        <CopyBlock label="Copy Codex settings" text={codexToml(facts)} />
      </div>
    );
  }
  if (step.kind === "windsurf") {
    return (
      <div className="space-y-3">
        <p className="text-[12.5px] text-faint">File: {windsurfPath(os)}</p>
        <CopyBlock label="Copy Windsurf settings" text={windsurfConfig(facts)} />
      </div>
    );
  }
  if (step.kind === "gemini") {
    return (
      <CopyBlock
        label="Copy Gemini settings"
        text={pretty({
          mcpServers: {
            ensemble: {
              command: "node",
              args: [facts.bridgeScript],
              env: { HUB_API_URL: facts.hubApiUrl, ENSEMBLE_BRIDGE_TOKEN: tokenValue(facts) },
            },
          },
        })}
      />
    );
  }
  if (step.kind === "zed") return <CopyBlock label="Copy Zed settings" text={zedSnippet(facts)} />;
  if (step.kind === "visual-studio") {
    return (
      <CopyBlock
        label="Copy Visual Studio settings"
        text={pretty({
          servers: {
            ensemble: {
              type: "stdio",
              command: "node",
              args: [facts.bridgeScript],
              env: { HUB_API_URL: facts.hubApiUrl, ENSEMBLE_BRIDGE_TOKEN: tokenValue(facts) },
            },
          },
        })}
      />
    );
  }
  if (step.kind === "jetbrains") return <CopyBlock label="Copy JetBrains JSON" text={jetbrainsConfig(facts)} />;
  if (step.kind === "cline") {
    return (
      <div className="space-y-3">
        <p className="text-[12.5px] text-faint">Terminal app file: {clinePath(os)}</p>
        <CopyBlock label="Copy Cline settings" text={clineConfig(facts)} />
      </div>
    );
  }
  if (step.kind === "continue") return <CopyBlock label="Copy ensemble.yaml" text={continueYaml(facts)} />;
  if (step.kind === "opencode") {
    return (
      <CopyBlock
        label="Copy opencode settings"
        text={pretty({
          mcp: {
            ensemble: {
              type: "local",
              command: ["node", facts.bridgeScript],
              enabled: true,
              env: { HUB_API_URL: facts.hubApiUrl, ENSEMBLE_BRIDGE_TOKEN: tokenValue(facts) },
            },
          },
        })}
      />
    );
  }
  if (step.kind === "http-start") {
    return (
      <div className="space-y-3">
        <CopyBlock label="Copy command" text={httpStartCommand(facts, os)} />
        <p className="text-[12.5px] text-faint">Address: {facts.httpUrl}</p>
      </div>
    );
  }
  if (step.kind === "http-config") {
    return (
      <div className="space-y-3">
        <CopyBlock label="VS Code" text={httpVsCodeConfig(facts)} />
        <CopyBlock label="Cursor, Claude, Windsurf, and most others" text={httpMcpConfig(facts)} />
        <CopyBlock label="Cline" text={httpClineConfig(facts)} />
      </div>
    );
  }
  if (step.kind === "test") {
    return <TestStep requiresHttp={Boolean(step.requiresHttp)} hasKey={hasKey} built={built} httpUp={httpUp} state={state} onTested={onTested} />;
  }
  return null;
}

function TestStep({
  requiresHttp,
  hasKey,
  built,
  httpUp,
  state,
  onTested,
}: {
  requiresHttp: boolean;
  hasKey: boolean;
  built: boolean;
  httpUp: boolean;
  state: "connected" | "running" | "not_running" | undefined;
  onTested: () => void;
}) {
  const client = useQueryClient();
  const [ran, setRan] = useState(false);
  const [pending, setPending] = useState(false);
  const ready = hasKey && built && (!requiresHttp || httpUp);
  const lines = [
    hasKey ? "Your key is saved." : "Create your read-only key on the first step.",
    built ? "The connector program is ready." : "Run the prepare command, then test again.",
    state === "connected"
      ? "An app has already used your key."
      : httpUp
        ? "The shared connection is running."
        : requiresHttp
          ? "The shared connection is not running yet. Leave the start command open and test again."
          : "This app starts Ensemble on its own, so the shared connection can stay off.",
  ];
  return (
    <div className="space-y-3">
      <button
        type="button"
        className="btn-primary"
        disabled={pending}
        onClick={() => {
          setPending(true);
          void client.invalidateQueries({ queryKey: ["connect-bridge"] }).finally(() => {
            setRan(true);
            setPending(false);
            onTested();
          });
        }}
      >
        {pending ? "Checking…" : "Test connection"}
      </button>
      {ran ? (
        <div className={cx("rounded-xl border px-3 py-3", ready ? "border-ok/40 bg-ok/10" : "border-warn/40 bg-panel")} role="status">
          <p className="text-[14px] font-medium">{ready ? "You’re set" : "One thing left"}</p>
          <ul className="mt-2 space-y-1 text-[13px] leading-5 text-muted">
            {lines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          {ready ? <p className="mt-2 text-[13px]">Open the app and paste a question from the Connect page.</p> : null}
        </div>
      ) : null}
    </div>
  );
}

function TroubleList({ appId }: { appId: Parameters<typeof troubleFor>[0] }) {
  const rows = troubleFor(appId);
  return (
    <section className="mt-10" aria-labelledby="trouble-title">
      <h2 id="trouble-title" className="text-[15px] font-semibold">
        If something looks wrong
      </h2>
      <div className="mt-2 divide-y divide-[var(--line)] rounded-xl border border-line bg-panel">
        {rows.map((row) => (
          <details key={row.problem} className="group px-3 py-2.5">
            <summary className="cursor-pointer text-[13.5px] font-medium">{row.problem}</summary>
            <p className="mt-1.5 text-[13px] leading-5 text-muted">{row.fix}</p>
          </details>
        ))}
      </div>
    </section>
  );
}
