/**
 * The core suite: one node (the Assistant template) in its owner's DM, on the owner's subscription.
 * Facts with sources, the owner's board (tasks, pages, memory, reminders, a meeting, a day plan),
 * work on the owner's computer (files, a coding fix, a screenshot) and short research.
 */
import { join } from "node:path";
import { check, has, mentionsDate, norm, numbersIn, okTool, urlsIn } from "../lib/grade.js";
import { getJson, nodeLts } from "../lib/truth.js";
import { localDay, seedCalendar, seedPage, seedTask, serveHtml, shareFolder, writeFiles } from "../lib/fixtures.js";
import type { Task } from "../lib/types.js";
import { assistant, dateIn, filesIn, hiddenTests, lastAnswer, linkStatus, meetingsAhead, newPages, newTasks, nodeTests, noChatter, readText, sha256, sharedFiles, spoken, timeIn, webLookup, type Shared } from "./helpers.js";

const factWithSource: Task = {
  id: "fact-with-source",
  suite: "core",
  category: "qa",
  title: "Node.js LTS line, its latest version and end of support, with a link (endoflife.date)",
  setup: assistant,
  steps: [{ say: "What is the newest Node.js LTS release line, its latest version number, and the date its support ends? Cite your source with a link." }],
  truth: async () => nodeLts(),
  checks: ({ ev, truth }) => {
    const text = lastAnswer(ev);
    return [
      check("names the LTS line", new RegExp(`\\b(v|node(\\.js)?\\s*)?${truth.major}\\b`, "i").test(text), "truth", { note: `expected ${truth.major}` }),
      check("latest version", has(text, truth.latest!), "truth", { note: `expected ${truth.latest}` }),
      check("end of support date", mentionsDate(text, truth.eol!), "truth", { note: `expected ${truth.eol}` }),
      check("cites a link", urlsIn(text).length > 0, "reply"),
      check("looked it up on the web", webLookup(ev), "trace", { evidence: true }),
    ];
  },
};

const todoAndMemory: Task = {
  id: "todo-and-memory",
  suite: "core",
  category: "board",
  title: "Adds a todo and remembers a preference, then recalls both in the next message",
  setup: assistant,
  steps: [{ say: "Add a todo called Draft the Q4 plan, and remember that I prefer short answers." }, { say: "What did I ask you to remember a moment ago, and which todo did you add?" }],
  checks: ({ ev }) => {
    const recall = ev.answers[1] ?? "";
    return [
      check("the todo exists", newTasks(ev).some((task) => /q4 plan/i.test(task.title)), "state", { evidence: true }),
      check("the preference is a memory", ev.memories.some((row) => /short/i.test(row.content)), "state", { evidence: true }),
      check("recalls the preference", /short/i.test(recall), "reply"),
      check("recalls the todo", /q4 plan/i.test(recall), "reply"),
    ];
  },
};

const lookupThenWrite: Task = {
  id: "lookup-then-write",
  suite: "core",
  category: "research",
  title: "Finds Python 3.14's release date on the web and writes it into a todo's notes without asking",
  setup: async (ctx) => {
    await assistant(ctx);
    ctx.data.todo = await seedTask(ctx, { title: "Draft the Q4 plan" });
  },
  steps: [{ say: "Find the official release date of Python 3.14 on the web and put it in the notes of my todo Draft the Q4 plan. Don't ask me anything." }],
  truth: async () => {
    const row = ((await getJson("https://endoflife.date/api/python.json")) as Array<{ cycle: string; releaseDate: string }>).find((cycle) => cycle.cycle === "3.14");
    if (!row) throw new Error("endoflife.date lists no Python 3.14");
    return { date: row.releaseDate };
  },
  checks: ({ ev, truth, data }) => {
    const todo = ev.tasks.find((task) => task.id === data.todo);
    const page = ev.pages.find((row) => row.taskId === data.todo);
    const written = `${todo?.notes ?? ""}\n${todo?.description ?? ""}\n${page?.text ?? ""}`;
    const answer = lastAnswer(ev).trim();
    return [
      check("the todo's notes carry the date", mentionsDate(written, truth.date!), "state", { evidence: true, note: `expected ${truth.date}` }),
      check("looked it up on the web", webLookup(ev), "trace", { evidence: true }),
      check("asked nothing", !answer.endsWith("?") && !ev.cards.some((card) => /question/.test(card.type)), "reply"),
      check("no second todo", ev.tasks.filter((task) => /q4 plan/i.test(task.title)).length === 1, "state"),
    ];
  },
};

