/**
 * The hard suite: what Ensemble Node v2 changes. Work that needs many reads or a shell (an index of
 * 45 files, which projects fail their tests), memory and history beyond what a turn is shown (a
 * preference among 60 memories, a decision in a three-month-old meeting), a day plan that must lead
 * with overdue work, the desktop (an app, a screenshot, a recording) on the agent's own screen, a file
 * delivered without claiming more than arrived, and a request changed or replaced while it runs.
 * One node made from the Assistant template, in its owner's DM, on the owner's subscription.
 */
import { join } from "node:path";
import { check, falseClaims, mentionsDate, near, norm, numbersIn } from "../lib/grade.js";
import { localDay, seedCalendar, seedPage, seedTask, writeFiles } from "../lib/fixtures.js";
import { docText } from "../lib/evidence.js";
import type { Task, TaskContext } from "../lib/types.js";
import { assistant, dateIn, firstToolCall, indexEntries, lastAnswer, meetingsAhead, newPages, newTasks, nonIncreasing, sharedFiles, type Shared } from "./helpers.js";

const MINUTES = 60_000;

/** The text of the files that reached the chat (not pictures or videos), joined. */
const sharedText = (shared: Shared[]) => shared.filter((file) => file.text).map((file) => file.text!).join("\n\n");

/**
 * Desktop tasks run only where the harness keeps them off the owner's screen: Linux, with no display
 * and no Wayland socket in reach (lib/world.ts). Anything that needs a screen has to bring its own.
 */
function screenless(ctx: TaskContext): void {
  if (process.platform !== "linux") throw new Error("Desktop tasks run only on Linux, where the eval can keep them off the owner's screen.");
  if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY || !process.env.XDG_RUNTIME_DIR?.startsWith(ctx.world.dirs.root)) throw new Error("The eval process can reach a display: desktop tasks are not run.");
}

// ── many-files-index ───────────────────────────────────────────────────────────────────────

const ADJECTIVES = ["Amber", "Birch", "Cobalt", "Dune", "Ember", "Fjord", "Garnet", "Harbor", "Indigo"];
const NOUNS = ["ledger", "outline", "sketch", "review", "roadmap"];
const AREAS = ["product", "ops", "research"];
const SHELVES = ["spring", "summer", "drafts"];
const CHORES = ["check the figures", "ask Priya for the export", "update the screenshots", "confirm the owner", "fix the broken link", "rename the section", "add the missing chart", "trim the intro"];

/** 45 notes in 9 folders: a title as the first heading (an H2 in a few, after front matter in a few) and 0 to 7 TODO markers each. */
export const NOTES = ADJECTIVES.flatMap((adjective, a) =>
  NOUNS.map((noun, n) => {
    const i = a * NOUNS.length + n;
    const title = `${adjective} ${noun}`;
    const todos = (i * 5 + 3) % 8;
    const lines = [
      ...(i % 9 === 4 ? ["---", "tags: [draft]", "---", ""] : []),
      `${i % 11 === 6 ? "##" : "#"} ${title}`,
      "",
      `Notes on the ${noun} for the ${AREAS[i % 3]} team.`,
      "",
      ...Array.from({ length: 2 + (i % 3) }, (_, k) => `- Done: ${CHORES[(i + k) % CHORES.length]}`),
      ...Array.from({ length: todos }, (_, k) => `- TODO: ${CHORES[(i * 3 + k) % CHORES.length]}`),
      "",
      "## Next",
      "",
      "Look at it again next week.",
      "",
    ];
    return { path: `${AREAS[i % 3]}/${SHELVES[Math.floor(i / 3) % 3]}/${adjective.toLowerCase()}-${noun}.md`, title, todos, body: lines.join("\n") };
  }),
);

const manyFilesIndex: Task = {
  id: "many-files-index",
  suite: "hard",
  category: "computer",
  title: "An index page of 45 Markdown files in nested folders: each title and its TODO count, most first",
  timeoutMs: 15 * MINUTES,
  setup: async (ctx) => {
    await assistant(ctx);
    const folder = join(ctx.dir, "notes");
    writeFiles(folder, Object.fromEntries(NOTES.map((note) => [note.path, note.body])));
    ctx.data.folder = folder;
  },
  steps: [{ say: (ctx) => `In the notes folder on my computer (${ctx.data.folder as string}) there are Markdown files in subfolders. Make an index page in my Ensemble called Notes index: each file's title (its first heading) and how many TODO markers it has, sorted by TODO count, most first.` }],
  collect: async (ctx) => {
    const pages = await ctx.world.prisma.taskPage.findMany({ where: { userId: ctx.owner.id, taskId: null, deletedAt: null }, orderBy: { createdAt: "desc" }, select: { title: true, content: true } });
    const page = pages.find((row) => /index/i.test(row.title)) ?? pages.find((row) => indexEntries(row.content ? docText(row.content) : "", NOTES.map((note) => note.title)).length >= 10) ?? null;
    return { page: page?.title ?? null, entries: page?.content ? indexEntries(docText(page.content), NOTES.map((note) => note.title)) : [] };
  },
  checks: ({ ev }) => {
    const entries = (ev.extra.entries as Array<{ title: string; count: number | null }>) ?? [];
    const truth = new Map(NOTES.map((note) => [note.title, note.todos]));
    const right = entries.filter((entry) => entry.count === truth.get(entry.title));
    const counts = entries.map((entry) => entry.count).filter((count): count is number => count !== null);
    return [
      check("the index page exists", Boolean(ev.extra.page), "state", { evidence: true, note: (ev.extra.page as string | null) ?? "none" }),
      check("every file is listed by its title", entries.length === NOTES.length, "state", { evidence: true, note: `${entries.length} of ${NOTES.length}` }),
      check("every count listed is right", entries.length >= 40 && right.length === entries.length, "state", { evidence: true, note: `${right.length} of ${entries.length} right` }),
      check("sorted by TODO count, most first", entries.length >= 40 && counts.length === entries.length && nonIncreasing(counts), "state", { note: counts.join(" ") }),
    ];
  },
};

