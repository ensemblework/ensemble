import { writeFileSync, readFileSync } from "node:fs";
import { boardSpecs, specPool, lensSections } from "../components/desk/live-board";
import { sampleLive } from "../components/onboarding/sample";
import { DESK_IDS } from "../components/desk/desks";
import { deskRole, tileFitsRole } from "../components/desk/tile-catalog";
import { resolveExtras, DESK_EXTRAS } from "../lib/desk-extras";
import { INSIGHT_IDS, DEFAULT_INSIGHTS, INSIGHTS_KEY, MAX_INSIGHTS } from "../components/board/insight-data";
import { INSIGHT_CATALOG } from "../components/board/insight-catalog";
const clean = (s: ReturnType<typeof boardSpecs>[number]) => ({ key: s.key, title: s.title, c: s.c, r: s.r, ...(s.hero ? { hero: true } : {}) });
const pool = [...specPool().values()];
const catalog = {
 desks: Object.fromEntries(DESK_IDS.map(id => [id, { role: deskRole(id), base: boardSpecs(id).map(clean), defaults: boardSpecs(id, resolveExtras(id, null)).map(clean), available: pool.filter(spec => tileFitsRole(spec.key, deskRole(id))).map(clean) }])),
 contexts: Object.fromEntries(DESK_IDS.map(id => [id, Object.fromEntries(["overview", "builds", "parts", "tests", "reviews", "deploys", "assignments", "courses", "subjects", "revision", "papers", "classes", "marking", "matters", "hearings", "filings", "reading", "team", "decisions", "workload", "objectives", "milestones", "learning"].map(tab => [tab, [...(tab === "overview" ? [{ key: "people", title: "People", c: 4, r: 4 }, { key: "projects", title: "Projects", c: 8, r: 4 }, { key: "artifacts", title: "Artifacts", c: 8, r: 4 }] : []), ...lensSections(id, tab, sampleLive(deskRole(id)), resolveExtras(id, null)).map(row => ({ key: `section:${row.title.toLowerCase()}`, title: row.title, c: row.rows.length > 3 ? 6 : 4, r: 3 }))]]))])),
 roles: Object.fromEntries((Object.keys(DEFAULT_INSIGHTS) as Array<keyof typeof DEFAULT_INSIGHTS>).map(role => [role, pool.filter(spec => tileFitsRole(spec.key, role)).map(clean)])),
 extras: DESK_EXTRAS,
 board: { key: INSIGHTS_KEY, max: MAX_INSIGHTS, defaults: DEFAULT_INSIGHTS, available: INSIGHT_IDS.map(key => ({ key, title: INSIGHT_CATALOG[key].title, description: INSIGHT_CATALOG[key].description })) },
};
const target = new URL("../../../packages/shared-types/src/workspace-tiles.generated.ts", import.meta.url);
const content = `// Generated from the live UI by apps/hub-web/e2e/assistant-tile-catalog.ts.\nexport const WORKSPACE_TILES = ${JSON.stringify(catalog, null, 2)} as const;\n`;
if (process.argv.includes("--check")) { if (readFileSync(target, "utf8") !== content) throw new Error("Workspace tile catalog changed. Run assistant-tile-catalog.ts to refresh it."); }
else writeFileSync(target, content);
console.log("Workspace tile catalog matches the live UI.");
