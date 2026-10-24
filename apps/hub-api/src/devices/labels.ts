/**
 * Folder labels a computer published in `Device.capabilities`.
 * A label is a name the person already added. It is not a path.
 */
export function pathShapedLabel(label: string): boolean {
  const value = label.trim();
  if (!value) return false;
  return value.startsWith("/") || value.startsWith("~") || value.includes("..") || /^[A-Za-z]:[\\/]/.test(value);
}

export function folderLabels(capabilities: unknown): string[] {
  if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) return [];
  const record = capabilities as { folders?: unknown; folderLabels?: unknown };
  const raw = record.folders ?? record.folderLabels;
  if (!Array.isArray(raw)) return [];
  const labels: string[] = [];
  for (const item of raw) {
    const label = typeof item === "string" ? item : item && typeof item === "object" && typeof (item as { label?: unknown }).label === "string" ? (item as { label: string }).label : "";
    const trimmed = label.trim();
    if (!trimmed || pathShapedLabel(trimmed)) continue;
    labels.push(trimmed);
  }
  return [...new Set(labels)].slice(0, 100);
}

/** Off unless the computer published `capabilities.runBranchPush === true`. The site cannot turn it on. */
export function runBranchPushEnabled(capabilities: unknown): boolean {
  if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) return false;
  return (capabilities as { runBranchPush?: unknown }).runBranchPush === true;
}

/**
 * Coding agents the computer's runtime can run a code task with. Runtimes that predate the list
 * run Claude Code, Codex and Cursor's agent.
 */
export function deviceEngines(capabilities: unknown): string[] {
  const listed = capabilities && typeof capabilities === "object" && !Array.isArray(capabilities) ? (capabilities as { engines?: unknown }).engines : undefined;
  if (!Array.isArray(listed)) return ["claude-code", "codex", "cursor-agent"];
  return listed.filter((value): value is string => typeof value === "string").slice(0, 20);
}

export function rejectPathLabels(capabilities: unknown): string | null {
  if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) return null;
  const record = capabilities as { folders?: unknown; folderLabels?: unknown };
  const raw = record.folders ?? record.folderLabels;
  if (!Array.isArray(raw)) return null;
  for (const item of raw) {
    const label = typeof item === "string" ? item : item && typeof item === "object" && typeof (item as { label?: unknown }).label === "string" ? (item as { label: string }).label : "";
    if (pathShapedLabel(label)) return "Send a folder label, not a path.";
  }
  return null;
}
