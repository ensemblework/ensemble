/** Opt-in, real-model checks over synthetic in-memory workspaces. No production records are read. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { DEFAULT_SETTINGS } from "@ensemble/shared-types";
import { createHttpHarness } from "../src/test/http.js";

const model = process.env.ENSEMBLE_EVAL_MODEL ?? "gpt-5-mini";
const ssh = process.argv[process.argv.indexOf("--ssh") + 1];
const remote = process.argv.includes("--ssh") ? ssh : null;
const harness = await createHttpHarness();
const { runAssistantTurn } = await import("../src/assistant/agent.js");
const { setAskRuntimeStreamForTests } = await import("../src/lib/model-turn.js");
const { buildResponsesPayload, itemsFromChat, toolsFor, turnFromResponse } = await import("../src/runtime/responses-api.js");
let tokensIn = 0, tokensOut = 0, cached = 0, calls = 0;
// ENSEMBLE_EVAL_ENV_FILE: an Ensemble env file with AZURE_FOUNDRY_RESOURCE and AZURE_FOUNDRY_API_KEY (Azure Foundry, as the included models).
const azure = (() => {
  const file = process.env.ENSEMBLE_EVAL_ENV_FILE;
  if (!file) return null;
  const values: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const match = /^\s*(?:export\s+)?([A-Z0-9_]+)=(.*)$/.exec(line);
    if (match) values[match[1]!] = match[2]!.trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  if (!values.AZURE_FOUNDRY_RESOURCE || !values.AZURE_FOUNDRY_API_KEY) throw new Error(`${file} has no AZURE_FOUNDRY_RESOURCE and AZURE_FOUNDRY_API_KEY.`);
  return { resource: values.AZURE_FOUNDRY_RESOURCE, key: values.AZURE_FOUNDRY_API_KEY };
})();
// Hub chat sends no effort for included models (routes/assistant.ts), so the model's own default applies; "low" etc. to compare.
const effort = process.env.ENSEMBLE_EVAL_EFFORT || null;
const repeat = Math.max(1, Number(process.env.ENSEMBLE_EVAL_REPEAT || 1));
// ENSEMBLE_EVAL_WITHOUT: tools to leave out (a comma list), to measure a tool by its absence.
const withoutTools = (process.env.ENSEMBLE_EVAL_WITHOUT ?? "").split(",").map(name => name.trim()).filter(Boolean);

async function request(payload: Record<string, unknown>): Promise<Record<string, any>> {
  if (remote) {
    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64");
    const script = `import os,json,shlex,base64,urllib.request,urllib.error\nenv={}\nfor line in open('/etc/ensemble.env'):\n line=line.strip()\n if not line or line.startswith('#') or '=' not in line: continue\n k,v=line.split('=',1)\n try: env[k]=shlex.split(v)[0] if v.strip() else ''\n except ValueError: pass\nresource=env['AZURE_FOUNDRY_RESOURCE']\nkey=env['AZURE_FOUNDRY_API_KEY']\npayload=base64.b64decode('${encoded}')\nreq=urllib.request.Request('https://'+resource+'.openai.azure.com/openai/v1/responses',data=payload,headers={'api-key':key,'Content-Type':'application/json'})\ntry:\n print(urllib.request.urlopen(req,timeout=55).read().decode())\nexcept urllib.error.HTTPError as e:\n print(json.dumps({'error':{'status':e.code,'message':e.read().decode()}}))\n`;
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn("ssh", ["-o", "BatchMode=yes", remote, "sudo", "python3", "-"], { stdio: ["pipe", "pipe", "pipe"] });
      let out = "", err = "";
      child.stdout.on("data", data => out += data); child.stderr.on("data", data => err += data);
      child.on("error", reject); child.on("close", code => code === 0 ? resolve(out) : reject(new Error(`Evaluation transport failed (${code}): ${err.slice(0, 300)}`)));
      child.stdin.end(script);
    });
    return JSON.parse(output);
  }
  if (azure) {
    const response = await fetch(`https://${azure.resource}.openai.azure.com/openai/v1/responses`, { method: "POST", headers: { "api-key": azure.key, "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(120_000) });
    return response.json();
  }
  const endpoint = process.env.ENSEMBLE_EVAL_URL ?? "https://api.openai.com/v1/responses";
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("Set OPENAI_API_KEY, or use --ssh with a configured Ensemble server.");
  const response = await fetch(endpoint, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(55_000) });
  return response.json();
}

setAskRuntimeStreamForTests(async args => {
  const payload = { ...buildResponsesPayload(model, itemsFromChat(args.messages as Record<string, unknown>[]), { tools: toolsFor((args.responsesTools ?? args.chatTools ?? []) as Record<string, unknown>[]), effort }), max_output_tokens: 4000 };
  const data = await request(payload);
  if (data.error) throw new Error(`Model evaluation failed: ${JSON.stringify(data.error).slice(0, 500)}`);
  calls++; tokensIn += data.usage?.input_tokens ?? 0; tokensOut += data.usage?.output_tokens ?? 0; cached += data.usage?.input_tokens_details?.cached_tokens ?? 0;
  const turn = turnFromResponse(data, model);
  if (turn.text) args.onDelta?.(String(turn.text));
  return { ...turn, model, credits: null, raw: data } as never;
});

try {
  // Each round is a new person with a fresh workspace, so a repeat never meets the last round's records.
  const workspace = async () => {
    const user = await harness.asUser();
    const page = await harness.prisma.taskPage.create({ data: { userId: user.id, title: "Launch brief", content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Keep the first paragraph." }] }, { type: "paragraph", content: [{ type: "text", text: "The launch date is October 20." }] }] } } });
    return { user, page };
  };
  // Answers checked against live ground truth (endoflife.date), fetched now so the checks stay right as releases come out.
  const releases = async (product: string) => (await (await fetch(`https://endoflife.date/api/${product}.json`, { signal: AbortSignal.timeout(20_000) })).json()) as Array<Record<string, string | boolean>>;
  const node = (await releases("nodejs")).find(row => row.lts && String(row.lts) <= new Date().toISOString().slice(0, 10))!;
  const python = await releases("python");
  const py314 = python.find(row => row.cycle === "3.14")!;
  type Result = Awaited<ReturnType<typeof runAssistantTurn>>;
  type Scenario = { name: string; message: string; expected?: string; page?: { path: string }; check?: (result: Result) => string[] };
  const used = (result: Result, name: string) => result.toolCalls.some(call => call.name === name);
  const asks = (text: string) => /\b(?:do you want me to|would you like me to|shall I|should I (?:go ahead|proceed)|want me to)\b/i.test(text);
  const scenarios: Scenario[] = [
    { name: "todo", message: "Create a todo called Review the launch brief.", expected: "hub_create_tasks" },
    { name: "dependent actions", message: "Create a person named Mira Chen with email mira@fieldnote.example and a project named Launch. Then create a todo called Review Launch linked to both the new person and new project. Do all three together.", expected: "hub_run_workflow" },
    { name: "tiles", message: "Add a Blocked tasks tile to my Board page. Keep all other tiles.", expected: "hub_edit_layout" },
    { name: "personal skill", message: "Create a personal skill called Concise summaries. Its instruction is: Write summaries as three concise bullets.", expected: "hub_manage_skill" },
    { name: "setting", message: "Change my app to light mode.", expected: "hub_update_settings" },
    { name: "precise edit", message: "On this page, replace only October 20 with October 22, keeping everything else.", expected: "hub_edit_page", page: { path: "/pages/:launch-brief" } },
    // Answer quality: facts that change, read from a source, with the link.
    {
      name: "node lts",
      message: "What is the latest LTS version of Node.js, and when does its support end? Cite the source.",
      check: result => [
        ...(new RegExp(`\\b(?:v|Node(?:\\.js)? )?${node.cycle}\\b`).test(result.content) ? [] : [`names Node ${node.cycle}`]),
        ...(result.content.includes(String(node.eol).slice(0, 4)) ? [] : [`end of support in ${String(node.eol).slice(0, 4)}`]),
        ...(/https?:\/\//.test(result.content) ? [] : ["a source link"]),
      ],
    },
    {
      name: "python latest",
      message: "What is the newest stable Python release right now (the full version number)? Include the link you got it from.",
      check: result => [...(result.content.includes(String(python[0]!.latest)) ? [] : [`says ${python[0]!.latest}`]), ...(/https?:\/\//.test(result.content) ? [] : ["a source link"])],
    },
    {
      name: "read link",
      message: "Read https://peps.python.org/pep-0745/ and tell me the planned release date of Python 3.14.0 final.",
      check: result => [...(used(result, "hub_read_web_page") ? [] : ["read the page"]), ...(/october\s+7|2025-10-07|7 october/i.test(result.content) ? [] : ["2025-10-07"])],
    },
    // Conduct: every part of the request done in this turn, nothing asked that was already asked for.
    {
      name: "two parts",
      message: "Add a todo called Renew passport, and also tell me what day of the week 2026-12-25 is.",
      expected: "hub_create_tasks",
      check: result => [...(/friday/i.test(result.content) ? [] : ["says Friday"]), ...(asks(result.content) ? ["asked permission"] : [])],
    },
    {
      name: "look up then act",
      message: "Look up the official release date of Python 3.14 on the web, then add a todo called Upgrade to Python 3.14 with that date in its notes. Don't ask me anything.",
      expected: "hub_create_tasks",
      check: result => {
        const notes = JSON.stringify(result.toolCalls.filter(call => call.name === "hub_create_tasks").map(call => call.input));
        return [...(notes.includes(String(py314.releaseDate)) || /october\s+7,?\s+2025|7 october 2025/i.test(notes) ? [] : [`notes carry ${py314.releaseDate}`]), ...(asks(result.content) ? ["asked permission"] : [])];
      },
    },
  ];
  const failures: string[] = [];
  const passes = new Map<string, number>();
  const selected = scenarios.filter(item => !process.env.ENSEMBLE_EVAL_SCENARIOS || process.env.ENSEMBLE_EVAL_SCENARIOS.split(",").includes(item.name));
  for (let round = 0; round < repeat; round += 1) {
   const { user, page } = await workspace();
   for (const scenario of selected) {
   try {
    const conversation = await harness.prisma.assistantConversation.create({ data: { userId: user.id } });
    const before = { calls, tokensIn, tokensOut };
    const result = await runAssistantTurn({ app: harness.app, userId: user.id, conversationId: conversation.id, message: scenario.message, page: scenario.page ? { path: scenario.page.path.replace(":launch-brief", page.id) } : { path: "/today" }, settings: { ...DEFAULT_SETTINGS, timezone: "Asia/Kolkata" }, model, provider: "openai", requestHeaders: { cookie: user.cookie }, emit() {}, ...(withoutTools.length ? { withoutTools } : {}) });
    const problems = scenario.check?.(result) ?? [];
    assert.equal(problems.length, 0, `${scenario.name}: missing ${problems.join("; ")}; tools ${result.toolCalls.map(call => call.name).join(", ") || "none"}; reply: ${result.content.slice(0, 600)}`);
    if (scenario.expected) {
      // The default write policy runs a write at once ("ok"); a stricter one holds it for Apply.
      assert.ok(result.toolCalls.some(call => call.name === scenario.expected && (call.state === "ok" || call.state === "awaiting_approval")), `${scenario.name}: expected ${scenario.expected}; got ${JSON.stringify(result.toolCalls).slice(0, 1500)}; ${result.content}`);
      const held = result.toolCalls.filter(call => call.state === "awaiting_approval");
      if (held.length) {
      await harness.prisma.assistantMessage.create({ data: { conversationId: conversation.id, userId: user.id, role: "assistant", content: result.content, toolCalls: held as never } });
      const applied = await user.inject({ method: "POST", url: "/api/assistant/apply", payload: { conversationId: conversation.id, calls: held.map(call => ({ name: call.name, input: call.input, callId: call.id })) } });
      assert.equal(applied.statusCode, 200, `${scenario.name}: ${applied.body}`); assert.equal(applied.json().partial, undefined, applied.body);
      }
    }
    passes.set(scenario.name, (passes.get(scenario.name) ?? 0) + 1);
    console.log(JSON.stringify({ scenario: scenario.name, round, passed: true, modelCalls: calls - before.calls, inputTokens: tokensIn - before.tokensIn, outputTokens: tokensOut - before.tokensOut, tools: result.toolCalls.map(call => call.name) }));
   } catch (error) { failures.push(scenario.name); console.log(JSON.stringify({ scenario: scenario.name, round, passed: false, error: error instanceof Error ? error.message : String(error) })); }
   }
  }
  const total = selected.length * repeat;
  console.log(JSON.stringify({ model, effort, repeat, without: withoutTools, passed: total - failures.length, of: total, byScenario: Object.fromEntries(selected.map(item => [item.name, `${passes.get(item.name) ?? 0}/${repeat}`])), calls, inputTokens: tokensIn, cachedInputTokens: cached, outputTokens: tokensOut }));
  assert.equal(failures.length, 0, `Failed scenarios: ${[...new Set(failures)].join(", ")}`);
} finally { setAskRuntimeStreamForTests(null); await harness.close(); }
