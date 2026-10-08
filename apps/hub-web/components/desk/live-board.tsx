"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import {
  BookOpen,
  Boxes,
  CalendarClock,
  FileText,
  Flag,
  Gavel,
  GitPullRequest,
  GraduationCap,
  Hourglass,
  Layers,
  LineChart,
  ListTodo,
  Scale,
  Target,
  Users,
  type LucideIcon,
} from "lucide-react";
import { api, type DeskLive } from "@/lib/api";
import { plural } from "@/lib/format";
import { DESK_EXTRAS, resolveExtras, type DeskExtraId } from "@/lib/desk-extras";
import { templateDeskLayout } from "@ensemble/shared-types/manifest";
import { useToast } from "@/components/toast";
import { placeCenteredPanel } from "@/lib/place-layer";
import { DESK_IDS, type DeskId } from "./desks";
import { arrange, hiddenTilesFor, isDefaultLayout, layoutKey, readLayout } from "./layout";
import { LiveDraw, liveDrawKind } from "./live-draw";
import { liveHero } from "./live-heroes";
import { DeskPreviewProvider, Num, Tile } from "./ui";
import { useLayoutPreference, useTileControls } from "./arrange";

type Row = { id: string; title: string; meta?: string };
type Field = { key: string; label: string; input?: "text" | "date" | "number" | "select"; options?: Array<[string, string]>; optional?: boolean; placeholder?: string };
export type Spec = {
  key: string;
  title: string;
  icon: LucideIcon;
  c: number;
  r: number;
  hero?: boolean;
  kind: string;
  action: string;
  ghost: string;
  sub?: string;
  fields: Field[];
  rows: (live: DeskLive) => Row[];
  stat?: (live: DeskLive) => { v: string; unit?: string; note?: string } | null;
};

const OPEN = new Set(["todo", "proposed", "in_progress", "blocked", "waiting_approval"]);
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const RULES: Array<[string, string]> = [
  ["30d", "30 days"],
  ["45d", "45 days"],
  ["90d", "90 days"],
  ["120d", "120 days"],
  ["3m", "3 months"],
  ["6m", "6 months"],
];
const WEEKDAYS: Array<[string, string]> = DAYS.map((label, index) => [String(index), label]);

function when(iso: string | null | undefined) {
  if (!iso) return "";
  return new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
}
function hm(min: number) {
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}
function ofType(live: DeskLive, type: string) {
  return live.tasks.filter((row) => row.taskType === type);
}
function openTasks(live: DeskLive) {
  return live.tasks.filter((row) => OPEN.has(row.status));
}
function todaySlots(live: DeskLive) {
  const day = new Date(`${live.today}T00:00:00Z`).getUTCDay();
  return live.slots.filter((row) => row.weekday === day);
}

const titleDay = (label: string, day = "day"): Field[] => [
  { key: "title", label },
  { key: "day", label: "Date", input: "date", optional: true },
];

function tile(partial: Spec): Spec {
  return partial;
}

