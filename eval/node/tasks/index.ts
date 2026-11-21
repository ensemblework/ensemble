/**
 * The task list and how `--tasks` picks from it: ids, `suite:<name>` (core, crew, hard, orch, code, work), a category, or `all`.
 */
import type { Task } from "../lib/types.js";
import { CORE } from "./core.js";
import { CREW } from "./crew.js";
import { HARD } from "./hard.js";
import { ORCH } from "./orch.js";
import { CODE } from "./code.js";
import { WORK } from "./work.js";

export const TASKS: Task[] = [...CORE, ...CREW, ...HARD, ...ORCH, ...CODE, ...WORK];

export function selectTasks(spec: string): Task[] {
  const wanted = spec.split(",").map((part) => part.trim()).filter(Boolean);
  if (!wanted.length || wanted.includes("all")) return TASKS;
  const chosen = TASKS.filter((task) => wanted.some((name) => name === task.id || name === `suite:${task.suite}` || name === task.category));
  const unknown = wanted.filter((name) => name !== "all" && !TASKS.some((task) => name === task.id || name === `suite:${task.suite}` || name === task.category));
  if (unknown.length) throw new Error(`Unknown task or suite: ${unknown.join(", ")}. Known: ${TASKS.map((task) => task.id).join(", ")}, ${[...new Set(TASKS.map((task) => `suite:${task.suite}`))].join(", ")}, all.`);
  return chosen;
}
