"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Activity, Boxes, ChartSpline, ChevronRight, Code2, FolderGit2, Gauge, Plus, Search, Sparkles, TerminalSquare, Workflow, type LucideIcon } from "lucide-react";
import { FEATURES } from "@ensemble/shared-types/features";
import type { OptionalModule } from "@ensemble/shared-types/modules";
import { setFeature } from "@/lib/features";

function Head({ title, description, action }: { title: string; description: string; action?: string }) {
  return (
    <div className="mb-5 flex items-end justify-between gap-6">
      <div className="min-w-0">
        <h2 className="display text-[40px] leading-none">{title}</h2>
        <div className="mt-2 h-[2px] w-full max-w-[280px] bg-[linear-gradient(90deg,var(--accent),transparent_70%)]" />
        <p className="mt-2 max-w-[62ch] text-[13.5px] leading-5 text-muted">{description}</p>
      </div>
      {action ? <span className="btn shrink-0">{action}</span> : null}
    </div>
  );
}

function Tag({ children, tone }: { children: string; tone: "green" | "yellow" | "blue" | "gray" }) {
  const color = tone === "green" ? "text-ok" : tone === "yellow" ? "text-warn" : tone === "blue" ? "text-accent" : "text-muted";
  return <span className={`rounded-md bg-raised px-1.5 py-px text-[11.5px] font-medium ${color}`}>{children}</span>;
}