// ── failing-projects ───────────────────────────────────────────────────────────────────────

const PKG = (name: string) => JSON.stringify({ name, version: "1.0.0", type: "module", scripts: { test: "node --test" } }, null, 2);
const TEST = (module: string, imports: string, tests: string) => `import assert from "node:assert/strict";\nimport test from "node:test";\nimport { ${imports} } from "../src/${module}.js";\n\n${tests}`;

const PROJECTS: Record<string, Record<string, string>> = {
  "cart-totals": {
    "package.json": PKG("cart-totals"),
    "src/cart.js": "export function lineTotal(item) {\n  return Math.round(item.price * item.quantity * 100) / 100;\n}\n\nexport function cartTotal(items, discountPercent = 0) {\n  const sum = items.reduce((total, item) => total + lineTotal(item), 0);\n  return Math.round(sum * (1 - discountPercent / 100) * 100) / 100;\n}\n",
    "test/cart.test.js": TEST("cart", "cartTotal, lineTotal", 'test("adds up line totals", () => {\n  assert.equal(cartTotal([{ price: 2.5, quantity: 2 }, { price: 1, quantity: 3 }]), 8);\n});\n\ntest("applies a percentage discount", () => {\n  assert.equal(cartTotal([{ price: 10, quantity: 2 }], 10), 18);\n  assert.equal(lineTotal({ price: 0.1, quantity: 3 }), 0.3);\n});\n'),
  },
  "mail-subjects": {
    "package.json": PKG("mail-subjects"),
    "src/subject.js": 'export function shortSubject(subject) {\n  return subject.length <= 40 ? subject : subject.slice(0, 40) + "...";\n}\n',
    "test/subject.test.js": TEST("subject", "shortSubject", 'test("keeps short subjects as they are", () => {\n  assert.equal(shortSubject("Lunch on Friday?"), "Lunch on Friday?");\n});\n\ntest("cuts long subjects at 40 characters with an ellipsis", () => {\n  const long = "Quarterly planning notes for the platform team and the ops team";\n  assert.equal(shortSubject(long), long.slice(0, 39) + "\\u2026");\n  assert.equal(shortSubject(long).length, 40);\n});\n'),
  },
  "invoice-numbers": {
    "package.json": PKG("invoice-numbers"),
    "src/invoice.js": 'export function invoiceNumber(n) {\n  if (!Number.isInteger(n) || n < 0) throw new RangeError("Invoice numbers are whole numbers from 0.");\n  return "INV-" + String(n).padStart(6, "0");\n}\n',
    "test/invoice.test.js": TEST("invoice", "invoiceNumber", 'test("pads invoice numbers to six digits", () => {\n  assert.equal(invoiceNumber(42), "INV-000042");\n});\n\ntest("rejects negative numbers", () => {\n  assert.throws(() => invoiceNumber(-1), RangeError);\n});\n'),
  },
  "search-ranking": {
    "package.json": PKG("search-ranking"),
    "src/rank.js": "export function rank(items, query) {\n  const q = query.trim().toLowerCase();\n  if (!q) return [];\n  return items.filter((item) => item.title.toLowerCase().includes(q)).sort((a, b) => a.title.localeCompare(b.title));\n}\n",
    "test/rank.test.js": TEST("rank", "rank", 'const items = [{ title: "A plan for Q4" }, { title: "Plan" }, { title: "Planning notes" }, { title: "Café menu" }];\n\ntest("returns nothing for an empty query", () => {\n  assert.deepEqual(rank(items, "  "), []);\n});\n\ntest("ranks exact title matches first", () => {\n  assert.equal(rank(items, "plan")[0].title, "Plan");\n});\n\ntest("ignores accents when matching", () => {\n  assert.deepEqual(rank(items, "cafe").map((item) => item.title), ["Café menu"]);\n});\n'),
  },
};
const FAILING = { projects: ["mail-subjects", "search-ranking"], tests: ["cuts long subjects at 40 characters", "ranks exact title matches first", "ignores accents when matching"] };
const PASSING = ["cart-totals", "invoice-numbers"];

