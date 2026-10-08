import type { DeskLive, OnboardingTemplateCard } from "@/lib/api";

type Task = DeskLive["tasks"][number];
type Flavor = {
  tasks: string[];
  people: Array<[name: string, role: string]>;
  meetings: string[];
  reminders: string[];
  deliverables: string[];
  courses: string[];
  artifacts: string[];
  countdown: string;
};

/** Fictional rows for previews. Nothing here is saved. */
const FLAVOR: Record<string, Flavor> = {
  student: {
    tasks: ["Outline the essay", "Problem set 4", "Lab write-up", "Read chapter 7", "Email the TA about the rubric", "Flashcards for week 3"],
    people: [["Priya Nair", "Teammate"], ["Dr. Osei", "Instructor"], ["Leo Park", "Lab partner"], ["Sam Ruiz", "Teammate"]],
    meetings: ["Study group", "Office hours with Dr. Osei", "Lab debrief"],
    reminders: ["Quiz on Thursday", "Submit lab report", "Book the library room"],
    deliverables: ["Lab report", "Midterm essay"],
    courses: ["Calculus II", "Organic Chemistry", "Econ 101", "Writing seminar"],
    artifacts: ["Lecture 6 slides.pdf", "Essay draft v2.docx", "Lab data.xlsx", "Rubric.pdf"],
    countdown: "Final exam",
  },
  teacher: {
    tasks: ["Plan Year 9 fractions", "Worksheet for 8B", "Email Arjun's parents", "Moderate coursework", "New seating plan", "Order lab kits"],
    people: [["Aisha Khan", "Year 9"], ["Tom Reid", "Year 10"], ["Ms. Diaz", "Head of department"], ["Ravi Menon", "Year 9"]],
    meetings: ["Department meeting", "Parent evening", "Check-in with Aisha"],
    reminders: ["Reports due", "Field trip forms", "Mock exam week"],
    deliverables: ["Term reports", "Unit 4 assessment"],
    courses: ["8B Maths", "9A Maths", "10C Maths", "Maths club"],
    artifacts: ["Unit 4 plan.docx", "Fractions worksheet.pdf", "Marks Term 1.xlsx", "Seating plan.png"],
    countdown: "End-of-term paper",
  },
  lawyer: {
    tasks: ["Reply to the notice", "Prepare for the client call", "Review lease clause 14", "Brief senior counsel", "Index of documents", "Settlement memo"],
    people: [["Meera Shah", "Client"], ["R. Iyer", "Opposing counsel"], ["Ana Costa", "Associate"], ["J. Okafor", "Clerk"]],
    meetings: ["Client call: Shah", "Conference with counsel", "Mediation prep"],
    reminders: ["File rejoinder", "Court fee deadline", "Client update"],
    deliverables: ["Written statement", "Settlement draft"],
    courses: ["Court 4", "Chambers", "Mediation", "Client meetings"],
    artifacts: ["Lease agreement.pdf", "Notice dated 2 Sept.pdf", "Draft reply v3.docx", "Evidence index.xlsx"],
    countdown: "Final hearing",
  },
  engineer: {
    tasks: ["Fix the flaky auth test", "Move jobs to the queue", "Review the cache PR", "RFC: rate limits", "Upgrade to Node 22", "Dashboards for p95"],
    people: [["Mira Chen", "Engineer"], ["Dev Patel", "Engineer"], ["Kai Tanaka", "Designer"], ["Lena Ortiz", "Product"]],
    meetings: ["Sprint planning", "Design review", "Incident retro"],
    reminders: ["Release freeze", "On-call handover", "RFC review"],
    deliverables: ["v2.14 release", "Rate limit RFC"],
    courses: ["Standup", "Focus block", "Pairing", "Review hour"],
    artifacts: ["#482 Cache invalidation", "Runbook: queues.md", "Architecture.png", "p95 dashboard"],
    countdown: "Release cut",
  },
  vibe: {
    tasks: ["Hook up Stripe checkout", "Landing page copy", "Fix the mobile nav", "Record a demo video", "Add Google sign-in", "Ask three friends to try it"],
    people: [["Jordan Lee", "Friend"], ["Nia Brooks", "Beta tester"], ["Omar Haddad", "Beta tester"]],
    meetings: ["Demo to Jordan", "Feedback call"],
    reminders: ["Domain renews", "Post the demo", "Reply to testers"],
    deliverables: ["Public beta", "Launch post"],
    courses: ["Build", "Build", "Test", "Ship"],
    artifacts: ["Demo.mp4", "Landing copy.md", "Feedback.csv", "Logo.png"],
    countdown: "Demo day",
  },
  manager: {
    tasks: ["Q4 planning doc", "Promotion packet for Dev", "Hiring plan", "Unblock the design review", "Offsite budget", "Incident retro actions"],
    people: [["Mira Chen", "Engineer"], ["Dev Patel", "Engineer"], ["Kai Tanaka", "Designer"], ["Lena Ortiz", "Product"], ["Sam Wu", "Engineer"]],
    meetings: ["Staff meeting", "Skip-level with Sam", "Roadmap review"],
    reminders: ["Performance reviews open", "Budget due", "Offsite"],
    deliverables: ["Q4 plan", "Hiring plan"],
    courses: ["1:1s", "Staff", "Planning", "Focus"],
    artifacts: ["Q4 plan.docx", "Org chart.png", "Hiring scorecard.pdf", "Roadmap.xlsx"],
    countdown: "Launch",
  },
};

