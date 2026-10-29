#!/usr/bin/env node
/**
 * Ensemble's `ask_person` tool for a coding agent Ensemble started (Claude
 * Code has no question tool in headless runs). A minimal stdio MCP server, no
 * dependencies: `tools/call` asks this computer's Ensemble, which shows the
 * question on Needs me (app, web, phone, `ensemble needs`) with the options
 * and a typed answer, and returns the answer as the tool result. In a run
 * nobody is watching, the recommended option comes back at once.
 *
 * Started by the coding agent (Claude Code, Codex, Copilot CLI, Cursor) from
 * the run's MCP config with ENSEMBLE_ENGINE_URL and ENSEMBLE_RUN set. The
 * engines give it a day-long tool timeout, as an answer can take that long;
 * if the agent still stops waiting, the question is withdrawn from Needs me.
 *
 * In Chat with the person's own agent (ENSEMBLE_CHAT=1) it also offers their
 * Ensemble board: ensemble_list_tasks, ensemble_create_task and
 * ensemble_search, answered by /api/engine/tool for that chat's run only.
 * In a task run it offers report_result (the run's structured result) and
 * attach_evidence (a file the owner should see), answered by the same route
 * (hub-api src/evidence/run-tools.ts, docs/30 §9).
 *
 * For an assistant turn run on the person's own subscription
 * (ENSEMBLE_ASSISTANT_TURN set, docs/30 §8) it offers that turn's Ensemble
 * tools instead, listed and called through /api/engine/assistant/*; when a
 * call changes the list (a playbook loaded) it tells the agent to list again.
 */
import { request as httpRequest } from "node:http";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

const TOOL = {
  name: "ask_person",
  description:
    "Ask the person who assigned this task one decision question and wait for the answer. Give 2–5 short options and say which one you recommend. Use it for real decisions (an unclear requirement, a choice between approaches), not for permission: Ensemble decides permissions itself.",
  inputSchema: {
    type: "object",
    properties: {
      question: { type: "string", description: "One clear question." },
      options: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 5, description: "Short, concrete choices." },
      recommended: { type: "string", description: "The option you recommend, written exactly as in options." },
    },
    required: ["question", "options"],
  },
};

const CHAT_TOOLS = [
  {
    name: "ensemble_list_tasks",
    description: "List the person's tasks on their Ensemble board (open ones unless include_done), newest first, with status, due date and id.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Only tasks whose title or description contains this." },
        include_done: { type: "boolean", description: "Include done and dropped tasks." },
      },
    },
  },
  {
    name: "ensemble_create_task",
    description: "Create a task (a todo) on the person's Ensemble board, for them. Use it when they ask you to make a task, a todo or a reminder.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "A short imperative title." },
        page: { type: "string", description: "The task's page, in Markdown: what to do, with any detail worth keeping." },
        due: { type: "string", description: "Due date, YYYY-MM-DD." },
      },
      required: ["title"],
    },
  },
  {
    name: "ensemble_search",
    description: "Search the person's Ensemble: notes, pages, tasks, projects and meeting notes. Returns matches with a short excerpt.",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
];

const EVIDENCE_KINDS = ["screenshot", "image", "video", "trace", "report", "log", "file"];

/** The worker's result, in the shape of hub-api src/node/report.ts (StepReport). */
const REPORT_TOOL = {
  name: "report_result",
  description:
    "Report your result once, when you finish or cannot go on. outcome: done (you built or wrote it), pass or fail (you verified something: list each check with its verdict), or blocked (say why in blockedBy). Ensemble checks it (a commit or contentHash you name must exist in your folder) and keeps it as the run's result; calling it again replaces it. Attach files first with attach_evidence and name them in checks or evidence.",
  inputSchema: {
    type: "object",
    properties: {
      outcome: { type: "string", enum: ["done", "pass", "fail", "blocked"] },
      summary: { type: "string", maxLength: 2000, description: "One paragraph: what you did and what came of it." },
      checks: {
        type: "array",
        maxItems: 50,
        description: "Each check you ran, with its verdict. A verification passes only when every check passed.",
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "The acceptance criterion's id, when your brief gave one." },
            name: { type: "string", description: "What was checked." },
            verdict: { type: "string", enum: ["pass", "fail", "blocked", "skipped"] },
            detail: { type: "string", maxLength: 2000, description: "What you saw: the failure, the output that matters." },
            evidence: { type: "array", maxItems: 20, items: { type: "string" }, description: "Evidence ids from attach_evidence, URLs or paths." },
            rerun: {
              type: "object",
              description: "How to run the check again without you.",
              properties: {
                command: { type: "string" },
                cwd: { type: "string" },
                expects: { anyOf: [{ type: "string", enum: ["exit_0"] }, { type: "object", properties: { outputMatches: { type: "string" } }, required: ["outputMatches"], additionalProperties: false }] },
              },
              required: ["command", "expects"],
              additionalProperties: false,
            },
          },
          required: ["name", "verdict"],
          additionalProperties: false,
        },
      },
      subject: {
        type: "object",
        description: "What you built or tested: the commit, or the working tree's git tree id as contentHash when nothing was committed.",
        properties: { repo: { type: "string" }, folder: { type: "string" }, branch: { type: "string" }, commit: { type: "string" }, contentHash: { type: "string" }, url: { type: "string" } },
        additionalProperties: false,
      },
      evidence: {
        type: "array",
        maxItems: 30,
        items: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["commit", "file", "url", "log", "screenshot", "video", "report", "evidence"] },
            ref: { type: "string", description: "An evidence id, a commit, a URL or a path." },
            caption: { type: "string", maxLength: 300 },
          },
          required: ["kind", "ref"],
          additionalProperties: false,
        },
      },
      blockedBy: { type: "string", enum: ["needs_owner", "login_required", "missing_access", "environment", "no_report", "no_progress", "unknown"] },
    },
    required: ["outcome", "summary"],
    additionalProperties: false,
  },
};