const multiPartTasks: Task = {
  id: "multi-part-tasks",
  suite: "core",
  category: "board",
  title: "Creates three dated tasks and a page that lists them",
  setup: async (ctx) => {
    await assistant(ctx);
    const zone = ctx.world.timeZone;
    ctx.data.dates = { venue: localDay(zone, 7).date, invitations: localDay(zone, 10).date, catering: localDay(zone, 14).date };
  },
  steps: [
    {
      say: (ctx) => {
        const dates = ctx.data.dates as Record<string, string>;
        const zone = ctx.world.timeZone;
        return `Create three tasks for the launch: Book the venue, due ${spoken(dates.venue!, zone)}; Send the invitations, due ${spoken(dates.invitations!, zone)}; and Order the catering, due ${spoken(dates.catering!, zone)}. Then make a page called Launch checklist that lists all three with their due dates.`;
      },
    },
  ],
  checks: ({ ev, data }) => {
    const dates = data.dates as Record<string, string>;
    const zone = (data.timeZone as string) ?? "UTC";
    const find = (word: RegExp) => newTasks(ev).find((task) => word.test(task.title));
    const due = (word: RegExp, date: string) => {
      const task = find(word);
      return Boolean(task?.due && (dateIn(task.due, zone) === date || task.due.slice(0, 10) === date));
    };
    const page = newPages(ev).find((row) => /launch checklist/i.test(row.title));
    const listed = page ? ["venue", "invitation", "catering"].every((word) => norm(page.text).includes(word)) : false;
    const dated = page ? Object.values(dates).filter((date) => mentionsDate(page.text, date) || norm(page.text).includes(norm(spoken(date, zone)).split(" ").slice(1).join(" "))).length : 0;
    return [
      check("three tasks", Boolean(find(/venue/i) && find(/invitation/i) && find(/catering/i)), "state", { evidence: true }),
      check("venue due date", due(/venue/i, dates.venue!), "state", { evidence: true, note: `expected ${dates.venue}` }),
      check("invitations due date", due(/invitation/i, dates.invitations!), "state", { evidence: true, note: `expected ${dates.invitations}` }),
      check("catering due date", due(/catering/i, dates.catering!), "state", { evidence: true, note: `expected ${dates.catering}` }),
      check("the Launch checklist page", Boolean(page), "state", { evidence: true }),
      check("the page lists the three with dates", listed && dated === 3, "state", { note: page ? `${dated} of 3 dates` : "no page" }),
    ];
  },
};

const MEETING = [
  "# Product sync",
  "Attendees: Mira Chen, Theo Park, Sam Ortiz",
  "## Decisions",
  "- The annual plan gets a 15% discount.",
  "- The release moves to the first Thursday of next month.",
  "## Action items",
  "- Theo: update the pricing page with the annual discount by Friday.",
  "- Sam: fix the CSV export bug before the release.",
  "- Mira: draft the onboarding email for new teams.",
  "## Notes",
  "Support tickets about exports doubled this month. The onboarding email has not changed since spring.",
];

