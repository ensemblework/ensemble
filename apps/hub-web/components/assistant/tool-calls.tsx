"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ArrowUpRight,
  BookOpen,
  CalendarDays,
  ChartLine,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Code2,
  File,
  FileText,
  FolderKanban,
  Globe,
  LayoutGrid,
  Layers,
  ListChecks,
  Mail,
  MessageSquare,
  Pencil,
  Plus,
  Redo2,
  Search,
  Settings2,
  SquareCheck,
  Table,
  Trash2,
  Undo2,
  Users,
  Workflow,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useState, type ReactNode } from "react";
import { formatEntityText, type AssistantRef } from "@ensemble/shared-types";
import { api, type AssistantMessageRecord, type AssistantToolCallRecord } from "@/lib/api";
import { applyNotice, applyRepliesToCache } from "@/lib/assistant-apply";
import { plural } from "@/lib/format";
import { useToast } from "../toast";
import { cx } from "../ui";

/** Names whose words do not read as an action on their own. */
const NAMED: Record<string, string> = {
  hub_web_search: "Search the web",
  hub_read_web_page: "Read a web page",
  hub_how_to: "Read a playbook",
  hub_run_workflow: "Run steps",
  hub_fetch_now: "Fetch from connected apps",
  hub_search_context: "Search your context",
  hub_read_context: "Read from your context",
  hub_read_surface: "Read this screen",
  apps_search: "Search a connected app",
  apps_read: "Read from a connected app",
};

const APPS: Record<string, string> = {
  gmail: "Gmail",
  calendar: "Calendar",
  drive: "Drive",
  docs: "Google Docs",
  sheets: "Google Sheets",
  slides: "Google Slides",
  outlook: "Outlook",
  teams: "Teams",
  onedrive: "OneDrive",
  word: "Word",
  excel: "Excel",
  powerpoint: "PowerPoint",
  zoom: "Zoom",
  docusign: "DocuSign",
  jira: "Jira",
  github: "GitHub",
  slack: "Slack",
  linear: "Linear",
  notion: "Notion",
};

/** What an app's own create makes, when the tool name names no object (`docs_create`). */
const APP_THING: Record<string, string> = {
  docs: "Google Doc",
  sheets: "Google Sheet",
  slides: "Google Slides deck",
  word: "Word document",
  excel: "Excel workbook",
  powerpoint: "PowerPoint deck",
};

const VERBS = new Set([
  "list", "get", "read", "search", "find", "create", "update", "delete", "add", "remove", "run", "fetch", "send", "append",
  "replace", "upsert", "view", "edit", "move", "set", "suggest", "stop", "start", "apply", "draft", "save", "open", "attach",
  "assign", "complete", "archive", "restore", "share", "schedule", "reply", "mark", "link", "unlink", "rename", "duplicate",
  "import", "export", "plan", "check", "write", "post", "comment", "invite", "change", "make", "summarize", "ask", "watch",
]);

const sentence = (words: string[]) => {
  const text = words.join(" ").trim();
  return text ? text[0]!.toUpperCase() + text.slice(1) : "";
};

/** A tool name as a verb and its object: `calendar_create_event` reads "Create Calendar event". */
export function toolLabel(name: string): string {
  if (NAMED[name]) return NAMED[name]!;
  const mcp = /^mcp_([a-z0-9-]+)_(.+)$/i.exec(name);
  if (mcp) {
    const server = APPS[mcp[1]!.toLowerCase()] ?? sentence(mcp[1]!.split(/[-_]/));
    return `${toolLabel(mcp[2]!)} · ${server}`;
  }
  const words = name.replace(/^(hub|apps)_/, "").split(/[_\s]+/).filter(Boolean).map((word) => word.toLowerCase());
  if (!words.length) return "Step";
  const at = words.findIndex((word) => VERBS.has(word));
  if (at <= 0) return sentence(words);
  const app = words.slice(0, at).join("_");
  const object = words.slice(at + 1);
  const where = APPS[app] ?? sentence(words.slice(0, at));
  return sentence([words[at]!, ...(object.length ? [where, ...object] : [APP_THING[app] ?? where])]);
}