function specsFor(id: DeskId): Spec[] {
  const task = (key: string, title: string, icon: LucideIcon, c: number, r: number, kind: string, action: string, ghost: string, rows: Spec["rows"], extra?: Partial<Spec>): Spec =>
    tile({ key, title, icon, c, r, kind, action, ghost, fields: titleDay("Title"), rows, ...extra });

  if (id === "chambers") {
    return [
      tile({
        key: "limitation", title: "Limitation", icon: Hourglass, c: 12, r: 4, hero: true, kind: "matter", action: "Add your first limitation date",
        ghost: "The band keeps every limitation date in sight", sub: "Add a matter with its order date. The period is counted here.",
        fields: [
          { key: "title", label: "Matter" },
          { key: "orderDate", label: "Order date", input: "date" },
          { key: "rule", label: "Rule", input: "select", options: RULES },
          { key: "court", label: "Court", optional: true },
        ],
        rows: (live) => live.limitation.map((row) => ({ id: row.id, title: row.title, meta: `${row.days}d · ${when(row.due)}${row.court ? ` · ${row.court}` : ""}` })),
        stat: (live) => (live.limitation[0] ? { v: String(live.limitation[0].days), unit: "days", note: live.limitation[0].note ?? live.limitation[0].title } : null),
      }),
      tile({
        key: "hearings", title: "Hearings", icon: Gavel, c: 6, r: 3, kind: "hearing", action: "Add a hearing", ghost: "No hearings listed this week",
        fields: [
          { key: "title", label: "Matter" },
          { key: "day", label: "Date", input: "date" },
          { key: "court", label: "Court", optional: true },
        ],
        rows: (live) => ofType(live, "hearing").map((row) => ({ id: row.id, title: row.title, meta: [when(row.due), row.court].filter(Boolean).join(" · ") })),
      }),
      tile({
        key: "billable", title: "Billable", icon: Scale, c: 3, r: 3, kind: "time", action: "Log your first hour", ghost: "Set a weekly target",
        fields: [
          { key: "title", label: "Matter" },
          { key: "hours", label: "Hours", input: "number" },
        ],
        rows: (live) => ofType(live, "time").map((row) => ({ id: row.id, title: row.title, meta: `${((row.measure ?? 0) / 60).toFixed(1)} h` })),
        stat: (live) => {
          const mins = ofType(live, "time").reduce((sum, row) => sum + (row.measure ?? 0), 0);
          return mins ? { v: (mins / 60).toFixed(1), unit: "h", note: "Logged on matters" } : null;
        },
      }),
      task("stages", "Stages", Layers, 3, 3, "matter", "Add a matter", "Matters group by stage", (live) => {
        const counts = new Map<string, number>();
        for (const row of ofType(live, "matter")) counts.set(row.matterStage || "Open", (counts.get(row.matterStage || "Open") ?? 0) + 1);
        return [...counts.entries()].map(([name, n]) => ({ id: name, title: name, meta: String(n) }));
      }, { fields: [{ key: "title", label: "Matter" }, { key: "orderDate", label: "Order date", input: "date" }, { key: "rule", label: "Rule", input: "select", options: RULES }] }),
      task("filings", "Filings", FileText, 5, 4, "filing", "Add a filing", "Nothing due to file", (live) => [
        ...live.deliverables.map((row) => ({ id: row.id, title: row.title, meta: when(row.due) })),
        ...ofType(live, "filing").map((row) => ({ id: row.id, title: row.title, meta: when(row.due) })),
      ]),
      task("drafts", "Drafts", FileText, 4, 4, "draft", "Add a draft", "Drafts you are in stay here", (live) => ofType(live, "draft").concat(openTasks(live).filter((row) => row.taskType === "matter")).slice(0, 4).map((row) => ({ id: row.id, title: row.title, meta: row.matterStage ?? "" }))),
      task("cause", "Cause list", CalendarClock, 3, 2, "hearing", "Add a hearing", "Today's list is empty", (live) => ofType(live, "hearing").filter((row) => row.due === live.today || (row.due && row.due >= live.today)).slice(0, 3).map((row) => ({ id: row.id, title: row.title, meta: row.court ?? when(row.due) })), { fields: [{ key: "title", label: "Matter" }, { key: "day", label: "Date", input: "date" }, { key: "court", label: "Court", optional: true }] }),
      tile({
        key: "unbilled", title: "Unbilled", icon: Scale, c: 3, r: 2, kind: "time", action: "Log your first hour", ghost: "Hours you log land here",
        fields: [{ key: "title", label: "Matter" }, { key: "hours", label: "Hours", input: "number" }],
        rows: (live) => ofType(live, "time").slice(0, 2).map((row) => ({ id: row.id, title: row.title, meta: `${((row.measure ?? 0) / 60).toFixed(1)} h` })),
        stat: (live) => {
          const mins = ofType(live, "time").reduce((sum, row) => sum + (row.measure ?? 0), 0);
          return mins ? { v: (mins / 60).toFixed(1), unit: "h" } : null;
        },
      }),
      task("focus", "Focus", ListTodo, 6, 3, "task", "Add what needs you", "Open work shows here", (live) => openTasks(live).slice(0, 4).map((row) => ({ id: row.id, title: row.title, meta: row.taskType ?? "" }))),
      task("follow", "Follow-ups", Users, 6, 3, "task", "Add a follow-up", "People and notes you owe", (live) => [
        ...live.meetings.map((row) => ({ id: row.id, title: row.title, meta: "Meeting" })),
        ...live.people.slice(0, 3).map((row) => ({ id: row.id, title: row.name, meta: row.role ?? "Person" })),
      ]),
    ];
  }
  if (id === "semester") {
    return [
      tile({
        key: "week", title: "This week", icon: CalendarClock, c: 12, r: 4, hero: true, kind: "slot", action: "Add your timetable", ghost: "The week is waiting for a class",
        fields: [
          { key: "title", label: "Class" },
          { key: "weekday", label: "Day", input: "select", options: WEEKDAYS },
          { key: "start", label: "Start", placeholder: "09:00" },
          { key: "end", label: "End", placeholder: "10:15" },
          { key: "course", label: "Course", optional: true },
        ],
        rows: (live) => live.slots.map((row) => ({ id: row.id, title: row.title, meta: `${DAYS[row.weekday]} ${hm(row.startMin)}–${hm(row.endMin)}${row.course ? ` · ${row.course}` : ""}` })),
        stat: (live) => (todaySlots(live)[0] ? { v: String(todaySlots(live).length), unit: "today", note: todaySlots(live).map((row) => row.title).join(" · ") } : live.slots[0] ? { v: String(live.slots.length), unit: live.slots.length === 1 ? "class" : "classes" } : null),
      }),
      task("deadlines", "Deadlines", Flag, 4, 4, "deadline", "Add a deadline", "Dates you name stay on the rail", (live) => [
        ...live.deliverables.map((row) => ({ id: row.id, title: row.title, meta: when(row.due) })),
        ...ofType(live, "deadline").map((row) => ({ id: row.id, title: row.title, meta: when(row.due) })),
      ]),
      tile({
        key: "courses", title: "Courses", icon: GraduationCap, c: 8, r: 2, kind: "slot", action: "Add your timetable", ghost: "Courses come from the timetable",
        fields: [{ key: "title", label: "Class" }, { key: "weekday", label: "Day", input: "select", options: WEEKDAYS }, { key: "start", label: "Start", placeholder: "09:00" }, { key: "end", label: "End", placeholder: "10:15" }, { key: "course", label: "Course", optional: true }],
        rows: (live) => {
          const names = new Map<string, number>();
          for (const row of live.slots) names.set(row.course || row.title, (names.get(row.course || row.title) ?? 0) + 1);
          return [...names.entries()].map(([name, n]) => ({ id: name, title: name, meta: plural(n, "slot") }));
        },
      }),
      tile({
        key: "streak", title: "Attendance", icon: Target, c: 5, r: 2, kind: "attendance", action: "Mark attendance", ghost: "One mark starts the count",
        fields: [{ key: "name", label: "Name" }, { key: "present", label: "Present", input: "select", options: [["yes", "Present"], ["no", "Absent"]] }],
        rows: () => [],
        stat: (live) => {
          const total = live.attendance.present + live.attendance.absent;
          return total ? { v: String(Math.round((live.attendance.present / total) * 100)), unit: "%", note: `${live.attendance.present} present · ${live.attendance.absent} absent` } : null;
        },
      }),
      tile({
        key: "now", title: "Now", icon: CalendarClock, c: 3, r: 2, kind: "slot", action: "Add your timetable", ghost: "Nothing on today",
        fields: [{ key: "title", label: "Class" }, { key: "weekday", label: "Day", input: "select", options: WEEKDAYS }, { key: "start", label: "Start", placeholder: "09:00" }, { key: "end", label: "End", placeholder: "10:15" }],
        rows: (live) => todaySlots(live).map((row) => ({ id: row.id, title: row.title, meta: hm(row.startMin) })),
      }),
      task("plan", "Study plan", ListTodo, 4, 3, "task", "Add a study block", "Open tasks for the week", (live) => openTasks(live).slice(0, 4).map((row) => ({ id: row.id, title: row.title, meta: when(row.due) }))),
      tile({
        key: "group", title: "People", icon: Users, c: 4, r: 3, kind: "person", action: "Name your group", ghost: "The group is empty",
        fields: [{ key: "name", label: "Name" }],
        rows: (live) => live.people.map((row) => ({ id: row.id, title: row.name, meta: row.role ?? "" })),
      }),
      task("reading", "Reading", BookOpen, 4, 3, "reading", "Add a reading", "A paper or a chapter", (live) => ofType(live, "reading").concat(openTasks(live).filter((row) => row.taskType === "reading")).slice(0, 4).map((row) => ({ id: row.id, title: row.title }))),
    ];
  }
  if (id === "exam") {
    return [
      tile({
        key: "countdown", title: "Countdown", icon: Hourglass, c: 8, r: 4, hero: true, kind: "exam", action: "Set the exam date", ghost: "The countdown starts from the exam date",
        fields: [{ key: "day", label: "Exam date", input: "date" }],
        rows: (live) => live.countdowns.map((row) => ({ id: row.id, title: row.title, meta: `${row.days}d · ${when(row.due)}` })),
        stat: (live) => (live.countdowns[0] ? { v: String(live.countdowns[0].days), unit: "days", note: `${live.countdowns[0].title} · ${when(live.countdowns[0].due)}` } : null),
      }),
      task("target", "Today", Target, 4, 2, "revision", "Add today's topic", "One topic is enough", (live) => ofType(live, "revision").slice(0, 2).map((row) => ({ id: row.id, title: row.title, meta: row.subject ?? when(row.due) })), { fields: [{ key: "title", label: "Topic" }, { key: "subject", label: "Subject", optional: true }] }),
      task("affairs", "Saved", BookOpen, 4, 2, "reading", "Add a note", "What you saved this week", (live) => ofType(live, "reading").slice(0, 2).map((row) => ({ id: row.id, title: row.title }))),
      task("syllabus", "Syllabus", Layers, 6, 3, "phase", "Add a phase", "Phases of the syllabus", (live) => ofType(live, "phase").map((row) => ({ id: row.id, title: row.title, meta: when(row.due) || row.pipelineStage || "" }))),
      tile({
        key: "mocks", title: "Mocks", icon: Target, c: 6, r: 3, kind: "mock", action: "Log a mock score", ghost: "Two scores make a line",
        fields: [
          { key: "score", label: "Score", input: "number" },
          { key: "outOf", label: "Out of", input: "number" },
          { key: "subject", label: "Subject", optional: true },
        ],
        rows: (live) => ofType(live, "mock").map((row) => ({ id: row.id, title: row.title, meta: row.subject ?? "" })),
        stat: (live) => {
          const mocks = ofType(live, "mock");
          const last = mocks[0];
          return last ? { v: String(last.measure ?? 0), unit: last.weight ? `/ ${last.weight}` : "", note: last.subject || `${mocks.length} logged` } : null;
        },
      }),
      task("revision", "Revision", BookOpen, 5, 3, "revision", "Add a revision", "Topics still due", (live) => ofType(live, "revision").map((row) => ({ id: row.id, title: row.title, meta: [row.subject, when(row.due)].filter(Boolean).join(" · ") })), { fields: [{ key: "title", label: "Topic" }, { key: "subject", label: "Subject", optional: true }, { key: "day", label: "Due", input: "date", optional: true }] }),
      tile({
        key: "hours", title: "Hours", icon: CalendarClock, c: 4, r: 3, kind: "time", action: "Log an hour", ghost: "Hours you study",
        fields: [{ key: "title", label: "What" }, { key: "hours", label: "Hours", input: "number" }],
        rows: (live) => ofType(live, "time").map((row) => ({ id: row.id, title: row.title, meta: `${((row.measure ?? 0) / 60).toFixed(1)} h` })),
        stat: (live) => {
          const mins = ofType(live, "time").reduce((sum, row) => sum + (row.measure ?? 0), 0);
          return mins ? { v: (mins / 60).toFixed(1), unit: "h" } : null;
        },
      }),
      tile({
        key: "accuracy", title: "Accuracy", icon: Target, c: 3, r: 3, kind: "mock", action: "Log a mock score", ghost: "Scores land here",
        fields: [{ key: "score", label: "Score", input: "number" }, { key: "outOf", label: "Out of", input: "number" }, { key: "subject", label: "Subject", optional: true }],
        rows: (live) => ofType(live, "mock").slice(0, 3).map((row) => ({ id: row.id, title: row.subject || row.title, meta: row.weight ? `${Math.round(((row.measure ?? 0) / row.weight) * 100)}%` : "" })),
        stat: (live) => {
          const mocks = ofType(live, "mock").filter((row) => row.weight);
          if (!mocks.length) return null;
          const pct = Math.round(mocks.reduce((sum, row) => sum + ((row.measure ?? 0) / (row.weight || 1)) * 100, 0) / mocks.length);
          return { v: String(pct), unit: "%", note: plural(mocks.length, "paper") };
        },
      }),
    ];
  }
  if (id === "literature") {
    return [
      task("pipeline", "Papers", BookOpen, 12, 4, "paper", "Add a paper", "A paper starts in To read", (live) => ofType(live, "paper").map((row) => ({ id: row.id, title: row.title, meta: row.pipelineStage ?? "" })), { hero: true, fields: [{ key: "title", label: "Paper" }, { key: "stage", label: "Stage", optional: true, placeholder: "To read" }, { key: "words", label: "Words", input: "number", optional: true }] }),
      tile({
        key: "words", title: "Words", icon: FileText, c: 4, r: 3, kind: "paper", action: "Add a paper", ghost: "Word count follows the draft",
        fields: [{ key: "title", label: "Paper" }, { key: "words", label: "Words", input: "number", optional: true }],
        rows: (live) => ofType(live, "paper").filter((row) => row.wordCount != null).map((row) => ({ id: row.id, title: row.title, meta: String(row.wordCount) })),
        stat: (live) => {
          const words = ofType(live, "paper").reduce((sum, row) => sum + (row.wordCount ?? 0), 0);
          return words ? { v: words.toLocaleString("en-GB"), unit: "words" } : null;
        },
      }),
      tile({
        key: "cites", title: "Citations", icon: Layers, c: 4, r: 3, kind: "citation", action: "Add a citation", ghost: "Link a claim to a source",
        fields: [{ key: "from", label: "From" }, { key: "to", label: "Cites" }],
        rows: (live) => live.citations.map((row) => ({ id: row.id, title: row.fromTitle, meta: row.toTitle })),
      }),
      task("read", "Reading", BookOpen, 4, 3, "reading", "Add a reading", "What is open", (live) => ofType(live, "reading").map((row) => ({ id: row.id, title: row.title }))),
      task("questions", "Open questions", ListTodo, 6, 3, "task", "Add a question", "What is still open", (live) => openTasks(live).slice(0, 4).map((row) => ({ id: row.id, title: row.title }))),
      tile({ key: "advisor", title: "People", icon: Users, c: 3, r: 3, kind: "person", action: "Add a person", ghost: "Advisor and co-authors", fields: [{ key: "name", label: "Name" }], rows: (live) => live.people.map((row) => ({ id: row.id, title: row.name, meta: row.role ?? "" })) }),
      task("venue", "Venue", Flag, 3, 3, "deadline", "Pick a venue", "The deadline stays up", (live) => live.deliverables.concat(ofType(live, "deadline").map((row) => ({ id: row.id, title: row.title, due: row.due, status: "" }))).map((row) => ({ id: row.id, title: row.title, meta: when(row.due) }))),
    ];
  }
  if (id === "classes") {
    return [
      tile({
        key: "periods", title: "Periods", icon: CalendarClock, c: 12, r: 4, hero: true, kind: "slot", action: "Add today's periods", ghost: "The timetable fills from the periods you add",
        fields: [{ key: "title", label: "Period" }, { key: "weekday", label: "Day", input: "select", options: WEEKDAYS }, { key: "start", label: "Start", placeholder: "09:00" }, { key: "end", label: "End", placeholder: "09:45" }, { key: "course", label: "Class", optional: true }],
        rows: (live) => live.slots.map((row) => ({ id: row.id, title: row.title, meta: `${DAYS[row.weekday]} ${hm(row.startMin)}` })),
      }),
      tile({
        key: "marking", title: "Marking", icon: FileText, c: 4, r: 3, kind: "grade", action: "Add a set to mark", ghost: "The pile has a class",
        fields: [{ key: "className", label: "Class" }, { key: "expected", label: "Expected", input: "number" }, { key: "marked", label: "Marked", input: "number" }],
        rows: (live) => live.grading.map((row) => ({ id: row.id, title: row.className, meta: `${row.marked}/${row.expected}` })),
        stat: (live) => {
          const left = live.grading.reduce((sum, row) => sum + Math.max(0, row.expected - row.marked), 0);
          return live.grading.length ? { v: String(left), unit: "left" } : null;
        },
      }),
      task("syllabus", "Classes", GraduationCap, 4, 3, "phase", "Add a class plan", "What the class is on", (live) => ofType(live, "phase").map((row) => ({ id: row.id, title: row.title, meta: when(row.due) }))),
      tile({ key: "people", title: "People", icon: Users, c: 4, r: 3, kind: "person", action: "Add a person", ghost: "Students and colleagues", fields: [{ key: "name", label: "Name" }], rows: (live) => live.people.map((row) => ({ id: row.id, title: row.name })) }),
      tile({
        key: "attendance", title: "Attendance", icon: Target, c: 3, r: 2, kind: "attendance", action: "Mark attendance", ghost: "Mark who was in",
        fields: [{ key: "name", label: "Name" }, { key: "present", label: "Present", input: "select", options: [["yes", "Present"], ["no", "Absent"]] }],
        rows: () => [],
        stat: (live) => {
          const total = live.attendance.present + live.attendance.absent;
          return total ? { v: String(live.attendance.present), unit: "in", note: `${live.attendance.absent} absent` } : null;
        },
      }),
      task("meet", "Meetings", Users, 3, 2, "task", "Add a follow-up", "After class", (live) => live.meetings.map((row) => ({ id: row.id, title: row.title }))),
      task("duty", "Duty", ListTodo, 3, 2, "task", "Add a duty", "What else is on you", (live) => openTasks(live).slice(0, 3).map((row) => ({ id: row.id, title: row.title }))),
      task("paper", "Next paper", Flag, 3, 2, "deadline", "Set the next paper", "The date stays visible", (live) => [
        ...ofType(live, "deadline").map((row) => ({ id: row.id, title: row.title, meta: when(row.due) })),
        ...live.countdowns.map((row) => ({ id: row.id, title: row.title, meta: when(row.due) })),
      ]),
    ];
  }
  if (id === "staff") {
    return [
      tile({
        key: "load", title: "Team", icon: Users, c: 8, r: 4, hero: true, kind: "person", action: "Add your team", ghost: "Load has a name",
        fields: [{ key: "name", label: "Name" }, { key: "capacity", label: "Hours / week", input: "number", optional: true }, { key: "cadence", label: "1:1 every N days", input: "number", optional: true }],
        rows: (live) => live.people.map((row) => ({ id: row.id, title: row.name, meta: row.capacityHours != null ? `${row.capacityHours} h` : row.role ?? "" })),
      }),
      task("blockers", "Blockers", Flag, 4, 4, "task", "Log a blocker", "What is stuck", (live) => live.tasks.filter((row) => row.status === "blocked").map((row) => ({ id: row.id, title: row.title }))),
      tile({
        key: "ones", title: "1:1s", icon: Users, c: 6, r: 3, kind: "person", action: "Set a 1:1 cadence", ghost: "Overdue meetings show once a cadence is set",
        fields: [{ key: "name", label: "Name" }, { key: "cadence", label: "Every N days", input: "number" }],
        rows: (live) => live.people.filter((row) => row.oneOnOneDays).map((row) => ({ id: row.id, title: row.name, meta: `every ${row.oneOnOneDays}d` })),
      }),
      tile({
        key: "objectives", title: "Objectives", icon: Target, c: 6, r: 3, kind: "objective", action: "Add an objective", ghost: "Progress has a home",
        fields: [{ key: "title", label: "Objective" }, { key: "progress", label: "Progress %", input: "number", optional: true }],
        rows: (live) => live.objectives.map((row) => ({ id: row.id, title: row.title, meta: `${row.progress}%` })),
        stat: (live) => (live.objectives[0] ? { v: String(live.objectives[0].progress), unit: "%", note: live.objectives[0].title } : null),
      }),
      task("decisions", "Decisions", ListTodo, 7, 3, "task", "Log a decision", "So it stays decided", (live) => [
        ...live.meetings.map((row) => ({ id: row.id, title: row.title, meta: "Note" })),
        ...ofType(live, "decision").map((row) => ({ id: row.id, title: row.title, meta: "" })),
      ]),
      tile({ key: "out", title: "People", icon: Users, c: 5, r: 3, kind: "person", action: "Add your team", ghost: "Who is on the team", fields: [{ key: "name", label: "Name" }], rows: (live) => live.people.map((row) => ({ id: row.id, title: row.name, meta: row.lastInteraction ? when(row.lastInteraction) : "" })) }),
    ];
  }
  if (id === "branch") {
    return [
      task("reviews", "Reviews", GitPullRequest, 8, 4, "review", "Add a review", "Reviews waiting on you", (live) => ofType(live, "review").slice(0, 4).map((row) => ({ id: row.id, title: row.title, meta: "PR" })), { hero: true }),
      tile({ key: "repos", title: "Repos", icon: GitPullRequest, c: 4, r: 2, kind: "review", action: "Name the work", ghost: "Linked repos show here", fields: [{ key: "title", label: "Review" }], rows: (live) => live.repos.map((row) => ({ id: row.id, title: row.fullName })) }),
      tile({
        key: "checks", title: "Checks", icon: Flag, c: 4, r: 2, kind: "test", action: "Add a check", ghost: "A failing check stays visible",
        fields: [{ key: "name", label: "Check" }, { key: "status", label: "Status", input: "select", options: [["fail", "Fail"], ["pass", "Pass"], ["unknown", "Unknown"]] }],
        rows: (live) => live.tests.map((row) => ({ id: row.id, title: row.name, meta: row.status })),
      }),
      tile({
        key: "deploys", title: "Deploys", icon: Boxes, c: 6, r: 3, kind: "deploy", action: "Log a deploy", ghost: "What shipped",
        fields: [{ key: "name", label: "Name" }, { key: "env", label: "Env", optional: true, placeholder: "prod" }],
        rows: (live) => live.deploys.map((row) => ({ id: row.id, title: row.name, meta: row.env })),
      }),
      task("issues", "Issues", ListTodo, 6, 3, "task", "Add an issue", "Open work", (live) => openTasks(live).filter((row) => row.taskType !== "review").slice(0, 4).map((row) => ({ id: row.id, title: row.title }))),
      task("wip", "In progress", Layers, 4, 2, "task", "Name the work in progress", "The cap stays honest", (live) => live.tasks.filter((row) => row.status === "in_progress").map((row) => ({ id: row.id, title: row.title }))),
      task("blocked", "Blocked", Flag, 4, 2, "task", "Log a blocker", "What is stuck", (live) => live.tasks.filter((row) => row.status === "blocked").map((row) => ({ id: row.id, title: row.title }))),
      task("done", "Done", Target, 4, 2, "task", "Add a note", "Finished this week", (live) => live.tasks.filter((row) => row.status === "done").slice(0, 3).map((row) => ({ id: row.id, title: row.title }))),
    ];
  }
  if (id === "bench") {
    return [
      task("build", "Build", Boxes, 12, 4, "deadline", "Name the next milestone", "The date stays up", (live) => openTasks(live).slice(0, 4).map((row) => ({ id: row.id, title: row.title, meta: when(row.due) })), { hero: true }),
      tile({
        key: "parts", title: "Parts", icon: Boxes, c: 4, r: 4, kind: "part", action: "Add a part", ghost: "Parts get a status",
        fields: [{ key: "name", label: "Part" }, { key: "qty", label: "Qty", input: "number", optional: true }, { key: "status", label: "Status", input: "select", options: [["out", "Out"], ["ordered", "Ordered"], ["in", "In"]] }],
        rows: (live) => live.parts.map((row) => ({ id: row.id, title: row.name, meta: `${row.qty} · ${row.status}` })),
        stat: (live) => (live.parts.length ? { v: String(live.parts.filter((row) => row.status === "out").length), unit: "out", note: plural(live.parts.length, "part") } : null),
      }),
      tile({
        key: "tests", title: "Tests", icon: Flag, c: 4, r: 4, kind: "test", action: "Log a test run", ghost: "Pass and fail show",
        fields: [{ key: "name", label: "Test" }, { key: "build", label: "Build", optional: true }, { key: "status", label: "Status", input: "select", options: [["pass", "Pass"], ["fail", "Fail"], ["unknown", "Unknown"]] }],
        rows: (live) => live.tests.map((row) => ({ id: row.id, title: row.name, meta: [row.build, row.status].filter(Boolean).join(" · ") })),
      }),
      tile({
        key: "log", title: "Builds", icon: Boxes, c: 4, r: 4, kind: "deploy", action: "Log a build", ghost: "What left the bench",
        fields: [{ key: "name", label: "Build" }, { key: "env", label: "Rev", optional: true }],
        rows: (live) => live.deploys.map((row) => ({ id: row.id, title: row.name, meta: row.env })),
      }),
      tile({ key: "count", title: "Still out", icon: Boxes, c: 3, r: 2, kind: "part", action: "Add a part", ghost: "Nothing on the BOM", fields: [{ key: "name", label: "Part" }], rows: (live) => live.parts.filter((row) => row.status !== "in").slice(0, 3).map((row) => ({ id: row.id, title: row.name, meta: row.status })), stat: (live) => (live.parts.length ? { v: String(live.parts.filter((row) => row.status !== "in").length), unit: "out" } : null) }),
      task("lead", "Lead time", CalendarClock, 3, 2, "deadline", "Add a date", "When it is due", (live) => ofType(live, "deadline").map((row) => ({ id: row.id, title: row.title, meta: when(row.due) }))),
      tile({ key: "result", title: "Last result", icon: Flag, c: 3, r: 2, kind: "test", action: "Log a test run", ghost: "The latest run", fields: [{ key: "name", label: "Test" }, { key: "status", label: "Status", input: "select", options: [["pass", "Pass"], ["fail", "Fail"]] }], rows: (live) => live.tests.slice(0, 2).map((row) => ({ id: row.id, title: row.name, meta: row.status })) }),
      task("next", "Milestone", Flag, 3, 2, "deadline", "Name the next milestone", "The date stays up", (live) => live.deliverables.map((row) => ({ id: row.id, title: row.title, meta: when(row.due) }))),
    ];
  }
  return [
    task("day", "Your day", CalendarClock, 8, 4, "task", "Add what needs you", "A decision or a review", (live) => openTasks(live).slice(0, 4).map((row) => ({ id: row.id, title: row.title, meta: when(row.due) })), { hero: true }),
    task("needs", "Needs you", Flag, 4, 2, "task", "Add a task", "Waiting on you", (live) => openTasks(live).slice(0, 2).map((row) => ({ id: row.id, title: row.title }))),
    tile({ key: "brief", title: "Reminders", icon: CalendarClock, c: 4, r: 2, kind: "deadline", action: "Add a reminder", ghost: "A date you should see", fields: [{ key: "title", label: "Reminder" }, { key: "day", label: "Date", input: "date", optional: true }], rows: (live) => live.reminders.map((row) => ({ id: row.id, title: row.title, meta: when(row.dueDate) })) }),
    task("focus", "Focus", ListTodo, 6, 3, "task", "Add what needs you", "Open work", (live) => openTasks(live).slice(0, 4).map((row) => ({ id: row.id, title: row.title }))),
    task("proposed", "Proposed", Layers, 6, 3, "task", "Add a proposal", "Not decided yet", (live) => live.tasks.filter((row) => row.status === "proposed").map((row) => ({ id: row.id, title: row.title }))),
    tile({ key: "dels", title: "Deliverables", icon: Flag, c: 4, r: 3, kind: "deadline", action: "Name a deliverable", ghost: "So the date stays visible", fields: [{ key: "title", label: "Deliverable" }, { key: "day", label: "Due", input: "date", optional: true }], rows: (live) => live.deliverables.map((row) => ({ id: row.id, title: row.title, meta: when(row.due) })) }),
    tile({ key: "people", title: "People", icon: Users, c: 4, r: 3, kind: "person", action: "Add a person", ghost: "People on the work", fields: [{ key: "name", label: "Name" }], rows: (live) => live.people.map((row) => ({ id: row.id, title: row.name })) }),
    tile({ key: "reminders", title: "Dates", icon: CalendarClock, c: 4, r: 3, kind: "deadline", action: "Add a date", ghost: "Upcoming dates", fields: [{ key: "title", label: "Title" }, { key: "day", label: "Date", input: "date" }], rows: (live) => live.countdowns.map((row) => ({ id: row.id, title: row.title, meta: `${row.days}d` })).concat(live.reminders.map((row) => ({ id: row.id, title: row.title, meta: when(row.dueDate) }))) }),
  ];
}

