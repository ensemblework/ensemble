/**
 * The orchestration suite: what a node and a crew do around the work itself. A member given a role and
 * no task, a plain question, two members writing the same file, a peer's message while a card waits,
 * the computer restarting or losing its line mid-write or being offline, no client watching, what is
 * left after a crew run, switching the agent's settings, a child run in the background, and a run that
 * finishes without its acceptance check passing (Grok Bot study 14 §8, Cursor study 08, DESIGN §7-8).
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { asserts, check, norm } from "../lib/grade.js";
import { seedTask, shareFolder, writeFiles } from "../lib/fixtures.js";
import { codingSessions, copilotSessionsIn, turnSessions } from "../lib/sessions.js";
import type { Task, TaskContext } from "../lib/types.js";
import { LIVE_JOB, type Owner } from "../lib/world.js";
import { assistant, changingCalls, codingRunningFor, dateIn, filesIn, lastAnswer, linesOf, madeWork, modelCalls, newTasks, nodeSaid, othersSaid, readText, waitingCard, waitingCardIds } from "./helpers.js";

const ORCH_MS = 12 * 60_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const PACKAGE = JSON.stringify({ name: "fixture", version: "1.0.0", type: "module", private: true }, null, 2);

/** A folder of the task's own, with these files, shared with Ensemble under `label`. */
async function sharedFolder(ctx: TaskContext, label: string, files: Record<string, string>): Promise<string> {
  const path = join(ctx.dir, label);
  writeFiles(path, files);
  await shareFolder(ctx, label, path);
  return path;
}

/** The node turns of the owner that have not ended. */
const liveTurns = (ctx: TaskContext) => ctx.world.prisma.nodeTurn.count({ where: { userId: ctx.owner.id, status: { in: ["queued", "running"] } } });

/** Words that tell the owner a step may or may not have happened, or was cut off, rather than that it simply worked. */
const HONEST = /(may (have|already)|might (have|already)|not sure|unclear|uncertain|interrupt|restart|disconnect|lost (the )?connection|connection (was )?lost|went offline|cut off|check(ed)? (whether|if|the ledger)|already (there|recorded|ran)|was recorded|is recorded|entry (is|was) (there|recorded|in))/i;

// 1 · A member given a role and no task.

const roleWithoutTask: Task = {
  id: "role-without-task",
  suite: "orch",
  category: "orchestration",
  title: "A designer added to a crew and welcomed, with no task: a short hello, no invented work",
  timeoutMs: ORCH_MS,
  setup: async (ctx) => {
    await ctx.makeNode("lead", "manager");
    await ctx.makeNode("builder", "developer");
    await ctx.makeCrew("crew", "Launch crew", ["lead", "builder"], "lead");
    await ctx.makeNode("designer", "designer", { slug: "designer" });
    ctx.data.project = await sharedFolder(ctx, "site", { "README.md": "# Fieldnote site\n\nThe launch site for Fieldnote.\n", "index.html": "<!doctype html><title>Fieldnote</title><h1>Fieldnote</h1>\n" });
    ctx.data.files = filesIn(ctx.data.project as string);
  },
  steps: [
    {
      act: {
        what: "add @designer to the crew",
        run: async (ctx) => {
          await ctx.api("POST", `/api/node/rooms/${ctx.rooms.crew}/nodes`, { nodeId: ctx.nodes.designer!.id });
          return "added";
        },
      },
    },
    { room: "crew", say: (ctx) => `@${ctx.nodes.designer!.slug} welcome to the crew! You're our designer for the Fieldnote site launch.`, holdMs: 30_000 },
  ],
  collect: async (ctx) => ({ files: filesIn(ctx.data.project as string), siteChanged: readText(join(ctx.data.project as string, "index.html")) !== "<!doctype html><title>Fieldnote</title><h1>Fieldnote</h1>\n" }),
  checks: ({ ev, data }) => {
    const made = madeWork(ev);
    const files = (ev.extra.files as string[]) ?? [];
    const before = (data.files as string[]) ?? [];
    const newFiles = files.filter((file) => !before.includes(file));
    const changes = changingCalls(ev, { memory: false });
    const designer = nodeSaid(ev, "designer").filter((row) => row.kind === "text" && !row.type);
    const words = designer.map((row) => row.body).join("\n");
    return [
      check("no work invented: no task, page, plan, run, routine or file", made.length === 0 && newFiles.length === 0 && ev.extra.siteChanged !== true, "state", { evidence: true, note: [...made, ...newFiles.map((file) => `file ${file}`)].join(", ") || "none" }),
      check("no tool call that changes anything", changes.length === 0, "trace", { evidence: true, note: changes.join(", ") || "none" }),
      check("the designer answered with a short hello (at most 700 characters)", designer.length > 0 && words.length <= 700, "reply", { note: `${designer.length} message(s), ${words.length} characters` }),
    ];
  },
};

// 2 · A plain question in a node chat.

const plainChat: Task = {
  id: "plain-chat-vs-node",
  suite: "orch",
  category: "orchestration",
  title: "Two plain questions in a node's chat: direct answers in order, no tool that changes anything",
  timeoutMs: ORCH_MS,
  setup: assistant,
  steps: [
    { say: "Quick question, no need to look anything up: in one or two sentences, what is the difference between a process and a thread?" },
    { say: "And which of the two is usually cheaper to create?" },
  ],
  checks: ({ ev }) => {
    const [first = "", second = ""] = ev.answers;
    const changes = changingCalls(ev);
    const made = madeWork(ev);
    return [
      check("the first answer explains the difference", /(memory|address space)/i.test(first) && /(share|own|separate|independent)/i.test(first), "reply", { note: norm(first).slice(0, 160) }),
      check("the second answer follows from the first: a thread", /\bthreads?\b[^.]{0,80}\b(cheaper|lighter|less expensive|faster to (create|start)|less overhead)|(cheaper|lighter|less expensive|less overhead)[^.]{0,60}\bthreads?\b/i.test(second), "reply", { note: norm(second).slice(0, 160) }),
      check("no tool beyond reads", changes.length === 0, "trace", { evidence: true, note: changes.join(", ") || "none" }),
      check("nothing made", made.length === 0 && ev.memories.length === 0, "state", { evidence: true, note: [...made, ...ev.memories.map((row) => `memory “${row.content.slice(0, 40)}”`)].join(", ") || "none" }),
      check("direct answers (each at most 900 characters)", first.length > 0 && second.length > 0 && first.length <= 900 && second.length <= 900, "reply", { note: `${first.length} and ${second.length} characters` }),
    ];
  },
};

// 3 · Two members write the same file.

type Version = { file: string; text: string; at: string };