const EVIDENCE_TOOL = {
  name: "attach_evidence",
  description:
    "Attach a file your owner should see with this run's result: a screenshot, image, video, trace, report, log or file, by its path (in your folder, or one this run may read). Ensemble checks it (never keys, .env files, histories or anything holding a secret; images and files up to 20 MB, video and traces up to 100 MB), copies it into this run's evidence folder and returns its evidence id.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "The file, relative to your folder or absolute." },
      kind: { type: "string", enum: EVIDENCE_KINDS },
      caption: { type: "string", maxLength: 300, description: "What it shows, in one line." },
      requirementId: { type: "string", description: "The requirement it shows, when your brief named one." },
    },
    required: ["path", "kind"],
    additionalProperties: false,
  },
};

export function toolsFor(env = process.env) {
  return env.ENSEMBLE_CHAT === "1" ? [TOOL, ...CHAT_TOOLS] : [TOOL, REPORT_TOOL, EVIDENCE_TOOL];
}

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

export function questionInput(args) {
  const options = (Array.isArray(args?.options) ? args.options : []).filter((value) => typeof value === "string" && value.trim()).slice(0, 5);
  const recommended = typeof args?.recommended === "string" && options.includes(args.recommended) ? args.recommended : null;
  return {
    questions: [
      {
        question: String(args?.question ?? "").slice(0, 1000),
        multiSelect: false,
        // The judge picks "(Recommended)" when nobody is watching; the card shows it as the recommended option.
        options: options.map((label) => ({ label: label === recommended ? `${label} (Recommended)` : label })),
      },
    ],
  };
}

function ask(input, signal) {
  return post("/api/engine/ask", { tool_name: "AskUserQuestion", tool_input: input }, (message) => ({ decision: "deny", message }), "POST", signal);
}

/** One request to this computer's Ensemble with the run's (or the turn's) secret; `failed` shapes the answer when it cannot be reached. Aborting `signal` hangs up. */
function post(path, payload, failed, method = "POST", signal) {
  const base = process.env.ENSEMBLE_ENGINE_URL;
  const turn = process.env.ENSEMBLE_ASSISTANT_TURN;
  const run = process.env.ENSEMBLE_RUN;
  if (!base || !(turn || run)) return Promise.resolve(failed("Ensemble is not reachable from this run."));
  if (signal?.aborted) return Promise.resolve(failed("The agent stopped waiting."));
  const body = payload === undefined ? "" : JSON.stringify(payload);
  const secret = turn ? { "x-ensemble-turn": turn } : { "x-ensemble-run": run };
  return new Promise((resolve) => {
    let req;
    const hangUp = () => {
      req?.destroy();
      done(failed("The agent stopped waiting."));
    };
    const done = (value) => {
      signal?.removeEventListener("abort", hangUp);
      resolve(value);
    };
    signal?.addEventListener("abort", hangUp, { once: true });
    req = httpRequest(
      new URL(path, base),
      { method, headers: { ...(body ? { "content-type": "application/json", "content-length": Buffer.byteLength(body) } : {}), ...secret } },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => {
          try {
            done(JSON.parse(text));
          } catch {
            done(failed(`Ensemble answered ${res.statusCode}.`));
          }
        });
      },
    );
    req.on("error", (error) => done(failed(`Ensemble could not be reached (${error.message}).`)));
    req.end(body || undefined);
  });
}

/** The assistant turn's tools, as Ensemble last listed them. */
let turnTools = null;