const meetingToTasks: Task = {
  id: "meeting-to-tasks",
  suite: "core",
  category: "board",
  title: "Turns a meeting note page into tasks for its action items and a summary page",
  setup: async (ctx) => {
    await assistant(ctx);
    ctx.data.meeting = await seedPage(ctx, "Product sync", MEETING);
  },
  steps: [{ say: "Turn my meeting note Product sync into tasks, one per action item, and a short summary page of the meeting." }],
  checks: ({ ev }) => {
    const made = newTasks(ev);
    const item = (word: RegExp) => made.some((task) => word.test(`${task.title} ${task.notes} ${task.description}`));
    const summary = newPages(ev).find((page) => /sync|summary|meeting/i.test(page.title) || /15\s?%/.test(page.text));
    const text = summary ? norm(summary.text) : "";
    return [
      check("a task for the pricing page", item(/pricing/i), "state", { evidence: true }),
      check("a task for the CSV export bug", item(/export/i), "state", { evidence: true }),
      check("a task for the onboarding email", item(/onboarding/i), "state", { evidence: true }),
      check("no more than the action items", made.length >= 3 && made.length <= 5, "state", { note: `${made.length} tasks` }),
      check("a summary page", Boolean(summary), "state", { evidence: true }),
      check("the summary has the decisions", /15\s?%/.test(text) && /(release|thursday)/.test(text), "state"),
    ];
  },
};

const planMyDay: Task = {
  id: "plan-my-day",
  suite: "core",
  category: "board",
  title: "Plans the rest of today around the owner's meetings and tasks, naming the overdue task",
  setup: async (ctx) => {
    await assistant(ctx);
    const zone = ctx.world.timeZone;
    const meetings = meetingsAhead(zone);
    await seedTask(ctx, { title: "Renew the company domain", due: localDay(zone, -1).at("17:00") });
    await seedTask(ctx, { title: "Review the Q4 budget", due: localDay(zone).at("23:30") });
    await seedTask(ctx, { title: "Prepare the board deck", due: localDay(zone, 5).at("17:00") });
    await seedCalendar(ctx, meetings);
    ctx.data.meetings = meetings.map((row) => `${row.title} ${row.at}`);
  },
  steps: [{ say: "Plan my day for today." }],
  checks: async ({ ev, judge, data }) => {
    const text = lastAnswer(ev);
    const meetings = [/standup/i, /design review/i, /theo/i].filter((word) => word.test(text)).length;
    const verdict = await judge(
      `A good answer is a plan for the rest of today in time order that fits work around the three meetings (${(data.meetings as string[]).join(", ")}), puts the overdue task (Renew the company domain, due yesterday) early and says it is overdue, includes the task due today (Review the Q4 budget), and invents no meetings or tasks. Score 1 for all of that, 0.5 if one part is missing, 0 if it is not a plan of today.`,
      text,
    );
    return [
      check("names the overdue task", /domain/i.test(text), "reply"),
      check("names today's task", /budget/i.test(text), "reply"),
      check("names today's meetings", meetings >= 2, "reply", { note: `${meetings} of 3` }),
      check("read the board and the calendar", okTool(ev, /^hub_(list_tasks|list_due|get_task|search_work|search_context)$/) && okTool(ev, /^(hub_list_events|calendar_list_events|outlook_calendar_list_events)$/), "trace", { evidence: true }),
      check("judge ≥ 0.6", verdict.score >= 0.6, "judge", { note: `${verdict.score}: ${verdict.reason}` }),
    ];
  },
};

const LARGEST = { "photo.raw": 480_000, "nested/archive.bin": 250_000, "log-2026.txt": 92_000, "config.json": 4_000, "notes.txt": 1_200, "nested/readme.md": 300 };

