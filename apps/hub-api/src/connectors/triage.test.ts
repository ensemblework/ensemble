/**
 * Model replies recorded from triage, plus the same shapes written by hand.
 * No network. Gemini often returns a JSON array even when the prompt asks
 * for {"todos":[...]}.
 */
import assert from "node:assert/strict";
import test from "node:test";
import "../runtime/test-env.js";
import { parseModelJson } from "../runtime/model-json.js";
import { TRIAGE_PROMPT, triageDueInstant } from "./triage.js";
import { readTriageTodos, triageTodosFromReply, type HeuristicSource } from "./triage-todos.js";

const IDS = new Set(["art_priya", "art_rahul", "art_news"]);

const PRIYA = {
  id: "art_priya",
  title: "Reply to Priya with p95 latency numbers",
  priority: "p0",
  due: "2026-10-03",
  owner: "me",
  rationale: "Priya asked for the p95 latency numbers by the end of the day.",
  excerpt: "Can you send the p95 latency numbers by EOD?",
};

const RAHUL = {
  id: "art_rahul",
  title: "Send Rahul the load-test p95 before Thursday",
  priority: "p1",
  due: "2026-10-08",
  owner: "me",
  rationale: "Rahul needs the p95 numbers for Thursday's review.",
  excerpt: "Could you send me the p95 numbers from the load test before Thursday's review?",
};

/** A Gemini reply that ignored the object schema and returned an array inside a fence. */
const GEMINI_ARRAY_REPLY = `Here is the triage:

\`\`\`json
[
  {
    "id": "art_priya",
    "title": "Reply to Priya with p95 latency numbers",
    "priority": "p0",
    "due": "2026-10-03",
    "owner": "me",
    "rationale": "Priya asked for the p95 latency numbers by the end of the day.",
    "excerpt": "Can you send the p95 latency numbers by EOD?"
  },
  {
    "id": "art_rahul",
    "title": "",
    "priority": "p1",
    "due": null,
    "owner": "me",
    "rationale": "The subject looks like an ask but no title was produced.",
    "excerpt": "Could you send the numbers?"
  },
  {
    "id": "art_news",
    "title": "Decline the TypeScript newsletter",
    "priority": "p2",
    "due": null,
    "owner": "agent",
    "rationale": "The newsletter asked for a subscription confirmation.",
    "excerpt": "Confirm your subscription to keep receiving TS Weekly."
  }
]
\`\`\`
`;

function read(reply: unknown): { todos: ReturnType<typeof readTriageTodos>; skipped: string[] } {
  const skipped: string[] = [];
  const todos = readTriageTodos(reply, IDS, (reason) => skipped.push(reason));
  return { todos, skipped };
}

test("an object with todos and extra keys keeps every valid todo", () => {
  const { todos, skipped } = read({
    notes: "two asks",
    todos: [PRIYA, { id: "art_rahul" }, RAHUL],
  });
  assert.deepEqual(todos, [PRIYA, RAHUL]);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0] ?? "", /missing title/);
});

test("a bare array of todos is kept", () => {
  const { todos, skipped } = read([PRIYA, RAHUL]);
  assert.deepEqual(todos, [PRIYA, RAHUL]);
  assert.deepEqual(skipped, []);
});

test("an array of per-email objects keeps nested todos and does not invent a null one", () => {
  const { todos, skipped } = read([
    {
      id: "art_priya",
      from: "Priya Shah <priya@fieldnote.dev>",
      subject: "p95 latency numbers",
      todo: {
        title: PRIYA.title,
        priority: "p0",
        due: "2026-10-03",
        owner: "me",
        rationale: PRIYA.rationale,
        excerpt: PRIYA.excerpt,
      },
    },
    {
      email: { id: "art_rahul", subject: "Load test numbers before Thursday?" },
      todos: [
        {
          title: RAHUL.title,
          priority: "p1",
          due: "2026-10-08",
          owner: "me",
          rationale: RAHUL.rationale,
          excerpt: RAHUL.excerpt,
        },
      ],
    },
    { id: "art_news", subject: "This week in TypeScript", todo: null },
  ]);
  assert.deepEqual(todos, [PRIYA, RAHUL]);
  assert.deepEqual(skipped, []);
});

test("a fenced Gemini array keeps valid todos and logs the blank title", () => {
  const { todos, skipped } = read(GEMINI_ARRAY_REPLY);
  assert.deepEqual(todos, [
    PRIYA,
    {
      id: "art_news",
      title: "Decline the TypeScript newsletter",
      priority: "p2",
      due: null,
      owner: "agent",
      rationale: "The newsletter asked for a subscription confirmation.",
      excerpt: "Confirm your subscription to keep receiving TS Weekly.",
    },
  ]);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0] ?? "", /art_rahul|missing title/);
  assert.match(skipped[0] ?? "", /missing title/);
});