function extraSpecs(extras: ReadonlySet<DeskExtraId>): Spec[] {
  const more: Spec[] = [];
  if (extras.has("deadlines")) {
    more.push(tile({
      key: "deadlines", title: "Deadlines", icon: Hourglass, c: 6, r: 3, kind: "deadline", action: "Add a deadline", ghost: "A date you cannot miss",
      fields: [{ key: "title", label: "Deadline" }, { key: "day", label: "Date", input: "date" }],
      rows: (live) => ofType(live, "deadline").map((row) => ({ id: row.id, title: row.title, meta: when(row.due) })),
    }));
  }
  if (extras.has("learning")) {
    more.push(tile({
      key: "concepts", title: "What I'm learning", icon: BookOpen, c: 6, r: 3, kind: "concept", action: "Add something you're learning", ghost: "Your own learning, not the class's",
      fields: [{ key: "title", label: "Concept" }, { key: "subject", label: "Where you left it", optional: true }],
      rows: (live) => ofType(live, "concept").map((row) => ({ id: row.id, title: row.title, meta: row.subject ?? "" })),
    }));
  }
  if (extras.has("bench")) {
    more.push(tile({
      key: "hold", title: "On the bench", icon: Boxes, c: 6, r: 3, kind: "hold", action: "What's clamped", ghost: "The piece in front of you, and the next check",
      fields: [{ key: "title", label: "What's clamped" }, { key: "day", label: "Next check", input: "date", optional: true }],
      rows: (live) => ofType(live, "hold").map((row) => ({ id: row.id, title: row.title, meta: when(row.due) })),
    }));
  }
  return more;
}

