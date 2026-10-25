/**
 * What a run changes beyond its own folder's snapshot: files in another folder it was allowed to
 * write, and in a repository its folder's snapshot does not cover (a nested repository, or any
 * repository when the run folder is not one). The first time the run is about to write in such a
 * repository, that repository's working tree is snapshotted, so the change listed at the end is the
 * difference since then, like the run folder's own. A file outside any repository is listed with its
 * line count. The home folder and a disk root are never treated as a repository to snapshot.
 */
import { lstat, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { agentChanges, lineCount, MAX_CHANGED_FILES, runsPrograms, type ChangedFile, type GitRunner } from "./changed-files.js";
import { within } from "./guard.js";

/** Repositories one run snapshots at most. */
export const MAX_TRACKED_REPOS = 10;

type Tracked = { top: string; startTree: string; initialHead: string };
export type RepoChange = { repo: string; startTree: string; endTree: string; initialHead: string; files: ChangedFile[] };

export type RunChangeTools = {
  /** The repository's working tree as a git tree (a throwaway index), or null. */
  snapshot: (repo: string) => Promise<string | null>;
  /** The repository's HEAD commit, or "" when it has none. */
  head: (repo: string) => Promise<string>;
  git: GitRunner;
};

/** How a changed file is named on the web: relative to the run folder inside it, `~/…` in the home folder, else in full. */
export function displayPath(root: string, full: string, home = homedir()): string {
  const slash = (path: string) => path.split(sep).join("/");
  if (within(root, full, false)) return slash(relative(root, full));
  if (within(home, full, false)) return `~/${slash(relative(home, full))}`;
  return slash(full);
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

export class RunChanges {
  private readonly repos = new Map<string, Promise<Tracked | null>>();
  /** Files outside any repository, and whether each existed when the run first wrote it. */
  private readonly loose = new Map<string, boolean>();

  constructor(
    private readonly root: string,
    /** The run folder's own snapshot already covers its repository. */
    private readonly rootSnapshot: boolean,
    private readonly tools: RunChangeTools,
    private readonly home = homedir(),
  ) {}

  /** The repository a path is in: the nearest folder with `.git` above it, never the home folder or a disk root. */
  private async repoOf(path: string): Promise<string | null> {
    let dir = path;
    while (!(await exists(dir))) {
      const parent = dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
    if (!(await stat(dir)).isDirectory()) dir = dirname(dir);
    for (;;) {
      if (dir === this.home || dirname(dir) === dir) return null;
      if (await exists(join(dir, ".git"))) return dir;
      dir = dirname(dir);
    }
  }

  /**
   * Called before the run writes `path` (a file, or with `folder` a folder a command runs in). Takes
   * the repository's starting snapshot the first time. Never throws: tracking never stops a run.
   */
  async note(path: string, options: { folder?: boolean } = {}): Promise<void> {
    try {
      const top = await this.repoOf(path);
      if (!top) {
        if (!options.folder && !this.loose.has(path) && !(this.rootSnapshot && within(this.root, path))) this.loose.set(path, await exists(path));
        return;
      }
      if (this.rootSnapshot && top === this.root) return;
      if (this.repos.has(top) || this.repos.size >= MAX_TRACKED_REPOS) return;
      this.repos.set(
        top,
        (async () => {
          if (await runsPrograms(top)) return null;
          const startTree = await this.tools.snapshot(top);
          return startTree ? { top, startTree, initialHead: await this.tools.head(top) } : null;
        })().catch(() => null),
      );
      await this.repos.get(top);
    } catch {
      // A path that cannot be inspected is simply not tracked.
    }
  }

  /** The changes since each repository's first write, and the loose files, named for the web. */
  async collect(): Promise<{ files: ChangedFile[]; repos: RepoChange[] }> {
    const files: ChangedFile[] = [];
    const repos: RepoChange[] = [];
    for (const pending of this.repos.values()) {
      const tracked = await pending;
      if (!tracked || files.length >= MAX_CHANGED_FILES) continue;
      const endTree = await this.tools.snapshot(tracked.top).catch(() => null);
      if (!endTree || endTree === tracked.startTree) continue;
      const changed = await agentChanges(this.tools.git, tracked.top, tracked.startTree, endTree).catch(() => ({ files: [] as ChangedFile[], nested: [] }));
      if (!changed.files.length) continue;
      repos.push({ repo: tracked.top, startTree: tracked.startTree, endTree, initialHead: tracked.initialHead, files: changed.files });
      for (const file of changed.files.slice(0, MAX_CHANGED_FILES - files.length)) files.push({ ...file, path: displayPath(this.root, join(tracked.top, file.path), this.home) });
    }
    for (const [path, existed] of this.loose) {
      if (files.length >= MAX_CHANGED_FILES) break;
      const info = await lstat(path).catch(() => null);
      if (!info) {
        if (existed) files.push({ path: displayPath(this.root, path, this.home), status: "deleted", added: 0, removed: 0 });
        continue;
      }
      if (!info.isFile()) continue;
      const count = await lineCount(path);
      files.push({ path: displayPath(this.root, path, this.home), status: existed ? "modified" : "added", added: existed ? 0 : count.lines, removed: 0, ...(count.binary ? { binary: true } : {}) });
    }
    return { files, repos };
  }
}
