/**
 * Ensemble in the terminal: two tabs.
 *
 *   Tasks  agent runs on this computer, and everything that needs you, answered right here
 *          (click a button, press its number, or type /allow, /deny, /answer …).
 *   Chat   your agent. Claude Code, Codex or Cursor's agent on your own sign-in, working in the
 *          folder you opened it in under your run profile (each message continues its session),
 *          or Ensemble Code (Ensemble's agent, a model with your key).
 *
 * One input router handles keys, the mouse and the slash-command menu. The layout is fixed rows
 * (tabs, main, actions, composer, status), so every click maps to a region computed here.
 */
import { terminalBrand } from "@ensemble/brand/cli";
import { WorkingMark } from "./brand.js";
import { Box, Text, useApp, useInput, useStdout, type Key } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { INCLUDED_LABEL, INCLUDED_LOCAL_ONLY, INCLUDED_PROVIDER, pickRunProfile, type RunProfile } from "@ensemble/shared-types";
import { PROVIDERS } from "../local-commands.js";
import type { ChatFrame, CodeSession, Decision, JobDetail, LocalApi, ModelRow, Settings, ToolCall, Workspace } from "./local.js";
import { hit, isMouse, parseMouse, type Region } from "./mouse.js";
import {
  ago,
  AGENT_MODELS,
  buildItems,
  chatTurnRequest,
  commandAnswer,
  decisionActions,
  engineOf,
  FINISHED,
  GROUP_LABEL,
  installedAgent,
  keyLine,
  matchCommands,
  parseCommand,
  profileSummary,
  runRequest,
  sourceLabel,
  STATUS_GLYPH,
  titleFrom,
  withKeys,
  type Action,
  type AgentEngine,
  type Answer,
  type Item,
} from "./model.js";
import { ENGINE_LABEL, type Engine, type Prefs } from "./prefs.js";
import { includedNotice, localOnlyRow, modelLabel, type IncludedNotice } from "./included.js";
import { cellWidth, markdown, pad, plain, truncate, wrapLine, type Line, type Segment } from "./text.js";

const ACCENT = terminalBrand(process.env, Boolean(process.stdout.isTTY)).color;
/** The picker row a local-only computer gets for the included models: picking it says how to connect. */
const LOCAL_ONLY_PICK = "\u0000included";
const MUTED = "gray";

export type Account = { email: string | null; paired: boolean; apiBase: string };

/** Side effects that live outside the app (sign-in, the background service), so the app is testable. */
export type Ops = {
  update?: () => Promise<string>;
  signIn: (onCode: (code: string, url: string, opened: boolean) => void, signal: AbortSignal) => Promise<{ email: string | null; paired: boolean }>;
  signOut: () => Promise<string[]>;
  runnerService: (install: boolean) => Promise<string>;
  savePrefs: (prefs: Prefs) => void;
  connectHook: (tool: string, remove: boolean) => Promise<string>;
  connectedHooks: () => Promise<string[]>;
};

type Entry = { id: string; kind: "user" | "assistant" | "agent" | "tool" | "failed" | "pending" | "note" | "error" | "included"; text: string; notice?: IncludedNotice };

type Overlay =
  | { kind: "picker"; title: string; hint?: string; items: Array<{ id: string; label: string; detail?: string; active?: boolean }>; index: number; onPick: (id: string) => void }
  | { kind: "input"; title: string; hint: string; secret: boolean; value: string; onSubmit: (value: string) => void }
  | { kind: "text"; title: string; lines: Line[] }
  | { kind: "login"; code: string | null; url: string | null; opened: boolean; abort: AbortController };

type Notice = { text: string; tone: "info" | "ok" | "error" };

let entrySeq = 0;
const entry = (kind: Entry["kind"], text: string): Entry => ({ id: `e${(entrySeq += 1)}`, kind, text });
/** An error entry, or a notice when it is an included refusal ("connect this computer", "credits used"). */
const failure = (text: string, code?: string | null): Entry => {
  const notice = includedNotice(code, text);
  return notice ? { ...entry("included", notice.text), notice } : entry("error", text);
};

