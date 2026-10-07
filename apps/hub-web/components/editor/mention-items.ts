import { mentionQuery } from "@ensemble/shared-types";
import type { Entity } from "../../lib/api";
import { MENTION_GROUPS } from "./editor-commands";
import type { MenuItem } from "./suggestion-menu";

export type EntitySource = () => Entity[];

const ASK_ENSEMBLE: MenuItem = { type: "action", kind: "ensemble", id: "ask-ensemble", label: "Ask Ensemble", detail: "Ask about this page, or create a diagram or plot" };
export const NEW_DIAGRAM: MenuItem = { type: "create", kind: "diagram", id: "new-diagram", label: "New diagram", detail: "Start a blank diagram and mention it here" };

export function mentionItems(query: string, entities: EntitySource, diagramsOn: () => boolean | null, plotsOn: () => boolean | null): MenuItem[] {
  const diagrams = diagramsOn() === true;
  const plots = plotsOn() === true;
  const groups = MENTION_GROUPS.filter((group) => (group.kind !== "diagram" || diagrams) && (group.kind !== "plot" || plots));
  const needle = query.trim().toLowerCase();
  if (!needle) return [ASK_ENSEMBLE, ...groups.map((group) => ({ type: "group" as const, ...group }))];
  const scoped = mentionQuery(query);
  if (scoped?.kind === "plot") {
    if (!plots) return [];
    const parts = scoped.search.split(":");
    const parent = parts.length > 1 ? parts.shift()!.trim().toLowerCase() : null;
    const search = parts.join(":").trim().toLowerCase();
    const rows = entities();
    if (parent) {
      const space = rows.find((row) => row.isSpace && (row.id.toLowerCase() === parent || row.label.toLowerCase() === parent));
      const parentId = space?.id ?? (parent === "data" || parent === "data files" ? "data" : parent === "saved" || parent === "saved plots" ? "saved" : null);
      if (!parentId) return [];
      return rows.filter((row) => row.parentId === parentId && row.label.toLowerCase().includes(search))
        .slice(0, 40).map((row) => ({ type: "entity" as const, ...row }));
    }
    const spaces: MenuItem[] = rows.filter((row) => row.isSpace && row.label.toLowerCase().includes(search))
      .map((row) => ({ type: "group", kind: "plot", label: row.label, detail: row.detail, prefix: `plots:${row.id}:` }));
    const saved: MenuItem[] = "saved plots".includes(search) && rows.some((row) => row.parentId === "saved")
      ? [{ type: "group", kind: "plot", label: "Saved plots", detail: "Browse saved charts", prefix: "plots:saved:" }] : [];
    const data = rows.filter((row) => row.kind === "dataset" && row.label.toLowerCase().includes(search))
      .slice(0, 30).map((row) => ({ type: "entity" as const, ...row }));
    return [...spaces, ...saved, ...data];
  }
  if (scoped && ((scoped.kind === "diagram" && !diagrams) || (scoped.kind === "dataset" && !plots))) return [];
  const search = (scoped?.search ?? query).toLowerCase();
  const matches = entities().filter((row) => (
    scoped ? row.kind === scoped.kind : !["plot", "dataset"].includes(row.kind)
  ) && (row.kind !== "diagram" || diagrams) && row.label.toLowerCase().includes(search))
    .slice(0, scoped ? 40 : 10).map((row) => ({ type: "entity" as const, ...row }));
  if (scoped) return matches;
  return [
    ...("ask ensemble".includes(search) || "ensemble".includes(search) ? [ASK_ENSEMBLE] : []),
    ...matches,
    ...groups.filter((group) => group.label.toLowerCase().includes(search)).map((group) => ({ type: "group" as const, ...group })),
    ...(diagrams && (search.includes("diagram") || search === "new") ? [NEW_DIAGRAM] : []),
  ];
}
