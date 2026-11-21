/**
 * The Markdown summary of a run (eval/node/results/<stamp>-<label>.md) and the totals behind it,
 * with the measures v2 is meant to move: turns that ended without a reply, error messages in the
 * chat, false claims and input tokens per task, per suite.
 */
import type { CleanupEntry, RunResult, Saved } from "./types.js";

/** A turn that failed because the agent ended without a reply or anything done (a turn that did work answers from its tool log); result files may hold the earlier wording. */
export const NO_ANSWER = /returned no answer|ended its turn without replying/i;

/** A result with its no-answer and error-message counts, read from its errors when an older file lacks them. */
export function withMetrics(result: RunResult): RunResult {
  const noAnswerTurns = result.metrics.noAnswerTurns ?? result.errors.filter((line) => /^turn of @/.test(line) && NO_ANSWER.test(line)).length;
  const errorMessages = result.metrics.errorMessages ?? result.errors.filter((line) => line.startsWith("error message in the chat:")).length;
  return { ...result, metrics: { ...result.metrics, noAnswerTurns, errorMessages } };
}

const pct = (value: number) => `${Math.round(value * 100)}%`;
const mean = (values: number[]) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
const seconds = (ms: number) => `${Math.round(ms / 1000)} s`;
const thousands = (value: number) => (value >= 10_000 ? `${Math.round(value / 1000)}k` : String(Math.round(value)));
/** A table cell: no pipes or line breaks. */
const cell = (text: string) => text.replace(/\|/g, "/").replace(/\s*\n\s*/g, " ").trim();

export type Totals = {
  runs: number;
  passed: number;
  verified: number;
  meanScore: number;
  falseClaims: number;
  turns: number;
  modelCalls: number;
  tokensIn: number;
  tokensOut: number;
  credits: number;
  ensembleTools: number;
  agentTools: number;
  approvals: number;
  unanswered: number;
  errors: number;
  noAnswerTurns: number;
  errorMessages: number;
  timeouts: number;
  wallMs: number;
};

export function totals(rows: RunResult[]): Totals {
  const results = rows.map(withMetrics);
  return {
    runs: results.length,
    passed: results.filter((row) => row.pass).length,
    verified: results.filter((row) => row.verifiedPass).length,
    meanScore: mean(results.map((row) => row.score)),
    falseClaims: sum(results.map((row) => row.falseClaims.length)),
    turns: sum(results.map((row) => row.metrics.turns)),
    modelCalls: sum(results.map((row) => row.metrics.modelCalls)),
    tokensIn: sum(results.map((row) => row.metrics.tokensIn)),
    tokensOut: sum(results.map((row) => row.metrics.tokensOut)),
    credits: sum(results.map((row) => row.metrics.credits)),
    ensembleTools: sum(results.map((row) => row.metrics.ensembleTools)),
    agentTools: sum(results.map((row) => row.metrics.agentTools)),
    approvals: sum(results.map((row) => row.metrics.approvals)),
    unanswered: sum(results.map((row) => row.metrics.unanswered)),
    errors: sum(results.map((row) => row.metrics.errors)),
    noAnswerTurns: sum(results.map((row) => row.metrics.noAnswerTurns ?? 0)),
    errorMessages: sum(results.map((row) => row.metrics.errorMessages ?? 0)),
    timeouts: results.filter((row) => row.status === "timeout").length,
    wallMs: sum(results.map((row) => row.metrics.wallMs)),
  };
}

function row(input: RunResult, repeats: number): string {
  const result = withMetrics(input);
  const m = result.metrics;
  const name = repeats > 1 ? `${result.task} #${result.repeat + 1}` : result.task;
  const status = result.status === "done" ? (result.pass ? "pass" : "fail") : result.status;
  return `| ${name} | ${result.suite} | ${status} | ${result.verifiedPass ? "yes" : "no"} | ${pct(result.score)} | ${result.falseClaims.length} | ${m.noAnswerTurns ?? 0} / ${m.errorMessages ?? 0} | ${m.turns} | ${m.modelCalls} | ${m.ensembleTools} | ${m.agentTools} | ${thousands(m.tokensIn)} / ${thousands(m.tokensOut)} | ${m.credits.toFixed(2)} | ${seconds(m.wallMs)} | ${m.approvals}${m.unanswered ? ` (${m.unanswered} unanswered)` : ""} | ${m.errors} |`;
}