function iso(offset: number, base: Date) {
  const day = new Date(Date.UTC(base.getFullYear(), base.getMonth(), base.getDate() + offset));
  return day.toISOString().slice(0, 10);
}

function task(id: string, title: string, extra: Partial<Task> = {}): Task {
  return {
    id,
    title,
    status: "todo",
    taskType: "task",
    due: null,
    startsAt: null,
    court: null,
    matterStage: null,
    orderDate: null,
    subject: null,
    weight: null,
    wordCount: null,
    pipelineStage: null,
    measure: null,
    rule: null,
    projectId: "p1",
    ...extra,
  };
}

const STATUSES = ["in_progress", "todo", "blocked", "todo", "done", "proposed", "in_progress", "done"];

export function sampleLive(role: string, card?: Pick<OnboardingTemplateCard, "preview"> | null, now = new Date()): DeskLive {
  const flavor = FLAVOR[role] ?? FLAVOR.engineer!;
  const today = iso(0, now);
  const weekday = now.getDay();
  const starter = card?.preview.tasks.map((row) => row.title) ?? [];
  const titles = [...new Set([...starter, ...flavor.tasks])].slice(0, 8);
  const generic = titles.map((title, index) =>
    task(`t${index}`, title, { status: STATUSES[index % STATUSES.length]!, due: index % 3 === 0 ? iso(index + 2, now) : null }),
  );
  const subjects = flavor.courses.slice(0, 3);
  const typed: Task[] = [
    task("dl1", flavor.deliverables[0]!, { taskType: "deadline", due: iso(3, now) }),
    task("dl2", flavor.reminders[0]!, { taskType: "deadline", due: iso(9, now) }),
    task("h1", "Shah v. Northwind", { taskType: "hearing", due: today, court: "High Court, Court 4" }),
    task("h2", "Iyer appeal", { taskType: "hearing", due: iso(2, now), court: "District Court" }),
    task("tm1", "Shah v. Northwind", { taskType: "time", measure: 150 }),
    task("tm2", "Lease review", { taskType: "time", measure: 90 }),
    task("tm3", "Settlement memo", { taskType: "time", measure: 60 }),
    task("m1", "Shah v. Northwind", { taskType: "matter", matterStage: "Pleadings" }),
    task("m2", "Costa lease", { taskType: "matter", matterStage: "Evidence" }),
    task("m3", "Okafor estate", { taskType: "matter", matterStage: "Pleadings" }),
    task("f1", "Written statement", { taskType: "filing", due: iso(5, now) }),
    task("dr1", "Reply to notice, v3", { taskType: "draft", matterStage: "Review" }),
    task("dr2", "Vendor MSA redline", { taskType: "draft", matterStage: "First pass" }),
    task("r1", "Attention Is All You Need", { taskType: "reading" }),
    task("r2", "Chapter 7: Equilibrium", { taskType: "reading" }),
    task("r3", "Case notes: Donoghue v Stevenson", { taskType: "reading" }),
    task("rv1", "Integration by parts", { taskType: "revision", subject: subjects[0] ?? null, due: today }),
    task("rv2", "Reaction mechanisms", { taskType: "revision", subject: subjects[1] ?? null, due: iso(1, now) }),
    task("rv3", "Elasticity", { taskType: "revision", subject: subjects[2] ?? null, due: iso(2, now) }),
    task("mk1", "Mock 3", { taskType: "mock", status: "logged", measure: 78, weight: 100, subject: subjects[0] ?? null }),
    task("mk2", "Mock 2", { taskType: "mock", status: "logged", measure: 71, weight: 100, subject: subjects[1] ?? null }),
    task("mk3", "Mock 1", { taskType: "mock", status: "logged", measure: 62, weight: 100, subject: subjects[0] ?? null }),
    task("ph1", "Unit 1: Foundations", { taskType: "phase", due: iso(-6, now), pipelineStage: "Done" }),
    task("ph2", "Unit 2: Core methods", { taskType: "phase", due: iso(8, now) }),
    task("ph3", "Unit 3: Applications", { taskType: "phase", due: iso(22, now) }),
    task("pp1", "Transformers for small data", { taskType: "paper", pipelineStage: "Drafting", wordCount: 6200 }),
    task("pp2", "A survey of retrieval methods", { taskType: "paper", pipelineStage: "Reading" }),
    task("pp3", "Scaling laws revisited", { taskType: "paper", pipelineStage: "To read" }),
    task("pp4", "Benchmarks that age well", { taskType: "paper", pipelineStage: "Done", wordCount: 8400 }),
    task("rw1", "#482 Cache invalidation", { taskType: "review", status: "in_progress" }),
    task("rw2", "#479 Queue retries", { taskType: "review" }),
    task("rw3", "#475 Upgrade to Node 22", { taskType: "review" }),
    task("dc1", "Ship date moves to the 14th", { taskType: "decision", status: "logged" }),
    task("dc2", "Keep the free plan", { taskType: "decision", status: "logged" }),
    task("cn1", "React server components", { taskType: "concept", subject: "Halfway through the docs" }),
    task("cn2", "Postgres indexes", { taskType: "concept", subject: "Composite keys" }),
    task("cn3", "Prompting for tests", { taskType: "concept" }),
  ];
  const deliverables = [
    ...(card?.preview.deliverables ?? []).map((row, index) => ({ id: `d${index}`, title: row.title, due: row.dueInDays == null ? null : iso(row.dueInDays, now), status: "upcoming" })),
    ...flavor.deliverables.map((title, index) => ({ id: `fd${index}`, title, due: iso(6 + index * 7, now), status: "upcoming" })),
  ].slice(0, 4);
  const people = flavor.people.map(([name, personRole], index) => ({
    id: `pe${index}`,
    name,
    role: personRole,
    capacityHours: [44, 36, 30, 40, 28][index] ?? 32,
    oneOnOneDays: index < 3 ? [7, 14, 7][index]! : null,
    lastInteraction: iso(-(index * 3 + 1), now),
  }));
  const slot = (id: string, title: string, day: number, start: number, length: number, course: string) => ({ id, title, weekday: day, startMin: start, endMin: start + length, course });
  const slots = [
    ...flavor.courses.map((course, index) => slot(`s${index}`, course, (index % 5) + 1, 9 * 60 + (index % 2) * 120, 75, course)),
    slot("st1", flavor.courses[0]!, weekday, 10 * 60, 60, flavor.courses[0]!),
    slot("st2", flavor.courses[1]!, weekday, 14 * 60, 60, flavor.courses[1]!),
  ];
  return {
    today,
    tasks: [...generic, ...typed],
    deliverables,
    people,
    meetings: flavor.meetings.map((title, index) => ({ id: `mt${index}`, title })),
    artifacts: flavor.artifacts.map((title, index) => ({ id: `a${index}`, title, kind: "file", url: null, ts: iso(-index, now), source: index % 2 ? "Drive" : "Upload" })),
    reminders: flavor.reminders.map((title, index) => ({ id: `rm${index}`, title, dueDate: iso(index * 2 + 1, now) })),
    slots,
    holidays: [],
    attendance: { present: 24, absent: 2 },
    objectives: [
      { id: "o1", title: "Activation to 40%", progress: 64 },
      { id: "o2", title: "Cut onboarding time in half", progress: 41 },
      { id: "o3", title: "Zero sev-1 incidents", progress: 82 },
    ],
    deploys: [
      { id: "dp1", name: "api v2.14.0", env: "prod", at: iso(0, now) },
      { id: "dp2", name: "web v2.14.0", env: "prod", at: iso(0, now) },
      { id: "dp3", name: "api v2.14.0-rc2", env: "staging", at: iso(-1, now) },
    ],
    parts: [
      { id: "pa1", name: "Checkout flow", status: "in", qty: 1 },
      { id: "pa2", name: "Sign-in", status: "ordered", qty: 1 },
      { id: "pa3", name: "Pricing page", status: "in", qty: 1 },
    ],
    tests: [
      { id: "ts1", name: "auth e2e", build: "#219", status: "fail" },
      { id: "ts2", name: "checkout", build: "#219", status: "pass" },
      { id: "ts3", name: "unit", build: "#219", status: "pass" },
    ],
    citations: [
      { id: "c1", fromTitle: "Section 2 claim", toTitle: "Vaswani et al. 2017" },
      { id: "c2", fromTitle: "Clause 14.2", toTitle: "Lease Act s. 106" },
      { id: "c3", fromTitle: "Related work", toTitle: "Lewis et al. 2020" },
    ],
    grading: [
      { id: "g1", className: "8B essays", expected: 28, marked: 19 },
      { id: "g2", className: "9A quiz", expected: 31, marked: 31 },
      { id: "g3", className: "10C coursework", expected: 24, marked: 6 },
    ],
    repos: [
      { id: "rp1", fullName: "fieldnote/app" },
      { id: "rp2", fullName: "fieldnote/api" },
    ],
    projects: [{ id: "p1", name: card?.preview.project ?? "Project" }],
    limitation: [
      { id: "l1", title: "Shah v. Northwind", court: "High Court", due: iso(12, now), days: 12, shifted: false, note: "Appeal window" },
      { id: "l2", title: "Costa lease", court: null, due: iso(41, now), days: 41, shifted: false, note: null },
      { id: "l3", title: "Okafor estate", court: "District Court", due: iso(88, now), days: 88, shifted: false, note: null },
    ],
    countdowns: [{ id: "cd1", title: flavor.countdown, due: iso(9, now), days: 9 }],
  };
}

export type BoardLane = { id: string; title: string; cards: Array<{ id: string; title: string; who: string | null; due: string | null }> };

export function sampleBoard(live: DeskLive): BoardLane[] {
  const lanes: Array<[string, string, string[]]> = [
    ["todo", "To do", ["todo", "proposed"]],
    ["doing", "In progress", ["in_progress"]],
    ["stuck", "Waiting", ["blocked", "waiting_approval"]],
    ["done", "Done", ["done"]],
  ];
  const generic = live.tasks.filter((row) => row.taskType === "task");
  return lanes.map(([id, title, statuses], laneIndex) => ({
    id,
    title,
    cards: generic
      .filter((row) => statuses.includes(row.status))
      .slice(0, 3)
      .map((row, index) => ({ id: row.id, title: row.title, who: live.people[(laneIndex + index) % Math.max(1, live.people.length)]?.name ?? null, due: row.due })),
  }));
}