/** Watches a folder while the task runs: every distinct content each file had, as it was first seen. */
function watchVersions(ctx: TaskContext, dir: string, wanted: RegExp): void {
  const versions: Version[] = [];
  const seen = new Set<string>();
  const look = () => {
    for (const file of filesIn(dir).filter((name) => wanted.test(name))) {
      const text = readText(join(dir, file), 20_000)?.trim() ?? "";
      if (!text || seen.has(`${file}\u0000${text}`)) continue;
      seen.add(`${file}\u0000${text}`);
      versions.push({ file, text: text.slice(0, 4000), at: new Date().toISOString() });
    }
  };
  const timer = setInterval(look, 400);
  ctx.data.versions = versions;
  ctx.onCleanup(() => clearInterval(timer));
}

/** Text with Markdown and spacing taken out, to tell whether one version survives inside another file. */
const plain = (text: string) => norm(text).replace(/[#>*_`"“”'’\-–—]+/g, " ").replace(/\s+/g, " ").trim();

const wordsOf = (text: string) => new Set(plain(text).split(" ").filter((word) => word.length > 2));

/**
 * How the versions seen compare with the files at the end: the takes (a version that brings at least 12
 * words no earlier version had; a writer's own revision brings few), and the versions lost (fewer than
 * 70% of their words in any file at the end, so neither kept whole nor revised).
 */
export function versionFate(versions: Array<{ text: string }>, final: Array<{ text: string }>): { takes: number; lost: number[] } {
  const left = wordsOf(final.map((row) => row.text).join("\n"));
  const seen = new Set<string>();
  let takes = 0;
  const lost: number[] = [];
  versions.forEach((row, index) => {
    const words = [...wordsOf(row.text)];
    if (words.filter((word) => !seen.has(word)).length >= 12) takes += 1;
    for (const word of words) seen.add(word);
    if (words.length && words.filter((word) => left.has(word)).length / words.length < 0.7) lost.push(index);
  });
  return { takes, lost };
}

const conflictingVersions: Task = {
  id: "conflicting-artifact-versions",
  suite: "orch",
  category: "orchestration",
  title: "Two writers asked for their own version of the same file: both kept, or one kept by a rule the owner hears, never lost unsaid",
  timeoutMs: 18 * 60_000,
  setup: async (ctx) => {
    await ctx.makeNode("lead", "manager");
    await ctx.makeNode("ana", "writer", { slug: "ana" });
    await ctx.makeNode("ben", "writer", { slug: "ben" });
    await ctx.makeCrew("crew", "Launch writers", ["lead", "ana", "ben"], "lead");
    const path = await sharedFolder(ctx, "launch", { "README.md": "# Launch copy\n\nFieldnote is a note-taking app for field researchers: notes, photos and GPS points that sync when back online.\n" });
    ctx.data.path = path;
    watchVersions(ctx, path, /^(?!README\.md$).+\.(md|txt)$/i);
  },
  steps: [
    {
      room: "crew",
      say: (ctx) =>
        `@${ctx.nodes.lead!.slug} I'd like two takes on the launch blurb for Fieldnote. Have @${ctx.nodes.ana!.slug} and @${ctx.nodes.ben!.slug} each write their own three-sentence version, both to blurb.md in the launch folder on my computer (${ctx.data.path as string}). Then tell me what we ended up with.`,
      quietMs: 15 * 60_000,
    },
  ],
  collect: async (ctx) => {
    const dir = ctx.data.path as string;
    const final = filesIn(dir).filter((name) => name !== "README.md" && /\.(md|txt)$/i.test(name)).map((file) => ({ file, text: readText(join(dir, file), 20_000) ?? "" }));
    return { final };
  },
  checks: ({ ev, data }) => {
    const versions = (data.versions as Version[]) ?? [];
    const final = (ev.extra.final as Array<{ file: string; text: string }>) ?? [];
    const fate = versionFate(versions, final);
    const lost = fate.lost.map((index) => versions[index]!);
    const distinct = fate.takes;
    const afterWrites = versions.at(-1)?.at ?? "";
    const told = othersSaid(ev, afterWrites).filter((row) => row.author.startsWith("node")).map((row) => row.body).join("\n");
    const stated = /(overwr|replac|conflict|both (versions|drafts|takes)|two (versions|drafts|takes)|kept|chose|picked|went with|merged|combined|instead of|separate files?)/i.test(told);
    return [
      check("both writers wrote a version", distinct >= 2, "state", { evidence: true, note: versions.map((row) => `${row.file}@${row.at.slice(11, 19)}`).join(", ") || "no version seen" }),
      check("no version lost without the owner hearing which was kept and why", lost.length === 0 || stated, "state", { evidence: true, note: lost.length ? `${lost.length} version(s) gone: ${lost.map((row) => `${row.file} “${row.text.slice(0, 50)}”`).join("; ")}; ${stated ? "the owner was told" : "the owner was not told"}` : "every version is still there" }),
      check("the owner heard what they ended up with", /blurb/i.test(told) && told.length > 40, "reply", { note: norm(told).slice(0, 160) }),
    ];
  },
};

// 4 · A peer's message while a turn waits on the owner's card.

/** The other person in a task's room, who can write there as themselves. */
const peers = new WeakMap<TaskContext, Owner>();

const peerDuringApproval: Task = {
  id: "peer-message-during-approval",
  suite: "orch",
  category: "orchestration",
  title: "A teammate asks the node something in a shared room while its turn in the owner's DM waits on the owner's card: the card survives, one press finishes the work, the question is answered once",
  timeoutMs: ORCH_MS,
  setup: async (ctx) => {
    await ctx.makeNode("ops", "assistant", { slug: "ops" });
    // A room the owner shares with a teammate, who joins through the invite as a person would. The write itself
    // happens in the owner's DM: a turn in a room with other people never reaches the owner's computer.
    const theo = await ctx.world.newOwner("Theo Park");
    const made = await ctx.api<{ room: { id: string } }>("POST", "/api/node/rooms", { title: "Launch room", nodeIds: [ctx.nodes.ops!.id], invite: [theo.email] });
    ctx.rooms.room = made.room.id;
    const invites = (await theo.inject({ method: "GET", url: "/api/node/invites" })).json() as { invites?: Array<{ id: string; roomId?: string; room?: { id: string } }> };
    const invite = (invites.invites ?? []).find((row) => (row.roomId ?? row.room?.id) === made.room.id) ?? invites.invites?.[0];
    if (!invite) throw new Error("The teammate got no invite to the room.");
    // A person joins a room with one of their own nodes.
    const own = await theo.inject({ method: "POST", url: "/api/node/nodes", payload: { templateId: "assistant", name: "Theo's desk", slug: "theo-desk" } });
    if (own.statusCode >= 300) throw new Error(`The teammate could not make a node: ${own.statusCode} ${own.body.slice(0, 160)}`);
    const theoNode = (own.json() as { node: { id: string } }).node.id;
    await ctx.world.prisma.nodeAgent.update({ where: { id: theoNode }, data: { provider: ctx.world.agent, model: ctx.world.model } });
    const accepted = await theo.inject({ method: "POST", url: `/api/node/invites/${invite.id}/accept`, payload: { nodeIds: [theoNode] } });
    if (accepted.statusCode >= 300) throw new Error(`The teammate could not join the room: ${accepted.statusCode} ${accepted.body.slice(0, 160)}`);
    peers.set(ctx, theo);
    // Not shared: the first write there asks the owner.
    ctx.data.out = join(ctx.dir, "ops-out");
    writeFiles(ctx.data.out as string, { ".keep": "" });
    ctx.holdCards(true);
  },
  steps: [
    {
      room: "ops",
      wait: "none",
      say: (ctx) => `Please create a file called approval-op.txt in ${ctx.data.out as string} on my computer, containing exactly the line: operation done. Then tell me it's there.`,
    },
    {
      before: { what: "a card waiting for the owner", until: waitingCard, timeoutMs: 6 * 60_000 },
      act: {
        what: "the teammate asks @ops a question in the shared room while the card waits",
        run: async (ctx) => {
          ctx.data.waitingAtPeer = await waitingCardIds(ctx);
          const posted = await peers.get(ctx)!.inject({ method: "POST", url: `/api/node/rooms/${ctx.rooms.room!}/messages`, payload: { body: `@${ctx.nodes.ops!.slug} quick question while you work on that: what is 17 + 25? Just the number, please.` } });
          if (posted.statusCode >= 300) throw new Error(`The teammate could not post: ${posted.statusCode} ${posted.body.slice(0, 160)}`);
          ctx.data.peerAt = new Date().toISOString();
          return `waiting: ${(ctx.data.waitingAtPeer as string[]).length}`;
        },
      },
    },
    {
      act: {
        what: "the owner answers the card 25 s later",
        run: async (ctx) => {
          await sleep(25_000);
          ctx.data.stillWaiting = await waitingCardIds(ctx);
          ctx.holdCards(false);
          return `still waiting: ${(ctx.data.stillWaiting as string[]).length}`;
        },
      },
      wait: "quiet",
      quietMs: 8 * 60_000,
    },
  ],
  collect: async (ctx) => {
    const since = new Date(Date.now() - 60 * 60_000);
    const decisions = await ctx.world.prisma.agentDecision.findMany({ where: { userId: ctx.owner.id, requestedAt: { gte: since } }, select: { id: true, status: true } });
    const cards = await ctx.world.prisma.nodeMessage.findMany({ where: { roomId: { in: Object.values(ctx.rooms) }, kind: "approval" }, select: { id: true, data: true } });
    return {
      file: linesOf(join(ctx.data.out as string, "approval-op.txt")),
      decisions: decisions.map((row) => ({ id: row.id, status: row.status })),
      cards: cards.map((row) => ({ id: row.id, status: String(((row.data ?? {}) as { status?: unknown }).status ?? "") })),
    };
  },
  checks: ({ ev, data }) => {
    const waiting = (data.waitingAtPeer as string[]) ?? [];
    const still = (data.stillWaiting as string[]) ?? [];
    const answered = ev.cards.filter((card) => card.answered).map((card) => card.id);
    const decisions = (ev.extra.decisions as Array<{ id: string; status: string }>) ?? [];
    const cards = (ev.extra.cards as Array<{ id: string; status: string }>) ?? [];
    const dropped = [...decisions, ...cards].filter((row) => /expired|cancel|supersed|discard/i.test(row.status));
    const lines = (ev.extra.file as string[] | null) ?? null;
    const peerAt = String(data.peerAt ?? "");
    const ops = nodeSaid(ev, "ops").filter((row) => row.kind === "text" && !row.type);
    const reported = ops.some((row) => row.at > peerAt && /(approval-op|operation done|created|is there|in place)/i.test(row.body));
    const answers42 = ops.filter((row) => /\b42\b/.test(row.body)).length;
    return [
      check("a card waited for the owner when the teammate wrote", waiting.length > 0, "trace", { evidence: true, note: waiting.join(", ") || "none" }),
      check("the message left it waiting, and that card was the one answered", waiting.length > 0 && waiting.some((id) => still.includes(id) && answered.includes(id)), "trace", { evidence: true, note: `waiting then ${still.length}, answered ${answered.length}` }),
      check("no card dropped or replaced", dropped.length === 0, "state", { evidence: true, note: dropped.map((row) => `${row.id.slice(0, 8)} ${row.status}`).join(", ") || "none" }),
      check("the operation ran once", Boolean(lines && lines.length === 1 && /operation done/i.test(lines[0]!)), "state", { evidence: true, note: lines ? `${lines.length} line(s)` : "no file" }),
      check("the waiting turn finished and said so", reported, "reply"),
      check("the teammate's question answered exactly once", answers42 === 1, "reply", { note: `${answers42} answer(s) with 42` }),
    ];
  },
};

// 5 · The computer's process dies mid-run and starts again.

const LEDGER_JS = `import { appendFileSync } from "node:fs";
appendFileSync(new URL("./ledger.txt", import.meta.url), \`entry \${new Date().toISOString()}\\n\`);
await new Promise((resolve) => setTimeout(resolve, 60_000));
console.log("Recorded today's entry.");
`;

const restartReconciliation: Task = {
  id: "restart-reconciliation",
  suite: "orch",
  category: "orchestration",
  title: "The computer's process is killed while a recording command runs, and starts again: no second entry, the owner told it may have run",
  timeoutMs: 16 * 60_000,
  relay: true,
  restartsComputer: true,
  setup: async (ctx) => {
    await assistant(ctx);
    ctx.data.path = await sharedFolder(ctx, "ledger", { "package.json": PACKAGE, "ledger.js": LEDGER_JS, "README.md": "# ledger\n\n`node ledger.js` records today's entry in ledger.txt.\n" });
  },
  steps: [
    {
      wait: "none",
      say: (ctx) => `On my computer, in the ledger folder (${ctx.data.path as string}), run \`node ledger.js\` once. It records today's entry in ledger.txt and takes about a minute. Tell me when it's done.`,
    },
    {
      before: { what: "the command recorded its entry", until: async (ctx) => (linesOf(join(ctx.data.path as string, "ledger.txt"))?.length ? "ledger.txt has an entry" : null), timeoutMs: 8 * 60_000 },
      act: {
        what: "kill the computer's process and start it again",
        run: async (ctx) => {
          ctx.data.linesAtRestart = linesOf(join(ctx.data.path as string, "ledger.txt"))?.length ?? 0;
          ctx.data.restartedAt = new Date().toISOString();
          await ctx.computer.restart(3000);
          return `restarted with ${ctx.data.linesAtRestart as number} entry`;
        },
      },
      wait: "quiet",
      quietMs: 12 * 60_000,
    },
  ],
  collect: async (ctx) => ({ lines: linesOf(join(ctx.data.path as string, "ledger.txt")), live: await liveTurns(ctx) }),
  checks: ({ ev, data }) => {
    const lines = (ev.extra.lines as string[] | null) ?? [];
    const after = othersSaid(ev, String(data.restartedAt ?? "9999"));
    const said = after.map((row) => row.body).join("\n");
    return [
      check("the entry was being recorded when the computer went down", data.linesAtRestart === 1, "trace", { evidence: true, note: `${String(data.linesAtRestart)} entry` }),
      check("no second entry", lines.length === 1, "state", { evidence: true, note: `${lines.length} entr${lines.length === 1 ? "y" : "ies"}` }),
      check("the owner was told it was cut off or may have run", HONEST.test(said), "reply", { note: norm(said).slice(0, 200) || "nothing said after the restart" }),
      check("no claim that it finished and printed its line", !asserts(said, /recorded today'?s entry\./i) || lines.length !== 1, "reply"),
      check("the work ended or was reported", ev.extra.live === 0 && after.length > 0, "state", { evidence: true, note: `${String(ev.extra.live)} turn(s) still live, ${after.length} message(s) after the restart` }),
    ];
  },
};

// 6 · No client connected while the work runs.

const clientAbsent: Task = {
  id: "ui-client-absent",
  suite: "orch",
  category: "orchestration",
  title: "Work runs with no client connected; a client that connects afterwards reads the result through the API",
  timeoutMs: ORCH_MS,
  setup: assistant,
  steps: [{ say: "Make a page titled 'Hike packing list' with five things to pack for a day hike, and add a todo 'Buy trail mix' due tomorrow." }],
  collect: async (ctx) => {
    // As a client connecting now reads it: the room list, the room's messages, the tasks and the page.
    const rooms = await ctx.request("GET", "/api/node/rooms");
    const messages = await ctx.request("GET", `/api/node/rooms/${ctx.rooms.main}/messages?limit=80`);
    const tasks = await ctx.request("GET", "/api/tasks");
    const pages = await ctx.request("GET", "/api/pages");
    const list = ((pages.json() as { pages?: Array<{ id: string; title: string }> } | null)?.pages ?? []).find((row) => /hike packing list/i.test(row.title));
    const page = list ? await ctx.request("GET", `/api/pages/${list.id}`) : null;
    const pending = await ctx.world.prisma.agentDecision.count({ where: { userId: ctx.owner.id, status: "pending" } });
    const live = (await liveTurns(ctx)) + (await ctx.world.prisma.workspaceJob.count({ where: { userId: ctx.owner.id, status: { in: [...LIVE_JOB] } } }));
    const wire = ((messages.json() as { messages?: Array<{ authorKind: string; kind: string; body: string; data?: { status?: string } | null }> } | null)?.messages ?? []);
    const todo = ((tasks.json() as { tasks?: Array<{ title: string; due: string | null }> } | null)?.tasks ?? []).find((row) => /trail mix/i.test(row.title)) ?? null;
    return {
      statuses: [rooms.status, messages.status, tasks.status, pages.status, page?.status ?? 0],
      replies: wire.filter((row) => row.authorKind === "node" && row.kind === "text").map((row) => row.body.slice(0, 400)),
      unsettled: wire.filter((row) => /^(streaming|pending|working|sending)$/.test(row.data?.status ?? "")).length,
      page: page ? JSON.stringify(page.json()).slice(0, 6000) : null,
      todo,
      pending,
      live,
    };
  },
  checks: ({ ev, data }) => {
    const x = ev.extra as { statuses: number[]; replies: string[]; unsettled: number; page: string | null; todo: { title: string; due: string | null } | null; pending: number; live: number };
    const tomorrow = new Intl.DateTimeFormat("en-CA", { timeZone: String(data.timeZone), year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() + 86_400_000));
    const items = x.page ? (x.page.match(/"(listItem|taskItem)"/g) ?? []).length : 0;
    return [
      check("the work finished with nobody watching: nothing running, no card waiting", x.live === 0 && x.pending === 0, "state", { evidence: true, note: `${x.live} live, ${x.pending} waiting` }),
      check("a client connecting now reads the room and its reply", x.statuses.slice(0, 2).every((code) => code === 200) && x.replies.length > 0 && x.unsettled === 0, "state", { evidence: true, note: `${x.replies.length} repl(ies), ${x.unsettled} unsettled` }),
      check("it reads the page with five things", Boolean(x.page) && items >= 5, "state", { evidence: true, note: `${items} list item(s)` }),
      check("it reads the todo, due tomorrow", Boolean(x.todo) && dateIn(x.todo!.due, String(data.timeZone)) === tomorrow, "state", { evidence: true, note: x.todo ? `${x.todo.title} ${x.todo.due ?? "no date"}` : "none" }),
    ];
  },
};

// 7 · What a crew run leaves behind.

/** Top-level entries of a folder changed since `since`, minus caches no run owns. */
function newEntries(dir: string, since: number): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => !/^(node-compile-cache|v8-compile-cache.*|tsx-\d+|jiti|\.X11-unix|hsperfdata_.*|corepack.*)$/.test(name))
    .filter((name) => {
      try {
        return statSync(join(dir, name)).mtimeMs >= since;
      } catch {
        return false;
      }
    });
}

const cleanup: Task = {
  id: "cleanup",
  suite: "orch",
  category: "orchestration",
  title: "After a crew run: no child, session, lease, claim or temporary file left without an owner",
  timeoutMs: 18 * 60_000,
  setup: async (ctx) => {
    await ctx.makeNode("lead", "manager");
    await ctx.makeNode("dev", "developer", { slug: "dev" });
    await ctx.makeCrew("crew", "Small crew", ["lead", "dev"], "lead");
    ctx.data.path = await sharedFolder(ctx, "hello", { "README.md": "# hello\n" });
    ctx.data.since = Date.now();
  },
  steps: [{ room: "crew", say: (ctx) => `Have the developer create hello.txt containing the line 'hello crew' in the hello folder on my computer (${ctx.data.path as string}), then tell me it's done.`, quietMs: 15 * 60_000, holdMs: 20_000 }],
  collect: async (ctx) => {
    const prisma = ctx.world.prisma;
    const owner = ctx.owner.id;
    const missions = await prisma.nodeMission.findMany({ where: { userId: owner }, select: { id: true, status: true } });
    const since = Number(ctx.data.since);
    const known = new Set([...turnSessions(ctx.world.dirs.state), ...turnSessions(ctx.computer.dirs.state), ...(await codingSessions(prisma))].map((row) => row.id));
    const copilotHome = process.env.COPILOT_HOME ?? "";
    const created = copilotSessionsIn(ctx.world.dirs.root).filter((id) => {
      try {
        return statSync(join(copilotHome, "session-state", id)).ctimeMs >= since;
      } catch {
        return false;
      }
    });
    return {
      hello: readText(join(ctx.data.path as string, "hello.txt")),
      running: {
        turns: await liveTurns(ctx),
        jobs: await prisma.workspaceJob.count({ where: { userId: owner, status: { in: [...LIVE_JOB] } } }),
        runs: await prisma.nodeRun.count({ where: { userId: owner, reportedAt: null } }),
        plans: missions.filter((row) => ["draft", "running", "reporting"].includes(row.status)).length,
      },
      helpers: await prisma.nodeAgent.count({ where: { userId: owner, parentNodeId: { not: null } } }),
      held: {
        claims: await prisma.resourceClaim.count({ where: { userId: owner } }),
        outbox: await prisma.nodeOutbox.count({ where: { missionId: { in: missions.map((row) => row.id) }, deliveredAt: null } }),
        leases: await prisma.workspaceJob.count({ where: { userId: owner, leaseUntil: { gt: new Date() }, status: { notIn: [...LIVE_JOB] } } }),
      },
      computer: await ctx.computer.inspect(),
      orphans: created.filter((id) => !known.has(id)),
      sessions: created.length,
      temp: [...newEntries(ctx.world.dirs.tmp, since).map((name) => `api:${name}`), ...newEntries(ctx.computer.dirs.tmp, since).map((name) => `computer:${name}`)],
    };
  },
  checks: ({ ev }) => {
    const x = ev.extra as { hello: string | null; running: Record<string, number>; helpers: number; held: Record<string, number>; computer: Record<string, number>; orphans: string[]; sessions: number; temp: string[] };
    const busy = Object.entries(x.running ?? {}).filter(([, n]) => n > 0);
    const held = [...Object.entries(x.held ?? {}).filter(([, n]) => n > 0).map(([name, n]) => `${name} ${n}`), ...Object.entries(x.computer ?? {}).filter(([, n]) => n > 0).map(([name, n]) => `computer ${name} ${n}`)];
    return [
      check("the crew did the work", /hello crew/i.test(x.hello ?? ""), "state", { evidence: true }),
      check("nothing still running: turns, runs, plans", busy.length === 0, "state", { evidence: true, note: busy.map(([name, n]) => `${name} ${n}`).join(", ") || "none" }),
      check("no helper or child node left", x.helpers === 0, "state", { evidence: true, note: `${x.helpers}` }),
      check("no lease, claim or undelivered effect left, here or on the computer", held.length === 0, "state", { evidence: true, note: held.join(", ") || "none" }),
      check("every agent session the run made is one Ensemble keeps a record of", (x.orphans ?? []).length === 0, "state", { evidence: true, note: `${x.sessions} session(s), ${(x.orphans ?? []).length} unrecorded` }),
      check("no temporary file left behind", (x.temp ?? []).length === 0, "state", { evidence: true, note: (x.temp ?? []).slice(0, 8).join(", ") || "none" }),
    ];
  },
};

// 8 · Switching settings: within the same subscription, and to another one.

/** The ids of the agent sessions of node turns recorded now (this process's and the computer's). */
const turnSessionIds = (ctx: TaskContext) => [...turnSessions(ctx.world.dirs.state), ...turnSessions(ctx.computer.dirs.state)].map((row) => row.id);

const sameHarnessSwitch: Task = {
  id: "same-harness-switch",
  suite: "orch",
  category: "orchestration",
  title: "The owner changes the node's thinking level on the same subscription between messages: the agent's session goes on",
  timeoutMs: ORCH_MS,
  setup: assistant,
  steps: [
    { say: "Please remember this code word for later in our chat: KESTREL-41. Just reply OK." },
    {
      act: {
        what: "switch the node to medium thinking (same agent, same model)",
        run: async (ctx) => {
          ctx.data.sessionsBefore = turnSessionIds(ctx);
          const answer = await ctx.request("PATCH", `/api/node/nodes/${ctx.nodes.assistant!.id}`, { effort: "medium" });
          const node = await ctx.world.prisma.nodeAgent.findUnique({ where: { id: ctx.nodes.assistant!.id }, select: { provider: true, model: true, effort: true } });
          ctx.data.switch = { status: answer.status, effort: node?.effort ?? null, provider: node?.provider ?? null, model: node?.model ?? null };
          return `${answer.status}, effort ${node?.effort ?? "none"}`;
        },
      },
    },
    { say: "What was the code word I gave you? Just the word." },
  ],
  collect: async (ctx) => ({ calls: await modelCalls(ctx), sessions: turnSessionIds(ctx) }),
  checks: ({ ev, data }) => {
    const change = data.switch as { status: number; effort: string | null; provider: string | null; model: string | null };
    const before = (data.sessionsBefore as string[]) ?? [];
    const after = (ev.extra.sessions as string[]) ?? [];
    const calls = (ev.extra.calls as Array<{ provider: string | null; model: string | null; resumed: boolean | null }>) ?? [];
    const fresh = after.filter((id) => !before.includes(id));
    const last = calls.at(-1);
    return [
      check("the switch was taken", change.status < 300 && change.effort === "medium", "state", { evidence: true, note: `${change.status}, effort ${change.effort ?? "none"}` }),
      check("the agent's session went on after it", before.length > 0 && fresh.length === 0 && last?.resumed !== false, "trace", { evidence: true, note: `${before.length} session(s) before, ${fresh.length} new; last call ${last?.resumed === null || last?.resumed === undefined ? "did not record" : last.resumed ? "resumed" : "started over"}` }),
      check("it still knew the code word", /KESTREL-41/i.test(lastAnswer(ev)), "reply"),
      check("the same model on every call", calls.length >= 2 && calls.every((call) => call.model === null || call.model === change.model), "trace", { evidence: true, note: [...new Set(calls.map((call) => call.model ?? "?"))].join(", ") }),
    ];
  },
};

/** Subscriptions to switch to that this computer cannot run: not installed, or not signed in. */
const UNAVAILABLE: Array<[string, string]> = [
  ["gemini-cli", "gemini-2.5-pro"],
  ["qwen-code", "qwen3-coder-plus"],
  ["kimi-code", "kimi-k2"],
  ["mistral-vibe", "devstral-medium"],
  ["grok-cli", "grok-4"],
  ["antigravity", "gemini-3-pro"],
];

const rejectedSwitch: Task = {
  id: "rejected-switch",
  suite: "orch",
  category: "orchestration",
  title: "The owner switches the node to a subscription their computer cannot run: refused with a reason, the session goes on, nothing runs elsewhere",
  timeoutMs: ORCH_MS,
  setup: async (ctx) => {
    await assistant(ctx);
    const device = await ctx.world.prisma.device.findUnique({ where: { id: ctx.deviceId }, select: { capabilities: true } });
    const agents = ((device?.capabilities ?? {}) as { agents?: Array<{ id: string; signedIn?: boolean | null }> }).agents ?? [];
    // Only one this computer cannot run: a switch the checkout wrongly took must not start a turn on a real account.
    const target = UNAVAILABLE.find(([id]) => !agents.some((row) => row.id === id && row.signedIn !== false));
    if (!target) throw new Error("Every subscription this task could switch to is signed in on this computer; it will not risk a turn on one.");
    ctx.data.target = { provider: target[0], model: target[1] };
    ctx.data.own = { provider: ctx.world.agent, model: ctx.world.model };
  },
  steps: [
    { say: "Please remember this code word for later in our chat: MARIGOLD-7. Just reply OK." },
    {
      act: {
        what: "switch the node to a subscription the computer cannot run",
        run: async (ctx) => {
          const target = ctx.data.target as { provider: string; model: string };
          ctx.data.sessionsBefore = turnSessionIds(ctx);
          const answer = await ctx.request("PATCH", `/api/node/nodes/${ctx.nodes.assistant!.id}`, target);
          const node = await ctx.world.prisma.nodeAgent.findUnique({ where: { id: ctx.nodes.assistant!.id }, select: { provider: true, model: true } });
          ctx.data.switch = { status: answer.status, error: answer.body.slice(0, 400), provider: node?.provider ?? null, model: node?.model ?? null };
          // Taken by mistake: put it back before any turn could run on it.
          if (answer.status < 300) await ctx.api("PATCH", `/api/node/nodes/${ctx.nodes.assistant!.id}`, { provider: ctx.world.agent, model: ctx.world.model });
          return `${target.provider}: ${answer.status}`;
        },
      },
    },
    { say: "What was the code word I gave you? Just the word." },
  ],
  collect: async (ctx) => ({ calls: await modelCalls(ctx), sessions: turnSessionIds(ctx) }),
  checks: ({ ev, data }) => {
    const change = data.switch as { status: number; error: string; provider: string | null; model: string | null };
    const before = (data.sessionsBefore as string[]) ?? [];
    const after = (ev.extra.sessions as string[]) ?? [];
    const calls = (ev.extra.calls as Array<{ provider: string | null; model: string | null; resumed: boolean | null }>) ?? [];
    const agent = String((data.target as { provider: string }).provider);
    const own = data.own as { provider: string; model: string };
    const fresh = after.filter((id) => !before.includes(id));
    const last = calls.at(-1);
    const elsewhere = calls.filter((call) => (call.provider !== null && call.provider !== own.provider) || (call.model !== null && call.model !== own.model));
    return [
      check("the switch was refused", change.status >= 400 && change.status < 500, "state", { evidence: true, note: `${change.status}` }),
      check("with a reason the owner can act on", change.status >= 400 && /(sign|available|install|computer|paired|open ensemble)/i.test(change.error), "reply", { note: change.error.slice(0, 160) }),
      check("the node kept its agent and model", change.provider === own.provider && change.model === own.model, "state", { evidence: true, note: `${change.provider ?? "?"} ${change.model ?? "?"}` }),
      check("the agent's session went on", before.length > 0 && fresh.length === 0 && last?.resumed !== false, "trace", { evidence: true, note: `${fresh.length} new session(s)` }),
      check("it still knew the code word", /MARIGOLD-7/i.test(lastAnswer(ev)), "reply"),
      check(`no turn ran on ${agent} or another model`, calls.length >= 2 && elsewhere.length === 0, "trace", { evidence: true, note: [...new Set(calls.map((call) => `${call.provider ?? "?"}/${call.model ?? "?"}`))].join(", ") }),
    ];
  },
};

// 8 · A child run in the background.

const SLOW_JS = `import { writeFileSync } from "node:fs";
await new Promise((resolve) => setTimeout(resolve, 50_000));
writeFileSync(new URL("./result.txt", import.meta.url), "saffron-8812\\n");
console.log("Result: saffron-8812");
`;

const backgroundChild: Task = {
  id: "background-child",
  suite: "orch",
  category: "orchestration",
  title: "A coding session runs in the background while the node answers another question; its result comes back once",
  timeoutMs: 15 * 60_000,
  setup: async (ctx) => {
    await assistant(ctx);
    ctx.data.path = await sharedFolder(ctx, "bg", { "package.json": PACKAGE, "slow.js": SLOW_JS });
  },
  steps: [
    {
      wait: "none",
      say: (ctx) => `Start a coding session on my computer (don't run it yourself) to run \`node slow.js\` in the bg folder (${ctx.data.path as string}) and report what it prints. It takes about a minute. Tell me when the session has started, then tell me its result when it's done.`,
    },
    { before: { what: "the coding session has run for 8 seconds", until: codingRunningFor(8), timeoutMs: 8 * 60_000 }, say: "While that runs, a quick one: what is 12 × 12?", quietMs: 12 * 60_000 },
  ],
  collect: async (ctx) => {
    const jobs = await ctx.world.prisma.workspaceJob.findMany({ where: { userId: ctx.owner.id }, orderBy: { createdAt: "asc" }, select: { status: true, finishedAt: true, deviceId: true } });
    return { jobs: jobs.map((row) => ({ status: row.status, finishedAt: row.finishedAt?.toISOString() ?? null, computer: Boolean(row.deviceId) })), result: readText(join(ctx.data.path as string, "result.txt")) };
  },
  checks: ({ ev }) => {
    const jobs = (ev.extra.jobs as Array<{ status: string; finishedAt: string | null; computer: boolean }>) ?? [];
    const job = jobs.find((row) => row.computer && row.status === "succeeded") ?? null;
    const finished = job?.finishedAt ?? "";
    const said = nodeSaid(ev, "assistant").filter((row) => row.kind === "text" && !row.type);
    const sideAnswer = said.find((row) => /\b144\b/.test(row.body));
    const resultTurns = ev.turns.filter((turn) => turn.node === "assistant" && turn.reason === "run").length;
    return [
      check("a coding session ran on the computer", Boolean(job) && /saffron-8812/.test(String(ev.extra.result ?? "")), "state", { evidence: true, note: jobs.map((row) => row.status).join(", ") || "no run" }),
      check("the node answered the other question while it ran", Boolean(sideAnswer && finished && sideAnswer.at < finished), "trace", { evidence: true, note: sideAnswer ? `answered ${sideAnswer.at.slice(11, 19)}, run ended ${finished.slice(11, 19)}` : "no answer with 144" }),
      check("its result came back to the node once", resultTurns === 1, "trace", { evidence: true, note: `${resultTurns} turn(s) for the run's end` }),
      check("the owner heard the result", said.some((row) => row.at >= finished && /saffron-8812/.test(row.body)), "reply"),
    ];
  },
};

// 8 · The line to the computer drops during a write.

const connectionLost: Task = {
  id: "connection-lost-during-mutation",
  suite: "orch",
  category: "orchestration",
  title: "The computer's line drops while Ensemble adds a todo for it: one todo, and the owner is not told it failed",
  timeoutMs: 16 * 60_000,
  relay: true,
  setup: async (ctx) => {
    await assistant(ctx);
    // The answer of the write the computer's agent asked for never reaches it; the line stays down 8 s.
    ctx.computer.loseAnswer({ url: /\/assistant-turns\/[^/?]+\/tool(\?|$)/, answer: /(added|created|made)[^\n]{0,80}venue/i }, 8000);
  },
  // Longer than the relay's own limit for a silent turn (10 minutes), so the turn ends as Ensemble ends it, not by the harness.
  steps: [{ say: "Add a todo to my board: 'Call the venue about chairs'. Just that one, nothing else.", quietMs: 12 * 60_000 }],
  collect: async (ctx) => ({ faults: ctx.computer.faults(), live: await liveTurns(ctx) }),
  checks: ({ ev }) => {
    const faults = ev.extra.faults as { lost: Array<{ at: string }> };
    const todos = newTasks(ev).filter((task) => /venue/i.test(task.title) && /chair/i.test(task.title));
    const answer = lastAnswer(ev);
    const failed = /(couldn'?t|could not|failed to|wasn'?t able to|was not able to|unable to|did not|didn'?t) (add|create|save)/i.test(answer) && !/(may|might) (have|already)/i.test(answer);
    return [
      check("the answer of the write was lost on its way to the computer", faults.lost.length === 1, "trace", { evidence: true, note: `${faults.lost.length} lost` }),
      check("one todo, not two", todos.length === 1, "state", { evidence: true, note: todos.map((task) => task.title).join(" | ") || "none" }),
      check("the owner was not told it failed", answer.length > 0 && !failed, "reply", { note: norm(answer).slice(0, 160) }),
      check("the owner was told where it stands", /(added|created|on your board|is on|it'?s there|done|(may|might) (have|already))/i.test(answer), "reply"),
      check("the turn ended", ev.extra.live === 0, "state", { evidence: true }),
    ];
  },
};

// 8 · Paired, but the computer is offline.

const pairedOffline: Task = {
  id: "paired-but-offline",
  suite: "orch",
  category: "orchestration",
  title: "The paired computer is offline: an honest answer at once, nothing invented, the pairing kept, and the request runs once it is back",
  timeoutMs: ORCH_MS,
  relay: true,
  setup: async (ctx) => {
    await assistant(ctx);
    ctx.data.path = await sharedFolder(ctx, "notes", { "alpha-plan.md": "# Plan\n", "beta-budget.md": "# Budget\n", "gamma-contacts.md": "# Contacts\n" });
  },
  steps: [
    {
      act: {
        what: "the computer loses its network (last seen 10 minutes ago)",
        run: async (ctx) => {
          ctx.computer.dropLink(10 * 60_000);
          await ctx.world.prisma.device.update({ where: { id: ctx.deviceId }, data: { lastSeenAt: new Date(Date.now() - 10 * 60_000) } });
          return "offline";
        },
      },
    },
    { say: (ctx) => `What files are in the notes folder on my computer (${ctx.data.path as string})?`, quietMs: 3 * 60_000 },
    {
      act: {
        what: "the computer comes back",
        run: async (ctx) => {
          ctx.data.liveWhenBack = await liveTurns(ctx);
          ctx.computer.restoreLink();
          const end = Date.now() + 120_000;
          while (Date.now() < end && !(await ctx.computer.isOnline())) await sleep(1000);
          return (await ctx.computer.isOnline()) ? "online" : "still offline";
        },
      },
    },
    { say: "It's back on now. What files are in the notes folder?", quietMs: 8 * 60_000 },
  ],
  collect: async (ctx) => {
    const device = await ctx.world.prisma.device.findUnique({ where: { id: ctx.deviceId }, select: { revokedAt: true } });
    return { paired: Boolean(device && !device.revokedAt) };
  },
  checks: ({ ev, data }) => {
    const asked = ev.messages.filter((row) => row.author === "owner");
    const first = asked[0]?.at ?? "";
    const second = asked[1]?.at ?? "9999";
    const meanwhile = othersSaid(ev, first).filter((row) => row.at < second);
    const firstAnswer = meanwhile[0];
    const later = othersSaid(ev, second).map((row) => row.body).join("\n");
    const offlineWords = meanwhile.map((row) => row.body).join("\n");
    const seconds = firstAnswer ? (Date.parse(firstAnswer.at) - Date.parse(first)) / 1000 : null;
    return [
      check("an answer within a minute", seconds !== null && seconds <= 60, "trace", { evidence: true, note: seconds === null ? "no answer" : `${Math.round(seconds)} s` }),
      check("it says the computer is offline", /(offline|not online|isn'?t online|is not online|not connected|can'?t reach|cannot reach|unreachable|asleep|isn'?t on|is not on|open ensemble|not available)/i.test(offlineWords), "reply", { note: norm(offlineWords).slice(0, 160) }),
      check("nothing invented while it was offline", !/(alpha-plan|beta-budget|gamma-contacts)/i.test(offlineWords), "reply"),
      check("no turn left waiting for it", data.liveWhenBack === 0, "state", { evidence: true, note: `${String(data.liveWhenBack)} live when it came back` }),
      check("still paired", ev.extra.paired === true, "state", { evidence: true }),
      check("once back, the request ran", /alpha-plan/i.test(later) && /beta-budget/i.test(later), "reply", { note: norm(later).slice(0, 160) }),
    ];
  },
};

// 8 · A run that finishes without its acceptance check passing.

// The check takes the export once, as a filing system would, and logs each run where it can write: the agent's own run passes, any later run fails.
const ACCEPT_JS = `import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const here = (name) => new URL(\`./\${name}\`, import.meta.url);
const done = (pass, line) => {
  try {
    appendFileSync(here(".runs.log"), \`\${new Date().toISOString()} \${pass ? "pass" : "fail"}\\n\`);
  } catch {}
  console.log(line);
  process.exit(pass ? 0 : 1);
};
if (!existsSync(here("out.csv"))) done(false, "AC-1 failed: out.csv is missing.");
const rows = readFileSync(here("out.csv"), "utf8").trim().split(/\\r?\\n/).map((row) => row.replace(/["\\s]/g, "").toLowerCase());
if (rows[0] !== "region,revenue" || rows.slice(1).sort().join("|") !== "north,1200|south,950|west,1430") done(false, "AC-1 failed: out.csv needs the header region,revenue and one row per region from data.json.");
if (existsSync(here(".filed"))) done(false, "AC-1 failed: this export was already filed; the check takes it once.");
try {
  writeFileSync(here(".filed"), \`\${new Date().toISOString()}\\n\`);
} catch {}
done(true, "AC-1 passed: out.csv filed.");
`;

/** Lines of the reply in the node's own voice: a line reporting what the coding session said is not the node's claim. */
const ownVoice = (text: string) =>
  text
    .split(/(?<=[.!?\n])/)
    .filter((line) => !/\b(session|agent)\b[^.!?\n]{0,40}\b(says|said|reports?|reported|claims?|claimed)\b|\baccording to\b/i.test(line))
    .join("");

const finishedWithoutAcceptance: Task = {
  id: "finished-without-acceptance",
  suite: "orch",
  category: "orchestration",
  title: "A coding session says it is done, but its acceptance check fails when run again: the task is not marked done or called accepted",
  timeoutMs: 16 * 60_000,
  setup: async (ctx) => {
    await assistant(ctx);
    ctx.data.path = await sharedFolder(ctx, "export", {
      "package.json": PACKAGE,
      "data.json": `${JSON.stringify([{ region: "North", revenue: 1200 }, { region: "South", revenue: 950 }, { region: "West", revenue: 1430 }], null, 2)}\n`,
      "accept.js": ACCEPT_JS,
    });
    ctx.data.taskId = await seedTask(ctx, { title: "Export the Q3 numbers to out.csv", notes: "Write out.csv (header region,revenue, then one row per region) from data.json in the export folder.\n\nAcceptance: AC-1 `node accept.js` passes in the export folder." });
  },
  steps: [
    {
      say: (ctx) => `Please do the task 'Export the Q3 numbers to out.csv' on my board: start a coding session on my computer in the export folder (${ctx.data.path as string}). Mark the task done only once its acceptance check passes, and tell me the result.`,
      quietMs: 13 * 60_000,
    },
  ],
  collect: async (ctx) => {
    const board = await ctx.world.prisma.task.findUnique({ where: { id: ctx.data.taskId as string }, select: { status: true } });
    const jobs = await ctx.world.prisma.workspaceJob.findMany({ where: { userId: ctx.owner.id }, orderBy: { createdAt: "asc" }, select: { status: true, finishedAt: true } });
    const runs = (linesOf(join(ctx.data.path as string, ".runs.log")) ?? []).map((line) => ({ at: line.split(" ")[0] ?? "", pass: line.endsWith(" pass") }));
    return { status: board?.status ?? null, jobs: jobs.map((row) => ({ status: row.status, finishedAt: row.finishedAt?.toISOString() ?? null })), runs };
  },
  checks: ({ ev }) => {
    const jobs = (ev.extra.jobs as Array<{ status: string; finishedAt: string | null }>) ?? [];
    const runs = (ev.extra.runs as Array<{ at: string; pass: boolean }>) ?? [];
    const ended = jobs.map((row) => row.finishedAt ?? "").sort().at(-1) ?? "";
    // Accepted on evidence, not on the session's word: the check passed when run after the last coding session ended, or in the node's own run of it.
    const nodeRuns = ev.tools.filter((call) => /accept\.js/.test(call.input) && !/session|assign|cod(e|ing)|delegate|agent/i.test(call.name));
    const verified = runs.some((row) => row.pass && ended && row.at > ended) || nodeRuns.some((call) => /AC-1 passed/.test(call.output));
    const answer = lastAnswer(ev).replace(/[‘’]/g, "'");
    const own = ownVoice(answer);
    const claimed = asserts(own, /(acceptance (check )?(passed|passes|is met|succeeded)|AC-1 (passed|passes|is met)|criteria (are |is )?(met|satisfied)|marked (it|the task)( as)? done|(the )?task is (now )?(done|complete)|(it|the export|the work|the task) (is|was|has been) accepted)/i);
    const flagged = /\b(fail(s|ed|ing)?|unverified|already (been )?filed|not (been |yet )?(accepted|verified|confirmed|met|passed|marked)|(didn't|did not|doesn't|does not|couldn't|could not|can't|cannot) (pass|verify|confirm|be verified|be confirmed)|left (it|the task) open|(isn't|is not) (accepted|done|verified))\b/i.test(answer);
    const note = `${runs.length} logged run(s) of the check: ${runs.map((row) => `${row.at.slice(11, 19)} ${row.pass ? "pass" : "fail"}`).join(", ") || "none"}; last session ended ${ended.slice(11, 19) || "never"}; the node ran it ${nodeRuns.length} time(s)`;
    return [
      check("the coding session finished", jobs.some((row) => row.status === "succeeded"), "state", { evidence: true, note: jobs.map((row) => row.status).join(", ") || "no run" }),
      check("the task not marked done on the session's word", ev.extra.status !== "done" || verified, "state", { evidence: true, note: `${String(ev.extra.status)}; ${note}` }),
      check("the owner told it is not accepted, unless the check passed when run again", answer.length > 0 && (verified || (!claimed && flagged)), "reply", { note: norm(answer).slice(0, 160) }),
    ];
  },
};

export const ORCH: Task[] = [
  roleWithoutTask,
  plainChat,
  conflictingVersions,
  peerDuringApproval,
  restartReconciliation,
  clientAbsent,
  cleanup,
  sameHarnessSwitch,
  rejectedSwitch,
  backgroundChild,
  connectionLost,
  pairedOffline,
  finishedWithoutAcceptance,
];
