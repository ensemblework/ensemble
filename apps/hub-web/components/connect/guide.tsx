"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, ExternalLink } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useDesktopParam } from "@/lib/desktop-param";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { appById, isAppId } from "@/lib/connect/catalog";
import {
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
  jetbrainsConfig,
  osFromPlatform,
  vscodeCliCommand,
  vscodeInstallUrl,
  vscodeUserConfig,
  windsurfConfig,
  windsurfPath,
  zedSnippet,
  type ConnectFacts,
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
  const app = isAppId(id) ? appById(id) : undefined;
  const bridge = useQuery({ queryKey: ["connect-bridge"], queryFn: api.connectBridge, refetchInterval: 20_000, staleTime: 10_000 });
  const token = useBridgeToken();
  const [osPick, setOsPick] = useState<ConnectOs | null>(null);
  const os = osPick ?? (bridge.data ? osFromPlatform(bridge.data.platform) : "linux");
  const facts: ConnectFacts = bridge.data
    ? {
        repoRoot: bridge.data.repoRoot,
        bridgeScript: bridge.data.bridgeScript,
        node: bridge.data.node,
        hubApiUrl: connectHubUrl({ hubApiUrl: bridge.data.hubApiUrl, publicApiUrl: bridge.data.publicApiUrl }),
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
        <StatusPill state={bridge.isLoading ? "loading" : (bridge.data?.state ?? "not_running")} />
      </div>

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
  if (step.kind === "zed") return <CopyBlock label="Copy Zed settings" text={zedSnippet(facts)} />;
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
