import { formatBinding, type ShortcutBinding } from "@ensemble/shared-types";
import { hasModule, moduleForPath } from "@ensemble/shared-types/modules";

/** Where each "Go to" sequence leads. */
export const GO_ROUTES: Readonly<Record<string, string>> = {
  "go-today": "/today",
  "go-board": "/board",
  "go-needs": "/needs-me",
  "go-meetings": "/meetings",
  "go-recap": "/recap",
  "go-settings": "/settings",
  "go-diagrams": "/diagrams",
  "go-plots": "/plots",
};

/** Shortcuts that only work on one surface, and how the help sheet names it. */
const SCOPES: Record<string, { title: string; here: (pathname: string) => boolean }> = {
  today: { title: "On Today", here: (path) => path === "/today" },
  diagrams: { title: "In a diagram", here: (path) => path.startsWith("/diagrams") },
  page: { title: "On a page", here: (path) => /^\/(pages|tasks|shared|p)\/[^/]+/.test(path) },
};

const GROUP_ORDER = ["Everywhere", "Create", "Go to", "Code"];

/** The optional module a binding needs, if any: off modules hide their shortcuts. */
function moduleOf(binding: ShortcutBinding) {
  const route = GO_ROUTES[binding.id];
  if (route) return moduleForPath(route);
  if (binding.scope === "diagrams") return "diagrams" as const;
  if (binding.group === "Code") return "code" as const;
  return null;
}

/** Whether a shortcut can work in this space: its module is on. Unknown modules (shell not loaded) count as off. */
export function shortcutAvailable(binding: ShortcutBinding, modules: string | null | undefined): boolean {
  const gate = moduleOf(binding);
  return !gate || hasModule(modules, gate);
}

const KEY_NAMES: Record<string, string> = { escape: "Esc", delete: "Delete", backspace: "Backspace", enter: "Enter", tab: "Tab", " ": "Space", space: "Space" };

function keysFor(binding: ShortcutBinding, apple: boolean): string {
  const chord = apple ? binding.mac : binding.other;
  const named = chord && KEY_NAMES[chord.key.toLowerCase()];
  const shown = named && chord ? { ...binding, mac: { ...chord, key: named }, other: { ...chord, key: named } } : binding;
  return formatBinding(shown, apple);
}

export type ShortcutHelpGroup = { title: string; rows: Array<{ label: string; keys: string[] }> };

/**
 * The help sheet: shortcuts for features that are on, grouped by area, one row per action
 * (Quick capture's chord and its C key share a row), and surface-only shortcuts only on
 * that surface.
 */
export function shortcutHelp(
  bindings: readonly ShortcutBinding[],
  { apple, modules, pathname }: { apple: boolean; modules: string | null | undefined; pathname: string },
): ShortcutHelpGroup[] {
  const groups = new Map<string, Map<string, string[]>>();
  for (const binding of bindings) {
    if (!shortcutAvailable(binding, modules)) continue;
    const scope = binding.scope === "global" ? null : SCOPES[binding.scope];
    if (binding.scope !== "global" && !scope?.here(pathname)) continue;
    const keys = keysFor(binding, apple);
    if (!keys) continue;
    const title = scope?.title ?? binding.group;
    const rows = groups.get(title) ?? new Map<string, string[]>();
    groups.set(title, rows);
    const row = rows.get(binding.label) ?? [];
    if (!row.includes(keys)) row.push(keys);
    rows.set(binding.label, row);
  }
  const rank = (title: string) => {
    const index = GROUP_ORDER.indexOf(title);
    return index < 0 ? -1 : index;
  };
  return [...groups.entries()]
    .sort(([a], [b]) => rank(a) - rank(b))
    .map(([title, rows]) => ({ title, rows: [...rows.entries()].map(([label, keys]) => ({ label, keys })) }));
}
