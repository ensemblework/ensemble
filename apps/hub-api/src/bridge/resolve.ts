export const OPEN_STATUSES = ["proposed", "todo", "in_progress", "waiting_approval", "blocked"] as const;

export interface TaskRef {
  id: string;
  title: string;
  status: string;
  updatedAt: string;
  repoId: string | null;
  projectId: string | null;
}

export type BriefResolution =
  | { kind: "untracked_repo"; repoName: string; message: string }
  | { kind: "ambiguous"; branch: string; candidates: TaskRef[]; message: string }
  | {
      kind: "task";
      task: TaskRef;
      via: "branch" | "recent";
      otherOpen: TaskRef[];
      message: string;
    }
  | {
      kind: "branch_unmatched";
      branch: string;
      closed: TaskRef[];
      message: string;
    }
  | { kind: "repo_only"; message: string }
  | { kind: "no_anchor"; message: string };

export function distinctById(tasks: TaskRef[]): TaskRef[] {
  const map = new Map<string, TaskRef>();
  for (const task of tasks) {
    const prev = map.get(task.id);
    if (!prev || task.updatedAt > prev.updatedAt) map.set(task.id, task);
  }
  return [...map.values()];
}

/**
 * Pick the task a coding session is on.
 * A branch that matches several tasks is ambiguous: name them, do not guess.
 * A branch that matches nothing does not fall through to "most recently touched".
 * With a repo and no branch, the most recently updated open task is the anchor.
 */
export function resolveBriefAnchor(input: {
  repoRequested: string | null;
  repoFound: boolean;
  branch: string | null;
  /** Tasks tied to this branch (jobs or sessions), deleted rows already removed. */
  branchTasks: TaskRef[];
  /** Open tasks on the resolved repo, newest first. Ignored when no repo row exists. */
  openTasksOnRepo: TaskRef[];
}): BriefResolution {
  const branchTasks = distinctById(input.branchTasks);
  const open = input.openTasksOnRepo.filter((task) => (OPEN_STATUSES as readonly string[]).includes(task.status));

  if (input.repoRequested && !input.repoFound) {
    return {
      kind: "untracked_repo",
      repoName: input.repoRequested,
      message: `Repository ${input.repoRequested} is not tracked in Ensemble. Nothing was guessed from another repo.`,
    };
  }

  if (input.branch && branchTasks.length > 1) {
    return {
      kind: "ambiguous",
      branch: input.branch,
      candidates: branchTasks,
      message: `Branch ${input.branch} matches ${branchTasks.length} tasks. No single task was chosen.`,
    };
  }

  if (input.branch && branchTasks.length === 1) {
    const task = branchTasks[0]!;
    const openMatch = (OPEN_STATUSES as readonly string[]).includes(task.status);
    if (!openMatch) {
      return {
        kind: "branch_unmatched",
        branch: input.branch,
        closed: [task],
        message: `Branch ${input.branch} only matches a ${task.status} task (“${task.title}”). It was not treated as the current task.`,
      };
    }
    return {
      kind: "task",
      task,
      via: "branch",
      otherOpen: open.filter((row) => row.id !== task.id).slice(0, 5),
      message: `Branch ${input.branch} matches “${task.title}”.`,
    };
  }

  if (input.branch && branchTasks.length === 0) {
    return {
      kind: "branch_unmatched",
      branch: input.branch,
      closed: [],
      message: input.repoFound
        ? `Branch ${input.branch} matches no task on this repository. Project and repository context is included without guessing a task.`
        : `Branch ${input.branch} matches no task. No repository was resolved either.`,
    };
  }

  if (input.repoFound && open.length > 0) {
    const [task, ...rest] = open;
    return {
      kind: "task",
      task: task!,
      via: "recent",
      otherOpen: rest.slice(0, 5),
      message:
        rest.length > 0
          ? `No branch was given. The most recently updated open task on this repository is “${task!.title}”. ${rest.length} other open task(s) are listed and were not chosen.`
          : `No branch was given. The open task on this repository is “${task!.title}”.`,
    };
  }

  if (input.repoFound) {
    return {
      kind: "repo_only",
      message: "This repository is tracked, and it has no open task. Repository and project context is included without inventing a task.",
    };
  }

  return {
    kind: "no_anchor",
    message: input.branch
      ? "No repository or task matched."
      : "No repository or branch was provided, and none could be resolved. Pass repo and branch, or run the bridge from a git checkout Ensemble tracks.",
  };
}