export function boardSpecs(id: DeskId, extras: ReadonlySet<DeskExtraId> = new Set()): Spec[] {
  const base = specsFor(id);
  const keys = new Set(base.map((spec) => spec.key));
  return [...base, ...extraSpecs(extras).filter((spec) => !keys.has(spec.key))];
}

let NATIVE: Set<string> | null = null;
/** Extra tiles that are off and not drawn by any desk on its own. A saved layout cannot bring these back. */
export function extraGates(deskId: DeskId, extras: ReadonlySet<DeskExtraId>) {
  NATIVE ??= new Set(DESK_IDS.flatMap((id) => specsFor(id).map((spec) => spec.key)));
  const own = new Set(specsFor(deskId).map((spec) => spec.key));
  const on = new Set(extraSpecs(extras).map((spec) => spec.key).filter((key) => !own.has(key)));
  const blocked = new Set(DESK_EXTRAS.map((extra) => extra.tile).filter((key) => !on.has(key) && !NATIVE!.has(key)));
  return { extras: on, blocked };
}

let POOL: Map<string, Spec> | null = null;
/** Every live tile any desk can draw, first desk wins on a shared key. A layout may borrow from here. */
export function specPool(): ReadonlyMap<string, Spec> {
  if (POOL) return POOL;
  const pool = new Map<string, Spec>();
  for (const id of DESK_IDS) for (const spec of specsFor(id)) if (!pool.has(spec.key)) pool.set(spec.key, spec);
  for (const spec of extraSpecs(new Set(DESK_EXTRAS.map((extra) => extra.id)))) if (!pool.has(spec.key)) pool.set(spec.key, spec);
  POOL = pool;
  return pool;
}