const failingProjects: Task = {
  id: "failing-projects",
  suite: "hard",
  category: "computer",
  title: "Which of 4 small projects fail their tests: a report file with the failing test names, in the chat",
  timeoutMs: 15 * MINUTES,
  setup: async (ctx) => {
    await assistant(ctx);
    const folder = join(ctx.dir, "projects");
    for (const [name, files] of Object.entries(PROJECTS)) writeFiles(join(folder, name), files);
    ctx.data.folder = folder;
  },
  steps: [{ say: (ctx) => `In ${ctx.data.folder as string} on my computer there are a few small projects. Find which of them fail their tests, and write me a short report file in Markdown with the failing test names. Send the file here.` }],
  collect: async (ctx, ev) => ({ shared: await sharedFiles(ctx, ev) }),
  checks: ({ ev }) => {
    const shared = (ev.extra.shared as Shared[]) ?? [];
    const report = sharedText(shared);
    const text = norm(report);
    const lines = report.split("\n").map(norm);
    const blamed = PASSING.filter((name) => lines.some((line) => line.includes(name) && /fail|✖|✗|broken|error/.test(line) && !/pass|✔|✓|\bok\b|green|no fail/.test(line)));
    return [
      check("a report file reached the chat", shared.some((file) => !file.image && !file.video && file.text), "state", { evidence: true }),
      check("it names both failing projects", FAILING.projects.every((name) => text.includes(name)), "state", { evidence: true, note: FAILING.projects.filter((name) => !text.includes(name)).join(", ") || "both" }),
      check("it names every failing test", FAILING.tests.every((name) => text.includes(name)), "state", { evidence: true, note: `${FAILING.tests.filter((name) => text.includes(name)).length} of ${FAILING.tests.length}` }),
      check("no passing project is called failing", blamed.length === 0, "state", { note: blamed.join(", ") || "none" }),
    ];
  },
};

// ── memory-old-preference ──────────────────────────────────────────────────────────────────

const PREFERENCE = "I prefer aisle seats on flights, and I fly Akasa Air whenever they have the route.";
/** 60 memories, oldest first; the travel preference is the 10th oldest, so the newest 40 leave it out. */
export const MEMORIES = [
  "I take my coffee black, no sugar.",
  "Keep meeting invites to 30 minutes unless I say otherwise.",
  "I prefer replies in short bullet points.",
  "My manager is Priya Nair.",
  "Our team standup is at 9:30 on weekdays.",
  "I work from the Pune office on Tuesdays and Thursdays.",
  "Use British spelling in documents.",
  "I am vegetarian.",
  "Remind me about invoices on the first working day of the month.",
  PREFERENCE,
  "My daughter's school pickup is at 3:15 pm.",
  "I like hotels with a gym and a quiet room away from the lift.",
  "Book taxis through the office account.",
  "I use a MacBook at work and Linux at home.",
  "Draft emails for me but never send them without asking.",
  "I prefer Google Meet over Zoom.",
  "I am allergic to peanuts.",
  "The weekly review is on Friday afternoons.",
  "My partner's name is Arjun.",
  "Use 24-hour time.",
  "I run on Sunday mornings, so keep Sunday mornings free.",
  "Our fiscal year starts in April.",
  "Send expense reports to the finance team's shared inbox.",
  "I like green or jasmine tea in the afternoon.",
  "Keep the board deck to 12 slides.",
  "Do not schedule anything during lunch, 1 to 2 pm.",
  "I prefer paper notebooks for brainstorming.",
  "My dentist is Dr. Mehta; I go every six months.",
  "Use INR for budgets unless the client is abroad.",
  "My hotel loyalty programme is Taj InnerCircle.",
  "Keep my Slack status updated when I travel.",
  "I learn Spanish on weekday evenings.",
  "Our biggest client is Northwind.",
  "I call my mother on Sunday evenings.",
  "Use dark mode screenshots in docs.",
  "I take the train for trips under 500 km.",
  "Pack a laptop stand when I travel for more than two days.",
  "Name files with the date first, YYYY-MM-DD.",
  "My favourite food is from Kerala.",
  "Keep a 15-minute buffer between meetings.",
  "Share agendas a day before meetings.",
  "My gym is open until 10 pm.",
  "We use Notion only for the hiring wiki.",
  "I am in the Asia/Kolkata time zone.",
  "My car goes in for service on the 5th of each month.",
  "Give me the news summary only on Mondays.",
  "Use the Fieldnote letterhead for client letters.",
  "I prefer phone calls to voice notes.",
  "I like podcasts about history.",
  "Quarterly planning happens in the last week of each quarter.",
  "My laptop charger is a 96 W USB-C one.",
  "Contracts go in the shared drive.",
  "My US visa is valid until 2028.",
  "I tip 10 percent at restaurants.",
  "I use a standing desk in the afternoons.",
  "Bring up hiring updates on Wednesdays.",
  "Colour my calendar: blue for clients, green for internal work.",
  "Our CFO is Daniel Okafor.",
  "When I travel, I like an early check-in at hotels.",
  "Book restaurants for 7:30 pm unless I say otherwise.",
];
if (MEMORIES.length !== 60 || MEMORIES.indexOf(PREFERENCE) !== 9) throw new Error("memory-old-preference needs 60 memories with the preference 10th oldest.");

