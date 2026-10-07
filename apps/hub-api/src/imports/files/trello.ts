/**
 * Trello boards, from the free JSON export (board menu → Print, export and
 * share → Export as JSON) or from the API. Both have the same card shape.
 */
import { cleanLabels, normalizeDate } from "../mapping.js";
import { ImportError, type ImportContainer, type ImportItem } from "../types.js";

export interface TrelloLabel { id?: string; name?: string; color?: string | null }
export interface TrelloCard {
  id: string;
  name?: string;
  desc?: string;
  due?: string | null;
  start?: string | null;
  dueComplete?: boolean;
  closed?: boolean;
  idList?: string;
  idBoard?: string;
  labels?: TrelloLabel[];
  idMembers?: string[];
  members?: Array<{ id: string; fullName?: string; username?: string }>;
  checklists?: TrelloChecklist[];
  url?: string;
  shortUrl?: string;
  dateLastActivity?: string;
}
export interface TrelloChecklist { id?: string; idCard?: string; name?: string; checkItems?: Array<{ name?: string; state?: string; pos?: number }> }
export interface TrelloList { id: string; name?: string; closed?: boolean }
export interface TrelloBoard {
  id: string;
  name?: string;
  url?: string;
  desc?: string;
  closed?: boolean;
  lists?: TrelloList[];
  cards?: TrelloCard[];
  checklists?: TrelloChecklist[];
  members?: Array<{ id: string; fullName?: string; username?: string }>;
}

export function isTrelloExport(value: unknown): value is TrelloBoard {
  const board = value as TrelloBoard;
  return Boolean(board && typeof board === "object" && typeof board.id === "string" && Array.isArray(board.lists) && Array.isArray(board.cards));
}

export function parseTrelloExport(text: string): TrelloBoard {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    throw new ImportError("That JSON file could not be read.");
  }
  if (!isTrelloExport(parsed)) throw new ImportError("That JSON file is not a Trello board export. In Trello, open the board menu → Print, export and share → Export as JSON.");
  return parsed;
}

function checklistMarkdown(lists: TrelloChecklist[]): string {
  return lists
    .map((list) => {
      const items = [...(list.checkItems ?? [])].sort((a, b) => (a.pos ?? 0) - (b.pos ?? 0));
      const lines = items.map((item) => `- [${item.state === "complete" ? "x" : " "}] ${(item.name ?? "").replace(/\n/g, " ")}`);
      return [`### ${list.name || "Checklist"}`, ...lines].join("\n");
    })
    .join("\n\n");
}

export function trelloContainer(board: TrelloBoard): ImportContainer {
  return { id: board.id, name: board.name || "Trello board", kind: "board", count: (board.cards ?? []).filter((card) => !card.closed).length };
}

export function trelloItems(board: TrelloBoard, cards: TrelloCard[] = board.cards ?? []): ImportItem[] {
  const lists = new Map((board.lists ?? []).map((list) => [list.id, list]));
  const members = new Map((board.members ?? []).map((member) => [member.id, member.fullName || member.username || ""]));
  const checklistsByCard = new Map<string, TrelloChecklist[]>();
  for (const list of board.checklists ?? []) {
    if (!list.idCard) continue;
    checklistsByCard.set(list.idCard, [...(checklistsByCard.get(list.idCard) ?? []), list]);
  }
  const items: ImportItem[] = [];
  for (const card of cards) {
    const list = card.idList ? lists.get(card.idList) : undefined;
    if (card.closed || list?.closed) continue;
    const checklists = card.checklists?.length ? card.checklists : checklistsByCard.get(card.id) ?? [];
    const people = card.members?.length
      ? card.members.map((member) => member.fullName || member.username || "")
      : (card.idMembers ?? []).map((id) => members.get(id) ?? "");
    items.push({
      kind: "task",
      externalId: card.id,
      title: card.name ?? "",
      description: card.desc || null,
      dueDate: normalizeDate(card.due),
      startDate: normalizeDate(card.start),
      status: list?.name ?? null,
      done: Boolean(card.dueComplete),
      labels: cleanLabels((card.labels ?? []).map((label) => label.name || label.color || "")),
      assignees: people.filter(Boolean),
      url: card.shortUrl || card.url || null,
      containerId: board.id,
      projectRef: board.id,
      projectName: board.name ?? "Trello board",
      pageMarkdown: checklists.length ? checklistMarkdown(checklists) : null,
      updatedAt: card.dateLastActivity ?? null,
    });
  }
  return items;
}