async function assistantTools() {
  if (turnTools) return turnTools;
  const answer = await post("/api/engine/assistant/tools", undefined, (error) => ({ error }), "GET");
  turnTools = Array.isArray(answer?.tools) ? answer.tools : [];
  return turnTools;
}

async function handleAssistant(message) {
  if (message.method === "initialize") {
    send({ id: message.id, result: { protocolVersion: message.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: { listChanged: true } }, serverInfo: { name: "ensemble", version: "1" } } });
  } else if (message.method === "tools/list") {
    send({ id: message.id, result: { tools: await assistantTools() } });
  } else if (message.method === "tools/call") {
    const answer = await post("/api/engine/assistant/tool", { name: message.params?.name, input: message.params?.arguments ?? {} }, (error) => ({ text: error, isError: true }));
    const text = typeof answer?.text === "string" ? answer.text : String(answer?.error ?? "The tool failed.");
    send({ id: message.id, result: { content: [{ type: "text", text }], ...(answer?.isError || typeof answer?.text !== "string" ? { isError: true } : {}) } });
    if (Array.isArray(answer?.tools)) {
      turnTools = answer.tools;
      send({ method: "notifications/tools/list_changed" });
    }
  } else if (message.method === "ping") {
    send({ id: message.id, result: {} });
  } else if (message.id !== undefined) {
    send({ id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } });
  }
}

export function answerText(input, verdict) {
  const question = input.questions[0].question;
  const answer = verdict?.updatedInput?.answers?.[question];
  if (verdict?.decision === "allow" && typeof answer === "string") return `The person answered: ${answer.replace(/\s*\(Recommended\)$/, "")}`;
  return `No answer: ${verdict?.message ?? "the person did not answer"}`;
}

/**
 * Questions still waiting for the person, by JSON-RPC id. The agent cancelling one hangs up its
 * request, and Ensemble withdraws the Needs me card: an answer would reach nobody. (A client may
 * close its input and still read the answers, so that alone hangs up nothing; the run's end does.)
 */
const waiting = new Map();

export const HEARTBEAT_MS = 20_000;

/**
 * While a question waits, MCP progress notifications when the agent asked for them (a progress
 * token), so a client that resets its request timeout on progress keeps waiting for the person.
 * The engines also give this server a day-long tool timeout (docs/30).
 */
export function heartbeat(message, write = send, every = HEARTBEAT_MS) {
  const token = message.params?._meta?.progressToken;
  if (token === undefined || token === null) return () => undefined;
  let beat = 0;
  const timer = setInterval(() => write({ method: "notifications/progress", params: { progressToken: token, progress: ++beat, message: "Waiting for the person's answer on Needs me." } }), every);
  timer.unref?.();
  return () => clearInterval(timer);
}

async function handle(message) {
  if (message.method === "initialize") {
    send({ id: message.id, result: { protocolVersion: message.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "ensemble", version: "1" } } });
  } else if (message.method === "tools/list") {
    send({ id: message.id, result: { tools: toolsFor() } });
  } else if (message.method === "tools/call") {
    const name = message.params?.name;
    if (name !== TOOL.name && toolsFor().some((tool) => tool.name === name)) {
      const answer = await post("/api/engine/tool", { name, input: message.params?.arguments ?? {} }, (error) => ({ error }));
      const text = typeof answer?.text === "string" ? answer.text : String(answer?.error ?? "The tool failed.");
      send({ id: message.id, result: { content: [{ type: "text", text }], ...(typeof answer?.text === "string" ? {} : { isError: true }) } });
      return;
    }
    if (name !== TOOL.name) {
      send({ id: message.id, error: { code: -32602, message: `Unknown tool ${name}` } });
      return;
    }
    const input = questionInput(message.params?.arguments ?? {});
    const call = new AbortController();
    waiting.set(message.id, call);
    const stop = heartbeat(message);
    try {
      const verdict = await ask(input, call.signal);
      // Cancelled by the agent: MCP sends no reply to a cancelled request.
      if (call.signal.aborted) return;
      send({ id: message.id, result: { content: [{ type: "text", text: answerText(input, verdict) }] } });
    } finally {
      stop();
      waiting.delete(message.id);
    }
  } else if (message.method === "notifications/cancelled") {
    waiting.get(message.params?.requestId)?.abort();
  } else if (message.method === "ping") {
    send({ id: message.id, result: {} });
  } else if (message.id !== undefined) {
    send({ id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } });
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  for await (const line of createInterface({ input: process.stdin })) {
    if (!line.trim()) continue;
    try {
      const message = JSON.parse(line);
      void (process.env.ENSEMBLE_ASSISTANT_TURN ? handleAssistant(message) : handle(message));
    } catch {
      // not JSON: ignore, as MCP clients only send JSON-RPC lines
    }
  }
}
