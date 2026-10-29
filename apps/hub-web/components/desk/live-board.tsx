"use client";
import { useAssistantSurface } from "@/lib/assistant-surface";

import { ProposalsWidget } from "../today/proposals-widget";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import {
  BookOpen,
  Bot,
  Boxes,
  ChartColumn,
  Crosshair,
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
import { DESK_IDS, type DeskId } from "./desks";
import { arrange, hiddenTilesFor, isDefaultLayout, layoutKey, readLayout } from "./layout";
import { CalendarAgenda } from "./calendar-agenda";
import { tileVisual } from "./tile-visuals";
import { deskRole, tileFitsRole } from "./tile-catalog";
import { liveHero } from "./live-heroes";
import { DeskPreviewProvider, Tile } from "./ui";
import { useLayoutPreference, useTileControls } from "./arrange";
import { DeskAddForm } from "./add-form";
import { parseClock, type DeskField } from "./form-check";
import { byUrgency, dayLabel, isLate } from "./tile-data";

type Row = { id: string; title: string; meta?: string };
type Field = DeskField;
export type Spec = {
  key: string;
  title: string;
  icon: LucideIcon;
  c: number;
  r: number;
  hero?: boolean;
  derived?: boolean;
  kind: string;
  action: string;
  ghost: string;
  sub?: string;
  fields: Field[];
  rows: (live: DeskLive) => Row[];
  stat?: (live: DeskLive) => { v: string; unit?: string; note?: string } | null;
  /** The header count when it is not the number of rows (attendance counts marks). */
  count?: (live: DeskLive) => number;
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

function when(iso: string | null | undefined, today: string) {
  return iso ? dayLabel(iso, today) : "";
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
        rows: (live) => live.limitation.map((row) => ({ id: row.id, title: row.title, meta: `${row.days}d · ${when(row.due, live.today)}${row.court ? ` · ${row.court}` : ""}` })),
        stat: (live) => (live.limitation[0] ? { v: String(live.limitation[0].days), unit: "days", note: live.limitation[0].note ?? live.limitation[0].title } : null),
      }),
      tile({
        key: "hearings", title: "Hearings", icon: Gavel, c: 6, r: 3, kind: "hearing", action: "Add a hearing", ghost: "No hearings listed this week",
        fields: [
          { key: "title", label: "Matter" },
          { key: "day", label: "Date", input: "date" },
          { key: "court", label: "Court", optional: true },
        ],
        rows: (live) => ofType(live, "hearing").map((row) => ({ id: row.id, title: row.title, meta: [when(row.due, live.today), row.court].filter(Boolean).join(" · ") })),
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
        ...live.deliverables.map((row) => ({ id: row.id, title: row.title, meta: when(row.due, live.today) })),
        ...ofType(live, "filing").map((row) => ({ id: row.id, title: row.title, meta: when(row.due, live.today) })),
      ]),
      task("drafts", "Drafts", FileText, 4, 4, "draft", "Add a draft", "Drafts you are in stay here", (live) => ofType(live, "draft").slice(0, 4).map((row) => ({ id: row.id, title: row.title, meta: row.matterStage ?? "" }))),
      task("cause", "Cause list", CalendarClock, 3, 2, "hearing", "Add a hearing", "Today's list is empty", (live) => ofType(live, "hearing").filter((row) => row.due === live.today || (row.due && row.due >= live.today)).slice(0, 3).map((row) => ({ id: row.id, title: row.title, meta: row.court ?? when(row.due, live.today) })), { fields: [{ key: "title", label: "Matter" }, { key: "day", label: "Date", input: "date" }, { key: "court", label: "Court", optional: true }] }),
      tile({
        key: "unbilled", title: "Logged time", icon: Scale, c: 3, r: 2, kind: "time", action: "Log your first hour", ghost: "Hours you log land here",
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
        ...live.deliverables.map((row) => ({ id: row.id, title: row.title, meta: when(row.due, live.today) })),
        ...ofType(live, "deadline").map((row) => ({ id: row.id, title: row.title, meta: when(row.due, live.today) })),
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
        fields: [{ key: "name", label: "Name" }, { key: "present", label: "Status", input: "select", options: [["yes", "Present"], ["no", "Absent"]] }],
        rows: () => [],
        count: (live) => live.attendance.present + live.attendance.absent,
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
      task("plan", "Study plan", ListTodo, 4, 3, "task", "Add a study block", "Open tasks for the week", (live) => byUrgency(openTasks(live)).slice(0, 4).map((row) => ({ id: row.id, title: row.title, meta: when(row.due, live.today) }))),
      tile({
        key: "group", title: "Project group", icon: Users, c: 4, r: 3, kind: "person", action: "Name your group", ghost: "The group is empty",
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
        rows: (live) => live.countdowns.map((row) => ({ id: row.id, title: row.title, meta: `${row.days}d · ${when(row.due, live.today)}` })),
        stat: (live) => (live.countdowns[0] ? { v: String(live.countdowns[0].days), unit: "days", note: `${live.countdowns[0].title} · ${when(live.countdowns[0].due, live.today)}` } : null),
      }),
      task("target", "Today", Target, 4, 2, "revision", "Add today's topic", "One topic is enough", (live) => ofType(live, "revision").slice(0, 2).map((row) => ({ id: row.id, title: row.title, meta: row.subject ?? when(row.due, live.today) })), { fields: [{ key: "title", label: "Topic" }, { key: "subject", label: "Subject", optional: true }] }),
      task("affairs", "Saved", BookOpen, 4, 2, "reading", "Add a note", "What you saved this week", (live) => ofType(live, "reading").slice(0, 2).map((row) => ({ id: row.id, title: row.title }))),
      task("syllabus", "Syllabus", Layers, 6, 3, "phase", "Add a phase", "Phases of the syllabus", (live) => ofType(live, "phase").map((row) => ({ id: row.id, title: row.title, meta: when(row.due, live.today) || row.pipelineStage || "" }))),
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
      task("revision", "Revision", BookOpen, 5, 3, "revision", "Add a revision", "Topics still due", (live) => ofType(live, "revision").map((row) => ({ id: row.id, title: row.title, meta: [row.subject, when(row.due, live.today)].filter(Boolean).join(" · ") })), { fields: [{ key: "title", label: "Topic" }, { key: "subject", label: "Subject", optional: true }, { key: "day", label: "Due", input: "date", optional: true }] }),
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
      tile({ key: "advisor", title: "Advisors", icon: Users, c: 3, r: 3, kind: "person", action: "Add a person", ghost: "Advisor and co-authors", fields: [{ key: "name", label: "Name" }], rows: (live) => live.people.map((row) => ({ id: row.id, title: row.name, meta: row.role ?? "" })) }),
      task("venue", "Venue", Flag, 3, 3, "deadline", "Pick a venue", "The deadline stays up", (live) => live.deliverables.concat(ofType(live, "deadline").map((row) => ({ id: row.id, title: row.title, due: row.due, status: "" }))).map((row) => ({ id: row.id, title: row.title, meta: when(row.due, live.today) }))),
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
      task("syllabus", "Classes", GraduationCap, 4, 3, "phase", "Add a class plan", "What the class is on", (live) => ofType(live, "phase").map((row) => ({ id: row.id, title: row.title, meta: when(row.due, live.today) }))),
      tile({ key: "people", title: "People", icon: Users, c: 4, r: 3, kind: "person", action: "Add a person", ghost: "Students and colleagues", fields: [{ key: "name", label: "Name" }], rows: (live) => live.people.map((row) => ({ id: row.id, title: row.name })) }),
      tile({
        key: "attendance", title: "Attendance", icon: Target, c: 3, r: 2, kind: "attendance", action: "Mark attendance", ghost: "Mark who was in",
        fields: [{ key: "name", label: "Name" }, { key: "present", label: "Status", input: "select", options: [["yes", "Present"], ["no", "Absent"]] }],
        rows: () => [],
        count: (live) => live.attendance.present + live.attendance.absent,
        stat: (live) => {
          const total = live.attendance.present + live.attendance.absent;
          return total ? { v: String(live.attendance.present), unit: "in", note: `${live.attendance.absent} absent` } : null;
        },
      }),
      task("meet", "Meetings", Users, 3, 2, "task", "Add a follow-up", "After class", (live) => live.meetings.map((row) => ({ id: row.id, title: row.title }))),
      task("duty", "Duty", ListTodo, 3, 2, "task", "Add a duty", "What else is on you", (live) => openTasks(live).slice(0, 3).map((row) => ({ id: row.id, title: row.title }))),
      task("paper", "Next paper", Flag, 3, 2, "deadline", "Set the next paper", "The date stays visible", (live) => [
        ...ofType(live, "deadline").map((row) => ({ id: row.id, title: row.title, meta: when(row.due, live.today) })),
        ...live.countdowns.map((row) => ({ id: row.id, title: row.title, meta: when(row.due, live.today) })),
      ]),
    ];
  }
  if (id === "staff") {
    return [
      tile({
        key: "load", title: "Team", icon: Users, c: 8, r: 4, hero: true, kind: "person", action: "Add your team", ghost: "Weekly capacity for each person",
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
      tile({ key: "out", title: "Team contacts", icon: Users, c: 5, r: 3, kind: "person", action: "Add your team", ghost: "Who is on the team", fields: [{ key: "name", label: "Name" }], rows: (live) => live.people.map((row) => ({ id: row.id, title: row.name, meta: row.lastInteraction ? when(row.lastInteraction, live.today) : "" })) }),
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
      task("issues", "Issues", ListTodo, 6, 3, "task", "Add an issue", "Open work", (live) => byUrgency(openTasks(live).filter((row) => row.taskType !== "review")).map((row) => ({ id: row.id, title: row.title }))),
      task("wip", "In progress", Layers, 4, 2, "task", "Name the work in progress", "The cap stays honest", (live) => live.tasks.filter((row) => row.status === "in_progress").map((row) => ({ id: row.id, title: row.title }))),
      task("blocked", "Blocked", Flag, 4, 2, "task", "Log a blocker", "What is stuck", (live) => live.tasks.filter((row) => row.status === "blocked").map((row) => ({ id: row.id, title: row.title }))),
      task("done", "Done", Target, 4, 2, "task", "Add a note", "Finished this week", (live) => live.tasks.filter((row) => row.status === "done").map((row) => ({ id: row.id, title: row.title }))),
    ];
  }
  if (id === "bench") {
    return [
      task("build", "Next milestone", Boxes, 12, 4, "deadline", "Name the next milestone", "The date stays up", (live) => byUrgency(openTasks(live)).slice(0, 4).map((row) => ({ id: row.id, title: row.title, meta: when(row.due, live.today) })), { hero: true }),
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
        key: "log", title: "Build log", icon: Boxes, c: 4, r: 4, kind: "deploy", action: "Log a build", ghost: "What left the bench",
        fields: [{ key: "name", label: "Build" }, { key: "env", label: "Rev", optional: true }],
        rows: (live) => live.deploys.map((row) => ({ id: row.id, title: row.name, meta: row.env })),
      }),
      tile({ key: "count", title: "Still out", icon: Boxes, c: 3, r: 2, kind: "part", action: "Add a part", ghost: "Nothing on the BOM", fields: [{ key: "name", label: "Part" }], rows: (live) => live.parts.filter((row) => row.status !== "in").slice(0, 3).map((row) => ({ id: row.id, title: row.name, meta: row.status })), stat: (live) => (live.parts.length ? { v: String(live.parts.filter((row) => row.status !== "in").length), unit: "out" } : null) }),
      task("lead", "Lead time", CalendarClock, 3, 2, "deadline", "Add a date", "When it is due", (live) => ofType(live, "deadline").map((row) => ({ id: row.id, title: row.title, meta: when(row.due, live.today) }))),
      tile({ key: "result", title: "Last result", icon: Flag, c: 3, r: 2, kind: "test", action: "Log a test run", ghost: "The latest run", fields: [{ key: "name", label: "Test" }, { key: "status", label: "Status", input: "select", options: [["pass", "Pass"], ["fail", "Fail"]] }], rows: (live) => live.tests.slice(0, 2).map((row) => ({ id: row.id, title: row.name, meta: row.status })) }),
      task("next", "Milestone", Flag, 3, 2, "deadline", "Name the next milestone", "The date stays up", (live) => live.deliverables.map((row) => ({ id: row.id, title: row.title, meta: when(row.due, live.today) }))),
    ];
  }
  return [
    task("day", "Your day", CalendarClock, 8, 4, "task", "Add what needs you", "A decision or a review", (live) => byUrgency(openTasks(live)).slice(0, 4).map((row) => ({ id: row.id, title: row.title, meta: when(row.due, live.today) })), { hero: true }),
    task("needs", "Needs you", Flag, 4, 2, "task", "Add a task", "Waiting on you", (live) => openTasks(live).slice(0, 2).map((row) => ({ id: row.id, title: row.title }))),
    tile({ key: "brief", title: "Reminders", icon: CalendarClock, c: 4, r: 2, kind: "deadline", action: "Add a reminder", ghost: "A date you should see", fields: [{ key: "title", label: "Reminder" }, { key: "day", label: "Date", input: "date", optional: true }], rows: (live) => live.reminders.map((row) => ({ id: row.id, title: row.title, meta: when(row.dueDate, live.today) })) }),
    task("focus", "Focus", ListTodo, 6, 3, "task", "Add what needs you", "Open work", (live) => byUrgency(openTasks(live)).map((row) => ({ id: row.id, title: row.title }))),
    task("proposed", "Proposed", Layers, 6, 3, "task", "Add a proposal", "Not decided yet", (live) => live.tasks.filter((row) => row.status === "proposed").map((row) => ({ id: row.id, title: row.title }))),
    tile({ key: "dels", title: "Deliverables", icon: Flag, c: 4, r: 3, kind: "deadline", action: "Name a deliverable", ghost: "So the date stays visible", fields: [{ key: "title", label: "Deliverable" }, { key: "day", label: "Due", input: "date", optional: true }], rows: (live) => live.deliverables.map((row) => ({ id: row.id, title: row.title, meta: when(row.due, live.today) })) }),
    tile({ key: "people", title: "People", icon: Users, c: 4, r: 3, kind: "person", action: "Add a person", ghost: "People on the work", fields: [{ key: "name", label: "Name" }], rows: (live) => live.people.map((row) => ({ id: row.id, title: row.name })) }),
    tile({ key: "reminders", title: "Dates", icon: CalendarClock, c: 4, r: 3, kind: "deadline", action: "Add a date", ghost: "Upcoming dates", fields: [{ key: "title", label: "Title" }, { key: "day", label: "Date", input: "date" }], rows: (live) => live.countdowns.map((row) => ({ id: row.id, title: row.title, meta: `${row.days}d` })).concat(live.reminders.map((row) => ({ id: row.id, title: row.title, meta: when(row.dueDate, live.today) }))) }),
  ];
}