const computerLargestFiles: Task = {
  id: "computer-largest-files",
  suite: "core",
  category: "computer",
  title: "Writes a Markdown report of a folder's 3 largest files on the computer and shares it in the chat",
  setup: async (ctx) => {
    await assistant(ctx);
    const folder = join(ctx.dir, "data");
    writeFiles(folder, LARGEST);
    ctx.data.folder = folder;
  },
  steps: [{ say: (ctx) => `Make a Markdown report of the 3 largest files in ${ctx.data.folder as string} on my computer, subfolders included: name and size in bytes, largest first. Save it as largest-files.md in that folder and share the file with me here.` }],
  collect: async (ctx, ev) => {
    const named = filesIn(ctx.dir).find((name) => /largest-files\.md$/i.test(name));
    const elsewhere = named ? null : filesIn(join(ctx.world.dirs.computer, "workspace")).find((name) => /largest-files\.md$/i.test(name));
    return {
      report: named ? readText(join(ctx.dir, named), 4000) : null,
      reportPath: named ?? (elsewhere ? `the node's own folder: ${elsewhere}` : null),
      shared: await sharedFiles(ctx, ev),
    };
  },
  checks: ({ ev }) => {
    const report = (ev.extra.report as string | null) ?? "";
    const order = ["photo.raw", "archive.bin", "log-2026.txt"].map((name) => norm(report).indexOf(name));
    const shared = (ev.extra.shared as Shared[]) ?? [];
    const sharedReport = shared.find((file) => file.text && /photo\.raw/.test(file.text));
    return [
      check("the report file is in that folder", Boolean(report), "state", { evidence: true, note: (ev.extra.reportPath as string | null) ?? "not found" }),
      check("it names the 3 largest in order", order.every((at) => at >= 0) && order[0]! < order[1]! && order[1]! < order[2]!, "state"),
      check("it gives their sizes", [480_000, 250_000, 92_000].every((size) => numbersIn(report).includes(size)), "state"),
      check("a file reached the chat", shared.some((file) => !file.image), "state", { evidence: true }),
      check("the shared file is the report", Boolean(sharedReport), "state", { evidence: true }),
      noChatter(ev),
    ];
  },
};

const LISTS_JS = `/** The next line's prefix when Enter is pressed at the end of a Markdown list item, or null. */
export function continueList(line) {
  const ordered = /^(\\s*)(\\d)\\. (.*)$/.exec(line);
  if (ordered) return \`\${ordered[1]}\${Number(ordered[2]) + 1}. \`;
  const bullet = /^(\\s*)([-*]) (.*)$/.exec(line);
  if (bullet) return \`\${bullet[1]}- \`;
  return null;
}
`;

const LISTS_TEST = `import assert from "node:assert/strict";
import test from "node:test";
import { continueList } from "../src/lists.js";

test("a numbered item continues with the next number", () => {
  assert.equal(continueList("1. Buy milk"), "2. ");
});

test("a bullet continues with the same bullet", () => {
  assert.equal(continueList("- Buy milk"), "- ");
  assert.equal(continueList("* Buy milk"), "* ");
});

test("plain text is not a list", () => {
  assert.equal(continueList("Buy milk"), null);
});
`;

const LISTS_README = `# listfmt

\`continueList(line)\` gives the prefix of the next line when Enter is pressed at the end of a Markdown list item:

- A numbered item continues with the next number: \`9. a\` gives \`10. \`.
- A bullet continues with the same bullet character (\`-\` or \`*\`).
- Indentation is kept: \`  - a\` gives \`  - \`.
- An empty item ends the list: \`- \` or \`3. \` gives null.
- Anything else gives null.

Run the tests with \`npm test\`.
`;

const LISTS_HIDDEN = (module: string) => `import assert from "node:assert/strict";
import test from "node:test";
import { continueList } from ${JSON.stringify(module)};

test("numbers past 9", () => {
  assert.equal(continueList("9. a"), "10. ");
  assert.equal(continueList("10. a"), "11. ");
});
test("the same bullet", () => {
  assert.equal(continueList("* a"), "* ");
  assert.equal(continueList("- a"), "- ");
});
test("indentation kept", () => {
  assert.equal(continueList("  - a"), "  - ");
  assert.equal(continueList("    3. a"), "    4. ");
});
test("an empty item ends the list", () => {
  assert.equal(continueList("- "), null);
  assert.equal(continueList("3. "), null);
});
test("plain text", () => {
  assert.equal(continueList("hello"), null);
  assert.equal(continueList(""), null);
});
`;