export function App(props: { api: LocalApi; folder: string; version: string; updateNotice?: string | null; account: Account; prefs: Prefs; ops: Ops }) {
  const { api, folder, ops } = props;
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [size, setSize] = useState({ cols: stdout.columns || 100, rows: stdout.rows || 30 });
  useEffect(() => {
    const onResize = () => setSize({ cols: stdout.columns || 100, rows: stdout.rows || 30 });
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);

  const [prefs, setPrefsState] = useState<Prefs>(props.prefs);
  const setPrefs = useCallback(
    (change: Partial<Prefs>) =>
      setPrefsState((current) => {
        const next = { ...current, ...change };
        ops.savePrefs(next);
        return next;
      }),
    [ops],
  );
  const [account, setAccount] = useState<Account>(props.account);
  const tab = prefs.tab;

  // ── data ──────────────────────────────────────────────────────────────────────────────────
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [offline, setOffline] = useState<string | null>(null);
  const [agentsOff, setAgentsOff] = useState(false);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [sandbox, setSandbox] = useState<string>("");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [detail, setDetail] = useState<JobDetail | null>(null);
  const [now, setNow] = useState(Date.now());

  const refresh = useCallback(async () => {
    try {
      const [nextWorkspace, nextDecisions] = await Promise.all([
        api.workspace().catch((error: Error & { status?: number }) => {
          if (error.status === 404) {
            setAgentsOff(true);
            return null;
          }
          throw error;
        }),
        api.decisions(),
      ]);
      if (nextWorkspace) {
        setAgentsOff(false);
        setWorkspace(nextWorkspace);
      }
      setDecisions(nextDecisions);
      setOffline(null);
    } catch (error) {
      setOffline(error instanceof Error ? error.message : String(error));
    }
    setNow(Date.now());
  }, [api]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 1500);
    return () => clearInterval(timer);
  }, [refresh]);

  const loadSettings = useCallback(async () => {
    setSettings(await api.settings().catch(() => null));
  }, [api]);
  useEffect(() => {
    void loadSettings();
    void api
      .guard()
      .then((guard) => setSandbox(guard.sandbox.osSandbox ? guard.sandbox.mechanism : "none"))
      .catch(() => setSandbox(""));
  }, [api, loadSettings]);

  const items = useMemo(() => buildItems(workspace, decisions), [workspace, decisions]);
  const selected: Item | null = items.find((item) => item.key === selectedKey) ?? items[0] ?? null;
  const selectedJobId = selected?.job?.id ?? null;
  useEffect(() => {
    if (!selectedJobId) {
      setDetail(null);
      return;
    }
    let live = true;
    const load = () =>
      api
        .job(selectedJobId)
        .then((next) => live && setDetail(next))
        .catch(() => undefined);
    void load();
    const timer = setInterval(load, 1500);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [api, selectedJobId]);

  const profile: RunProfile = useMemo(
    () => (settings ? pickRunProfile(settings, prefs.profileId) : pickRunProfile({ runProfiles: [], defaultRunProfileId: null }, null)),
    [settings, prefs.profileId],
  );
  const engine: Engine = prefs.engine ?? profile.engine;
  // Claude Code, Codex or Cursor: Chat is that agent, on the person's own sign-in.
  const agentChat = engine !== "ensemble";
  const tierSetting = settings?.models[settings.assistant.defaultTier ?? "medium"];
  const tierModel = tierSetting ? modelLabel(tierSetting.provider, tierSetting.model) : "";
  const chatModelLabel = agentChat
    ? `${prefs.agentModel ?? "default model"} · your sign-in`
    : prefs.chatModel
      ? modelLabel(prefs.chatModel.split("::")[0], prefs.chatModel.split("::")[1]!)
      : tierModel
        ? `${tierModel} (default)`
        : "chat default model";
  const needs = items.filter((item) => item.group === "needs").length;

  // ── chat ──────────────────────────────────────────────────────────────────────────────────
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [pending, setPending] = useState<ToolCall[]>([]);
  const [chatScroll, setChatScroll] = useState(0);
  const chatAbort = useRef<AbortController | null>(null);
  const conversationRef = useRef<string | null>(null);
  conversationRef.current = conversationId;
  // Chat with your agent: the chat's task, the last message's run (the next one continues it), and the run in progress.
  const chatTask = useRef<{ taskId: string; lastJobId: string | null } | null>(null);
  const [agentTurn, setAgentTurn] = useState<string | null>(null);

  const code: CodeSession = useMemo(
    () => ({ folder, engine, profileId: prefs.profileId, ...(settings?.orchestration.outsideAccess ? { outsideAccess: settings.orchestration.outsideAccess } : {}) }),
    [folder, engine, prefs.profileId, settings],
  );

  const sendAgentChat = useCallback(
    async (message: string) => {
      setEntries((current) => [...current, entry("user", message), entry("agent", "")]);
      setChatScroll(0);
      setStreaming(true);
      try {
        let chat = chatTask.current;
        if (!chat) {
          const created = await api.json<{ task: { id: string } }>("/api/tasks", { body: { title: `Chat: ${titleFrom(message)}`, description: message, owner: "agent", status: "todo" } });
          chat = { taskId: created.task.id, lastJobId: null };
        }
        const started = await api.json<{ jobId: string }>("/api/agent/assign", {
          body: chatTurnRequest({ taskId: chat.taskId, folder, message, profile, engine: engine as AgentEngine, model: prefs.agentModel, previousJobId: chat.lastJobId }),
        });
        chatTask.current = { taskId: chat.taskId, lastJobId: started.jobId };
        setAgentTurn(started.jobId);
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        setEntries((current) => [...current.filter((item, index) => !(item.kind === "agent" && !item.text && index === current.length - 1)), entry("error", /trust/i.test(text) ? `${text} Type /trust to trust this folder.` : text)]);
        setStreaming(false);
      }
    },
    [api, engine, folder, prefs.agentModel, profile],
  );

  // The agent's reply streams in from its run's log; its questions and permission requests come as buttons.
  useEffect(() => {
    if (!agentTurn) return;
    let live = true;
    const poll = async () => {
      const next = await api.job(agentTurn).catch(() => null);
      if (!live || !next) return;
      const done = FINISHED.has(next.job.status);
      setEntries((current) => {
        const at = current.map((item) => item.kind).lastIndexOf("agent");
        if (at < 0) return current;
        const text = next.log || current[at]!.text || (done && next.job.status === "succeeded" ? (next.job.summary ?? "") : "");
        const updated = [...current.slice(0, at), { ...current[at]!, text }, ...current.slice(at + 1)];
        if (!done || next.job.status === "succeeded") return updated;
        if (next.job.status === "cancelled") return [...updated, entry("note", "Stopped.")];
        return [...updated, entry("error", next.job.error || `${ENGINE_LABEL[engine]} stopped.`)];
      });
      if (done) {
        live = false;
        setAgentTurn(null);
        setStreaming(false);
        void refresh();
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 700);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [agentTurn, api, engine, refresh]);

  const sendChat = useCallback(
    async (message: string) => {
      if (streaming) return;
      if (agentChat) return sendAgentChat(message);
      setEntries((current) => [...current, entry("user", message), entry("assistant", "")]);
      setChatScroll(0);
      setStreaming(true);
      const abort = new AbortController();
      chatAbort.current = abort;
      const [provider, model] = prefs.chatModel?.includes("::") ? prefs.chatModel.split("::", 2) : [undefined, prefs.chatModel ?? undefined];
      const appendAssistant = (text: string) =>
        setEntries((current) => {
          const last = current[current.length - 1];
          if (last?.kind === "assistant") return [...current.slice(0, -1), { ...last, text: last.text + text }];
          return [...current, entry("assistant", text)];
        });
      // The turn's error frame is shown once; a "done" that only repeats it adds nothing.
      let failed: string | null = null;
      const onFrame = (frame: ChatFrame) => {
        if (frame.type === "status" && frame.conversationId) setConversationId(frame.conversationId);
        else if (frame.type === "delta") appendAssistant(frame.text);
        else if (frame.type === "tool") {
          const call = frame.call;
          setEntries((current) => [...current, entry(call.state === "failed" ? "failed" : "tool", call.state === "failed" ? call.error ?? `${call.name} failed` : call.summary || call.name), entry("assistant", "")]);
        } else if (frame.type === "pending") {
          setPending((current) => [...current, frame.call]);
          setEntries((current) => [...current, entry("pending", frame.preview || frame.call.summary || frame.call.name), entry("assistant", "")]);
        } else if (frame.type === "error") {
          failed = frame.message ?? frame.error ?? "Something went wrong.";
          const text = failed;
          const code = frame.code;
          setEntries((current) => [...current, failure(text, code)]);
        } else if (frame.type === "done") {
          setConversationId(frame.conversationId);
          if (failed && frame.content?.trim() === failed.trim()) {
            setEntries((current) => current.filter((item, index) => !(item.kind === "assistant" && !item.text.trim() && index === current.length - 1)));
            return;
          }
          // The final text replaces what streamed (it may add "press Apply" and the like).
          setEntries((current) => {
            const trimmed = current.filter((item, index) => !(item.kind === "assistant" && !item.text.trim() && index < current.length - 1));
            const last = trimmed[trimmed.length - 1];
            if (last?.kind === "assistant") return [...trimmed.slice(0, -1), { ...last, text: frame.content || last.text }];
            return frame.content ? [...trimmed, entry("assistant", frame.content)] : trimmed;
          });
        }
      };
      try {
        await api.chat(
          { ...(conversationRef.current ? { conversationId: conversationRef.current } : {}), message, ...(model ? { model, ...(provider ? { provider } : {}) } : {}), code },
          onFrame,
          abort.signal,
        );
      } catch (error) {
        if (!abort.signal.aborted) setEntries((current) => [...current, failure(chatError(error), (error as { code?: string }).code)]);
      } finally {
        setEntries((current) => current.filter((item, index) => !(item.kind === "assistant" && !item.text.trim() && index === current.length - 1)));
        setStreaming(false);
        chatAbort.current = null;
      }
    },
    [agentChat, api, code, prefs.chatModel, sendAgentChat, streaming],
  );

  const stopChat = useCallback(() => {
    if (agentTurn) {
      // The run's end ("Stopped.") comes back through the poll.
      void api.stopJob(agentTurn).catch(() => undefined);
      return;
    }
    chatAbort.current?.abort();
    if (conversationRef.current) void api.stopChat(conversationRef.current).catch(() => undefined);
    setEntries((current) => [...current, entry("note", "Stopped.")]);
  }, [agentTurn, api]);

  const applyPending = useCallback(
    async (apply: boolean) => {
      const calls = pending;
      setPending([]);
      if (!apply) {
        setEntries((current) => [...current, entry("note", "Discarded. Nothing changed.")]);
        return;
      }
      try {
        const result = await api.apply({ ...(conversationRef.current ? { conversationId: conversationRef.current } : {}), calls: calls.map((call) => ({ name: call.name, input: call.input, callId: call.id })), code });
        setEntries((current) => [...current, entry("tool", result.summary || "Done.")]);
        void refresh();
      } catch (error) {
        setEntries((current) => [...current, entry("error", error instanceof Error ? error.message : String(error))]);
      }
    },
    [api, code, pending, refresh],
  );

  // ── composer, notices, overlays ───────────────────────────────────────────────────────────
  // The prompt lives in a ref: keys (and a paste) can arrive faster than React re-renders, and each
  // must see the text the one before it left.
  const composer = useRef({ value: "", cursor: 0 });
  const [, redraw] = useState(0);
  const value = composer.current.value;
  const cursor = composer.current.cursor;
  const [history, setHistory] = useState<string[]>([]);
  const [historyAt, setHistoryAt] = useState(-1);
  const [menuIndex, setMenuIndex] = useState(0);
  const [actionIndex, setActionIndex] = useState(0);
  const [notice, setNoticeState] = useState<Notice | null>(props.updateNotice ? {text:props.updateNotice,tone:"info"} : null);
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const [detailScroll, setDetailScroll] = useState(0);
  const [exitArmed, setExitArmed] = useState(false);
  const noticeTimer = useRef<NodeJS.Timeout | null>(null);
  const say = useCallback((text: string, tone: Notice["tone"] = "info") => {
    setNoticeState({ text, tone });
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNoticeState(null), tone === "error" ? 9000 : 5000);
  }, []);

  // No model key on this computer, but an agent with its own sign-in: work with that agent.
  const pickedAgent = useRef(false);
  useEffect(() => {
    if (pickedAgent.current || !settings || prefs.engine !== null || profile.engine !== "ensemble") return;
    pickedAgent.current = true;
    void Promise.all([api.modelKeys().catch(() => null), api.agentApps().catch(() => null)]).then(([keys, apps]) => {
      if (!keys || withKeys(keys.credentials).length || !apps) return;
      const agent = installedAgent(apps.agents);
      if (!agent) return;
      setPrefs({ engine: agent });
      say(`No model key here, so you're working with ${ENGINE_LABEL[agent]} on your own sign-in. /agent to change.`, "ok");
    });
  }, [api, prefs.engine, profile.engine, say, setPrefs, settings]);

  const setText = (next: string, at = next.length) => {
    composer.current = { value: next, cursor: Math.max(0, Math.min(next.length, at)) };
    redraw((count) => count + 1);
    setMenuIndex(0);
  };
  const setCursor = (at: number) => {
    composer.current = { ...composer.current, cursor: Math.max(0, Math.min(composer.current.value.length, at)) };
    redraw((count) => count + 1);
  };

  const menuOpen = value.startsWith("/") && !value.includes(" ") && !overlay;
  const menu = menuOpen ? matchCommands(value, tab).slice(0, 8) : [];

  // ── answering ─────────────────────────────────────────────────────────────────────────────
  const selectedDecision = selected?.decision ?? null;
  // What your agent is asking in Chat right now.
  const chatDecision = agentTurn ? (decisions.find((row) => row.status === "pending" && row.detail?.jobId === agentTurn) ?? null) : null;
  const actions: Action[] = tab === "tasks" && selectedDecision ? decisionActions(selectedDecision) : [];
  const chatActions: Array<{ id: string; label: string; tone: Action["tone"]; run: () => void }> =
    tab === "chat"
      ? chatDecision
        ? decisionActions(chatDecision).map((action) => ({ id: action.id, label: action.recommended ? `★ ${action.label}` : action.label, tone: action.tone, run: () => void answer(action.answer, chatDecision) }))
        : pending.length
        ? [
            { id: "apply", label: pending.length > 1 ? `Apply ${pending.length} changes` : "Apply", tone: "primary", run: () => void applyPending(true) },
            { id: "discard", label: "Discard", tone: "danger", run: () => void applyPending(false) },
          ]
        : streaming
          ? [{ id: "stop", label: "Stop (Esc)", tone: "danger", run: stopChat }]
          : []
      : [];
  const bar = tab === "tasks" ? actions.map((action) => ({ id: action.id, label: action.recommended ? `★ ${action.label}` : action.label, tone: action.tone, run: () => void answer(action.answer) })) : chatActions;

  const answer = async (reply: Answer, decision: Decision | null = selectedDecision) => {
    if (!decision) return say("Nothing is waiting on you here.");
    try {
      await api.decide(decision.id, { decision: reply.decision, ...(reply.scope ? { scope: reply.scope } : {}), ...(reply.reason ? { reason: reply.reason } : {}), confirmed: true });
      say(reply.decision === "allow" ? (reply.reason && decision.detail.options?.length ? `Answered: ${reply.reason}` : "Allowed.") : "Denied. The agent was told.", "ok");
      setActionIndex(0);
      void refresh();
    } catch (error) {
      say(error instanceof Error ? error.message : String(error), "error");
    }
  };

  // ── commands ──────────────────────────────────────────────────────────────────────────────
  const startRun = async (text: string) => {
    if (!text.trim()) return say("Say what to do: /run fix the failing tests", "error");
    try {
      const created = await api.json<{ task: { id: string } }>("/api/tasks", { body: { title: titleFrom(text), description: text, owner: "agent", status: "todo" } });
      const started = await api.json<{ jobId: string }>("/api/agent/assign", { body: runRequest({ taskId: created.task.id, folder, instructions: text, profile, engine: prefs.engine }) });
      say(`Started ${ENGINE_LABEL[engine]} on “${titleFrom(text)}”.`, "ok");
      setPrefs({ tab: "tasks" });
      setSelectedKey(`job:${started.jobId}`);
      void refresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      say(/trust/i.test(message) ? `${message} Type /trust to trust this folder.` : message, "error");
    }
  };

  const pickProfile = () => {
    const profiles = settings ? [...settings.runProfiles] : [];
    const quick = pickRunProfile({ runProfiles: [], defaultRunProfileId: null, orchestration: settings?.orchestration }, null);
    const all = profiles.length ? profiles : [quick];
    setOverlay({
      kind: "picker",
      title: "Run profile",
      hint: "Saved on the Assign dialog (up to three). Used by /run and by the agents Ensemble Code starts.",
      items: all.map((item) => ({ id: item.id, label: item.name + (item.id === settings?.defaultRunProfileId ? "  (default)" : ""), detail: `${ENGINE_LABEL[item.engine]} · ${profileSummary(item)}`, active: item.id === profile.id })),
      index: Math.max(0, all.findIndex((item) => item.id === profile.id)),
      onPick: (id) => {
        setPrefs({ profileId: id });
        say(`Run profile: ${all.find((item) => item.id === id)?.name ?? id}.`, "ok");
      },
    });
  };

  const pickEngine = async () => {
    const found = await api.agentApps().catch(() => ({ agents: [] as Array<{ id: string; app: boolean; cli: string | null }> }));
    const has = (id: string) => found.agents.find((agent) => agent.id === id);
    const engines: Array<{ id: Engine; note: string }> = [
      { id: "ensemble", note: "Ensemble Code: a model with your key (/keys)" },
      { id: "claude-code", note: has("claude")?.cli ? "your Claude Code sign-in" : "not found · curl -fsSL https://claude.ai/install.sh | bash" },
      { id: "codex", note: has("codex")?.cli || has("codex")?.app ? `your Codex sign-in${has("codex")?.cli ? "" : " (the ChatGPT app's)"}` : "not found · the ChatGPT app, or npm i -g @openai/codex" },
      { id: "cursor-agent", note: has("cursor")?.cli ? "your Cursor sign-in" : "not found · curl https://cursor.com/install -fsS | bash" },
    ];
    setOverlay({
      kind: "picker",
      title: "Who you work with",
      hint: "Chat and /run go to this agent. Claude Code, Codex and Cursor work in this folder on your own sign-in, under your run profile and Ensemble's sandbox; what they ask you shows up as buttons.",
      items: [
        { id: "", label: `Follow the run profile (${ENGINE_LABEL[profile.engine]})`, active: prefs.engine === null },
        ...engines.map((item) => ({ id: item.id, label: ENGINE_LABEL[item.id], detail: item.note, active: prefs.engine === item.id })),
        ...(has("copilot")?.cli ? [{ id: "copilot", label: "GitHub Copilot CLI", detail: "found · not yet: it has no per-run permission hook, so Ensemble can't hold it to your rules" }] : []),
      ],
      index: prefs.engine ? engines.findIndex((item) => item.id === prefs.engine) + 1 : 0,
      onPick: (id) => {
        if (id === "copilot") return say("Copilot CLI can't run under Ensemble's rules yet. Open a task in it from Tasks on the web, or pick Claude Code, Codex or Cursor.", "error");
        const next = (id || null) as Engine | null;
        const chosen = next ?? profile.engine;
        const missing = chosen !== "ensemble" && engines.find((item) => item.id === chosen)?.note.startsWith("not found");
        setPrefs({ engine: next, ...(next !== engine ? { agentModel: null } : {}) });
        chatTask.current = null;
        say(missing ? `${ENGINE_LABEL[chosen]} isn't on this computer yet: ${engines.find((item) => item.id === chosen)!.note.replace("not found · ", "")}` : `You're working with ${ENGINE_LABEL[chosen]}.`, missing ? "error" : "ok");
      },
    });
  };

  const pickModel = async () => {
    if (agentChat) {
      const listed = AGENT_MODELS[engine as AgentEngine];
      const typeOne = () =>
        setOverlay({
          kind: "input",
          title: `${ENGINE_LABEL[engine]}'s model`,
          hint: `A model name ${ENGINE_LABEL[engine]} knows (empty for its default). Enter saves, Esc cancels.`,
          secret: false,
          value: prefs.agentModel ?? "",
          onSubmit: (name) => {
            setPrefs({ agentModel: name.trim() || null });
            say(`${ENGINE_LABEL[engine]} uses ${name.trim() || "its default model"}.`, "ok");
          },
        });
      if (!listed) return typeOne();
      setOverlay({
        kind: "picker",
        title: `${ENGINE_LABEL[engine]}'s model`,
        hint: "Chat and /run use it, on your own sign-in.",
        items: [...listed.map((name) => ({ id: name, label: name === "default" ? "Default" : name, active: (prefs.agentModel ?? "default") === name })), { id: "\u0000type", label: "Another model…", detail: "type its name" }],
        index: Math.max(0, listed.indexOf(prefs.agentModel ?? "default")),
        onPick: (id) => {
          if (id === "\u0000type") return typeOne();
          setPrefs({ agentModel: id === "default" ? null : id });
          say(`${ENGINE_LABEL[engine]} uses ${id === "default" ? "its default model" : id}.`, "ok");
        },
      });
      return;
    }
    const catalog = await api.models().catch(() => null);
    const rows: ModelRow[] = (catalog?.providers ?? []).filter((row) => row.available && row.chat && row.models.length);
    const localOnly = localOnlyRow(catalog?.providers ?? []);
    if (!rows.length) {
      say(
        account.email
          ? "No model keys yet. Add one on the web (Settings → Models, your account's keys work here too) or here with /keys; or chat with Claude Code, Codex or Cursor: /agent."
          : "No model keys yet. Add one with /keys, or /login to use the keys and included models on your Ensemble account; or chat with Claude Code, Codex or Cursor: /agent.",
        "error",
      );
      return;
    }
    const choices = [
      ...rows.flatMap((row) =>
        row.models.slice(0, 25).map((model) => ({
          id: `${row.provider}::${model}`,
          label: modelLabel(row.provider, model),
          detail: row.provider === INCLUDED_PROVIDER ? `${INCLUDED_LABEL} · your credits` : `${row.provider}${row.cheapest === model ? " · cheapest" : ""}`,
        })),
      ),
      ...(localOnly ? [{ id: LOCAL_ONLY_PICK, label: INCLUDED_LABEL, detail: "connect this computer first: /login" }] : []),
    ];
    setOverlay({
      kind: "picker",
      title: "Ensemble Code's model",
      hint: "The model that chats and plans. Coding runs use the run profile's model.",
      // The chat's own default is the assistant's default tier, not the medium task tier.
      items: [{ id: "", label: "Chat default", detail: settings ? `${settings.models[settings.assistant.defaultTier ?? "medium"]?.provider ?? ""} ${settings.models[settings.assistant.defaultTier ?? "medium"]?.model ?? ""}` : "", active: !prefs.chatModel }, ...choices.map((choice) => ({ ...choice, active: prefs.chatModel === choice.id }))],
      index: Math.max(0, choices.findIndex((choice) => choice.id === prefs.chatModel) + 1),
      onPick: (id) => {
        if (id === LOCAL_ONLY_PICK) {
          setEntries((current) => [...current, failure("", INCLUDED_LOCAL_ONLY)]);
          return;
        }
        setPrefs({ chatModel: id || null });
        const [provider, model] = id.split("::");
        say(`Ensemble Code chats with ${id ? (provider === INCLUDED_PROVIDER ? `${modelLabel(provider, model!)} (${INCLUDED_LABEL})` : `${model} (${provider})`) : "the chat default model"}.`, "ok");
      },
    });
  };

  const addKey = (provider?: string) => {
    const ask = (name: string) =>
      setOverlay({
        kind: "input",
        title: `${name} key`,
        hint: "Saved encrypted on this computer only, never sent to ensemblework.com, and used here before your account's key. Enter saves, Esc cancels.",
        secret: true,
        value: "",
        onSubmit: (key) => {
          void api
            .setModelKey(name, key.trim())
            .then((result) => say(`Saved the ${name} key (${result.models} models).`, "ok"))
            .catch((error: Error) => say(error.message, "error"));
        },
      });
    if (provider && (PROVIDERS as readonly string[]).includes(provider)) return ask(provider);
    setOverlay({ kind: "picker", title: "Add a model key", items: PROVIDERS.filter((name) => name !== "cursor").map((name) => ({ id: name, label: name })), index: 0, onPick: ask });
  };

  const showStatus = async () => {
    const keys = await api.modelKeys().catch(() => ({ credentials: [] }));
    const lines: Line[] = [
      [{ text: "Account     ", dim: true }, { text: account.email ? `${account.email}${account.paired ? " · this computer is paired" : ""}` : "not signed in (/login)" }],
      [{ text: "Ensemble    ", dim: true }, { text: `running on this computer · port ${api.discovery.port}` }],
      [{ text: "Sandbox     ", dim: true }, { text: sandbox || "unknown" }],
      [{ text: "Folder      ", dim: true }, { text: folder }],
      [{ text: "Profile     ", dim: true }, { text: `${profile.name}: ${profileSummary(profile)}` }],
      [{ text: "Agent       ", dim: true }, { text: agentChat ? `${ENGINE_LABEL[engine]} (your sign-in) · ${prefs.agentModel ?? "its default model"}` : `Ensemble agent · ${prefs.chatModel ? prefs.chatModel.replace("::", " · ") : "chat default model"}` }],
      [{ text: "Model keys  ", dim: true }, { text: keyLine(keys.credentials) }],
      [{ text: "Version     ", dim: true }, { text: props.version }],
    ];
    setOverlay({ kind: "text", title: "Status", lines });
  };

  const showHelp = () => {
    const width = Math.min(size.cols - 6, 96);
    const lines: Line[] = [
      [{ text: "Keys", bold: true }],
      [{ text: "  Tab            ", color: ACCENT }, { text: "switch between Tasks and Chat" }],
      [{ text: "  ↑ ↓            ", color: ACCENT }, { text: "pick a run (Tasks) · scroll (Chat)" }],
      [{ text: "  1–9 · ← → ⏎    ", color: ACCENT }, { text: "press an answer button (when the prompt is empty)" }],
      [{ text: "  /              ", color: ACCENT }, { text: "commands; ↑ ↓ to choose, Tab or ⏎ to use" }],
      [{ text: "  Esc            ", color: ACCENT }, { text: "close · stop a reply" }],
      [{ text: "  Ctrl+B         ", color: ACCENT }, { text: "sidebar" }],
      [{ text: "  Ctrl+C twice   ", color: ACCENT }, { text: "leave (Ensemble keeps running tasks)" }],
      [{ text: "  Mouse          ", color: ACCENT }, { text: "click tabs, runs and buttons; scroll with the wheel" }],
      [],
      [{ text: "Commands", bold: true }],
      ...matchCommands("", tab).flatMap((command) => wrapLine([{ text: `  /${command.name}${command.args ? ` ${command.args}` : ""}`.padEnd(30), color: ACCENT }, { text: command.description }], width, " ".repeat(30))),
    ];
    setOverlay({ kind: "text", title: "Help", lines });
  };

  const login = () => {
    const abort = new AbortController();
    setOverlay({ kind: "login", code: null, url: null, opened: false, abort });
    ops
      .signIn((codeText, url, opened) => setOverlay((current) => (current?.kind === "login" ? { ...current, code: codeText, url, opened } : current)), abort.signal)
      .then((result) => {
        setOverlay(null);
        setAccount((current) => ({ ...current, email: result.email, paired: result.paired }));
        say(`Signed in${result.email ? ` as ${result.email}` : ""}.${result.paired ? " Tasks you assign to this computer on ensemblework.com run here." : ""}`, "ok");
      })
      .catch((error: Error) => {
        setOverlay(null);
        if (!abort.signal.aborted) say(error.message, "error");
      });
  };

  const hooks = async () => {
    const connected = await ops.connectedHooks().catch(() => [] as string[]);
    const tools = [
      { id: "claude", label: "Claude Code and the Claude app" },
      { id: "codex", label: "Codex (CLI and ChatGPT app)" },
      { id: "copilot-cli", label: "GitHub Copilot CLI" },
      { id: "cursor", label: "Cursor" },
    ];
    setOverlay({
      kind: "picker",
      title: "Prompts from your other AI tools",
      hint: "Connected tools send permission prompts and questions from tasks Ensemble opens in them to Tasks here. Pick one to connect or disconnect.",
      items: tools.map((tool) => ({ ...tool, detail: connected.includes(tool.id) ? "connected · pick to disconnect" : "not connected · pick to connect", active: connected.includes(tool.id) })),
      index: 0,
      onPick: (id) => {
        void ops
          .connectHook(id, connected.includes(id))
          .then((message) => say(message.split("\n")[0] ?? "Done.", "ok"))
          .catch((error: Error) => say(error.message, "error"));
      },
    });
  };

  const runCommand = async (text: string) => {
    const parsed = parseCommand(text);
    if (!parsed) return;
    const { name, args } = parsed;
    switch (name) {
      case "tasks":
      case "chat":
        return setPrefs({ tab: name });
      case "new":
        if (streaming) return say("Stop the reply first (Esc), then start a new chat.");
        setConversationId(null);
        chatTask.current = null;
        setEntries([]);
        setPending([]);
        return setPrefs({ tab: "chat" });
      case "run":
        return startRun(args);
      case "allow":
      case "deny":
      case "answer": {
        const target = tab === "chat" && chatDecision ? chatDecision : selectedDecision;
        if (!target) return say("Nothing is waiting on you here. Pick a run under “Needs you”.");
        const reply = commandAnswer(target, name, args);
        return typeof reply === "string" ? say(reply, "error") : answer(reply, target);
      }
      case "stop":
        if (streaming) return stopChat();
        if (selected?.job && ["queued", "running", "waiting_approval", "claimed"].includes(selected.job.status)) {
          await api.stopJob(selected.job.id).then(() => say("Stopping.", "ok")).catch((error: Error) => say(error.message, "error"));
          return refresh();
        }
        return say("Nothing to stop.");
      case "retry":
        if (!selected?.job) return say("Pick a run to run again.");
        await api.retryJob(selected.job.id).then((result) => (setSelectedKey(`job:${result.jobId}`), say("Running it again.", "ok"))).catch((error: Error) => say(error.message, "error"));
        return refresh();
      case "profile":
        if (args && settings) {
          const found = settings.runProfiles.find((item) => item.name.toLowerCase() === args.toLowerCase() || item.id === args);
          if (!found) return say(`No profile called “${args}”.`, "error");
          setPrefs({ profileId: found.id });
          return say(`Run profile: ${found.name}.`, "ok");
        }
        return pickProfile();
      case "agent": {
        const wanted = args.toLowerCase();
        const match = (Object.keys(ENGINE_LABEL) as Engine[]).find((id) => id === wanted || ENGINE_LABEL[id].toLowerCase().startsWith(wanted));
        if (wanted && match) {
          setPrefs({ engine: match, ...(match !== engine ? { agentModel: null } : {}) });
          chatTask.current = null;
          return say(`You're working with ${ENGINE_LABEL[match]}.`, "ok");
        }
        return pickEngine();
      }
      case "model":
        return pickModel();
      case "folder":
        return say(`Ensemble Code reads and works in ${folder}. Open \`ensemble\` in another folder to change it.`);
      case "trust":
        await api.trust(folder).then((row) => say(`Trusted ${row.path}. Review only and Run unattended can use it.`, "ok")).catch((error: Error) => say(error.message, "error"));
        return;
      case "keys":
        return addKey(args || undefined);
      case "sandbox":
        return say(sandbox && sandbox !== "none" ? `This computer's sandbox: ${sandbox}. Commands an agent runs stay inside it.` : "No sandbox here yet. On Windows run `ensemble sandbox setup` once (it asks for permission).", sandbox && sandbox !== "none" ? "info" : "error");
      case "hooks":
        return hooks();
      case "login":
        return login();
      case "logout": {
        const warnings = await ops.signOut().catch((error: Error) => [error.message]);
        setAccount((current) => ({ ...current, email: null, paired: false }));
        return say(warnings.length ? warnings.join(" ") : "Signed out. This computer is no longer paired.", warnings.length ? "error" : "ok");
      }
      case "runner": {
        const install = args !== "uninstall";
        return ops
          .runnerService(install)
          .then((message) => say(message, "ok"))
          .catch((error: Error) => say(error.message, "error"));
      }
      case "update":
        say("Checking for an update…");
        return ops.update?.().then(message => say(message, "ok")).catch((error: Error) => say(error.message, "error"));
      case "status":
        return showStatus();
      case "sidebar":
        return setPrefs({ sidebar: !prefs.sidebar });
      case "help":
        return showHelp();
      case "exit":
        return exit();
      default:
        return say(`Unknown command /${name}. Type / to see them.`, "error");
    }
  };

  const submit = () => {
    const text = composer.current.value.trim();
    if (!text) {
      if (bar.length) bar[Math.min(actionIndex, bar.length - 1)]!.run();
      return;
    }
    setHistory((current) => [text, ...current.filter((item) => item !== text)].slice(0, 50));
    setHistoryAt(-1);
    setText("");
    if (text.startsWith("/")) return void runCommand(text);
    if (tab === "tasks" && selectedDecision) {
      const reply = commandAnswer(selectedDecision, "answer", text);
      return typeof reply === "string" ? say(reply, "error") : void answer(reply);
    }
    if (tab === "chat" && chatDecision) {
      const reply = commandAnswer(chatDecision, "answer", text);
      return typeof reply === "string" ? say(reply, "error") : void answer(reply, chatDecision);
    }
    setPrefs({ tab: "chat" });
    void sendChat(text);
  };

  // ── layout ────────────────────────────────────────────────────────────────────────────────
  const cols = Math.max(40, size.cols);
  const rows = Math.max(12, size.rows) - 1;
  const extraRows = menu.length ? menu.length : bar.length || notice ? 1 : 0;
  const mainTop = 2;
  const mainHeight = Math.max(3, rows - mainTop - extraRows - 3 - 1);
  // A narrow terminal gives the whole width to the pane; Ctrl+B still brings the sidebar back on a wide one.
  const sidebarWidth = prefs.sidebar && cols >= 90 ? Math.min(42, Math.max(28, Math.floor(cols * 0.32))) : 0;
  const paneLeft = sidebarWidth ? sidebarWidth + 1 : 0;
  const paneWidth = cols - paneLeft - 1;
  const regions: Region[] = [];

  // Tabs.
  const tabLine: Line = [{ text: " [e] ", color: ACCENT, bold: true }, { text: "Ensemble ", bold: true }, { text: " " }];
  let x = cellWidth(tabLine.map((segment) => segment.text).join(""));
  for (const [id, label] of [
    ["tasks", needs ? ` Tasks · ${needs} need${needs === 1 ? "s" : ""} you ` : " Tasks "],
    ["chat", streaming ? " Chat · writing… " : " Chat "],
  ] as const) {
    const active = tab === id;
    tabLine.push({ text: label, ...(active ? { backgroundColor: ACCENT, color: "black", bold: true } : { color: id === "tasks" && needs ? "yellow" : undefined }) });
    const start = x;
    x += cellWidth(label);
    regions.push({ x1: start, x2: x - 1, y1: 0, y2: 0, onClick: () => setPrefs({ tab: id }) });
    tabLine.push({ text: " " });
    x += 1;
  }
  const right = ` ${shortPath(folder, 34)} `;
  tabLine.push({ text: " ".repeat(Math.max(1, cols - x - cellWidth(right))) }, { text: right, dim: true });

  // Main area lines.
  const mainLines: Line[] = [];
  const left: Line[] = [];
  const paneLines: Line[] = [];
  if (overlay) {
    mainLines.push(...overlayLines(overlay, cols, mainHeight, regions, mainTop, (index) => setOverlay((current) => (current?.kind === "picker" ? { ...current, index } : current)), (id) => {
      const current = overlay;
      setOverlay(null);
      if (current.kind === "picker") current.onPick(id);
    }));
  } else if (tab === "tasks") {
    // Sidebar: grouped runs.
    if (sidebarWidth) {
      let group: string | null = null;
      for (const item of items) {
        if (item.group !== group) {
          group = item.group;
          const count = items.filter((other) => other.group === item.group).length;
          left.push([{ text: ` ${GROUP_LABEL[item.group].toUpperCase()} `, bold: true, color: item.group === "needs" ? "yellow" : MUTED }, { text: `${count}`, dim: true }]);
        }
        const job = item.job;
        const glyph = item.group === "needs" || !job ? { glyph: "◆", color: "yellow" } : (STATUS_GLYPH[job.status] ?? { glyph: "•", color: MUTED });
        const label = job ? job.title : item.decision!.title;
        const tail = job ? (job.status === "running" ? ago(job.startedAt, now) : job.finishedAt ? ago(job.finishedAt, now) : engineOf(job)) : sourceLabel(item.decision!.source);
        const active = item.key === selected?.key;
        const room = sidebarWidth - 6 - cellWidth(tail);
        left.push([
          { text: active ? "▸" : " ", color: ACCENT },
          { text: ` ${glyph.glyph} `, color: glyph.color },
          { text: pad(label, room), bold: active, ...(active ? { color: "white" } : {}) },
          { text: ` ${tail}`, dim: true },
        ]);
        const row = mainTop + left.length - 1;
        regions.push({ x1: 0, x2: sidebarWidth - 1, y1: row, y2: row, onClick: () => (setSelectedKey(item.key), setDetailScroll(0), setActionIndex(0)) });
      }
      if (!items.length) left.push([{ text: " Nothing yet.", dim: true }], [], ...wrapLine([{ text: " Type /run and what to do, or ask in Chat. Tasks you assign to this computer on ensemblework.com show up here.", dim: true }], sidebarWidth - 1, " "));
    }
    paneLines.push(...taskPane({ item: selected, detail, width: paneWidth, now, agentsOff, offline }));
  } else {
    if (sidebarWidth) {
      left.push([{ text: agentChat ? ` ${ENGINE_LABEL[engine].toUpperCase()}` : " ENSEMBLE CODE", bold: true, color: MUTED }]);
      left.push([{ text: " + New chat", color: ACCENT }]);
      regions.push({ x1: 0, x2: sidebarWidth - 1, y1: mainTop + 1, y2: mainTop + 1, onClick: () => void runCommand("/new") });
      left.push([]);
      left.push([{ text: " Agent   ", dim: true }, { text: truncate(agentChat ? `${ENGINE_LABEL[engine]} · your sign-in` : ENGINE_LABEL[engine], sidebarWidth - 10) }]);
      left.push([{ text: " Profile ", dim: true }, { text: truncate(profile.name, sidebarWidth - 10) }]);
      left.push(...wrapLine([{ text: ` ${profileSummary(profile)}`, dim: true }], sidebarWidth - 1, " "));
      left.push([{ text: " Model   ", dim: true }, { text: truncate(agentChat ? (prefs.agentModel ?? "default") : chatModelLabel, sidebarWidth - 10) }]);
      left.push([]);
      for (const [label, command] of [
        [" /run   start an agent", "/run "],
        [" /agent who you work with", "/agent"],
        [" /profile how it runs", "/profile"],
        [" /model  its model", "/model"],
      ] as const) {
        left.push([{ text: label, dim: true }]);
        const row = mainTop + left.length - 1;
        regions.push({ x1: 0, x2: sidebarWidth - 1, y1: row, y2: row, onClick: () => (command.endsWith(" ") ? setText(command) : void runCommand(command)) });
      }
    }
    paneLines.push(...chatPane(entries, paneWidth, streaming, { agent: agentChat ? ENGINE_LABEL[engine] : null, folder: shortPath(folder, 60), profile: `${profile.name}: ${profileSummary(profile)}`, decision: chatDecision }));
  }

  if (!overlay) {
    const leftView = left.slice(0, mainHeight);
    let view: Line[];
    const scroll = tab === "chat" ? chatScroll : detailScroll;
    if (tab === "chat") {
      const end = Math.max(0, paneLines.length - scroll);
      view = paneLines.slice(Math.max(0, end - mainHeight), end);
    } else view = paneLines.slice(scroll, scroll + mainHeight);
    for (let row = 0; row < mainHeight; row += 1) {
      const leftLine = leftView[row] ?? [];
      const rightLine = view[row] ?? [];
      mainLines.push(sidebarWidth ? [...fit(leftLine, sidebarWidth), { text: "│", dim: true }, { text: " " }, ...rightLine] : [{ text: " " }, ...rightLine]);
    }
    regions.push({
      x1: paneLeft,
      x2: cols - 1,
      y1: mainTop,
      y2: mainTop + mainHeight - 1,
      onClick: () => undefined,
      onWheel: (delta) =>
        tab === "chat"
          ? setChatScroll((current) => Math.max(0, Math.min(paneLines.length - mainHeight, current - delta * 3)))
          : setDetailScroll((current) => Math.max(0, Math.min(Math.max(0, paneLines.length - mainHeight), current + delta * 3))),
    });
  }

  // Slash menu, or answer buttons, or a notice.
  const extraTop = mainTop + mainHeight;
  const extraLines: Line[] = [];
  if (menu.length) {
    menu.forEach((command, index) => {
      const active = index === Math.min(menuIndex, menu.length - 1);
      const name = `/${command.name}${command.args ? ` ${command.args}` : ""}`;
      extraLines.push([{ text: active ? " ❯ " : "   ", color: ACCENT }, { text: pad(name, 30), color: active ? ACCENT : undefined, bold: active }, { text: truncate(command.description, cols - 34), dim: !active }]);
      regions.push({ x1: 0, x2: cols - 1, y1: extraTop + index, y2: extraTop + index, onClick: () => void pickMenu(index) });
    });
  } else if (bar.length) {
    const line: Line = [{ text: " " }];
    let at = 1;
    bar.forEach((button, index) => {
      const active = index === Math.min(actionIndex, bar.length - 1);
      const label = ` ${index + 1} ${button.label} `;
      const color = button.tone === "danger" ? "red" : button.tone === "primary" ? "green" : "white";
      line.push(active ? { text: label, backgroundColor: color === "white" ? ACCENT : color, color: "black", bold: true } : { text: label, color });
      regions.push({ x1: at, x2: at + cellWidth(label) - 1, y1: extraTop, y2: extraTop, onClick: () => (setActionIndex(index), button.run()) });
      at += cellWidth(label) + 1;
      line.push({ text: " " });
    });
    if (tab === "tasks" && selectedDecision?.detail.allowCustom !== false && selectedDecision?.event === "question") line.push({ text: " or type your own answer", dim: true });
    extraLines.push(line);
  } else if (notice) {
    extraLines.push([{ text: ` ${notice.tone === "error" ? "✗" : notice.tone === "ok" ? "✓" : "•"} `, color: notice.tone === "error" ? "red" : notice.tone === "ok" ? "green" : ACCENT }, { text: truncate(notice.text, cols - 4), color: notice.tone === "error" ? "red" : undefined }]);
  }

  // Composer.
  const placeholder =
    overlay?.kind === "input"
      ? ""
      : tab === "chat"
        ? chatDecision?.event === "question"
          ? "Type your answer, or / for commands"
          : agentChat
            ? `Message ${ENGINE_LABEL[engine]}, or type / for commands`
            : "Ask Ensemble Code, or type / for commands"
        : selectedDecision?.event === "question"
          ? "Type your answer, or / for commands"
          : "Type / for commands, or describe a task and press ⏎ to plan it in Chat";
  const composerValue = overlay?.kind === "input" ? (overlay.secret ? "•".repeat(overlay.value.length) : overlay.value) : value;
  const composerCursor = overlay?.kind === "input" ? overlay.value.length : cursor;
  const inner = cols - 6;
  const shown = composerLine(composerValue.replace(/\n/g, "⏎"), composerCursor, inner);

  // Status bar.
  const leftStatus: Segment[] = [
    { text: "[e] ", color: ACCENT, brandWorking: !offline && (streaming || workspace?.running.some(job => job.status === "running") === true) },
    { text: profile.name, bold: true },
    { text: ` · ${ENGINE_LABEL[engine]}`, dim: false },
    { text: ` · ${chatModelLabel}`, dim: true },
    { text: ` · sandbox ${sandbox || "…"}`, dim: true },
  ];
  const rightStatus: Segment[] = [
    offline ? { text: "● offline ", color: "red" } : { text: "● on ", color: "green" },
    { text: account.email ? `${account.email} ` : "not signed in · /login ", dim: !account.email },
  ];
  const status = spread(leftStatus, rightStatus, cols);
  const exitHint = exitArmed ? [{ text: " Press Ctrl+C again to leave. Ensemble keeps running tasks in the background.", color: "yellow" } as Segment] : null;

  // ── input ─────────────────────────────────────────────────────────────────────────────────
  const pickMenu = async (index: number) => {
    const command = menu[Math.min(index, menu.length - 1)];
    if (!command) return;
    if (command.args && command.name !== "allow" && command.name !== "profile" && command.name !== "agent" && command.name !== "model" && command.name !== "keys" && command.name !== "runner") {
      setText(`/${command.name} `);
      return;
    }
    setText("");
    await runCommand(`/${command.name}`);
  };

  const onInput = (input: string, key: Key) => {
    if (isMouse(input)) {
      const event = parseMouse(input);
      if (!event) return;
      const region = hit(regions, event.x, event.y);
      if (event.kind === "click") region?.onClick();
      else if (event.kind === "wheel-up") region?.onWheel?.(-1);
      else if (event.kind === "wheel-down") region?.onWheel?.(1);
      return;
    }
    if (key.ctrl && input === "c") {
      if (streaming) return stopChat();
      if (overlay) {
        if (overlay.kind === "login") overlay.abort.abort();
        return setOverlay(null);
      }
      if (composer.current.value) return setText("");
      if (exitArmed) return exit();
      setExitArmed(true);
      setTimeout(() => setExitArmed(false), 2000);
      return;
    }
    if (key.ctrl && input === "b") return setPrefs({ sidebar: !prefs.sidebar });

    // Overlays take the keys while open.
    if (overlay) {
      if (key.escape) {
        if (overlay.kind === "login") overlay.abort.abort();
        return setOverlay(null);
      }
      if (overlay.kind === "picker") {
        if (key.upArrow) return setOverlay({ ...overlay, index: Math.max(0, overlay.index - 1) });
        if (key.downArrow) return setOverlay({ ...overlay, index: Math.min(overlay.items.length - 1, overlay.index + 1) });
        if (key.return) {
          setOverlay(null);
          return overlay.onPick(overlay.items[overlay.index]!.id);
        }
        return;
      }
      if (overlay.kind === "input") {
        if (key.return) {
          setOverlay(null);
          if (overlay.value.trim()) overlay.onSubmit(overlay.value);
          return;
        }
        if (key.backspace || key.delete) return setOverlay((current) => (current?.kind === "input" ? { ...current, value: current.value.slice(0, -1) } : current));
        if (input && !key.ctrl && !key.meta) return setOverlay((current) => (current?.kind === "input" ? { ...current, value: current.value + input.replace(/[\r\n]/g, "") } : current));
        return;
      }
      if (key.return) return setOverlay(null);
      return;
    }

    if (menu.length) {
      if (key.upArrow) return setMenuIndex((current) => Math.max(0, current - 1));
      if (key.downArrow) return setMenuIndex((current) => Math.min(menu.length - 1, current + 1));
      if (key.tab) {
        const command = menu[Math.min(menuIndex, menu.length - 1)]!;
        return setText(`/${command.name}${command.args ? " " : ""}`);
      }
      if (key.return) return void pickMenu(menuIndex);
      if (key.escape) return setText("");
    }

    if (key.escape) {
      if (streaming) return stopChat();
      if (composer.current.value) return setText("");
      return;
    }
    if (key.tab) return setPrefs({ tab: tab === "tasks" ? "chat" : "tasks" });
    if (key.return) return submit();
    if (key.pageUp || key.pageDown) {
      const delta = key.pageUp ? -1 : 1;
      if (tab === "chat") return setChatScroll((current) => Math.max(0, current - delta * (mainHeight - 2)));
      return setDetailScroll((current) => Math.max(0, current + delta * (mainHeight - 2)));
    }

    if (!composer.current.value) {
      // An empty prompt: arrows and numbers drive the list and the buttons.
      if (key.upArrow || key.downArrow) {
        if (tab === "chat") return setChatScroll((current) => Math.max(0, current + (key.upArrow ? 1 : -1)));
        const index = items.findIndex((item) => item.key === selected?.key);
        const next = items[Math.max(0, Math.min(items.length - 1, index + (key.upArrow ? -1 : 1)))];
        if (next) {
          setSelectedKey(next.key);
          setDetailScroll(0);
          setActionIndex(0);
        }
        return;
      }
      if (key.leftArrow || key.rightArrow) {
        if (bar.length) setActionIndex((current) => Math.max(0, Math.min(bar.length - 1, current + (key.leftArrow ? -1 : 1))));
        return;
      }
      if (/^[1-9]$/.test(input) && bar[Number(input) - 1]) {
        setActionIndex(Number(input) - 1);
        return bar[Number(input) - 1]!.run();
      }
    }

    // Editing.
    if (key.upArrow || key.downArrow) {
      const nextAt = key.upArrow ? Math.min(history.length - 1, historyAt + 1) : Math.max(-1, historyAt - 1);
      setHistoryAt(nextAt);
      return setText(nextAt < 0 ? "" : history[nextAt]!);
    }
    const live = composer.current;
    if (key.leftArrow) return setCursor(live.cursor - 1);
    if (key.rightArrow) return setCursor(live.cursor + 1);
    if (key.home || (key.ctrl && input === "a")) return setCursor(0);
    if (key.end || (key.ctrl && input === "e")) return setCursor(live.value.length);
    if (key.ctrl && input === "u") return setText(live.value.slice(live.cursor), 0);
    if (key.ctrl && input === "w") {
      const before = live.value.slice(0, live.cursor).replace(/\S+\s*$/, "");
      return setText(before + live.value.slice(live.cursor), before.length);
    }
    if (key.backspace || key.delete) {
      if (live.cursor === 0) return;
      return setText(live.value.slice(0, live.cursor - 1) + live.value.slice(live.cursor), live.cursor - 1);
    }
    if (key.ctrl || key.meta) return;
    if (input) {
      const clean = input.replace(/\r\n?/g, "\n");
      setText(live.value.slice(0, live.cursor) + clean + live.value.slice(live.cursor), live.cursor + clean.length);
    }
  };
  // Ink re-attaches a key handler in an effect after each render, so a key that arrives just after
  // new buttons appear would reach the old one. One stable handler always calls this render's.
  const latestInput = useRef(onInput);
  latestInput.current = onInput;
  useInput(useCallback((input: string, key: Key) => latestInput.current(input, key), []));

  // ── render ────────────────────────────────────────────────────────────────────────────────
  return (
    <Box flexDirection="column" width={cols} height={rows}>
      <Row line={tabLine} width={cols} />
      <Row line={[{ text: "─".repeat(cols), dim: true }]} width={cols} />
      {mainLines.slice(0, mainHeight).map((line, index) => (
        <Row key={`m${index}`} line={line} width={cols} />
      ))}
      {Array.from({ length: Math.max(0, mainHeight - mainLines.length) }, (_, index) => (
        <Row key={`f${index}`} line={[]} width={cols} />
      ))}
      {extraLines.map((line, index) => (
        <Row key={`x${index}`} line={line} width={cols} />
      ))}
      <Box borderStyle="round" borderColor={overlay?.kind === "input" ? "yellow" : streaming ? MUTED : ACCENT} width={cols} height={3} paddingX={1}>
        <Text wrap="truncate-end">
          <Text color={ACCENT}>{overlay?.kind === "input" ? "🔑 " : "› "}</Text>
          {composerValue ? shown : <Text dimColor>{placeholder}</Text>}
        </Text>
      </Box>
      <Row line={exitHint ?? status} width={cols} />
    </Box>
  );
}

// ── panes ───────────────────────────────────────────────────────────────────────────────────

function taskPane(input: { item: Item | null; detail: JobDetail | null; width: number; now: number; agentsOff: boolean; offline: string | null }): Line[] {
  const { item, detail, width, now } = input;
  const lines: Line[] = [];
  if (input.offline) lines.push(...wrapLine([{ text: `Ensemble on this computer is not answering (${input.offline}). It restarts by itself; if it does not, run \`ensemble\` again.`, color: "red" }], width), []);
  if (input.agentsOff) {
    lines.push(...wrapLine([{ text: "Agents are off in this space. Turn them on in Settings → Account → Features (desktop app or ensemblework.com).", color: "yellow" }], width));
    return lines;
  }
  if (!item) {
    lines.push([{ text: "Welcome to Ensemble.", bold: true }], []);
    lines.push(
      ...markdown(
        [
          "Runs on this computer show up here: the ones you start with **/run** or from **Chat**, and the ones you assign to this computer on ensemblework.com.",
          "",
          "When a run needs you (a command to approve, a question), it shows here with buttons: click one, press its number, or type `/allow`, `/deny` or your own answer.",
          "",
          "- **/run** fix the failing tests  — start an agent here, now",
          "- **Tab** — talk to Ensemble Code in Chat",
          "- **/profile**, **/agent** — how runs go, and who codes",
          "- **/help** — every key and command",
        ].join("\n"),
        width,
      ),
    );
    return lines;
  }
  const decision = item.decision;
  if (item.job) {
    const job = detail?.job.id === item.job.id ? { ...item.job, ...detail.job } : item.job;
    const glyph = STATUS_GLYPH[job.status] ?? { glyph: "•", color: MUTED };
    lines.push(...wrapLine([{ text: `${glyph.glyph} `, color: glyph.color }, { text: job.title, bold: true }], width));
    const facts = [engineOf(job), job.unattended ? "Run unattended" : job.accessMode === "auto" ? "Review only" : "Ask", job.delivery === "local" ? "local only" : job.delivery === "commit" ? "may commit" : "may commit and push", job.executionMode === "sandbox" ? "sandbox on" : "sandbox off"];
    lines.push(...wrapLine([{ text: facts.join(" · "), dim: true }], width));
    if (job.folder) lines.push([{ text: truncate(job.folder, width), dim: true }]);
    lines.push([]);
    const when = job.status === "running" ? `running for ${ago(job.startedAt, now)}` : job.finishedAt ? `${job.status.replace("_", " ")} ${ago(job.finishedAt, now)} ago` : job.status === "queued" ? `queued${job.position ? ` (#${job.position})` : ""}` : job.status.replace("_", " ");
    lines.push([{ text: when, color: glyph.color }, ...(job.progress && job.status !== "succeeded" ? [{ text: ` · ${job.progress}`, dim: true }] : [])]);
    if (decision) lines.push([], ...decisionLines(decision, width));
    if (job.summary && ["succeeded", "failed", "blocked", "interrupted"].includes(job.status)) lines.push([], [{ text: "Summary", bold: true }], ...markdown(job.summary, width));
    if (job.error && job.status !== "succeeded") lines.push([], ...wrapLine([{ text: job.error, color: "red" }], width));
    const log = detail?.job.id === job.id ? detail.log : "";
    if (log.trim()) {
      lines.push([], [{ text: "Log", bold: true }, { text: "  (wheel or PgUp/PgDn to scroll)", dim: true }]);
      const logLines = plain(log.trim(), width, { dim: true });
      lines.push(...logLines.slice(-400));
    }
    return lines;
  }
  if (decision) lines.push(...decisionLines(decision, width));
  return lines;
}

function decisionLines(decision: Decision, width: number): Line[] {
  const lines: Line[] = [];
  const who = sourceLabel(decision.source);
  lines.push([{ text: "◆ Needs you", color: "yellow", bold: true }, { text: `  ${who}${decision.event === "question" ? " asks" : " wants to"}`, dim: true }]);
  lines.push(...wrapLine([{ text: decision.title, bold: true }], width));
  if (decision.detail?.command && !decision.title.includes(decision.detail.command)) lines.push(...wrapLine([{ text: "$ ", dim: true }, { text: decision.detail.command, color: "cyan" }], width, "  "));
  if (decision.cwd) lines.push([{ text: `in ${truncate(decision.cwd, width - 3)}`, dim: true }]);
  const details = decision.detail?.optionDetails ?? [];
  if (details.some((row) => row.description)) {
    lines.push([]);
    details.forEach((row, index) => lines.push(...wrapLine([{ text: `${index + 1}. `, color: ACCENT }, { text: row.label, bold: true }, ...(row.description ? [{ text: ` — ${row.description}`, dim: true }] : [])], width, "   ")));
  }
  return lines;
}

function chatPane(
  entries: readonly Entry[],
  width: number,
  streaming: boolean,
  context: { agent: string | null; folder: string; profile: string; decision: Decision | null },
): Line[] {
  const lines: Line[] = [];
  if (!entries.length) {
    if (context.agent) {
      lines.push([{ text: `Chat with ${context.agent}`, bold: true, color: ACCENT }]);
      lines.push(
        ...markdown(
          [
            `${context.agent} works in ${context.folder} on your own sign-in, under your run profile (${context.profile}). Each message continues the same conversation; /new starts over.`,
            "",
            "When it wants to run something or asks you a question, the buttons show up here. Ensemble's tools are loaded: it can list and create tasks on your board and search your notes.",
            "",
            "Try:",
            "- “What does this repo do, and where are its tests?”",
            "- “Fix the failing test in src/api and commit it”",
            "- “Make a task for each TODO in this folder”",
          ].join("\n"),
          width,
          { dim: true },
        ),
      );
      return lines;
    }
    lines.push([{ text: "Ensemble Code", bold: true, color: ACCENT }]);
    lines.push(
      ...markdown(
        [
          "Ask about this folder, plan a change, or hand work to an agent. It reads files and documents here (PDF, Word, Excel, PowerPoint), knows your tasks and notes, and starts runs under your run profile; the run's questions come to the Tasks tab.",
          "",
          "It needs a model key (/keys). No key? Chat with Claude Code, Codex or Cursor on your own sign-in instead: /agent.",
          "",
          "Try:",
          "- “What does this repo do, and where are its tests?”",
          "- “Read docs/spec.pdf and make a task for each open item”",
          "- “Clone owner/repo, fix the failing CI step and commit it”",
        ].join("\n"),
        width,
        { dim: true },
      ),
    );
    return lines;
  }
  for (const item of entries) {
    if (item.kind === "user") lines.push([], ...wrapLine([{ text: "› ", color: ACCENT, bold: true }, { text: item.text, bold: true }], width, "  "));
    else if (item.kind === "assistant") {
      if (item.text.trim()) lines.push([], ...markdown(item.text.trim(), width));
    } else if (item.kind === "agent") lines.push(...agentLines(item.text, width));
    else if (item.kind === "tool") lines.push(...wrapLine([{ text: "  ✓ ", color: "green" }, { text: item.text, dim: true }], width, "    "));
    else if (item.kind === "failed") lines.push(...wrapLine([{ text: "  ✗ ", color: "red" }, { text: item.text, color: "red" }], width, "    "));
    else if (item.kind === "pending") lines.push([], [{ text: "  ◇ Waiting for Apply", color: "yellow", bold: true }], ...markdown(item.text, width - 4).map((line) => [{ text: "    " }, ...line]));
    else if (item.kind === "note") lines.push(...wrapLine([{ text: `  ${item.text}`, dim: true, italic: true }], width));
    else if (item.kind === "included" && item.notice) lines.push([], ...noticeLines(item.notice, width));
    else lines.push([], ...wrapLine([{ text: "  ✗ ", color: "red" }, { text: item.text, color: "red" }], width, "    "));
  }
  if (context.decision) lines.push([], ...decisionLines(context.decision, width));
  else if (streaming) lines.push([{ text: "  ⠿ working…", color: ACCENT, dim: true }]);
  return lines;
}

/** An included refusal as a framed notice: what happened, why, and the command that fixes it. */
function noticeLines(notice: IncludedNotice, width: number): Line[] {
  const color = notice.tone === "warn" ? "yellow" : ACCENT;
  const bar = { text: "  │ ", color };
  return [
    [{ text: "  ╭─ ", color }, { text: notice.title, bold: true }],
    ...wrapLine([bar, { text: notice.text }], width, "  │ "),
    ...wrapLine([bar, { text: "→ ", color, bold: true }, { text: notice.hint, dim: true }], width, "  │   "),
    [{ text: "  ╰─", color }],
  ];
}

/** An agent's reply as its run logged it: what it said, and a line for each thing it did ("· Run npm test"). */
function agentLines(text: string, width: number): Line[] {
  const lines: Line[] = [];
  let said: string[] = [];
  const flush = () => {
    const body = said.join("\n").trim();
    if (body) lines.push([], ...markdown(body, width));
    said = [];
  };
  for (const raw of text.split("\n")) {
    if (raw.startsWith("· ")) {
      flush();
      lines.push(...wrapLine([{ text: "  ⏺ ", color: ACCENT }, { text: raw.slice(2), dim: true }], width, "    "));
    } else said.push(raw);
  }
  flush();
  return lines;
}

function overlayLines(
  overlay: Overlay,
  cols: number,
  height: number,
  regions: Region[],
  top: number,
  hover: (index: number) => void,
  pick: (id: string) => void,
): Line[] {
  const width = cols - 4;
  const lines: Line[] = [[{ text: `  ${overlay.kind === "login" ? "Sign in to Ensemble" : overlay.title}`, bold: true, color: ACCENT }, { text: "   Esc to close", dim: true }]];
  if (overlay.kind === "picker") {
    if (overlay.hint) lines.push(...wrapLine([{ text: `  ${overlay.hint}`, dim: true }], width, "  "));
    lines.push([]);
    const room = height - lines.length;
    const start = Math.max(0, Math.min(overlay.index - Math.floor(room / 2), overlay.items.length - room));
    overlay.items.slice(start, start + room).forEach((item, offset) => {
      const index = start + offset;
      const active = index === overlay.index;
      lines.push([
        { text: active ? "  ❯ " : "    ", color: ACCENT },
        { text: item.active ? "● " : "  ", color: "green" },
        { text: pad(item.label, Math.min(40, Math.floor(width * 0.45))), bold: active, color: active ? ACCENT : undefined },
        { text: truncate(item.detail ?? "", width - Math.min(40, Math.floor(width * 0.45)) - 8), dim: true },
      ]);
      const row = top + lines.length - 1;
      regions.push({ x1: 0, x2: cols - 1, y1: row, y2: row, onClick: () => (hover(index), pick(item.id)) });
    });
  } else if (overlay.kind === "input") {
    lines.push(...wrapLine([{ text: `  ${overlay.hint}`, dim: true }], width, "  "), [], [{ text: "  Type below, then press ⏎.", dim: true }]);
  } else if (overlay.kind === "text") {
    lines.push([], ...overlay.lines.map((line) => [{ text: "  " }, ...line]));
  } else {
    lines.push([]);
    if (!overlay.code) lines.push([{ text: "  Asking ensemblework.com for a sign-in code…", dim: true }]);
    else {
      lines.push([{ text: "  Your code  ", dim: true }, { text: ` ${overlay.code} `, backgroundColor: ACCENT, color: "black", bold: true }]);
      lines.push([]);
      lines.push(...wrapLine([{ text: overlay.opened ? "  A browser page opened. Check the code matches, then approve. " : "  Open this page, check the code matches, then approve: ", dim: true }], width, "  "));
      lines.push(...wrapLine([{ text: `  ${overlay.url}`, color: "cyan", underline: true }], width, "  "));
      lines.push([], [{ text: "  ⠿ Waiting for you to approve…", color: ACCENT }]);
    }
  }
  return lines.slice(0, height);
}

// ── rendering helpers ───────────────────────────────────────────────────────────────────────

function Row({ line, width }: { line: Line; width: number }) {
  const cut = fit(line, width);
  return (
    <Text wrap="truncate-end">
      {cut.length ? (
        cut.map((segment, index) => (
          <Text
            key={index}
            color={segment.color}
            backgroundColor={segment.backgroundColor}
            bold={segment.bold}
            dimColor={segment.dim}
            italic={segment.italic}
            underline={segment.underline}
            inverse={segment.inverse}
          >
            {segment.brandWorking ? <WorkingMark /> : segment.text}
          </Text>
        ))
      ) : (
        " "
      )}
    </Text>
  );
}

/** Exactly `width` cells: cut, or padded with spaces. */
function fit(line: Line, width: number): Line {
  const out: Line = [];
  let used = 0;
  for (const segment of line) {
    if (used >= width) break;
    const room = width - used;
    const text = cellWidth(segment.text) > room ? truncate(segment.text, room) : segment.text;
    out.push({ ...segment, text });
    used += cellWidth(text);
  }
  if (used < width) out.push({ text: " ".repeat(width - used) });
  return out;
}

function spread(leftPart: Segment[], rightPart: Segment[], width: number): Line {
  const leftWidth = cellWidth(leftPart.map((segment) => segment.text).join(""));
  const rightWidth = cellWidth(rightPart.map((segment) => segment.text).join(""));
  if (leftWidth + rightWidth + 1 > width) return fit([...leftPart], width);
  return [...leftPart, { text: " ".repeat(width - leftWidth - rightWidth) }, ...rightPart];
}

/** The prompt line with a block cursor, scrolled so the cursor stays in view. */
function composerLine(value: string, cursor: number, width: number) {
  const startAt = Math.max(0, cursor - width + 2);
  const visible = value.slice(startAt, startAt + width - 1);
  const at = cursor - startAt;
  const before = visible.slice(0, at);
  const under = visible[at] ?? " ";
  const after = visible.slice(at + 1);
  return (
    <>
      {before}
      <Text inverse>{under}</Text>
      {after}
    </>
  );
}

function shortPath(path: string, width: number): string {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const short = home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
  return cellWidth(short) <= width ? short : `…${short.slice(-(width - 1))}`;
}

function chatError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/no .*key|api key|credential|not configured|model_quota|quota/i.test(message)) return `${message} Add a model key with /keys, or chat with Claude Code, Codex or Cursor on your own sign-in: /agent.`;
  return message;
}