function extraSpecs(extras: ReadonlySet<DeskExtraId>): Spec[] {
  const more: Spec[] = [];
  if (extras.has("deadlines")) {
    more.push(tile({
      key: "deadlines", title: "Deadlines", icon: Hourglass, c: 6, r: 3, kind: "deadline", action: "Add a deadline", ghost: "A date you cannot miss",
      fields: [{ key: "title", label: "Deadline" }, { key: "day", label: "Date", input: "date" }],
      rows: (live) => ofType(live, "deadline").map((row) => ({ id: row.id, title: row.title, meta: when(row.due, live.today) })),
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
      rows: (live) => ofType(live, "hold").map((row) => ({ id: row.id, title: row.title, meta: when(row.due, live.today) })),
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

const DERIVED_ICON: Record<string, LucideIcon> = { calendar: CalendarClock, agenda: CalendarClock, "focus-now": Crosshair, agents: Bot, "your-week": ChartColumn };

let POOL: Map<string, Spec> | null = null;
/** Every live tile any desk can draw, first desk wins on a shared key. A layout may borrow from here. */
export function specPool(): ReadonlyMap<string, Spec> {
  if (POOL) return POOL;
  const pool = new Map<string, Spec>();
  for (const id of DESK_IDS) for (const spec of specsFor(id)) if (!pool.has(spec.key)) pool.set(spec.key, spec);
  for (const spec of extraSpecs(new Set(DESK_EXTRAS.map((extra) => extra.id)))) if (!pool.has(spec.key)) pool.set(spec.key, spec);
  for (const [key, title, ghost, c, r] of [
    ["progress", "Task progress", "A complete picture of your work", 4, 3],
    ["workload", "Workload", "Work grouped by its current status", 6, 3],
    ["agenda", "Calendar agenda", "Upcoming events from your connected calendars", 6, 4],
    ["calendar", "Calendar", "Your dates, with room to plan", 4, 5],
    ["time-split", "Time breakdown", "Where your logged hours go", 4, 3],
    ["due-week", "Week ahead", "Dated work across the next seven days", 6, 3],
    ["focus-now", "Focus now", "Your next three tasks, by date and priority", 4, 3],
    ["agents", "Agents at work", "Agent runs working now and next in line", 4, 3],
    ["your-week", "Your week", "What you finished each day, and your streak", 4, 3],
  ] as const) pool.set(key, { key, title, ghost, c, r, icon: DERIVED_ICON[key] ?? LineChart, kind: "task", action: "Open your board", derived: true, fields: [], rows: () => [], stat: () => ({ v: "0" }) });
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
    others: borrowable(defaults, shown).filter((spec) => tileFitsRole(spec.key, deskRole(deskId, shell.data?.onboardingTemplateId))),
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
  const late = openTasks(live).filter((row) => isLate(row, live.today)).length;
  if (openN && late) return `${openN} open on this desk, ${late} overdue.`;
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
  agenda: "/settings?tab=connections",
  "focus-now": "/board",
  agents: "/runs",
  "your-week": "/recap",
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

export function tileHref(key: string): string | undefined {
  return TILE_HREF[key];
}

export function quietAdd(spec: { key: string; title: string }): string {
  const noun = ADD_NOUN[spec.key] ?? spec.title.toLowerCase();
  return `+ Add ${noun}`.replace(/\bfirst\b/gi, "").replace(/\s+/g, " ").trim();
}

/** A tile has something to show: rows, or a figure such as attendance counts. Today and Context both decide with this. */
export function tileFilled(spec: Pick<Spec, "rows" | "stat">, live: DeskLive): boolean {
  return spec.rows(live).length > 0 || Boolean(spec.stat?.(live));
}

/** A tile's content. `footer` is its quiet action; list tiles put it beside "View all", other tiles below the picture. */
export function TileBody({ spec, live, preview = false, interactivePreview = false, footer }: { spec: Spec; live: DeskLive; preview?: boolean; interactivePreview?: boolean; footer?: ReactNode }) {
  const rows = spec.rows(live);
  const stat = spec.stat?.(live) ?? null;
  const hero = spec.hero ? liveHero({ specKey: spec.key, live, rows, stat }) : null;
  const visual = spec.key === "agenda" || hero ? null : tileVisual({ spec, live, preview, interactive: !preview || interactivePreview, footer, href: tileHref(spec.key) ?? (live.tasks.some((task) => task.id === rows[0]?.id) ? "/board" : undefined) });
  return <>
    <div className="visual-body" data-live-count={rows.length} data-live-hero={hero ? spec.key : undefined} data-list={visual?.list ? "1" : undefined}>
      {spec.key === "agenda" ? <CalendarAgenda live={live} preview={preview} /> : hero || visual?.node}
    </div>
    {visual?.list ? null : footer}
  </>;
}

function stubLive(live: DeskLive, kind: string, values: Record<string, string>): DeskLive {
  const id = `tmp-${Date.now()}`;
  if (kind === "slot") {
    return { ...live, slots: [...live.slots, { id, title: values.title || "Class", weekday: Number(values.weekday || 1), startMin: parseClock(values.start ?? "") ?? 9 * 60, endMin: parseClock(values.end ?? "") ?? 10 * 60, course: values.course ?? "" }] };
  }
  if (kind === "attendance") {
    const present = values.present !== "no";
    return { ...live, attendance: { present: live.attendance.present + (present ? 1 : 0), absent: live.attendance.absent + (present ? 0 : 1) } };
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

/** Tiles that draw their own footer link. */
const OWN_FOOTER = new Set(["focus-now", "agents", "your-week"]);

/** Desk entries saved as open tasks: they are on the board too, so the form and toast say so. */
const BOARD_KINDS = new Set(["hearing", "matter", "filing", "draft", "task", "paper", "reading", "exam", "phase", "revision", "deadline", "review", "concept", "hold"]);

export function LiveBoard({ deskId, live, mobile, plots, formKind = null }: { deskId: DeskId; live: DeskLive; mobile?: boolean; plots?: boolean; formKind?: string | null }) {
  const toast = useToast();
  const client = useQueryClient();
  const layout = useDeskLayout(deskId);
  const [form, setForm] = useState<Spec | null>(null);
  const consumed = useRef<string | null>(null);
  const specs = [...layout.shown];
  const proposals = specPool().get("proposed");
  if (proposals && live.tasks.some((task) => task.status === "proposed") && !specs.some((spec) => spec.key === "proposed") && (!layout.customized || !layout.hidden.includes("proposed"))) {
    specs.splice(Math.min(1, specs.length), 0, proposals);
  }
  const tiles = useTileControls({ shown: specs, hidden: layout.hidden, save: layout.save, customized: layout.customized, mobile, restoreHint: "Add it back from Add a tile." });
  useAssistantSurface("/today", { kind: "desk", tiles: specs.map(spec => ({ key: spec.key, title: spec.title, c: spec.c, r: spec.r })) });

  useEffect(() => {
    const kind = formKind;
    if (!kind || consumed.current === kind || !layout.ready) return;
    const spec = [...specs, ...layout.defaults].find((item) => item.kind === kind || item.key === kind);
    if (!spec) return;
    consumed.current = kind;
    setForm(spec);
  }, [formKind, layout.ready, specs, layout.defaults]);

  async function save(spec: Spec, values: Record<string, string>) {
    const snapshot = client.getQueryData<DeskLive>(["desk-live"]);
    if (snapshot) client.setQueryData(["desk-live"], stubLive(snapshot, spec.kind, values));
    let saved: Awaited<ReturnType<typeof api.deskAdd>>;
    try {
      saved = await api.deskAdd(spec.kind, values);
    } catch (error) {
      if (snapshot) client.setQueryData(["desk-live"], snapshot);
      throw error;
    }
    setForm(null);
    void client.invalidateQueries({ queryKey: ["desk-live"] });
    if (BOARD_KINDS.has(spec.kind)) void client.invalidateQueries({ queryKey: ["tasks"] });
    toast(BOARD_KINDS.has(spec.kind) ? `Added “${saved.title}”. It is a task on your board too.` : `Added “${saved.title}”.`, {
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
  }

  return (
    <>
      {plots ? <PlotsTile mobile={mobile} /> : null}
      {specs.map((spec) => {
        const rows = spec.rows(live);
        const filled = tileFilled(spec, live);
        const size = tiles.sizeOf(spec);
        const control = tiles.controls(spec);
        const footer = spec.key === "agenda" || OWN_FOOTER.has(spec.key) ? null : spec.derived ? <Link className="qadd" href="/board">Open your board →</Link> : (
          <button type="button" className="qadd" data-desk-add={spec.kind} onClick={() => setForm(spec)}>
            {quietAdd(spec)}
          </button>
        );
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
            meta={OWN_FOOTER.has(spec.key) ? undefined : spec.derived ? "Live" : filled ? String(spec.count?.(live) ?? (rows.length || 1)) : "Nothing yet"}
            onAdd={filled && !spec.derived ? () => setForm(spec) : undefined}
            openHref={filled ? tileHref(spec.key) ?? (spec.derived ? "/board" : undefined) : undefined}
            ghost={
              filled
                ? false
                : { label: spec.ghost, sub: spec.sub, action: spec.action, kind: spec.kind, onAction: () => setForm(spec) }
            }
          >
            {filled ? (
              spec.key === "proposed" ? <><ProposalsWidget />{footer}</> : <TileBody spec={{ ...spec, c: size.c, r: size.r }} live={live} footer={footer} />
            ) : null}
          </Tile>
        );
      })}
      {form ? (
        <DeskAddForm
          key={form.key}
          kind={form.kind}
          title={quietAdd(form).replace(/^\+\s*/, "")}
          fields={form.fields}
          note={BOARD_KINDS.has(form.kind) ? <>Saved as a task, so it shows on your <Link href="/board">board</Link> too.</> : undefined}
          onSubmit={(values) => save(form, values)}
          onClose={() => setForm(null)}
          returnFocus={() => document.querySelector<HTMLElement>(`[data-desk-key="${CSS.escape(form.key)}"] [data-desk-add]`)}
        />
      ) : null}
    </>
  );
}

/** A template's Today drawn from sample rows. Nothing in it is interactive. */
export function PreviewTiles({ deskId, tiles, live, mobile = false }: { deskId: DeskId; tiles: ReadonlyArray<readonly [string, number, number]>; live: DeskLive; mobile?: boolean }) {
  const specs = arrange(boardSpecs(deskId), specPool(), { v: 1, exact: true, hidden: [], tiles: tiles.map(([key, c, r]) => ({ key, c, r })) });
  return (
    <DeskPreviewProvider>
      {specs.map((spec) => {
        const rows = spec.rows(live);
        return (
          <Tile key={spec.key} title={spec.title} icon={spec.icon} c={mobile ? 4 : spec.c} r={spec.r} hero={spec.hero} meta={rows.length ? String(rows.length) : undefined}>
            <TileBody spec={spec} live={live} preview />
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
  hearings: ["hearings", "cause"],
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

export function lensSections(id: DeskId, tab: string, live: DeskLive, extras: ReadonlySet<DeskExtraId> = new Set()): Array<{ title: string; kind: string; icon: LucideIcon; rows: Row[]; filled: boolean; spec: Spec }> {
  const source: Partial<Record<string, DeskId>> = { builds: "bench", parts: "bench", tests: "bench", repos: "branch", reviews: "branch", deploys: "branch", assignments: "semester", courses: "semester", subjects: "exam", revision: "exam", papers: "literature", classes: "classes", marking: "classes", matters: "chambers", hearings: "chambers", filings: "chambers", reading: "literature", team: "staff", decisions: "staff", workload: "staff", objectives: "staff", milestones: "bench" };
  if (tab === "assignments") {
    const spec: Spec = { key: "assignments", title: "Assignments", icon: GraduationCap, c: 12, r: 4, kind: "task", action: "Add an assignment", ghost: "Coursework you add to your board", fields: [{ key: "title", label: "Assignment" }], rows: value => value.tasks.filter(row => row.taskType === "assignment").map(row => ({ id: row.id, title: row.title, meta: when(row.due,value.today) })) };
    const rows = spec.rows(live);
    return [{ title: spec.title, kind: spec.kind, icon: spec.icon, rows, filled: rows.length > 0, spec }];
  }
  const all = boardSpecs(source[tab] ?? id, tab === "learning" ? new Set([...extras, "learning" as const]) : extras);
  const aliases: Record<string,string> = { filings: "artifacts", reading: "artifacts", workload: "load", objectives: "load", milestones: "builds" };
  const keys = TAB_MATCH[aliases[tab] ?? tab];
  const specs = !keys ? all.slice(0, 4) : all.filter((spec) => keys.includes(spec.key));
  return specs.slice(0, 4).map((spec) => ({ title: spec.title, kind: spec.kind, icon: spec.icon, rows: spec.rows(live).slice(0, 6), filled: tileFilled(spec, live), spec }));
}