const codingFixTests: Task = {
  id: "coding-fix-tests",
  suite: "core",
  category: "coding",
  title: "Fixes a bug in a small Node project so its tests and hidden tests pass, tests unchanged",
  setup: async (ctx) => {
    await assistant(ctx);
    const project = join(ctx.dir, "listfmt");
    writeFiles(project, {
      "package.json": JSON.stringify({ name: "listfmt", version: "1.0.0", type: "module", scripts: { test: "node --test" } }, null, 2),
      "src/lists.js": LISTS_JS,
      "test/lists.test.js": LISTS_TEST,
      "README.md": LISTS_README,
    });
    await shareFolder(ctx, "listfmt", project);
    ctx.data.project = project;
    ctx.data.testHash = sha256(join(project, "test/lists.test.js"));
  },
  steps: [{ say: (ctx) => `My listfmt project on my computer (the listfmt folder, ${ctx.data.project as string}) has failing tests. Fix the bug in src/lists.js so npm test passes and it behaves as the README says, without changing the tests, then tell me what was wrong.` }],
  collect: async (ctx) => {
    const project = ctx.data.project as string;
    return {
      visible: await nodeTests(project),
      hidden: await hiddenTests(ctx, "hidden.test.js", LISTS_HIDDEN(`file://${join(project, "src/lists.js")}`)),
      testHash: sha256(join(project, "test/lists.test.js")),
      source: readText(join(project, "src/lists.js"), 3000),
    };
  },
  checks: ({ ev, data }) => {
    const visible = ev.extra.visible as { pass: boolean; summary: string };
    const hidden = ev.extra.hidden as { pass: boolean; summary: string };
    const text = lastAnswer(ev);
    return [
      check("its tests pass", visible.pass, "state", { evidence: true, note: visible.summary }),
      check("the hidden tests pass", hidden.pass, "state", { evidence: true, note: hidden.summary }),
      check("the tests are unchanged", ev.extra.testHash === data.testHash, "state", { evidence: true }),
      check("says what was wrong", /(bullet|\*|asterisk|digit|number|regex|pattern)/i.test(text), "reply"),
    ];
  },
  claims: [{ says: /\b(all )?(the )?tests (now )?pass(ed|ing)?\b/i, backed: (ev) => Boolean((ev.extra.visible as { pass?: boolean } | undefined)?.pass), what: "says the tests pass, and they do not" }],
};

const STATUS_PAGE = `<!doctype html><html><head><title>Fieldnote status</title><style>
body{font:18px system-ui,sans-serif;margin:40px;background:#f7f5ef;color:#222}
h1{font-size:34px}.ok{display:inline-block;padding:6px 14px;border-radius:8px;background:#2e7d4f;color:#fff}
table{margin-top:24px;border-collapse:collapse}td{padding:8px 18px;border-bottom:1px solid #ccc}
</style></head><body><h1>Fieldnote status board</h1><p class="ok">All systems normal</p>
<table><tr><td>API</td><td>Up</td></tr><tr><td>Sync</td><td>Up</td></tr><tr><td>Exports</td><td>Slow</td></tr></table></body></html>`;

const webScreenshot: Task = {
  id: "web-screenshot",
  suite: "core",
  category: "browse",
  title: "Sends a screenshot of a page served on this computer",
  setup: async (ctx) => {
    await assistant(ctx);
    ctx.data.url = `${await serveHtml(ctx, { "/status": STATUS_PAGE })}/status`;
  },
  steps: [{ say: (ctx) => `Send me a screenshot of ${ctx.data.url as string}` }],
  collect: async (ctx, ev) => ({ shared: await sharedFiles(ctx, ev) }),
  checks: ({ ev }) => {
    const pictures = ((ev.extra.shared as Shared[]) ?? []).filter((file) => file.image);
    return [
      check("a picture reached the chat", pictures.length > 0, "state", { evidence: true }),
      check("it is a real screenshot", pictures.some((file) => (file.image?.width ?? 0) >= 300 && (file.image?.height ?? 0) >= 150), "state", { evidence: true, note: pictures.map((file) => `${file.image?.format} ${file.image?.width}x${file.image?.height}`).join(", ") }),
      check("used the computer's browser", okTool(ev, /^(browser_(view|screenshot|open)|capture_screenshot)$/), "trace", { evidence: true }),
      check("says what the page shows", /fieldnote|all systems normal|exports?\W+(are |is )?slow/i.test(ev.replies.join("\n")), "reply"),
    ];
  },
};

