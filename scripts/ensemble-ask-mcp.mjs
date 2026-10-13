#!/usr/bin/env node
/**
 * Ensemble's `ask_person` tool for a coding agent Ensemble started (Claude
 * Code has no question tool in headless runs). A minimal stdio MCP server, no
 * dependencies: `tools/call` asks this computer's Ensemble, which shows the
 * question on Needs me (app, web, phone, `ensemble needs`) with the options
 * and a typed answer, and returns the answer as the tool result. In a run
 * nobody is watching, the recommended option comes back at once.
 *
 * Started by Claude Code from the run's --mcp-config with ENSEMBLE_ENGINE_URL
 * and ENSEMBLE_RUN set.
 *
 * In Chat with the person's own agent (ENSEMBLE_CHAT=1) it also offers their
 * Ensemble board: ensemble_list_tasks, ensemble_create_task and
 * ensemble_search, answered by /api/engine/tool for that chat's run only.
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

export function toolsFor(env = process.env) {
  return env.ENSEMBLE_CHAT === "1" ? [TOOL, ...CHAT_TOOLS] : [TOOL];
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

function ask(input) {
  return post("/api/engine/ask", { tool_name: "AskUserQuestion", tool_input: input }, (message) => ({ decision: "deny", message }));
}

/** One request to this computer's Ensemble with the run's secret; `failed` shapes the answer when it cannot be reached. */
function post(path, payload, failed) {
  const base = process.env.ENSEMBLE_ENGINE_URL;
  const run = process.env.ENSEMBLE_RUN;
  if (!base || !run) return Promise.resolve(failed("Ensemble is not reachable from this run."));
  const body = JSON.stringify(payload);
  return new Promise((done) => {
    const req = httpRequest(
      new URL(path, base),
      { method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), "x-ensemble-run": run } },
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
    req.end(body);
  });
}

export function answerText(input, verdict) {
  const question = input.questions[0].question;
  const answer = verdict?.updatedInput?.answers?.[question];
  if (verdict?.decision === "allow" && typeof answer === "string") return `The person answered: ${answer.replace(/\s*\(Recommended\)$/, "")}`;
  return `No answer: ${verdict?.message ?? "the person did not answer"}`;
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
    const verdict = await ask(input);
    send({ id: message.id, result: { content: [{ type: "text", text: answerText(input, verdict) }] } });
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
      void handle(JSON.parse(line));
    } catch {
      // not JSON: ignore, as MCP clients only send JSON-RPC lines
    }
  }
}