const OBJECT_ICONS: Array<[RegExp, LucideIcon]> = [
  [/web_search|web_page|_web_|browser/, Globe],
  [/gmail|outlook_.*mail|mail|email|message_/, Mail],
  [/calendar|event|meeting|zoom/, CalendarDays],
  [/task|todo/, SquareCheck],
  [/project/, FolderKanban],
  [/people|person|contact|member|invite/, Users],
  [/diagram/, Workflow],
  [/plot|chart/, ChartLine],
  [/sheet|excel|table|csv/, Table],
  [/page|docs|word|note|document/, FileText],
  [/file|drive|onedrive|attachment|upload/, File],
  [/tile|layout|desk|board|widget/, LayoutGrid],
  [/setting/, Settings2],
  [/workflow|steps|routine/, ListChecks],
  [/how_to|playbook|skill/, BookOpen],
  [/code|repo|commit|pull|github/, Code2],
  [/chat|teams|slack|comment|reply/, MessageSquare],
];

const VERB_ICONS: Array<[RegExp, LucideIcon]> = [
  [/(^|_)(search|find)(_|$)/, Search],
  [/(^|_)(create|add|upsert|draft|make)(_|$)/, Plus],
  [/(^|_)(update|edit|replace|change|set|rename|move)(_|$)/, Pencil],
  [/(^|_)(delete|remove|archive)(_|$)/, Trash2],
];

/** The icon for what a call touched; searches show a magnifier whatever they searched. */
export function toolIcon(name: string): LucideIcon {
  const key = name.toLowerCase();
  if (/(^|_)search(_|$)/.test(key) && !/web/.test(key)) return Search;
  for (const [pattern, icon] of OBJECT_ICONS) if (pattern.test(key)) return icon;
  for (const [pattern, icon] of VERB_ICONS) if (pattern.test(key)) return icon;
  return Wrench;
}

/** A proposal: a write the person has not applied yet. */
export const isProposal = (call: AssistantToolCallRecord) => call.state === "awaiting_approval" && call.isWrite !== false;

/** A finished read: nothing to act on, so a run of them can fold into one line. */
const quiet = (call: AssistantToolCallRecord) => call.state === "ok" && call.isWrite === false;

export type ToolRun = { kind: "call"; call: AssistantToolCallRecord } | { kind: "run"; calls: AssistantToolCallRecord[] };

/**
 * Calls in order, with runs of three or more finished reads folded into one line once there are
 * more than four calls. Writes, failures and proposals always keep their own line.
 */
export function foldRuns(calls: readonly AssistantToolCallRecord[]): ToolRun[] {
  if (calls.length <= 4) return calls.map((call) => ({ kind: "call", call }));
  const out: ToolRun[] = [];
  let run: AssistantToolCallRecord[] = [];
  const flush = () => {
    if (run.length >= 3) out.push({ kind: "run", calls: run });
    else out.push(...run.map((call) => ({ kind: "call" as const, call })));
    run = [];
  };
  for (const call of calls) {
    if (quiet(call)) {
      run.push(call);
      continue;
    }
    flush();
    out.push({ kind: "call", call });
  }
  flush();
  return out;
}

/** One line for a reply's finished steps: "8 steps · 1 change · 1 failed". */
export function stepsLine(calls: readonly AssistantToolCallRecord[]): string {
  const changes = calls.filter((call) => call.state === "ok" && call.isWrite !== false).length;
  const failed = calls.filter((call) => call.state === "failed").length;
  const undone = calls.filter((call) => call.state === "undone").length;
  return [
    plural(calls.length, "step"),
    changes ? plural(changes, "change") : "",
    undone ? `${undone} undone` : "",
    failed ? `${failed} failed` : "",
  ].filter(Boolean).join(" · ");
}