test("an array with leading and trailing prose is kept", () => {
  const reply = `I sorted the inbox.\n${JSON.stringify([PRIYA, RAHUL])}\nLet me know if you want these filed.`;
  const { todos, skipped } = read(reply);
  assert.deepEqual(todos, [PRIYA, RAHUL]);
  assert.deepEqual(skipped, []);
});

test("one bad item does not drop the valid todos around it", () => {
  const { todos, skipped } = read({
    todos: [
      PRIYA,
      { id: "art_rahul" },
      "nope",
      { title: "Missing the id" },
      { id: "not-in-batch", title: "Hallucinated follow-up", priority: "p2", owner: "me" },
      {
        id: "art_news",
        title: "   ",
        priority: "p2",
      },
      {
        id: "art_news",
        title: "Decline the TypeScript newsletter",
        priority: "high",
        due: null,
        owner: "agent",
        rationale: "Asked to confirm.",
        excerpt: "Confirm your subscription.",
        subject: "ignored",
      },
    ],
  });
  assert.deepEqual(
    todos.map((todo) => todo.id),
    ["art_priya", "art_news"],
  );
  assert.equal(todos[1]?.title, "Decline the TypeScript newsletter");
  assert.equal(todos[1]?.priority, "high");
  assert.equal("subject" in (todos[1] ?? {}), false);
  assert.ok(skipped.some((reason) => /missing title/.test(reason)));
  assert.ok(skipped.some((reason) => /not an object/.test(reason)));
  assert.ok(skipped.some((reason) => /missing id/.test(reason)));
  assert.ok(skipped.some((reason) => /unknown id not-in-batch/.test(reason)));
});

test("a subject line is not turned into a title", () => {
  const { todos, skipped } = read([
    { id: "art_priya", subject: "Reply to Priya with p95 latency numbers", priority: "p0" },
  ]);
  assert.deepEqual(todos, []);
  assert.ok(skipped.some((reason) => /missing title/.test(reason)));
});

test("unparseable prose is the usual JSON error and does not invent todos", () => {
  const skipped: string[] = [];
  const reply = "Priya asked for the p95 numbers by EOD. I would make that a todo.";
  assert.throws(
    () => readTriageTodos(reply, IDS, (reason) => skipped.push(reason)),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /^The model did not return JSON:/);
      assert.ok(error.message.includes(reply.slice(0, 40)));
      return true;
    },
  );
  assert.deepEqual(skipped, []);
  assert.throws(() => parseModelJson(reply), /The model did not return JSON:/);
});

test("parseModelJson still lifts an object out of prose and also lifts arrays", () => {
  assert.deepEqual(parseModelJson('Here you go {"todos":[{"id":"a"}]}'), { todos: [{ id: "a" }] });
  assert.deepEqual(parseModelJson('```json\n[{"id":"art_priya","title":"Reply"}]\n```'), [
    { id: "art_priya", title: "Reply" },
  ]);
  assert.deepEqual(parseModelJson('Notes before.\n[{"id":"art_priya"}]\nNotes after, with a } brace.'), [
    { id: "art_priya" },
  ]);
  assert.deepEqual(parseModelJson('Note {"excerpt":"use {braces}","todos":[{"id":"a"}]} trailing }'), {
    excerpt: "use {braces}",
    todos: [{ id: "a" }],
  });
});

const FOUR = [
  PRIYA,
  RAHUL,
  { id: "art_sam", title: "Reply to Sam about the rollout", priority: "p1", owner: "me" },
  { id: "art_anika", title: "Reply to Anika about the design review", priority: "p1", owner: "me" },
];
const FOUR_IDS = new Set(FOUR.map((todo) => todo.id));

function ask(id: string, name: string, subject: string): HeuristicSource {
  return {
    id,
    input: {
      kind: "email",
      title: subject,
      text: `Can you take a look at ${subject}?`,
      participants: [{ name }],
      metadata: { directlyToMe: true },
    },
  };
}

const ASKS = [
  ask("art_priya", "Priya Shah", "p95 latency numbers"),
  ask("art_rahul", "Rahul Mehta", "load test numbers"),
  ask("art_sam", "Sam Ortiz", "the rollout note"),
  ask("art_anika", "Anika Bose", "the design review"),
];

