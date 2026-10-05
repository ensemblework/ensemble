const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi;
const URL_RE = /https?:\/\/[^\s)<>"]+/gi;

export interface SurfaceEntity {
  id: string;
  kind: string;
  label: string;
}

export interface Citation {
  kind: "entity" | "web";
  id?: string;
  url?: string;
  label: string;
  href?: string;
}

function entityHref(entity: SurfaceEntity): string | undefined {
  if (entity.kind === "task") return `/tasks/${entity.id}`;
  if (entity.kind === "project") return `/projects/${entity.id}`;
  if (entity.kind === "people" || entity.kind === "person") return `/context?tab=people&search=${encodeURIComponent(entity.label)}`;
  if (entity.kind === "deliverable") return `/today`;
  if (entity.kind === "repo") return `/code`;
  if (entity.kind === "note") return `/context`;
  return undefined;
}

/** Drop ids that were not in the loaded context, then attach real sources. */
export function citeAnswer(text: string, entities: SurfaceEntity[]): { text: string; citations: Citation[] } {
  const allowed = new Set(entities.map((entity) => entity.id.toLowerCase()));
  const labels = new Map(entities.map((entity) => [entity.id.toLowerCase(), `${entity.kind} ${entity.label}`]));
  const cleaned = text.replace(UUID_RE, (id) => (allowed.has(id.toLowerCase()) ? id : ""));
  const citations: Citation[] = [];
  const seen = new Set<string>();
  for (const match of cleaned.match(UUID_RE) ?? []) {
    const key = match.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const entity = entities.find((row) => row.id.toLowerCase() === key);
    if (!entity) continue;
    citations.push({ kind: "entity", id: entity.id, label: labels.get(key) ?? entity.label, href: entityHref(entity) });
  }
  for (const raw of cleaned.match(URL_RE) ?? []) {
    const url = raw.replace(/[.,]+$/, "");
    if (seen.has(url)) continue;
    seen.add(url);
    citations.push({ kind: "web", url, label: url, href: url });
  }
  const collapsed = cleaned
    .replace(/`\s*`/g, "")
    .replace(/\(\s*\)/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text: collapsed, citations };
}
