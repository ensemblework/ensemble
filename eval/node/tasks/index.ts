/**
 * The task list and how `--tasks` picks from it: ids, `suite:core`, `suite:crew`, `suite:hard`, a category, or `all`.
 */
import type { Task } from "../lib/types.js";
import { CORE } from "./core.js";
import { CREW } from "./crew.js";
import { HARD } from "./hard.js";

export const TASKS: Task[] = [...CORE, ...CREW, ...HARD];

export function selectTasks(spec: string): Task[] {
  const wanted = spec.split(",").map((part) => part.trim()).filter(Boolean);
  if (!wanted.length || wanted.includes("all")) return TASKS;
  const chosen = TASKS.filter((task) => wanted.some((name) => name === task.id || name === `suite:${task.suite}` || name === task.category));
  const unknown = wanted.filter((name) => name !== "all" && !TASKS.some((task) => name === task.id || name === `suite:${task.suite}` || name === task.category));
  if (unknown.length) throw new Error(`Unknown task or suite: ${unknown.join(", ")}. Known: ${TASKS.map((task) => task.id).join(", ")}, suite:core, suite:crew, suite:hard, all.`);
  return chosen;
}
