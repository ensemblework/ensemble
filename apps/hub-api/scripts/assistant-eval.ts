/** Opt-in, real-model checks over synthetic in-memory workspaces. No production records are read. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
  const endpoint = process.env.ENSEMBLE_EVAL_URL ?? "https://api.openai.com/v1/responses";
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("Set OPENAI_API_KEY, or use --ssh with a configured Ensemble server.");
  const response = await fetch(endpoint, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(55_000) });
  return response.json();
}

setAskRuntimeStreamForTests(async args => {
  const payload = { ...buildResponsesPayload(model, itemsFromChat(args.messages as Record<string, unknown>[]), { tools: toolsFor((args.responsesTools ?? args.chatTools ?? []) as Record<string, unknown>[]), effort: "low" }), max_output_tokens: 4000 };
  const data = await request(payload);
  if (data.error) throw new Error(`Model evaluation failed: ${JSON.stringify(data.error).slice(0, 500)}`);
  calls++; tokensIn += data.usage?.input_tokens ?? 0; tokensOut += data.usage?.output_tokens ?? 0; cached += data.usage?.input_tokens_details?.cached_tokens ?? 0;
  const turn = turnFromResponse(data, model);
  if (turn.text) args.onDelta?.(String(turn.text));
  return { ...turn, model, credits: null, raw: data } as never;
});

try {
  const user = await harness.asUser();
  const page = await harness.prisma.taskPage.create({ data: { userId: user.id, title: "Launch brief", content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Keep the first paragraph." }] }, { type: "paragraph", content: [{ type: "text", text: "The launch date is October 20." }] }] } } });
  const scenarios = [
    { name: "todo", message: "Create a todo called Review the launch brief.", expected: "hub_create_tasks" },
    { name: "dependent actions", message: "Create a person named Mira Chen with email mira@fieldnote.example and a project named Launch. Then create a todo called Review Launch linked to both the new person and new project. Do all three together.", expected: "hub_run_workflow" },
    { name: "tiles", message: "Add a Blocked tasks tile to my Board page. Keep all other tiles.", expected: "hub_edit_layout" },
    { name: "personal skill", message: "Create a personal skill called Concise summaries. Its instruction is: Write summaries as three concise bullets.", expected: "hub_manage_skill" },
    { name: "setting", message: "Change my app to light mode.", expected: "hub_update_settings" },
    { name: "precise edit", message: "On this page, replace only October 20 with October 22, keeping everything else.", expected: "hub_edit_page", page: { path: `/pages/${page.id}` } },
  ];
  const failures: string[] = [];
  const selected = scenarios.filter(item => !process.env.ENSEMBLE_EVAL_SCENARIOS || process.env.ENSEMBLE_EVAL_SCENARIOS.split(",").includes(item.name));
  for (const scenario of selected) {
   try {
    const conversation = await harness.prisma.assistantConversation.create({ data: { userId: user.id } });
    const before = { calls, tokensIn, tokensOut };
    const result = await runAssistantTurn({ app: harness.app, userId: user.id, conversationId: conversation.id, message: scenario.message, page: scenario.page ?? { path: "/today" }, settings: { ...DEFAULT_SETTINGS, timezone: "Asia/Kolkata" }, model, provider: "openai", requestHeaders: { cookie: user.cookie }, emit() {} });
    assert.ok(result.toolCalls.some(call => call.name === scenario.expected && call.state === "awaiting_approval"), `${scenario.name}: expected ${scenario.expected}; got ${JSON.stringify(result.toolCalls)}; ${result.content}`);
    const held = result.toolCalls.filter(call => call.state === "awaiting_approval");
    await harness.prisma.assistantMessage.create({ data: { conversationId: conversation.id, userId: user.id, role: "assistant", content: result.content, toolCalls: held as never } });
    const applied = await user.inject({ method: "POST", url: "/api/assistant/apply", payload: { conversationId: conversation.id, calls: held.map(call => ({ name: call.name, input: call.input, callId: call.id })) } });
    assert.equal(applied.statusCode, 200, `${scenario.name}: ${applied.body}`); assert.equal(applied.json().partial, undefined, applied.body);
    console.log(JSON.stringify({ scenario: scenario.name, passed: true, modelCalls: calls - before.calls, inputTokens: tokensIn - before.tokensIn, outputTokens: tokensOut - before.tokensOut, tools: result.toolCalls.map(call => call.name) }));
   } catch (error) { failures.push(scenario.name); console.log(JSON.stringify({ scenario: scenario.name, passed: false, error: error instanceof Error ? error.message : String(error) })); }
  }
  console.log(JSON.stringify({ model, passed: selected.length - failures.length, failures, calls, inputTokens: tokensIn, cachedInputTokens: cached, outputTokens: tokensOut }));
  assert.equal(failures.length, 0, `Failed scenarios: ${failures.join(", ")}`);
} finally { setAskRuntimeStreamForTests(null); await harness.close(); }