const researchWithSources: Task = {
  id: "research-with-sources",
  suite: "core",
  category: "research",
  title: "A short comparison with two cited sources (judge and link checks)",
  setup: assistant,
  steps: [{ say: "Briefly compare SQLite and PostgreSQL for a small team's internal web app: 4 to 6 bullet points, and cite at least two sources with links." }],
  checks: async ({ ev, judge }) => {
    const text = lastAnswer(ev);
    // Checked when grading, so a regrade looks again.
    const links: Array<{ url: string; status: number }> = [];
    for (const url of [...new Set(urlsIn(text))].slice(0, 8)) links.push({ url, status: await linkStatus(url) });
    const hosts = new Set(links.map((link) => new URL(link.url).hostname.replace(/^www\./, "")));
    const working = links.filter((link) => link.status >= 200 && link.status < 400);
    const verdict = await judge(
      "Score 0..1 for accuracy and usefulness. A good answer has 4 to 6 bullets that contrast the two for a small team's internal app: SQLite is an embedded file with no server and is simplest to run and back up; it allows one writer at a time, so heavy concurrent writes favour PostgreSQL; PostgreSQL is a client-server database with stronger concurrency, roles, extensions and scaling, at more operational cost; a sensible recommendation. Penalise invented facts or sources that do not fit the claim.",
      text,
    );
    return [
      check("4 to 6 bullets", (text.match(/^\s*([-*•]|\d+\.)\s/gm) ?? []).length >= 4, "reply"),
      check("two sources from different sites", hosts.size >= 2, "reply", { note: [...hosts].join(", ") }),
      check("the links open", working.length >= 2, "truth", { evidence: true, note: links.map((link) => `${link.status} ${link.url}`).join(" · ") }),
      check("looked it up on the web", webLookup(ev), "trace", { evidence: true }),
      check("judge ≥ 0.6", verdict.score >= 0.6, "judge", { note: `${verdict.score}: ${verdict.reason}` }),
    ];
  },
};

const announceVsAct: Task = {
  id: "announce-vs-act",
  suite: "core",
  category: "board",
  title: "\"Remind me tomorrow at 9\": a real reminder, routine or dated task, not only words",
  setup: async (ctx) => {
    await assistant(ctx);
    ctx.data.tomorrow = localDay(ctx.world.timeZone, 1).date;
  },
  steps: [{ say: "Remind me tomorrow at 9 to call the bank." }],
  checks: ({ ev, data }) => {
    const zone = (data.timeZone as string) ?? "UTC";
    const tomorrow = data.tomorrow as string;
    const at9 = (iso: string | null) => Boolean(iso && dateIn(iso, zone) === tomorrow && timeIn(iso, zone) === "09:00");
    const reminders = ev.routines.filter((row) => (row.kind === "reminder" ? row.when?.startsWith(`${tomorrow} 09:00`) : at9(row.when)));
    const tasks = newTasks(ev).filter((task) => at9(task.due) || at9(task.startsAt));
    const scheduled = [...reminders.map((row) => `${row.title} ${row.detail}`), ...tasks.map((task) => `${task.title} ${task.notes}`)];
    const anything = ev.routines.length > 0 || newTasks(ev).length > 0;
    return [
      check("something real was scheduled", anything, "state", { evidence: true }),
      check("for tomorrow at 9:00", scheduled.length > 0, "state", { evidence: true, note: [...ev.routines.map((row) => `${row.kind} ${row.when}`), ...newTasks(ev).map((task) => `task ${task.due ?? task.startsAt}`)].join("; ") || "nothing" }),
      check("about calling the bank", scheduled.some((text) => /bank/i.test(text)), "state"),
    ];
  },
};

export const CORE: Task[] = [factWithSource, todoAndMemory, lookupThenWrite, multiPartTasks, meetingToTasks, planMyDay, computerLargestFiles, codingFixTests, webScreenshot, researchWithSources, announceVsAct];