type Prefs = Awaited<ReturnType<typeof api.preferences>>;

/** Tiles from other desks, one per title. A title this desk already has is left out. */
function borrowable(defaults: Spec[], shown: Spec[]): Spec[] {
  const taken = new Set([...defaults, ...shown].flatMap((spec) => [spec.key, `t:${spec.title.toLowerCase()}`]));
  const out: Spec[] = [];
  for (const spec of specPool().values()) {
    const title = `t:${spec.title.toLowerCase()}`;
    if (taken.has(spec.key) || taken.has(title)) continue;
    taken.add(title);
    out.push(spec);
  }
  return out;
}

/** The person's arrangement of this desk: order, sizes, and what they hid. Saved per desk in preferences. */
export function useDeskLayout(deskId: DeskId) {
  const client = useQueryClient();
  const toast = useToast();
  const key = layoutKey(deskId);
  const { prefs, layout, save } = useLayoutPreference(key);
  const shell = useQuery({ queryKey: ["shell"], queryFn: api.shell, staleTime: 30_000 });
  const extraValue = prefs.data?.preferences.find((row) => row.key === "desk.extras")?.value;
  const enabled = resolveExtras(deskId, extraValue);
  const defaults = boardSpecs(deskId, enabled);
  const gates = extraGates(deskId, enabled);
  // Reset goes back to the arrangement the signup template chose for this desk, not the bare desk.
  const template = templateDeskLayout(shell.data?.onboardingTemplateId ?? "");
  const start = template && template.desk === deskId ? template.value : null;
  const baseline = start ? arrange(defaults, specPool(), readLayout(start), gates) : defaults;
  const shown = arrange(defaults, specPool(), layout, gates);
  const hidden = layout?.exact ? hiddenTilesFor(defaults, shown).map((spec) => spec.key) : (layout?.hidden ?? []);
  return {
    ready: prefs.isSuccess,
    defaults,
    shown,
    hidden,
    customized: !isDefaultLayout(layout, shown, baseline),
    reset: () => save(start),
    hiddenSpecs: hiddenTilesFor(defaults, shown),
    others: borrowable(defaults, shown),
    save,
  };
}