/** "- lead: Mira Chen" lines of a proposal's preview, as fields. */
function previewLines(lines: string[]): ReactNode {
  if (!lines.length) return null;
  return (
    <ul className="tool-fields">
      {lines.map((line, index) => {
        const field = /^\s*[-•*]\s*([^:]{1,40}):\s*(.+)$/.exec(line);
        return field ? (
          <li key={index}><span className="tool-field-key">{field[1]}</span><span className="tool-field-value">{field[2]}</span></li>
        ) : (
          <li key={index}><span className="tool-field-value">{line.replace(/^\s*[-•*]\s*/, "")}</span></li>
        );
      })}
    </ul>
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A call's input as a few readable fields. Known ids show by title; unknown ids are left out. */
function inputFields(input: Record<string, unknown> | undefined, refs: readonly AssistantRef[]): Array<[string, string]> {
  if (!input) return [];
  const byId = new Map(refs.map((ref) => [ref.id, ref.label]));
  const value = (raw: unknown): string | null => {
    if (raw === null || raw === undefined || raw === "") return null;
    if (typeof raw === "string") {
      if (UUID.test(raw)) return byId.get(raw) ? `“${byId.get(raw)}”` : null;
      const text = formatEntityText(raw, refs, { plain: true }).replace(/\s+/g, " ").trim();
      return text.length > 120 ? `${text.slice(0, 119)}…` : text;
    }
    if (typeof raw === "number" || typeof raw === "boolean") return String(raw);
    if (Array.isArray(raw)) {
      const titles = raw.map((item) => (item && typeof item === "object" ? (item as Record<string, unknown>).title ?? (item as Record<string, unknown>).name : item)).filter((item): item is string => typeof item === "string" && !UUID.test(item));
      return titles.length === raw.length && titles.length <= 3 ? titles.map((title) => `“${title}”`).join(", ") : plural(raw.length, "item");
    }
    return null;
  };
  const out: Array<[string, string]> = [];
  for (const [key, raw] of Object.entries(input)) {
    // Ids are for tools; one shows only as the title it stands for.
    if (/^(id|ids)$|Id$|_id$/.test(key) && !(typeof raw === "string" && byId.has(raw))) continue;
    const shown = value(raw);
    if (shown) out.push([key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ").toLowerCase(), shown]);
    if (out.length >= 6) break;
  }
  return out;
}

function Mark({ icon: Icon, state }: { icon: LucideIcon; state: string }) {
  return (
    <span className="tool-mark" data-state={state} aria-hidden>
      {state === "failed" ? <CircleAlert size={13} /> : <Icon size={13} />}
    </span>
  );
}

/**
 * One call as one line: what it touched, what it did, and a small mark for its state. The line opens
 * to the rest (more lines of the result, the input, the tool). Apply, Undo and Open stay on the line.
 */
export function ToolCall({
  call,
  conversationId,
  refs,
  proposal = false,
  primary = true,
}: {
  call: AssistantToolCallRecord;
  conversationId: string | null;
  refs?: readonly AssistantRef[];
  /** Drawn in the proposals card: its preview fields always show. */
  proposal?: boolean;
  /** Its Apply is the main button (it is the only proposal). */
  primary?: boolean;
}) {
  const toast = useToast();
  const client = useQueryClient();
  const detailsId = useId();
  const [open, setOpen] = useState(false);
  const [local, setLocal] = useState<{ phase: "applied" | "undone"; entryId: string | null } | null>(null);
  const entryId = local?.entryId ?? call.undoEntryId ?? null;
  const phase = local?.phase ?? (call.state === "undone" ? "undone" : call.state === "ok" ? "applied" : "pending");
  useEffect(() => {
    const onUndo = (event: Event) => {
      const detail = (event as CustomEvent<{ entryId?: string; direction?: string }>).detail;
      if (!entryId || detail?.entryId !== entryId) return;
      setLocal({ phase: detail.direction === "redo" ? "applied" : "undone", entryId });
    };
    window.addEventListener("ensemble:undo", onUndo);
    return () => window.removeEventListener("ensemble:undo", onUndo);
  }, [entryId]);
  const apply = useMutation({
    mutationFn: () => api.applyAssistant({ name: call.name, input: call.input ?? {}, conversationId: conversationId ?? undefined, callId: call.id }),
    onSuccess: (result) => {
      const failedHere = result.failed?.some((item) => item.callId === call.id);
      setLocal(failedHere ? null : { phase: "applied", entryId: result.undoEntryId ?? null });
      if (conversationId && result.replies?.length) {
        client.setQueryData(["assistant-messages", conversationId], (current: { messages: AssistantMessageRecord[] } | undefined) =>
          current ? applyRepliesToCache(current, result.replies) ?? current : current,
        );
      }
      const notice = applyNotice(result);
      toast(notice.text, {
        tone: notice.tone,
        action: result.undoEntryId
          ? {
              label: "Undo",
              run: () => {
                void api
                  .undo(result.undoEntryId ?? undefined)
                  .then(() => client.invalidateQueries())
                  .catch((error: Error) => toast(error.message, { tone: "error" }));
              },
            }
          : undefined,
      });
      void client.invalidateQueries();
    },
    onError: (error) => toast((error as Error).message, { tone: "error" }),
  });
  const history = async (direction: "undo" | "redo") => {
    if (!entryId) return;
    try {
      if (direction === "undo") await api.undo(entryId);
      else await api.redo(entryId);
      setLocal({ phase: direction === "undo" ? "undone" : "applied", entryId });
      void client.invalidateQueries();
    } catch (error) {
      toast((error as Error).message, { tone: "error" });
    }
  };

  const failed = call.state === "failed";
  const allRefs = [...(call.refs ?? []), ...(refs ?? [])];
  const text = formatEntityText(call.error ?? call.summary ?? "", allRefs, { plain: true }).trim();
  const [first = "", ...rest] = text.split("\n").filter((line) => line.trim());
  const label = toolLabel(call.name);
  // A failure leads with what was tried; the error says why, under it.
  const title = failed ? label : first || label;
  const fields = inputFields(call.input, allRefs);
  const motion = failed ? "failed" : call.state === "awaiting_approval" ? "pending" : call.state === "ok" || phase === "applied" || phase === "undone" ? "done" : "running";
  const state = failed ? "failed" : phase === "undone" ? "undone" : phase === "applied" ? "done" : proposal || call.state === "awaiting_approval" ? "proposed" : "running";
  const retryable = failed && call.name === "hub_run_workflow" && Array.isArray(call.input?.steps) && !/interrupted|uncertain|may have completed/i.test(call.error ?? "");
  const canApply = phase === "pending" && (!failed || retryable);
  const external = call.href ? /^https?:/i.test(call.href) : false;

  return (
    <li className="assistant-tool tool-row" data-motion-slot="tool.call" data-state={motion} data-tool-state={state} data-proposal={proposal ? "" : undefined}>
      <div className="tool-line">
        <button type="button" className="tool-main" aria-expanded={open} aria-controls={detailsId} onClick={() => setOpen((value) => !value)} title={proposal ? undefined : label}>
          <Mark icon={toolIcon(call.name)} state={state} />
          <span className="tool-title">{title}</span>
          {phase === "applied" && call.isWrite !== false ? <span className="tool-meta"><Check size={11} aria-hidden />Applied</span> : null}
          {phase === "undone" ? <span className="tool-meta">Undone</span> : null}
          {failed ? <span className="tool-meta tool-meta-failed">Failed</span> : null}
          <ChevronRight size={12} className="tool-chevron" aria-hidden />
        </button>
        <span className="tool-actions">
          {call.href ? (
            external ? (
              <a href={call.href} target="_blank" rel="noreferrer" className="tool-action">Open<ArrowUpRight size={11} aria-hidden /></a>
            ) : (
              <Link href={call.href} className="tool-action">Open<ArrowUpRight size={11} aria-hidden /></Link>
            )
          ) : null}
          {canApply ? (
            <button type="button" className={cx(primary || failed ? "btn-primary" : "btn", "tool-apply")} onClick={() => apply.mutate()} disabled={apply.isPending}>
              {failed ? "Retry remaining steps" : "Apply"}
            </button>
          ) : null}
          {phase === "applied" && entryId ? (
            <button type="button" className="tool-action" onClick={() => void history("undo")}>
              <Undo2 size={11} aria-hidden />Undo
            </button>
          ) : null}
          {phase === "undone" && entryId ? (
            <button type="button" className="tool-action" onClick={() => void history("redo")}>
              <Redo2 size={11} aria-hidden />Redo
            </button>
          ) : null}
        </span>
      </div>
      {failed && text ? <p className="tool-error">{text}</p> : null}
      {proposal ? previewLines(rest) : null}
      <div id={detailsId} className="tool-details" hidden={!open}>
        {!failed && !proposal && rest.length ? <p className="tool-details-text">{rest.join("\n")}</p> : null}
        {fields.length ? (
          <dl className="tool-details-fields">
            {fields.map(([key, value]) => (
              <div key={key}><dt>{key}</dt><dd>{value}</dd></div>
            ))}
          </dl>
        ) : null}
        <p className="tool-details-name">{label}<code>{call.name}</code></p>
      </div>
    </li>
  );
}

export function ApplyAll({ calls, conversationId }: { calls: AssistantToolCallRecord[]; conversationId: string | null }) {
  const toast = useToast();
  const client = useQueryClient();
  const apply = useMutation({
    mutationFn: () =>
      api.applyAssistant({
        conversationId: conversationId ?? undefined,
        calls: calls.map((call) => ({ name: call.name, input: call.input ?? {}, callId: call.id })),
      }),
    onSuccess: (result) => {
      if (conversationId && result.replies?.length) {
        client.setQueryData(["assistant-messages", conversationId], (current: { messages: AssistantMessageRecord[] } | undefined) =>
          current ? applyRepliesToCache(current, result.replies) ?? current : current,
        );
      }
      // A partial batch: the rows already show which calls landed and which failed; the toast says it too.
      const notice = applyNotice(result);
      toast(notice.text, { tone: notice.tone });
      void client.invalidateQueries();
    },
    onError: (error) => toast((error as Error).message, { tone: "error" }),
  });
  return (
    <button type="button" className="btn-primary tool-apply" onClick={() => apply.mutate()} disabled={apply.isPending}>
      Apply all
    </button>
  );
}

/** "3 steps" folded into one line; it opens in place. */
function FoldedRun({ calls, conversationId, refs }: { calls: AssistantToolCallRecord[]; conversationId: string | null; refs?: readonly AssistantRef[] }) {
  const [open, setOpen] = useState(false);
  if (open) return <>{calls.map((call) => <ToolCall key={call.id} call={call} conversationId={conversationId} refs={refs} />)}</>;
  const allRefs = (call: AssistantToolCallRecord) => [...(call.refs ?? []), ...(refs ?? [])];
  const glance = calls
    .map((call) => formatEntityText(call.summary ?? "", allRefs(call), { plain: true }).split("\n")[0]?.replace(/\.$/, "") || toolLabel(call.name))
    .join(" · ");
  return (
    <li className="tool-row tool-run" data-tool-state="done">
      <div className="tool-line">
        <button type="button" className="tool-main" aria-expanded={false} onClick={() => setOpen(true)} aria-label={`Show ${plural(calls.length, "step")}`}>
          <Mark icon={Layers} state="done" />
          <span className="tool-title"><span className="tool-run-count">{plural(calls.length, "step")}</span><span className="tool-run-glance">{glance}</span></span>
          <ChevronDown size={12} className="tool-chevron" aria-hidden />
        </button>
      </div>
    </li>
  );
}

/** The running step of a live turn: the status line, with how long it has run once that is worth saying. */
function RunningStep({ status }: { status: string }) {
  const [since, setSince] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setSince(Date.now());
    setNow(Date.now());
  }, [status]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const seconds = Math.floor((now - since) / 1000);
  return (
    <li className="tool-row tool-running" data-tool-state="running">
      <div className="tool-line">
        <span className="tool-main">
          <span className="tool-mark" data-state="running" aria-hidden><span className="tool-spinner" /></span>
          <span className="tool-title" role="status">{status}</span>
          {seconds >= 3 ? <span className="tool-meta tabular-nums" aria-hidden>{seconds}s</span> : null}
        </span>
      </div>
    </li>
  );
}

/**
 * A reply's work: finished steps as a compact timeline (folded behind one line once the reply is
 * saved), and proposals waiting for Apply in their own card. Live turns pass `running` for the step
 * in progress.
 */
export function ToolSteps({
  calls,
  conversationId,
  refs,
  live = false,
  running = null,
}: {
  calls: readonly AssistantToolCallRecord[];
  conversationId: string | null;
  refs?: readonly AssistantRef[];
  live?: boolean;
  running?: string | null;
}) {
  const done = calls.filter((call) => !isProposal(call));
  const failed = done.some((call) => call.state === "failed");
  if (!done.length && !running) return null;
  const list = (
    <ol className="tool-timeline" aria-label="Steps">
      {foldRuns(done).map((row) =>
        row.kind === "run" ? (
          <FoldedRun key={row.calls[0]!.id} calls={row.calls} conversationId={conversationId} refs={refs} />
        ) : (
          <ToolCall key={row.call.id} call={row.call} conversationId={conversationId} refs={refs} />
        ),
      )}
      {running ? <RunningStep status={running} /> : null}
    </ol>
  );
  if (live) return <div className="assistant-activity" data-live="">{list}</div>;
  return (
    <details className="assistant-activity" open={failed || undefined}>
      <summary data-activity-toggle data-failed={failed ? "" : undefined}>
        <span className="tool-summary-mark" aria-hidden>{failed ? <CircleAlert size={13} /> : <Check size={13} />}</span>
        <span className="tool-summary-text">{stepsLine(done)}</span>
        <ChevronDown size={13} className="tool-summary-chevron" aria-hidden />
      </summary>
      {list}
    </details>
  );
}

/** Writes waiting for Apply. Nothing in the card has happened yet, and it says so. */
export function ToolProposals({ calls, conversationId, refs }: { calls: readonly AssistantToolCallRecord[]; conversationId: string | null; refs?: readonly AssistantRef[] }) {
  const pending = calls.filter(isProposal);
  if (!pending.length) return null;
  return (
    <section className="tool-proposals" aria-label="Proposed changes">
      <header className="tool-proposals-head">
        <span className="tool-proposals-title">{pending.length === 1 ? "Proposed change" : `${pending.length} proposed changes`}</span>
        <span className="tool-proposals-note">Nothing changes until you apply</span>
        {pending.length > 1 ? <ApplyAll calls={pending} conversationId={conversationId} /> : null}
      </header>
      <ol className="tool-timeline">
        {pending.map((call) => (
          <ToolCall key={call.id} call={call} conversationId={conversationId} refs={refs} proposal primary={pending.length === 1} />
        ))}
      </ol>
    </section>
  );
}
