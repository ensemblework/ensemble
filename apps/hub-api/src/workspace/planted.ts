/**
 * Files that run later, outside the sandbox, when the person opens the folder.
 *
 * Trust does not hide these. The review diff flags them so they are not just
 * "the agent edited the repo" (doc 24 §2A).
 */

export type PlantedKind = "vscode-task" | "envrc" | "husky" | "lifecycle" | "makefile";

export interface PlantedHit {
  path: string;
  kind: PlantedKind;
  reason: string;
}

const LIFECYCLE = [
  "preinstall",
  "install",
  "postinstall",
  "preprepare",
  "prepare",
  "postprepare",
  "prepublish",
  "prepublishOnly",
  "publish",
  "postpublish",
];

function normalised(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

export function flagPlanted(files: Array<{ path: string; text?: string }>): PlantedHit[] {
  const hits: PlantedHit[] = [];
  for (const file of files) {
    const path = normalised(file.path);
    const base = path.split("/").pop() ?? path;
    if (path === ".vscode/tasks.json" || path.endsWith("/.vscode/tasks.json")) {
      const text = file.text ?? "";
      if (!file.text || /folderOpen/.test(text)) {
        hits.push({
          path,
          kind: "vscode-task",
          reason: file.text
            ? "tasks.json runs a command when the folder is opened."
            : "tasks.json changed. Check it for a folderOpen task before trusting the folder.",
        });
      }
      continue;
    }
    if (base === ".envrc") {
      hits.push({ path, kind: "envrc", reason: "direnv runs .envrc when the folder is entered." });
      continue;
    }
    if (path === ".husky" || path.startsWith(".husky/") || path.includes("/.husky/")) {
      hits.push({ path, kind: "husky", reason: "The person's git will run this hook. The agent's git will not." });
      continue;
    }
    if (base === "package.json") {
      const text = file.text ?? "";
      let scripts: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(text) as { scripts?: Record<string, unknown> };
        scripts = parsed.scripts ?? {};
      } catch {
        scripts = {};
      }
      const present = LIFECYCLE.filter((name) => typeof scripts[name] === "string" && String(scripts[name]).trim());
      if (!file.text || present.length) {
        hits.push({
          path,
          kind: "lifecycle",
          reason: present.length
            ? `package.json lifecycle scripts will run on install: ${present.join(", ")}.`
            : "package.json changed. Check its lifecycle scripts before installing.",
        });
      }
      continue;
    }
    if (base === "Makefile" || base === "makefile" || base === "GNUmakefile") {
      hits.push({ path, kind: "makefile", reason: "Make runs commands from the Makefile when the person builds." });
    }
  }
  return hits;
}