function readFour(reply: string): { todos: ReturnType<typeof readTriageTodos>; skipped: string[] } {
  const skipped: string[] = [];
  const todos = readTriageTodos(reply, FOUR_IDS, (reason) => skipped.push(reason));
  return { todos, skipped };
}

test("a citation like [1] does not hide the todos object", () => {
  const reply = `as noted in [1], here:\n\`\`\`json\n${JSON.stringify({ todos: FOUR })}\n\`\`\``;
  const { todos, skipped } = readFour(reply);
  assert.deepEqual(todos, FOUR);
  assert.deepEqual(skipped, []);
});

test("an empty object in prose does not hide the todos object", () => {
  const reply = `Fill in {} first, then: ${JSON.stringify({ todos: FOUR })}`;
  const { todos, skipped } = readFour(reply);
  assert.deepEqual(todos, FOUR);
  assert.deepEqual(skipped, []);
});

test("a cut-off reply falls back to keyword rules for every ask", () => {
  const cutoff = `{"todos":[{"id":"art_priya","title":"Reply to Priya with p95 latency numbers","priority":"p0"},{"id":"art_rahul","ti`;
  const fenced = `\`\`\`json\n${cutoff}`;
  for (const reply of [cutoff, fenced]) {
    assert.throws(() => readFour(reply), /The model did not return JSON:/);
    const decided = triageTodosFromReply(reply, ASKS);
    assert.equal(decided.via, "heuristic");
    assert.match(decided.error ?? "", /^The model did not return JSON:/);
    assert.deepEqual(
      decided.todos.map((todo) => todo.id),
      ["art_priya", "art_rahul", "art_sam", "art_anika"],
    );
    assert.deepEqual(
      decided.todos.map((todo) => todo.title),
      [
        "Reply to Priya Shah: p95 latency numbers",
        "Reply to Rahul Mehta: load test numbers",
        "Reply to Sam Ortiz: the rollout note",
        "Reply to Anika Bose: the design review",
      ],
    );
  }
});

test("forty thousand unmatched braces are no match and stay cheap", () => {
  const reply = "{".repeat(40_000);
  const started = Date.now();
  assert.throws(() => parseModelJson(reply, "triage"), /The model did not return JSON:/);
  assert.ok(Date.now() - started < 1000, "unmatched braces should finish well under a second");
});

test("two JSON objects back to back are no match", () => {
  const reply = `${JSON.stringify({ todos: [PRIYA] })}${JSON.stringify({ todos: [RAHUL] })}`;
  assert.throws(() => read(reply), /The model did not return JSON:/);
});

test("stray braces in prose still leave the todos object", () => {
  const reply = `See the note {draft} before this: ${JSON.stringify({ todos: [PRIYA, RAHUL] })} trailing }`;
  const { todos, skipped } = read(reply);
  assert.deepEqual(todos, [PRIYA, RAHUL]);
  assert.deepEqual(skipped, []);
});

test("a plan reply must be an object with steps", () => {
  assert.deepEqual(
    parseModelJson('as noted in [1], fill in {} first, then: {"steps":[{"id":"s1","title":"Read"}]}', "plan"),
    { steps: [{ id: "s1", title: "Read" }] },
  );
  assert.throws(() => parseModelJson("as noted in [1], fill in {} first", "plan"), /The model did not return JSON:/);
});

test("a stray quote or brace in prose still yields the JSON object", () => {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (message?: unknown) => {
    warnings.push(String(message));
  };
  try {
    const quoted = 'My 27" monitor sits on the desk {"label":"desk","inches":27}';
    assert.deepEqual(parseModelJson(quoted), { label: "desk", inches: 27 });
    const braced = 'See {this note first {"todos":[{"id":"art_priya","title":"Reply to Priya"}]}';
    assert.deepEqual(parseModelJson(braced, "triage"), {
      todos: [{ id: "art_priya", title: "Reply to Priya" }],
    });
  } finally {
    console.warn = original;
  }
  const text = warnings.join("\n");
  assert.match(text, /fell back to a raw scan/);
  assert.match(text, /stray quote/);
  assert.match(text, /stray brace/);
  assert.equal(text.includes("monitor"), false);
  assert.equal(text.includes("27"), false);
  assert.equal(text.includes("art_priya"), false);
  assert.equal(text.includes("this note"), false);
});

test("a keyword fallback warns without the email text", () => {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (message?: unknown) => {
    warnings.push(String(message));
  };
  const reply = "Priya asked for the p95 numbers by EOD. I would make that a todo.";
  try {
    const decided = triageTodosFromReply(reply, ASKS);
    assert.equal(decided.via, "heuristic");
  } finally {
    console.warn = original;
  }
  const text = warnings.join("\n");
  assert.match(text, /triage fell back to keyword rules: the model did not return JSON/);
  assert.equal(text.includes("Priya"), false);
  assert.equal(text.includes("p95"), false);
  assert.equal(text.includes(reply.slice(0, 40)), false);
});