const HEADER = [
  "| task | suite | result | verified | score | false claims | no answer / error msgs | turns | model calls | Ensemble tools | agent tools | tokens in / out | credits | time | approvals | errors |",
  "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
];

export function summaryTable(results: RunResult[], repeats = 1): string {
  const t = totals(results);
  const total = `| **total** | | **${t.passed}/${t.runs}** | ${t.verified}/${t.runs} | ${pct(t.meanScore)} | ${t.falseClaims} | ${t.noAnswerTurns} / ${t.errorMessages} | ${t.turns} | ${t.modelCalls} | ${t.ensembleTools} | ${t.agentTools} | ${thousands(t.tokensIn)} / ${thousands(t.tokensOut)} | ${t.credits.toFixed(2)} | ${seconds(t.wallMs)} | ${t.approvals}${t.unanswered ? ` (${t.unanswered} unanswered)` : ""} | ${t.errors} |`;
  return [...HEADER, ...results.map((result) => row(result, repeats)), total].join("\n");
}

const minutes = (ms: number) => `${(ms / 60_000).toFixed(1)} min`;
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** Per suite and overall: the measures v2 is meant to move. */
export function suiteTable(results: RunResult[]): string {
  const suites = [...new Set(results.map((result) => result.suite))];
  const line = (name: string, rows: RunResult[]) => {
    const t = totals(rows);
    return `| ${name} | ${t.runs} | ${t.passed} | ${t.verified} | ${pct(t.meanScore)} | ${t.noAnswerTurns} | ${t.errorMessages} | ${t.falseClaims} | ${thousands(t.runs ? t.tokensIn / t.runs : 0)} | ${t.approvals}${t.unanswered ? ` (${t.unanswered} unanswered)` : ""} | ${minutes(t.wallMs)} | ${(t.runs ? t.credits / t.runs : 0).toFixed(2)} |`;
  };
  return [
    "| suite | tasks | passed | verified | mean score | turns ended with no answer | error messages | false claims | input tokens per task | approvals | time | credits per task |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|",
    ...suites.map((suite) => line(suite, results.filter((result) => result.suite === suite))),
    ...(suites.length > 1 ? [line("**all**", results)] : []),
  ].join("\n");
}

function cleanupLines(entries: CleanupEntry[]): string[] {
  if (!entries.length) return ["No agent sessions were made."];
  const deleted = entries.filter((entry) => entry.deleted);
  const left = entries.filter((entry) => !entry.deleted);
  return [
    `${deleted.length} of ${entries.length} agent sessions deleted.`,
    "",
    "| agent | session | kind | task | deleted |",
    "|---|---|---|---|---|",
    ...entries.map((entry) => `| ${entry.agent} | \`${entry.id}\` | ${entry.kind} | ${entry.task ?? "run"} | ${entry.deleted ? "yes" : `no${entry.note ? `: ${cell(entry.note)}` : ""}`} |`),
    ...(left.length ? ["", `Left: ${left.map((entry) => `\`${entry.id}\``).join(", ")}.`] : []),
  ];
}

/** Every task that failed, claimed something false, hit an error or met a card the harness could not approve. */
function problemLines(results: RunResult[], repeats: number): string[] {
  const lines: string[] = [];
  const problems = results.filter((result) => !result.pass || result.falseClaims.length || result.errors.length || result.cards.some((card) => !card.answered || card.answer === "declined"));
  if (!problems.length) lines.push("None.");
  for (const result of problems) {
    const name = repeats > 1 ? `${result.task} #${result.repeat + 1}` : result.task;
    const failed = result.checks.filter((entry) => !entry.pass).map((entry) => `${entry.name}${entry.note ? ` (${cell(entry.note)})` : ""}`);
    lines.push(`- **${name}**${result.status !== "done" ? ` [${result.status}]` : ""}: ${failed.length ? failed.join("; ") : "all checks passed"}.`);
    for (const claim of result.falseClaims) lines.push(`  - False claim: ${claim}.`);
    for (const error of result.errors) lines.push(`  - Error: ${cell(error)}`);
    const unanswered = result.cards.filter((card) => !card.answered);
    if (unanswered.length) lines.push(`  - Cards not answered: ${unanswered.map((card) => `${card.type}${card.note ? ` (${cell(card.note)})` : ""}`).join(", ")}.`);
    const declined = result.cards.filter((card) => card.answered && card.answer === "declined");
    if (declined.length) lines.push(`  - Cards declined: ${declined.map((card) => `${card.type}${card.note ? ` (${cell(card.note)})` : ""}`).join(", ")}.`);
  }
  return lines;
}