/** Rows the person added. Signup starters, people, and reminders do not dismiss the sample offer. */
export function ownCount(live: DeskLive): number {
  return (
    live.tasks.filter((row) => !row.starter).length +
    live.slots.length +
    live.parts.length +
    live.tests.length +
    live.grading.length +
    live.citations.length +
    live.objectives.length +
    live.deploys.length
  );
}

export function liveCount(live: DeskLive): number {
  return (
    live.tasks.length +
    live.slots.length +
    live.deliverables.length +
    live.people.length +
    live.parts.length +
    live.tests.length +
    live.grading.length +
    live.citations.length +
    live.objectives.length +
    live.deploys.length +
    live.meetings.length +
    live.reminders.length +
    live.limitation.length
  );
}

export function liveLine(id: DeskId, live: DeskLive): string | null {
  if (!liveCount(live)) return null;
  if (id === "chambers" && live.limitation[0]) return `${plural(live.limitation[0].days, "day")} to ${live.limitation[0].title}.`;
  if (id === "exam" && live.countdowns[0]) return `${plural(live.countdowns[0].days, "day")} to ${live.countdowns[0].title}.`;
  if (id === "semester" && todaySlots(live).length) return `${plural(todaySlots(live).length, "class")} today.`;
  const openN = openTasks(live).length;
  return openN ? `${openN} open on this desk.` : "Your entries are on the desk.";
}

