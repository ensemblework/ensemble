import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";

const RESERVED = new Set(["runs", "files", "projects", "worktrees", ".ensemble"]);

export function checkoutSlug(reply: string): string | null {
  const slug = reply.trim();
  return /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(slug) && /[a-z]/.test(slug) && !RESERVED.has(slug) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(slug) ? slug : null;
}

export function titleCheckoutSlug(title: string): string {
  const slug = title.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").slice(0, 40).replace(/^-+|-+$/g, "");
  return checkoutSlug(slug) ?? (slug ? checkoutSlug(`task-${slug}`) : null) ?? `task-${randomUUID().slice(0, 8)}`;
}

/** mkdir reserves the name before any writes, even when two runs choose it together. */
export async function reserveCheckoutFolder(workspace: string, slug: string, jobFolders: Iterable<string> = []): Promise<string> {
  const safe = checkoutSlug(slug);
  if (!safe) throw new Error("The checkout folder name is not safe.");
  slug = safe;
  const runs = join(workspace, "runs");
  await mkdir(runs, { recursive: true });
  if (!(await lstat(runs)).isDirectory()) throw new Error("The workspace's runs folder is not a folder.");
  const used = new Set([...jobFolders].map((name) => name.toLowerCase()));
  for (const dir of [workspace, runs, join(workspace, "projects"), join(workspace, "worktrees")]) {
    try {
      for (const name of await readdir(dir)) used.add(name.toLowerCase());
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  for (let index = 1; ; index += 1) {
    const suffix = index === 1 ? "" : `-${index}`;
    let stem = slug.slice(0, 40 - suffix.length).replace(/-+$/, "");
    if (!/[a-z]/.test(stem)) stem = `${slug.replace(/[^a-z]/g, "").slice(0, 1)}${stem.slice(1)}`;
    const name = `${stem}${suffix}`;
    if (used.has(name)) continue;
    const root = join(runs, name);
    try {
      await mkdir(root);
      return root;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      used.add(name);
    }
  }
}
