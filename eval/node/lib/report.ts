/**
 * The Markdown summary of a run (eval/node/results/<stamp>-<label>.md) and the totals behind it.
 */
import type { CleanupEntry, RunResult, Saved } from "./types.js";

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
  timeouts: number;
  wallMs: number;
};

export function totals(results: RunResult[]): Totals {
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
    timeouts: results.filter((row) => row.status === "timeout").length,
    wallMs: sum(results.map((row) => row.metrics.wallMs)),
  };
}

function row(result: RunResult, repeats: number): string {
  const m = result.metrics;
  const name = repeats > 1 ? `${result.task} #${result.repeat + 1}` : result.task;
  const status = result.status === "done" ? (result.pass ? "pass" : "fail") : result.status;
  return `| ${name} | ${result.suite} | ${status} | ${result.verifiedPass ? "yes" : "no"} | ${pct(result.score)} | ${result.falseClaims.length} | ${m.turns} | ${m.modelCalls} | ${m.ensembleTools} | ${m.agentTools} | ${thousands(m.tokensIn)} / ${thousands(m.tokensOut)} | ${m.credits.toFixed(2)} | ${seconds(m.wallMs)} | ${m.approvals}${m.unanswered ? ` (${m.unanswered} unanswered)` : ""} | ${m.errors} |`;
}

const HEADER = [
  "| task | suite | result | verified | score | false claims | turns | model calls | Ensemble tools | agent tools | tokens in / out | credits | time | approvals | errors |",
  "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
];

export function summaryTable(results: RunResult[], repeats = 1): string {
  const t = totals(results);
  const total = `| **total** | | **${t.passed}/${t.runs}** | ${t.verified}/${t.runs} | ${pct(t.meanScore)} | ${t.falseClaims} | ${t.turns} | ${t.modelCalls} | ${t.ensembleTools} | ${t.agentTools} | ${thousands(t.tokensIn)} / ${thousands(t.tokensOut)} | ${t.credits.toFixed(2)} | ${seconds(t.wallMs)} | ${t.approvals}${t.unanswered ? ` (${t.unanswered} unanswered)` : ""} | ${t.errors} |`;
  return [...HEADER, ...results.map((result) => row(result, repeats)), total].join("\n");
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

export function markdown(saved: Saved): string {
  const repeats = saved.repeat;
  const lines: string[] = [
    `# Ensemble Node eval: ${saved.label || saved.stamp}`,
    "",
    `Commit \`${saved.commit}\` · agent ${saved.agent} · model ${saved.model} · judge ${saved.judgeModel} · repeat ${repeats} · started ${saved.startedAt}${saved.finishedAt ? ` · finished ${saved.finishedAt}` : " · unfinished"}.`,
    "",
    "Score is the share of a task's checks that passed; a task passes when all do. Verified: it passed and every check that looks at real evidence (a row, a file, a picture, a tool that ran) passed. Turns are Ensemble's node turns; model calls, tokens and credits are the agent's own, read from its session logs. Approvals are the owner cards the harness answered (or could not).",
    "",
    summaryTable(saved.results, repeats),
    "",
    "## Failed checks, false claims and errors",
    "",
  ];
  const problems = saved.results.filter((result) => !result.pass || result.falseClaims.length || result.errors.length);
  if (!problems.length) lines.push("None.");
  for (const result of problems) {
    const name = repeats > 1 ? `${result.task} #${result.repeat + 1}` : result.task;
    const failed = result.checks.filter((entry) => !entry.pass).map((entry) => `${entry.name}${entry.note ? ` (${cell(entry.note)})` : ""}`);
    lines.push(`- **${name}**${result.status !== "done" ? ` [${result.status}]` : ""}: ${failed.length ? failed.join("; ") : "all checks passed"}.`);
    for (const claim of result.falseClaims) lines.push(`  - False claim: ${claim}.`);
    for (const error of result.errors) lines.push(`  - Error: ${cell(error)}`);
    const unanswered = result.cards.filter((card) => !card.answered);
    if (unanswered.length) lines.push(`  - Cards not answered: ${unanswered.map((card) => `${card.type}${card.note ? ` (${cell(card.note)})` : ""}`).join(", ")}.`);
  }
  lines.push("", "## Cleanup receipt", "", ...cleanupLines(saved.cleanup));
  if (saved.notes.length) lines.push("", "## Notes", "", ...saved.notes.map((note) => `- ${note}`));
  return `${lines.join("\n")}\n`;
}