/** Quiet add once a tile has rows. Ghost tiles keep the longer first-time action. */
const ADD_NOUN: Record<string, string> = {
  limitation: "limitation date",
  hearings: "hearing",
  billable: "hour",
  stages: "matter",
  filings: "filing",
  drafts: "draft",
  cause: "hearing",
  unbilled: "hour",
  focus: "task",
  follow: "follow-up",
  week: "class",
  deadlines: "deadline",
  courses: "class",
  streak: "attendance",
  now: "class",
  plan: "study block",
  group: "person",
  reading: "reading",
  countdown: "exam date",
  target: "topic",
  affairs: "note",
  syllabus: "phase",
  mocks: "mock score",
  revision: "revision",
  hours: "hour",
  accuracy: "mock score",
  pipeline: "paper",
  words: "paper",
  cites: "citation",
  read: "reading",
  questions: "question",
  advisor: "person",
  venue: "venue",
  periods: "period",
  marking: "set",
  people: "person",
  attendance: "attendance",
  meet: "follow-up",
  duty: "duty",
  paper: "paper",
  load: "person",
  blockers: "blocker",
  ones: "1:1",
  objectives: "objective",
  decisions: "decision",
  out: "person",
  reviews: "review",
  repos: "review",
  checks: "check",
  deploys: "deploy",
  issues: "issue",
  wip: "task",
  blocked: "blocker",
  done: "note",
  build: "milestone",
  parts: "part",
  tests: "test run",
  log: "build",
  count: "part",
  lead: "date",
  result: "test run",
  next: "milestone",
  day: "task",
  needs: "task",
  brief: "reminder",
  proposed: "proposal",
  dels: "deliverable",
  reminders: "date",
  concepts: "concept",
  hold: "piece",
};

const TILE_HREF: Record<string, string> = {
  reviews: "/code",
  repos: "/code",
  checks: "/runs",
  deploys: "/metrics",
  issues: "/board",
  wip: "/board",
  blocked: "/board",
  done: "/settings#completed",
  focus: "/board",
  day: "/board",
  needs: "/needs-me",
  proposed: "/board",
};

function tileHref(key: string): string | undefined {
  return TILE_HREF[key];
}

export function quietAdd(spec: { key: string; title: string }): string {
  const noun = ADD_NOUN[spec.key] ?? spec.title.toLowerCase();
  return `+ Add ${noun}`.replace(/\bfirst\b/gi, "").replace(/\s+/g, " ").trim();
}

function Body({ spec, live }: { spec: Spec; live: DeskLive }) {
  const rows = spec.rows(live).slice(0, 5);
  const stat = spec.stat?.(live) ?? null;
  if (spec.hero) {
    const hero = liveHero({ specKey: spec.key, live, rows, stat });
    if (hero) {
      return (
        <div className="col" data-live-count={rows.length} data-live-hero={spec.key} style={{ flex: 1, minHeight: 0 }}>
          {hero}
        </div>
      );
    }
  }
  const kind = liveDrawKind(spec.key);
  const drawn = kind === "ring" ? Boolean(stat) : kind === "bars" || kind === "timeline" ? rows.length > 0 : kind === "heat";
  return (
    <div className="col gap8" data-live-count={rows.length}>
      {drawn && kind ? <LiveDraw specKey={spec.key} rows={rows} stat={stat} /> : null}
      {!drawn && stat ? (
        <div className="row gap12" style={{ alignItems: "flex-end" }}>
          <Num v={stat.v} size={rows.length > 0 && rows.length <= 2 ? 56 : 40} unit={stat.unit} />
          {stat.note ? <span className="trunc" style={{ fontSize: 13, color: "var(--muted)", paddingBottom: 6 }}>{stat.note}</span> : null}
        </div>
      ) : null}
      {kind === "bars" ? null : rows.slice(0, kind === "timeline" ? 3 : 5).map((row) => (
        <div key={row.id} className="row sb" style={{ gap: 8, minWidth: 0 }}>
          <span className="trunc" style={{ fontSize: 13, fontWeight: 600 }}>{row.title}</span>
          {kind === "timeline" ? null : row.meta ? <span className="faint trunc" style={{ fontSize: 12, maxWidth: "46%" }}>{row.meta}</span> : null}
        </div>
      ))}
    </div>
  );
}

function stubLive(live: DeskLive, kind: string, values: Record<string, string>): DeskLive {
  const id = `tmp-${Date.now()}`;
  if (kind === "slot") {
    return { ...live, slots: [...live.slots, { id, title: values.title || "Class", weekday: Number(values.weekday || 1), startMin: 9 * 60, endMin: 10 * 60, course: values.course ?? "" }] };
  }
  if (kind === "matter") {
    return { ...live, limitation: [...live.limitation, { id, title: values.title || "Matter", court: values.court || null, due: values.orderDate || live.today, days: 0, shifted: false, note: "Counting…" }] };
  }
  if (kind === "mock") {
    return { ...live, tasks: [{ id, title: `Mock ${values.score}/${values.outOf}`, status: "done", taskType: "mock", due: live.today, startsAt: null, court: null, matterStage: null, orderDate: null, subject: values.subject || null, weight: Number(values.outOf || 0), wordCount: null, pipelineStage: null, measure: Number(values.score || 0), rule: null, projectId: null }, ...live.tasks] };
  }
  if (kind === "exam") {
    return { ...live, countdowns: [...live.countdowns, { id, title: "Exam", due: values.day || live.today, days: 0 }] };
  }
  return { ...live, tasks: [{ id, title: values.title || values.name || kind, status: "todo", taskType: kind, due: values.day || null, startsAt: null, court: values.court || null, matterStage: null, orderDate: null, subject: values.subject || null, weight: null, wordCount: null, pipelineStage: null, measure: null, rule: null, projectId: null }, ...live.tasks] };
}