test("deep bracket nesting is no match and a RangeError does not escape", () => {
  const nested = "[".repeat(20_000) + "]".repeat(20_000);
  assert.throws(
    () => parseModelJson(nested, "triage"),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error instanceof RangeError, false);
      assert.match(error.message, /^The model did not return JSON:/);
      return true;
    },
  );

  const original = JSON.parse;
  JSON.parse = () => {
    throw new RangeError("Maximum call stack size exceeded");
  };
  try {
    assert.throws(
      () => parseModelJson("[".repeat(4_000) + "]".repeat(4_000)),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error instanceof RangeError, false);
        assert.match(error.message, /^The model did not return JSON:/);
        return true;
      },
    );
  } finally {
    JSON.parse = original;
  }
});

test("a stated due_time is kept, and a missing one is not invented by the parser", () => {
  const { todos } = read({
    todos: [
      { ...PRIYA, due: "2026-10-06", due_time: "10:00" },
      { ...RAHUL, due: "2026-10-06T15:30:00" },
    ],
  });
  assert.equal(todos[0]?.dueTime, "10:00");
  assert.equal(todos[0]?.due, "2026-10-06");
  assert.equal(todos[1]?.due, "2026-10-06T15:30:00");
  assert.equal(todos[1]?.dueTime, undefined);
});

const kolkata = "Asia/Kolkata";

test("triage uses the stated time in the user's timezone, and 17:00 only when no time is given", () => {
  const atTen = triageDueInstant("2026-10-06", "10:00", kolkata);
  assert.equal(atTen?.toISOString(), "2026-10-06T04:30:00.000Z");
  const fromIso = triageDueInstant("2026-10-06T10:00:00", null, kolkata);
  assert.equal(fromIso?.toISOString(), "2026-10-06T04:30:00.000Z");
  const withSeconds = triageDueInstant("2026-10-06", "10:00:00", kolkata);
  assert.equal(withSeconds?.toISOString(), "2026-10-06T04:30:00.000Z");
  const noTime = triageDueInstant("2026-10-06", null, kolkata);
  assert.equal(noTime?.toISOString(), "2026-10-06T11:30:00.000Z");
  const omitted = triageDueInstant("2026-10-06", undefined, kolkata);
  assert.equal(omitted?.toISOString(), "2026-10-06T11:30:00.000Z");
  const invalid = triageDueInstant("2026-10-06", "10am", kolkata);
  assert.equal(invalid?.toISOString(), "2026-10-06T11:30:00.000Z");
  const badClock = triageDueInstant("2026-10-06", "25:99", kolkata);
  assert.equal(badClock?.toISOString(), "2026-10-06T11:30:00.000Z");
  assert.equal(triageDueInstant(null, "10:00", kolkata), null);
  assert.equal(triageDueInstant("not-a-date", "10:00", kolkata), null);
});

test("an ISO due with Z or an offset keeps its instant instead of the user's wall clock", () => {
  assert.equal(triageDueInstant("2026-10-06T15:00:00Z", null, kolkata)?.toISOString(), "2026-10-06T15:00:00.000Z");
  assert.equal(triageDueInstant("2026-10-06T23:30:00-07:00", null, kolkata)?.toISOString(), "2026-10-07T06:30:00.000Z");
  assert.equal(triageDueInstant("2026-10-06T23:30:00-0700", null, kolkata)?.toISOString(), "2026-10-07T06:30:00.000Z");
  assert.equal(triageDueInstant("2026-10-06T10:00+05:30", null, kolkata)?.toISOString(), "2026-10-06T04:30:00.000Z");
  // A stated due_time is a clock time in the user's zone, as before.
  assert.equal(triageDueInstant("2026-10-06T15:00:00Z", "10:00", kolkata)?.toISOString(), "2026-10-06T04:30:00.000Z");
});

test("the triage prompt asks for a time, absolute dates, and a proposal before Apply", () => {
  assert.match(TRIAGE_PROMPT, /due_time/);
  assert.match(TRIAGE_PROMPT, /HH:MM/);
  assert.match(TRIAGE_PROMPT, /before the Oct 6 release/);
  assert.match(TRIAGE_PROMPT, /not "before the release tomorrow"/);
  assert.match(TRIAGE_PROMPT, /press Apply to create it/);
  assert.match(TRIAGE_PROMPT, /created or drafted/);
});