function CodePreview() {
  const reviews = [
    ["Tighten the session cookie", "ensemble/hub · main", "+128", "−14", "In review", "yellow"],
    ["Desk tile grid", "ensemble/hub · feature-2", "+42", "−9", "Not reviewed", "blue"],
  ] as const;
  return (
    <div>
      <Head title="Code" description="Review what an agent changed, one change at a time." action="Terminal" />
      <div className="mb-3 flex items-center gap-3 text-[13px] text-muted">
        <span className="field py-1">Needs review</span>
        <span>Show expired</span>
      </div>
      {reviews.map(([title, meta, add, del, state, tone]) => (
        <div key={title} className="flex items-center gap-4 border-b border-line px-3 py-3">
          <div className="min-w-0 flex-1">
            <div className="truncate text-[14.5px] font-semibold">{title}</div>
            <div className="mt-0.5 truncate text-[12.5px] text-muted">{meta}</div>
          </div>
          <div className="flex w-44 flex-col items-end gap-1">
            <div className="text-[12px]">
              4 files <span className="text-ok">{add}</span> <span className="text-danger">{del}</span>
            </div>
            <Tag tone={tone}>{state}</Tag>
          </div>
        </div>
      ))}
      <h3 className="mb-2 mt-8 text-[17px] font-semibold">Local repositories</h3>
      <div className="grid grid-cols-2 gap-2">
        {["hub-web", "hub-api"].map((name) => (
          <div key={name} className="tile flex items-center gap-2 rounded-md bg-panel px-3 py-2.5 text-[13px]">
            <FolderGit2 size={15} className="text-muted" />
            <span>
              <span className="block font-semibold">{name}</span>
              <span className="block font-mono text-[11px] text-faint">~/ensemble/apps/{name}</span>
            </span>
          </div>
        ))}
      </div>
      <div className="mt-4 flex items-center gap-2 text-[12px] text-faint">
        <TerminalSquare size={13} /> Terminal closed · Ctrl+`
      </div>
    </div>
  );
}

function Lane({ title, count, cards, empty }: { title: string; count: string; cards: string[]; empty?: string }) {
  return (
    <div className="min-w-0">
      <div className="mb-2 flex items-baseline gap-2">
        <span className="text-[13px] font-semibold">{title}</span>
        <span className="text-[12px] text-muted">{count}</span>
      </div>
      <div className="space-y-2">
        {cards.length ? (
          cards.map((card) => (
            <div key={card} className="rounded-lg border border-line bg-panel px-3 py-3">
              <div className="text-[13.5px] font-semibold">{card}</div>
              <div className="mt-1 text-[12px] text-muted">Queued on this machine</div>
            </div>
          ))
        ) : (
          <div className="rounded-md border border-dashed border-line px-3 py-4 text-[12.5px] text-muted">{empty}</div>
        )}
      </div>
    </div>
  );
}

function WorkspacePreview() {
  return (
    <div>
      <Head title="Workspace" description="The agent's queue. Up to 3 tasks run at once." action="Assign task" />
      <div className="grid grid-cols-3 gap-4">
        <Lane title="Up next" count="2" cards={["Index the notes", "Draft the reply"]} />
        <Lane title="Working now" count="1/3" cards={["Review the diff"]} />
        <Lane title="Needs you" count="0" cards={[]} empty="The agent is not waiting on you." />
      </div>
      <div className="mt-8 grid grid-cols-2 gap-4">
        <Lane title="Recently done" count="1" cards={["Morning summary"]} />
        <Lane title="Stopped or failed" count="0" cards={[]} empty="Nothing stopped." />
      </div>
    </div>
  );
}

function RunsPreview() {
  const rows = [
    ["Index the reading pile", "Done", "green"],
    ["Morning job", "Running", "yellow"],
    ["Stopped after the third step", "Cancelled", "gray"],
  ] as const;
  return (
    <div>
      <Head title="Recent runs" description="Every delegated task leaves a trace: its plan, each step, the model, and the cost." />
      {rows.map(([title, state, tone]) => (
        <div key={title} className="flex items-center gap-3 border-b border-line px-2 py-2.5">
          <ChevronRight size={14} className="text-faint" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[14.5px] font-semibold">{title}</div>
            <div className="mt-0.5 text-[12.5px] text-muted">Today · claude · 3 steps</div>
          </div>
          <Tag tone={tone}>{state}</Tag>
        </div>
      ))}
    </div>
  );
}

function MetricsPreview() {
  const bars = [2, 4, 3, 6, 5, 8, 4, 7, 9, 6, 5, 8, 3, 4];
  return (
    <div>
      <Head title="Metrics" description="Calls, models, tokens and estimated cost over the last 14 days." action="All providers" />
      <div className="rounded-lg bg-panel p-4">
        <div className="mb-3 flex items-center justify-between text-[13px]">
          <span className="font-semibold">Calls per day</span>
          <span className="text-muted">peak 9 calls</span>
        </div>
        <div className="flex h-28 items-end gap-1.5 border-b border-dashed border-line-strong">
          {bars.map((value, index) => (
            <div key={index} className="flex-1 rounded-t bg-accent opacity-80" style={{ height: `${value * 10}%` }} />
          ))}
        </div>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-4">
        <div className="flex items-center gap-4 rounded-lg bg-panel p-4">
          <svg width="96" height="96" viewBox="0 0 96 96" aria-hidden>
            <circle cx="48" cy="48" r="32" fill="none" stroke="var(--raised)" strokeWidth="12" />
            <circle cx="48" cy="48" r="32" fill="none" stroke="var(--accent)" strokeWidth="12" strokeDasharray="120 80" transform="rotate(-90 48 48)" />
            <text x="48" y="52" textAnchor="middle" fill="var(--ink)" fontSize="16" fontWeight="700">48</text>
          </svg>
          <div className="space-y-1 text-[12.5px] text-muted">
            <div>Hub chat · 28</div>
            <div>Delegated tasks · 16</div>
            <div>Meeting extraction · 4</div>
          </div>
        </div>
        <div className="rounded-lg bg-panel p-4">
          <div className="mb-3 text-[13px] font-semibold">By model</div>
          {[
            ["claude", "70%"],
            ["local", "30%"],
          ].map(([name, width]) => (
            <div key={name} className="mb-2 grid grid-cols-[72px_1fr] items-center gap-2 text-[12.5px]">
              <span>{name}</span>
              <div className="h-2.5 overflow-hidden rounded bg-raised">
                <div className="h-full rounded bg-accent" style={{ width }} />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function DiagramsPreview() {
  return (
    <div>
      <Head title="Diagrams" description="Describe a system in plain text, or start from a few blocks." action="New diagram" />
      <div className="mb-4 rounded-xl border border-line bg-panel p-4">
        <div className="mb-3 flex items-center justify-between">
          <span className="text-[13px] font-medium">Checkout</span>
          <span className="text-[12px] text-faint">3 blocks</span>
        </div>
        <div className="flex items-center justify-center gap-3 py-2">
          {["Client", "Hub", "Store"].map((name, index) => (
            <div key={name} className="flex items-center gap-3">
              <div className="rounded-xl border border-line bg-raised px-5 py-6 text-[14px] font-medium">{name}</div>
              {index < 2 ? <span className="text-faint">→</span> : null}
            </div>
          ))}
        </div>
      </div>
      {["Checkout flow", "Agent loop"].map((title) => (
        <div key={title} className="flex items-center justify-between border-b border-line px-2 py-3">
          <span className="text-[14.5px] font-semibold">{title}</span>
          <span className="text-[12px] text-muted">Edited today</span>
        </div>
      ))}
    </div>
  );
}

function SkillsPreview() {
  return (
    <div>
      <Head title="Skill library" description="Review the agent's guidelines and reuse them on the next job." />
      <div className="mb-4 flex items-start gap-3 rounded-xl bg-panel px-4 py-3">
        <Sparkles size={16} className="mt-0.5 text-accent" />
        <div>
          <div className="text-[15px] font-semibold">Improve skills from my work</div>
          <div className="text-[12.5px] text-muted">Coming soon. Nothing is queued yet.</div>
        </div>
      </div>
      <div className="grid grid-cols-[240px_minmax(0,1fr)] gap-4">
        <div>
          <div className="mb-2 flex items-center gap-2 rounded-md bg-panel px-2 py-1.5 text-[13px] text-faint">
            <Search size={13} /> Search skills
          </div>
          {["Summarise a meeting", "Draft a reply", "File a note"].map((name, index) => (
            <div key={name} className={`rounded-md px-2 py-2 text-[13px] ${index === 0 ? "bg-hover font-semibold" : ""}`}>
              {name}
            </div>
          ))}
          <div className="mt-2 flex items-center gap-1 text-[12.5px] text-muted">
            <Plus size={13} /> New skill
          </div>
        </div>
        <div className="rounded-lg bg-panel p-4">
          <div className="text-[18px] font-semibold">Summarise a meeting</div>
          <div className="mt-3 h-28 rounded-md border border-line bg-raised p-3 font-mono text-[12px] leading-5 text-muted">
            Write the decisions first.
            <br />
            Then the open questions.
          </div>
        </div>
      </div>
    </div>
  );
}

const POINTS: Record<OptionalModule, readonly string[]> = {
  code: ["Review a change one file at a time", "Edit the files on this machine", "Open a terminal beside the diff"],
  workspace: ["Queue work for the agent", "Watch up to three jobs at once", "See what is waiting on you"],
  runs: ["Every job keeps its plan and steps", "See the model and the cost", "Stop a run that goes too far"],
  metrics: ["Calls and tokens over the last 14 days", "Cost kept beside the desk", "A ledger you can check"],
  skills: ["Guidelines the agent can reuse", "Search and edit them in one place", "Start the next job from a skill"],
  diagrams: ["Start from a sentence or a few blocks", "Keep the picture next to the work", "Open a diagram from the graph"],
  plots: ["Drop a CSV, spreadsheet, or paste", "Plot any column against any other", "Export a figure the way a paper expects"],
};

const ICONS: Record<OptionalModule, LucideIcon> = {
  code: Code2,
  workspace: Boxes,
  runs: Activity,
  metrics: Gauge,
  skills: Sparkles,
  diagrams: Workflow,
  plots: ChartSpline,
};

function Preview({ id }: { id: OptionalModule }) {
  if (id === "code") return <CodePreview />;
  if (id === "workspace") return <WorkspacePreview />;
  if (id === "runs") return <RunsPreview />;
  if (id === "metrics") return <MetricsPreview />;
  if (id === "diagrams") return <DiagramsPreview />;
  if (id === "plots") return <PlotsPreview />;
  return <SkillsPreview />;
}

function PlotsPreview() {
  return (
    <div>
      <Head title="Plots" description="A 2D figure from a table you drop in." action="New plot" />
      <div className="rounded-xl border border-dashed border-line px-6 py-10 text-center">
        <div className="display text-[26px]">Drop a table</div>
        <p className="mx-auto mt-2 max-w-md text-[13px] text-muted">CSV, Excel, Numbers, Parquet, or a public sheet link.</p>
      </div>
      <div className="mt-4 h-36 rounded-xl border border-line bg-panel p-4">
        <svg viewBox="0 0 320 90" className="h-full w-full" aria-hidden>
          <polyline fill="none" stroke="currentColor" strokeWidth="2" points="8,70 60,62 110,40 170,48 230,22 300,18" />
          <polyline fill="none" stroke="currentColor" strokeOpacity="0.45" strokeWidth="2" points="8,78 60,74 110,66 170,60 230,50 300,42" />
        </svg>
      </div>
    </div>
  );
}

export function FeatureLanding({ id }: { id: OptionalModule }) {
  const feature = FEATURES[id];
  const Icon = ICONS[id];
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const enable = async () => {
    setBusy(true);
    setError("");
    try {
      await setFeature(client, id, true);
      window.dispatchEvent(new CustomEvent("ensemble:feature-tour", { detail: { id } }));
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <div className="relative mx-auto min-h-[calc(100dvh-7.5rem)] max-w-[1100px] overflow-hidden" data-feature-landing={id}>
      <div className="pointer-events-none absolute inset-0 select-none overflow-hidden px-8 pt-8 blur-[7px] saturate-[0.72] brightness-75" aria-hidden data-feature-preview={id}>
        <Preview id={id} />
      </div>
      <div className="pointer-events-none absolute inset-0 bg-[rgb(var(--bg-rgb)/0.45)]" aria-hidden />
      <div className="relative z-10 flex min-h-[calc(100dvh-7.5rem)] items-center justify-center px-6 py-16">
        <div
          className="w-[min(440px,calc(100%-1rem))] rounded-2xl border border-line-strong bg-panel p-7 shadow-pop"
          style={{ animation: "pop-in var(--m-dur-ui) var(--m-ease-enter) both", boxShadow: "var(--elev-2)" }}
        >
          <span className="grid h-11 w-11 place-items-center rounded-xl bg-[rgb(var(--accent-rgb)/0.14)] text-accent shadow-[inset_0_0_0_1px_rgb(var(--accent-rgb)/0.28)]">
            <Icon size={22} />
          </span>
          <h1 className="display mt-4 text-[34px] leading-none">{feature.label}</h1>
          <p className="mt-3 text-[15px] leading-6 text-ink">{feature.line}</p>
          <ul className="mt-4 space-y-2 text-[13.5px] leading-5 text-muted">
            {POINTS[id].map((point) => (
              <li key={point} className="flex gap-2">
                <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
                <span>{point}</span>
              </li>
            ))}
          </ul>
          {error ? <p className="mt-3 text-[13px] text-danger">{error}</p> : null}
          <button type="button" className="btn-primary mt-6" disabled={busy} onClick={() => void enable()}>
            {busy ? "Enabling…" : `Enable ${feature.label}`}
          </button>
        </div>
      </div>
    </div>
  );
}