export function LiveBoard({ deskId, live, mobile, plots, formKind = null }: { deskId: DeskId; live: DeskLive; mobile?: boolean; plots?: boolean; formKind?: string | null }) {
  const toast = useToast();
  const client = useQueryClient();
  const layout = useDeskLayout(deskId);
  const [form, setForm] = useState<Spec | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  useLayoutEffect(() => {
    const node = formRef.current;
    if (!form || !node) return;
    const place = () => {
      const next = placeCenteredPanel(
        { width: window.innerWidth, height: window.innerHeight },
        node.scrollHeight,
      );
      node.style.top = `${next.top}px`;
      node.style.maxHeight = `${next.maxHeight}px`;
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [form]);
  const consumed = useRef<string | null>(null);
  const specs = layout.shown;
  const tiles = useTileControls({ shown: specs, hidden: layout.hidden, save: layout.save, customized: layout.customized, mobile, restoreHint: "Add it back from Add a tile." });

  useEffect(() => {
    const kind = formKind;
    if (!kind || consumed.current === kind || !layout.ready) return;
    const spec = [...specs, ...layout.defaults].find((item) => item.kind === kind || item.key === kind);
    if (!spec) return;
    consumed.current = kind;
    setForm(spec);
    setValues({});
  }, [formKind, layout.ready, specs, layout.defaults]);

  function open(spec: Spec) {
    setForm(spec);
    setValues({});
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!form || pending) return;
    setPending(true);
    const snapshot = client.getQueryData<DeskLive>(["desk-live"]);
    if (snapshot) client.setQueryData(["desk-live"], stubLive(snapshot, form.kind, values));
    setForm(null);
    try {
      const saved = await api.deskAdd(form.kind, values);
      await client.invalidateQueries({ queryKey: ["desk-live"] });
      toast(`Added “${saved.title}”.`, {
        action: {
          label: "Undo",
          run: () => {
            void (async () => {
              if (saved.undoEntryId) await api.undo(saved.undoEntryId);
              else await api.deskRemove(saved.kind, saved.id);
              await client.invalidateQueries({ queryKey: ["desk-live"] });
            })();
          },
        },
      });
    } catch (error) {
      if (snapshot) client.setQueryData(["desk-live"], snapshot);
      toast((error as Error).message, { tone: "error" });
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      {plots ? <PlotsTile mobile={mobile} /> : null}
      {specs.map((spec) => {
        const rows = spec.rows(live);
        const filled = rows.length > 0 || Boolean(spec.stat?.(live));
        const size = tiles.sizeOf(spec);
        const control = tiles.controls(spec);
        return (
          <Tile
            key={spec.key}
            deskKey={control.deskKey}
            title={spec.title}
            icon={spec.icon}
            c={mobile ? 4 : size.c}
            r={size.r}
            hero={spec.hero}
            attrs={control.attrs}
            grip={control.grip}
            onHide={control.onHide}
            corner={control.corner}
            meta={filled ? `${rows.length || 1}` : "Nothing yet"}
            onAdd={filled ? () => open(spec) : undefined}
            openHref={filled ? tileHref(spec.key) : undefined}
            ghost={
              filled
                ? false
                : { label: spec.ghost, sub: spec.sub, action: spec.action, kind: spec.kind, onAction: () => open(spec) }
            }
          >
            {filled ? (
              <>
                <Body spec={spec} live={live} />
                <button type="button" className="qadd" data-desk-add={spec.kind} onClick={() => open(spec)}>
                  {quietAdd(spec)}
                </button>
              </>
            ) : null}
          </Tile>
        );
      })}
      {form ? (
        <form ref={formRef} className="addpop tile" data-desk-form={form.kind} onSubmit={(event) => void save(event)} style={{ padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
          <div className="row sb">
            <span style={{ fontWeight: 650 }}>{quietAdd(form).replace(/^\+\s*/, "")}</span>
            <button type="button" className="btn" onClick={() => setForm(null)}>Close</button>
          </div>
          {form.fields.map((field) => (
            <label key={field.key} className="col gap4" style={{ fontSize: 12, color: "var(--muted)" }}>
              {field.label}
              {field.input === "select" ? (
                <select className="field" required={!field.optional} value={values[field.key] ?? ""} onChange={(event) => setValues({ ...values, [field.key]: event.target.value })}>
                  <option value="">Choose</option>
                  {field.options?.map(([value, label]) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
              ) : (
                <input
                  className="field"
                  required={!field.optional}
                  type={field.input ?? "text"}
                  placeholder={field.placeholder}
                  value={values[field.key] ?? ""}
                  onChange={(event) => setValues({ ...values, [field.key]: event.target.value })}
                />
              )}
            </label>
          ))}
          <button type="submit" className="btn-p" disabled={pending}>{pending ? "Saving…" : "Save"}</button>
        </form>
      ) : null}
    </>
  );
}

/** A template's Today drawn from sample rows. Nothing in it is interactive. */
export function PreviewTiles({ deskId, tiles, live }: { deskId: DeskId; tiles: ReadonlyArray<readonly [string, number, number]>; live: DeskLive }) {
  const specs = arrange(boardSpecs(deskId), specPool(), { v: 1, exact: true, hidden: [], tiles: tiles.map(([key, c, r]) => ({ key, c, r })) });
  return (
    <DeskPreviewProvider>
      {specs.map((spec) => {
        const rows = spec.rows(live);
        return (
          <Tile key={spec.key} title={spec.title} icon={spec.icon} c={spec.c} r={spec.r} hero={spec.hero} meta={rows.length ? String(rows.length) : undefined}>
            <Body spec={spec} live={live} />
          </Tile>
        );
      })}
    </DeskPreviewProvider>
  );
}

function PlotsTile({ mobile }: { mobile?: boolean }) {
  const plots = useQuery({ queryKey: ["plots"], queryFn: api.plots, staleTime: 30_000 });
  const rows = plots.data?.plots ?? [];
  return (
    <Tile title="Plots" icon={LineChart} c={mobile ? 4 : 4} r={3} meta={rows.length ? String(rows.length) : undefined} openHref="/plots">
      <div data-plots-live className="col gap8">
        {rows.length ? (
          rows.slice(0, 4).map((row) => (
            <Link key={row.id} href={`/plots/${row.id}`} className="row sb" style={{ gap: 8, minWidth: 0 }}>
              <span className="trunc" style={{ fontSize: 13, fontWeight: 600 }}>{row.title}</span>
              {row.datasetName ? <span className="faint trunc" style={{ fontSize: 12, maxWidth: "46%" }}>{row.datasetName}</span> : null}
            </Link>
          ))
        ) : (
          <span style={{ fontSize: 13, color: "var(--muted)" }}>{plots.isFetched ? "Upload a CSV or spreadsheet in Plots to chart it here." : ""}</span>
        )}
      </div>
    </Tile>
  );
}

const TAB_MATCH: Record<string, string[]> = {
  people: ["people", "advisor", "follow", "group", "ones", "out"],
  matters: ["limitation", "hearings", "stages", "filings", "drafts", "cause"],
  papers: ["pipeline", "words", "cites", "read"],
  courses: ["courses", "week", "now"],
  subjects: ["syllabus", "target"],
  mocks: ["mocks", "accuracy"],
  revision: ["revision", "target"],
  classes: ["syllabus", "periods"],
  marking: ["marking", "attendance"],
  team: ["load", "ones", "out"],
  decisions: ["decisions", "blockers"],
  load: ["load", "objectives"],
  repos: ["repos", "reviews"],
  reviews: ["reviews", "wip"],
  deploys: ["deploys", "done"],
  builds: ["build", "log"],
  parts: ["parts", "count"],
  tests: ["tests", "result", "checks"],
  work: ["focus", "needs", "day", "proposed"],
  dates: ["reminders", "dels", "deadlines", "countdown"],
  artifacts: ["cites", "read", "filings"],
  graph: ["cites", "words"],
  deadlines: ["deadlines", "venue"],
  learning: ["concepts"],
};

export function lensSections(id: DeskId, tab: string, live: DeskLive, extras: ReadonlySet<DeskExtraId> = new Set()): Array<{ title: string; kind: string; icon: LucideIcon; rows: Row[] }> {
  const all = boardSpecs(id, extras);
  const keys = TAB_MATCH[tab];
  const specs = !keys ? all.slice(0, 4) : all.filter((spec) => keys.includes(spec.key));
  return specs.slice(0, 4).map((spec) => ({ title: spec.title, kind: spec.kind, icon: spec.icon, rows: spec.rows(live).slice(0, 6) }));
}