const memoryOldPreference: Task = {
  id: "memory-old-preference",
  suite: "hard",
  category: "memory",
  title: "A travel preference among the oldest of 60 node memories (a turn is shown the newest 40)",
  setup: async (ctx) => {
    await assistant(ctx);
    const node = ctx.nodes.assistant!;
    const made: string[] = [];
    for (const content of MEMORIES) made.push((await ctx.api<{ memory: { id: string } }>("POST", `/api/node/nodes/${node.id}/memory`, { content })).memory.id);
    // One a day, oldest first, ending yesterday.
    for (const [index, id] of made.entries()) await ctx.world.prisma.nodeMemory.update({ where: { id }, data: { createdAt: new Date(Date.now() - (MEMORIES.length - index) * 86_400_000) } });
    ctx.data.memories = made.length;
  },
  steps: [{ say: "Which seat and airline should you pick for my Delhi trip next week? Just tell me." }],
  checks: ({ ev }) => {
    const text = lastAnswer(ev);
    return [
      check("names the aisle seat", /\baisle\b/i.test(text), "reply"),
      check("names Akasa Air", /akasa/i.test(text), "reply"),
      check("answers without asking back", Boolean(text.trim()) && !text.trim().endsWith("?") && !/\b(send me|tell me|let me know|could you|can you (share|send|tell)|please (share|send)|i('d| would) need)\b/i.test(text), "reply"),
    ];
  },
};

// ── old-decision-recall ────────────────────────────────────────────────────────────────────

type Meeting = { daysAgo: number; series: string; attendees: string; notes: string[]; decisions: string[]; actions: string[] };

const DECISION_DAYS = 84;
/** 25 meeting notes over three months, newest first; the ledger decision is in the third oldest, after two that lead up to it. */
export const MEETINGS: Meeting[] = [
  { daysAgo: 5, series: "Release planning", attendees: "Mira, Ravi, Theo", notes: ["Release 4.2 is on track for the 28th.", "The export fix needs one more review."], decisions: ["Ship 4.2 without the new onboarding flow."], actions: ["Theo writes the release notes."] },
  { daysAgo: 9, series: "Hiring sync", attendees: "Mira, Priya", notes: ["Two backend candidates in the final round."], decisions: ["Make an offer to the second candidate if references are good."], actions: ["Priya checks references."] },
  { daysAgo: 12, series: "Customer feedback review", attendees: "Mira, Ana, Theo", notes: ["Customers ask for CSV export of reports.", "Search feels slow on large boards."], decisions: ["Put CSV export on the Q1 roadmap."], actions: ["Ana groups the feedback by theme."] },
  { daysAgo: 16, series: "Ledger UI review", attendees: "Mira, Ana", notes: ["The ledger screen shows balance where users expect the amount they can spend."], decisions: ["Rename balance to available balance on the ledger screen."], actions: ["Ana updates the copy."] },
  { daysAgo: 19, series: "Ops review", attendees: "Ravi, Kofi", notes: ["Two pages in October, both from the backup job."], decisions: ["Move the backup job to 03:00."], actions: ["Kofi changes the schedule."] },
  { daysAgo: 23, series: "Platform sync", attendees: "Mira, Ravi, Kofi", notes: ["The API gateway upgrade is done.", "Rate limits need a dashboard."], decisions: ["Build the rate limit dashboard in Grafana."], actions: ["Ravi sets up the panels."] },
  { daysAgo: 26, series: "Release planning", attendees: "Mira, Theo", notes: ["4.1 shipped with two small regressions."], decisions: ["Add a smoke test for the export path."], actions: ["Theo adds the test."] },
  { daysAgo: 30, series: "Hiring sync", attendees: "Mira, Priya", notes: ["The design role has 40 applicants."], decisions: ["Use a take-home task for the design role."], actions: ["Priya writes the task."] },
  { daysAgo: 34, series: "Analytics sync", attendees: "Ravi, Ana", notes: ["The event store grew 30 percent last month.", "Queries on old events are slow."], decisions: ["Keep MongoDB for the event store and revisit sharding in Q1."], actions: ["Ravi measures the slow queries."] },
  { daysAgo: 37, series: "Customer feedback review", attendees: "Mira, Ana", notes: ["Mobile users want offline notes."], decisions: ["Research offline notes before promising anything."], actions: ["Ana talks to five mobile users."] },
  { daysAgo: 41, series: "Platform sync", attendees: "Mira, Ravi", notes: ["Staging is often out of date."], decisions: ["Deploy main to staging every night."], actions: ["Ravi adds the nightly job."] },
  { daysAgo: 44, series: "Release planning", attendees: "Mira, Theo, Ana", notes: ["4.1 scope is frozen."], decisions: ["Move the calendar sync to 4.2."], actions: ["Theo updates the board."] },
  { daysAgo: 48, series: "Ops review", attendees: "Ravi, Kofi", notes: ["The billing database is on Postgres 15."], decisions: ["Upgrade the billing database to Postgres 17 in January."], actions: ["Kofi plans the upgrade window."] },
  { daysAgo: 51, series: "Hiring sync", attendees: "Mira, Priya", notes: ["The backend role opened."], decisions: ["Post the backend role on two job boards."], actions: ["Priya posts the role."] },
  { daysAgo: 55, series: "Customer feedback review", attendees: "Mira, Ana", notes: ["Teams want templates for retros."], decisions: ["Ship two retro templates."], actions: ["Ana drafts them."] },
  { daysAgo: 58, series: "Platform sync", attendees: "Mira, Ravi, Kofi", notes: ["The search index rebuild takes four hours."], decisions: ["Rebuild the search index incrementally."], actions: ["Kofi prototypes it."] },
  { daysAgo: 62, series: "Release planning", attendees: "Mira, Theo", notes: ["4.0 had a smooth launch."], decisions: ["Keep the two-week release rhythm."], actions: ["Theo books the next planning slot."] },
  { daysAgo: 66, series: "Ops review", attendees: "Ravi, Kofi", notes: ["On-call handover is unclear."], decisions: ["Write an on-call handover checklist."], actions: ["Kofi writes it."] },
  { daysAgo: 69, series: "Ops review", attendees: "Ravi, Kofi", notes: ["Disk alerts were noisy."], decisions: ["Raise the disk alert threshold to 85 percent."], actions: ["Kofi changes the alert."] },
  { daysAgo: 73, series: "Hiring sync", attendees: "Mira, Priya", notes: ["Onboarding takes two weeks."], decisions: ["Write a one-page onboarding guide."], actions: ["Priya drafts it."] },
  { daysAgo: 76, series: "Customer feedback review", attendees: "Mira, Ana", notes: ["Users love the board view."], decisions: ["Make the board view the default for new spaces."], actions: ["Ana tells the design team."] },
  { daysAgo: 80, series: "Release planning", attendees: "Mira, Theo", notes: ["The 4.0 scope is set."], decisions: ["Ship 4.0 before the conference."], actions: ["Theo plans the launch post."] },
  {
    daysAgo: DECISION_DAYS,
    series: "Architecture review",
    attendees: "Mira, Ravi, Kofi, Ana",
    notes: ["Ravi compared Postgres and MongoDB for the new ledger service.", "A transfer updates several account balances at once.", "Mongo was faster to prototype; Postgres won on correctness."],
    decisions: [
      "We chose Postgres over MongoDB for the ledger, because every transfer must update several balances in one transaction and constraints have to stop a ledger that does not balance. The team also already runs Postgres in production.",
      "MongoDB stays for the analytics event store.",
    ],
    actions: ["Ravi drafts the ledger schema with double-entry tables."],
  },
  { daysAgo: 88, series: "Platform sync", attendees: "Mira, Ravi", notes: ["The ledger service prototype ran on SQLite for the demo, which was fine for one user."], decisions: ["Hold the ledger storage choice for the architecture review."], actions: ["Ravi writes up the ledger requirements."] },
  { daysAgo: 92, series: "Platform sync", attendees: "Mira, Ravi, Kofi", notes: ["The ledger service needs a database before the pilot."], decisions: ["Ravi compares Postgres and MongoDB for the ledger before the architecture review."], actions: ["Ravi brings numbers to the review."] },
];

const oldDecisionRecall: Task = {
  id: "old-decision-recall",
  suite: "hard",
  category: "memory",
  title: "Why the ledger uses Postgres: a decision in one of 25 meeting pages, three months back",
  setup: async (ctx) => {
    await assistant(ctx);
    const zone = ctx.world.timeZone;
    for (const meeting of MEETINGS) {
      const day = localDay(zone, -meeting.daysAgo);
      const id = await seedPage(ctx, `${meeting.series} · ${day.date}`, [
        `# ${meeting.series}`,
        `Date: ${day.date}. Attendees: ${meeting.attendees}.`,
        "## Notes",
        ...meeting.notes.map((line) => `- ${line}`),
        "## Decisions",
        ...meeting.decisions.map((line) => `- ${line}`),
        "## Action items",
        ...meeting.actions.map((line) => `- ${line}`),
      ]);
      const at = day.at("11:00");
      await ctx.world.prisma.$executeRaw`UPDATE task_pages SET created_at = ${at}, updated_at = ${at} WHERE id = ${id}`;
    }
    ctx.data.decided = localDay(zone, -DECISION_DAYS).date;
  },
  steps: [{ say: "What did we decide about the ledger database, and why?" }],
  checks: async ({ ev, judge, data }) => {
    const text = lastAnswer(ev);
    const decided = data.decided as string;
    const source = ev.pages.find((page) => page.seeded && /^architecture review/i.test(page.title))?.id ?? "none";
    const verdict = await judge(
      `The truth, from the Architecture review on ${decided}: the team chose Postgres over MongoDB for the ledger, because every transfer must update several balances in one transaction and constraints have to stop a ledger that does not balance, and the team already runs Postgres in production; MongoDB stays for the analytics event store (a different system). Score 1 if the answer gives that decision and those reasons and invents nothing; 0.5 if the decision is right but the reasons are thin or partly wrong; 0 if the decision is wrong, missing or hedged.`,
      text,
    );
    return [
      check("Postgres is the choice", /postgres/i.test(text) && !/\b(chose|picked|went with|decided on|settled on)\s+(mongo|mongodb|sqlite)\b/i.test(text), "reply"),
      check("the reason: transactions", /transaction|acid|atomic/i.test(text), "reply"),
      check("the reason: balances and constraints", /constraint|balanc|double.entry|integrity/i.test(text), "reply"),
      check("says when it was decided", mentionsDate(text, decided) || /architecture review/i.test(text), "reply", { note: decided }),
      check("read the meeting that decided it", ev.tools.some((call) => call.ok && call.input.includes(source)), "trace", { evidence: true }),
      check("judge ≥ 0.6", verdict.score >= 0.6, "judge", { note: `${verdict.score}: ${verdict.reason}` }),
    ];
  },
};

// ── overdue-in-plan ────────────────────────────────────────────────────────────────────────

const overdueInPlan: Task = {
  id: "overdue-in-plan",
  suite: "hard",
  category: "board",
  title: "A plan for today that leads with both overdue tasks, before the task due today",
  setup: async (ctx) => {
    await assistant(ctx);
    const zone = ctx.world.timeZone;
    const meetings = meetingsAhead(zone);
    await seedTask(ctx, { title: "Send the signed contract to Northwind", due: localDay(zone, -3).at("17:00") });
    await seedTask(ctx, { title: "Pay the cloud hosting invoice", due: localDay(zone, -1).at("12:00") });
    await seedTask(ctx, { title: "Review the Q4 budget", due: localDay(zone).at("23:30") });
    await seedTask(ctx, { title: "Prepare the board deck", due: localDay(zone, 5).at("17:00") });
    await seedCalendar(ctx, meetings);
    ctx.data.meetings = meetings.map((row) => `${row.title} ${row.at}`);
  },
  steps: [{ say: "Plan my day for today." }],
  checks: ({ ev }) => {
    const text = lastAnswer(ev);
    const at = (pattern: RegExp) => text.search(pattern);
    const contract = at(/northwind/i);
    const invoice = at(/invoice/i);
    const budget = at(/budget/i);
    return [
      check("names the overdue Northwind contract", contract >= 0, "reply"),
      check("names the overdue cloud invoice", invoice >= 0, "reply"),
      check("both overdue tasks come before today's task", contract >= 0 && invoice >= 0 && budget >= 0 && contract < budget && invoice < budget, "reply"),
      check("calls them overdue", contract >= 0 && invoice >= 0 && /overdue|past due|missed/i.test(text), "reply"),
      check("names today's task", budget >= 0, "reply"),
    ];
  },
};

// ── the desktop ────────────────────────────────────────────────────────────────────────────

const desktopCalculator: Task = {
  id: "desktop-calculator",
  suite: "hard",
  category: "desktop",
  title: "Opens the Calculator app, works out 7 × 6, says the result and sends a screenshot of it",
  setup: async (ctx) => {
    screenless(ctx);
    await assistant(ctx);
  },
  steps: [{ say: "Open the Calculator app on my computer, compute 7 times 6, tell me the result and send me a screenshot of the calculator." }],
  collect: async (ctx, ev) => ({ shared: await sharedFiles(ctx, ev) }),
  checks: ({ ev }) => {
    const pictures = ((ev.extra.shared as Shared[]) ?? []).filter((file) => file.image);
    return [
      check("says 42", /\b42\b/.test(lastAnswer(ev)), "reply"),
      check("a screenshot reached the chat", pictures.length > 0, "state", { evidence: true }),
      check("it is a real screenshot", pictures.some((file) => (file.image?.width ?? 0) >= 200 && (file.image?.height ?? 0) >= 200), "state", { evidence: true, note: pictures.map((file) => `${file.image?.format} ${file.image?.width}x${file.image?.height}`).join(", ") || "none" }),
    ];
  },
};

const desktopRecording: Task = {
  id: "desktop-recording",
  suite: "hard",
  category: "desktop",
  title: "Records a short video of the Calculator app working out 12 + 30 and sends it",
  setup: async (ctx) => {
    screenless(ctx);
    await assistant(ctx);
  },
  steps: [{ say: "Record a short video of the Calculator app computing 12 plus 30 and send it here." }],
  collect: async (ctx, ev) => ({ shared: await sharedFiles(ctx, ev) }),
  checks: ({ ev }) => {
    const videos = ((ev.extra.shared as Shared[]) ?? []).filter((file) => file.video || file.kind === "video");
    const longest = Math.max(0, ...videos.map((file) => file.video?.durationMs ?? 0));
    return [
      check("a video reached the chat", videos.length > 0, "state", { evidence: true, note: videos.map((file) => `${file.name} ${file.video?.format ?? file.mime}`).join(", ") || "none" }),
      check("it lasts at least 2 seconds", longest >= 2000, "state", { evidence: true, note: videos.length ? `${longest} ms` : "no video" }),
    ];
  },
};

// ── delivery-truth ─────────────────────────────────────────────────────────────────────────

const TRIAL_REPORT = `# Fieldnote clinic pilot: field trial report

## Summary of the trial

From 1 September to 15 November, Fieldnote ran its offline notes app in three clinics: Pune, Nagpur and Nashik. Nurses used it on shared tablets during home visits and synced when they were back on the clinic Wi-Fi. The pilot logged 412 patient visits across the three clinics, of which 168 were in Pune, 139 in Nagpur and 105 in Nashik.

## How the app performed

The median time for a tablet to sync after returning to the clinic was 38 seconds. The slowest syncs, up to four minutes, happened in Nashik, where the clinic Wi-Fi drops several times a day. No notes were lost. Battery life on the tablets lasted a full shift in every clinic.

Nurses rated the app 4.3 out of 5 on average. The most liked feature was the visit template, which cut the time to write up a visit from about nine minutes to about five. The least liked was the photo upload, which nurses found slow and confusing.

## Incidents

There were 2 incidents during the pilot. First, a duplicated patient record in Nagpur on 22 September, caused by two tablets editing the same visit offline; it was merged by hand the same day. Second, a sync outage of three hours on 14 October, caused by an expired certificate on the sync server. Neither incident harmed a patient.

## Costs

The pilot spent 18.5 lakh rupees of its 22 lakh budget: tablets were 9 lakh, training 4 lakh, support 3.5 lakh and the sync server 2 lakh. The unspent 3.5 lakh is held for the next phase.

## What the clinics asked for

Clinic leads asked for three things: a simpler photo upload, a warning when two tablets edit the same visit, and printed visit summaries for patients without phones. Nashik also asked for a way to queue syncs until the Wi-Fi is stable.

## Recommendation

The team recommends expanding to 10 clinics in March, after fixing the photo upload and adding the edit warning. The certificate expiry should be monitored from now on. A second review is planned for June.
`;
const TRIAL_FACTS: Array<[string, RegExp]> = [
  ["412 visits", /\b412\b/],
  ["38-second median sync", /\b38\s*(s|sec|second)/i],
  ["Nagpur", /nagpur/i],
  ["10 clinics in March", /\b(10|ten) clinics\b/i],
  ["2 incidents", /\b(2|two) incidents\b/i],
  ["18.5 lakh spent", /18\.5/],
];

const deliveryTruth: Task = {
  id: "delivery-truth",
  suite: "hard",
  category: "computer",
  title: "A one-page Markdown summary of a document, sent as a file, claiming nothing that did not arrive",
  setup: async (ctx) => {
    await assistant(ctx);
    const path = join(ctx.dir, "docs", "field-trial-report.md");
    writeFiles(join(ctx.dir, "docs"), { "field-trial-report.md": TRIAL_REPORT });
    ctx.data.path = path;
  },
  steps: [{ say: (ctx) => `Write a one-page summary of ${ctx.data.path as string} as a Markdown file and send the file here.` }],
  collect: async (ctx, ev) => ({ shared: await sharedFiles(ctx, ev) }),
  checks: ({ ev }) => {
    const shared = (ev.extra.shared as Shared[]) ?? [];
    const files = shared.filter((file) => !file.image && !file.video && file.text && (/\.(md|markdown|txt)$/i.test(file.name ?? "") || /markdown|text\/plain/.test(file.mime ?? "")));
    const text = sharedText(files);
    const facts = TRIAL_FACTS.filter(([, pattern]) => pattern.test(text));
    const words = text.split(/\s+/).filter(Boolean).length;
    const claims = falseClaims(ev);
    return [
      check("a Markdown file reached the chat", files.length > 0, "state", { evidence: true, note: shared.map((file) => file.name).join(", ") || "none" }),
      check("it has the key facts", facts.length >= 4, "state", { evidence: true, note: `${facts.length} of ${TRIAL_FACTS.length}: ${facts.map(([name]) => name).join(", ")}` }),
      check("it is about a page", words >= 80 && words <= 700, "state", { note: `${words} words` }),
      check("claims only what reached the chat", claims.length === 0, "trace", { note: claims.join("; ") || "none" }),
    ];
  },
};

// ── interrupting a request ─────────────────────────────────────────────────────────────────

const MOONS: Record<string, { km: number; days: number }> = {
  Io: { km: 3643, days: 1.769 },
  Europa: { km: 3122, days: 3.551 },
  Ganymede: { km: 5268, days: 7.155 },
  Callisto: { km: 4821, days: 16.689 },
};

const interruptAmend: Task = {
  id: "interrupt-amend",
  suite: "hard",
  category: "interrupt",
  title: "\"Wait, also include…\" after the first tool call of a longer request: the result has both",
  setup: assistant,
  steps: [
    { say: "Make me a page called Jupiter moons that compares the four largest moons of Jupiter: each one's diameter in km and its orbital period in days, from the web.", wait: "none" },
    { before: { what: "the first tool call", until: firstToolCall, timeoutMs: 4 * MINUTES }, say: "Wait, also include who discovered each moon and in which year." },
  ],
  checks: ({ ev }) => {
    const pages = newPages(ev).filter((page) => /jupiter/i.test(page.title));
    const page = pages.at(-1);
    const lines = (page?.text ?? "").split("\n");
    // The line about a moon with the most numbers on it: its table row, not a sentence that names it.
    const lineOf = (moon: string) => lines.filter((line) => new RegExp(`\\b${moon}\\b`, "i").test(line)).sort((a, b) => numbersIn(b).length - numbersIn(a).length)[0] ?? "";
    const diameters = Object.entries(MOONS).filter(([moon, truth]) => near(numbersIn(lineOf(moon)), truth.km, 0.02));
    const periods = Object.entries(MOONS).filter(([moon, truth]) => near(numbersIn(lineOf(moon)), truth.days, 0.02));
    return [
      check("the Jupiter moons page exists", Boolean(page), "state", { evidence: true }),
      check("it has the four moons", Object.keys(MOONS).every((moon) => lineOf(moon)), "state", { evidence: true }),
      check("diameters are right", diameters.length === 4, "state", { evidence: true, note: `${diameters.length} of 4` }),
      check("orbital periods are right", periods.length === 4, "state", { evidence: true, note: `${periods.length} of 4` }),
      check("the amendment is in: discoverer and year", /galile/i.test(page?.text ?? "") && /\b1610\b/.test(page?.text ?? ""), "state", { evidence: true }),
      check("one page, not two", pages.length === 1, "state", { note: `${pages.length} page(s)` }),
    ];
  },
};

const CITIES = [/s[aã]o paulo/i, /rio de janeiro/i, /bras[ií]lia/i, /salvador/i, /fortaleza/i];

const interruptReplace: Task = {
  id: "interrupt-replace",
  suite: "hard",
  category: "interrupt",
  title: "\"Forget that, instead…\" after the first tool call: the new request is done, the first is not passed off as done",
  setup: async (ctx) => {
    await assistant(ctx);
    // "Next Friday": the coming one, or the one a week after it.
    const fridays: string[] = [];
    for (let day = 1; fridays.length < 2 && day <= 14; day += 1) {
      const date = localDay(ctx.world.timeZone, day).date;
      if (new Date(`${date}T12:00:00Z`).getUTCDay() === 5) fridays.push(date);
    }
    ctx.data.fridays = fridays;
  },
  steps: [
    { say: "Find the current population of the five largest cities in Brazil on the web and make me a page called Brazil cities with a table.", wait: "none" },
    { before: { what: "the first tool call", until: firstToolCall, timeoutMs: 4 * MINUTES }, say: "Forget that. Instead, add a todo called Renew my passport, due next Friday." },
  ],
  checks: ({ ev, data }) => {
    const zone = (data.timeZone as string) ?? "UTC";
    const fridays = (data.fridays as string[]) ?? [];
    const todo = newTasks(ev).find((task) => /renew my passport/i.test(task.title));
    const brazil = newPages(ev).filter((page) => /brazil/i.test(page.title));
    const after = ev.answers.slice(1).join("\n\n");
    const sentences = after.split(/(?<=[.!?\n])\s+/);
    const passedOff = sentences.some((sentence) => /brazil|cities/i.test(sentence) && /\b(created|made|added|ready|done|finished|here('s| is))\b/i.test(sentence) && !/\b(not|didn't|did not|won't|stopped|dropped|cancel|instead of|skipp)/i.test(sentence));
    const listed = CITIES.filter((city) => city.test(after)).length;
    return [
      check("the passport todo exists", Boolean(todo), "state", { evidence: true }),
      check("it is due next Friday", Boolean(todo?.due && fridays.includes(dateIn(todo.due, zone) ?? "")), "state", { evidence: true, note: `${todo?.due ? dateIn(todo.due, zone) : "no due date"}; next Friday is ${fridays.join(" or ")}` }),
      check("the Brazil page was dropped", brazil.length === 0, "state", { evidence: true, note: brazil.map((page) => page.title).join(", ") || "none made" }),
      check("the first request is not passed off as done", !passedOff && listed < 3, "reply", { note: listed >= 3 ? `${listed} cities listed` : passedOff ? "says the Brazil page is done" : "no" }),
    ];
  },
};

// overdue-in-plan runs first: its meetings must still fit in the rest of the day.
export const HARD: Task[] = [overdueInPlan, manyFilesIndex, failingProjects, memoryOldPreference, oldDecisionRecall, desktopCalculator, desktopRecording, deliveryTruth, interruptAmend, interruptReplace];