/** What the columns mean, for every summary. */
export const COLUMNS =
  "Score is the share of a task's checks that passed; a task passes when all do. Verified: it passed and every check that looks at real evidence (a row, a file, a picture, a tool that ran) passed. No answer / error msgs: turns that failed because the agent ended without a reply, and error messages posted in the chat. Turns are Ensemble's node turns; model calls, tokens and credits are the agent's own, read from its session logs. Approvals are the owner cards the harness answered (or could not).";

/** Several saved runs side by side: their suites, then every task. */
export function summary(title: string, runs: Array<{ name: string; saved: Saved }>): string {
  const results = runs.flatMap((run) => run.saved.results);
  const unique = (values: string[]) => [...new Set(values)];
  const first = runs[0]!.saved;
  const repeats = Math.max(...runs.map((run) => run.saved.repeat));
  return `${[
    `# Ensemble Node eval: ${title}`,
    "",
    `Agent ${first.agent} · model ${first.model} · judge ${unique(runs.map((run) => run.saved.judgeModel)).join(", ")} · commits ${unique(runs.flatMap((run) => run.saved.commit.split(", "))).join(", ")} · repeat ${repeats}.`,
    "",
    COLUMNS,
    "",
    "## Suites",
    "",
    suiteTable(results),
    "",
    "## Tasks",
    "",
    summaryTable(results, repeats),
    "",
    "## Failed checks, false claims and errors",
    "",
    ...problemLines(results, repeats),
    "",
    "## Sources",
    "",
    ...runs.map((run) => `- [\`${run.name}.md\`](${run.name}.md): ${unique(run.saved.results.map((result) => result.suite)).join(", ")}, ${plural(run.saved.results.length, "task")}, ${run.saved.cleanup.filter((entry) => entry.deleted).length} of ${plural(run.saved.cleanup.length, "agent session")} deleted.`),
    "",
    "## Notes",
    "",
    ...unique(runs.flatMap((run) => run.saved.notes)).map((note) => `- ${note}`),
  ].join("\n")}\n`;
}

export function markdown(saved: Saved): string {
  const repeats = saved.repeat;
  const lines: string[] = [
    `# Ensemble Node eval: ${saved.label || saved.stamp}`,
    "",
    `Commit \`${saved.commit}\` · agent ${saved.agent} · model ${saved.model} · judge ${saved.judgeModel} · repeat ${repeats} · started ${saved.startedAt}${saved.finishedAt ? ` · finished ${saved.finishedAt}` : " · unfinished"}.`,
    "",
    COLUMNS,
    "",
    summaryTable(saved.results, repeats),
    "",
    "## Suite metrics",
    "",
    suiteTable(saved.results),
    "",
    "## Failed checks, false claims and errors",
    "",
    ...problemLines(saved.results, repeats),
  ];
  lines.push("", "## Cleanup receipt", "", ...cleanupLines(saved.cleanup));
  if (saved.notes.length) lines.push("", "## Notes", "", ...saved.notes.map((note) => `- ${note}`));
  return `${lines.join("\n")}\n`;
}
