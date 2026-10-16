/** How Trash names and links what it holds (`GET /api/deleted`). */

/** Where an item opens in the Hub once it is restored. Null: it has no page of its own. */
export function trashHref(kind: string, id: string, label = ""): string | null {
  const ref = encodeURIComponent(id);
  switch (kind) {
    case "page":
      return `/pages/${ref}`;
    case "task":
      return `/tasks/${ref}`;
    case "project":
      return `/projects/${ref}`;
    case "diagram":
      return `/diagrams/${ref}`;
    case "document":
      return `/files/${ref}`;
    case "meeting":
      return `/meetings?session=${ref}`;
    case "skill":
      return `/skills?skill=${ref}`;
    case "person":
      return `/context?tab=people&search=${encodeURIComponent(label)}`;
    default:
      return null;
  }
}

function plain(value: unknown, parts: string[] = []): string[] {
  if (!value || typeof value !== "object") return parts;
  const node = value as { text?: unknown; content?: unknown };
  if (typeof node.text === "string") parts.push(node.text);
  if (Array.isArray(node.content)) for (const child of node.content) plain(child, parts);
  return parts;
}

/** A trashed comment's own words, so two comments on the same quote read differently. */
export function commentTrashText(body: unknown, quote: string): string {
  const words = plain(body).join(" ").replace(/\s+/g, " ").trim() || quote.replace(/\s+/g, " ").trim();
  if (!words) return "Comment";
  return words.length > 120 ? `${words.slice(0, 119).trimEnd()}…` : words;
}

/** "On “Roadmap” · about “quoted words”". */
export function commentTrashDetail(pageTitle: string | null, quote: string, shown: string): string {
  const parts: string[] = [];
  if (pageTitle) parts.push(`On “${pageTitle}”`);
  const quoted = quote.replace(/\s+/g, " ").trim();
  if (quoted && quoted !== shown) parts.push(`about “${quoted.length > 60 ? `${quoted.slice(0, 59)}…` : quoted}”`);
  return parts.join(" · ");
}
