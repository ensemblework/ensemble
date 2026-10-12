/**
 * Trello: cards and boards (search, read), members of your open boards, and card
 * comments. Needs the API key saved with the token. Ids: Trello ids; a card or
 * board shortLink (from trello.com/c/… or /b/…) reads too.
 */
import type { AppItem, AppItemContent, AppItemPerson } from "@ensemble/shared-types";
import type { TrelloBoard, TrelloCard } from "../../../imports/files/trello.js";
import { ConnectorNotConnectedError } from "../../tokens.js";
import { facts, itemFetch, itemMarkdown } from "../http.js";
import { ItemError, MAX_PEOPLE, type ItemContext, type ItemSource } from "../types.js";

const API = "https://api.trello.com/1";
const LABEL = "Trello";
const CARD_FIELDS = "name,desc,due,dueComplete,closed,url,shortUrl,shortLink,dateLastActivity,idBoard,idList,labels";
/** Trello's limit for one comment. */
const MAX_COMMENT = 16_384;

type Card = TrelloCard & { shortLink?: string; board?: { name?: string }; list?: { name?: string } };
type Board = TrelloBoard & { dateLastActivity?: string | null };
interface Member {
  id: string;
  fullName?: string;
  username?: string;
}

const ID = /^[0-9a-f]{24}$|^[A-Za-z0-9]{8}$/;

/** "https://trello.com/c/AbCd1234/…" → the card's shortLink; /b/ → a board. */
export function trelloRef(text: string): { kind: "card" | "board"; id: string } | null {
  const match = /^https?:\/\/(?:www\.)?trello\.com\/([cb])\/([A-Za-z0-9]{8})(?:[/?#]|$)/i.exec(text.trim());
  if (!match) return null;
  return { kind: match[1]!.toLowerCase() === "c" ? "card" : "board", id: match[2]! };
}

function headers(ctx: ItemContext): Record<string, string> {
  const key = ctx.token.extra?.key ?? ctx.token.extra?.apiKey;
  if (!key) throw new ConnectorNotConnectedError("trello", "This Trello connection has no API key saved. Connect Trello again with your key and token in Settings → Connections.");
  return { Authorization: `OAuth oauth_consumer_key="${key}", oauth_token="${ctx.token.token}"` };
}

const get = <T>(ctx: ItemContext, path: string, params: Record<string, string> = {}) =>
  itemFetch<T>(ctx, "trello", LABEL, `${API}${path}?${new URLSearchParams(params)}`, { headers: headers(ctx) });

const day = (value: string | null | undefined) => (value ? value.slice(0, 10) : undefined);
const newest = <T extends { dateLastActivity?: string | null }>(rows: T[]) => [...rows].sort((a, b) => (b.dateLastActivity ?? "").localeCompare(a.dateLastActivity ?? ""));
const hit = ({ source, kind, id, title, subtitle, url, updatedAt }: AppItem): AppItem => ({ source, kind, id, title, subtitle, url, updatedAt });
const labelNames = (card: Card) => (card.labels ?? []).map((label) => label.name || label.color || "").filter(Boolean);

function cardItem(card: Card, boardName?: string): AppItem {
  return {
    source: "trello",
    kind: "card",
    id: card.id,
    title: card.name || "Untitled card",
    subtitle: [boardName ?? card.board?.name, card.list?.name, card.dueComplete ? "done" : null, card.closed ? "archived" : null].filter(Boolean).join(" · "),
    url: card.shortUrl ?? card.url,
    updatedAt: card.dateLastActivity,
  };
}

function boardItem(board: Board): AppItem {
  return {
    source: "trello",
    kind: "board",
    id: board.id,
    title: board.name || "Untitled board",
    subtitle: board.closed ? "Board · closed" : "Board",
    url: board.url,
    updatedAt: board.dateLastActivity ?? undefined,
  };
}

async function readCard(ctx: ItemContext, id: string): Promise<AppItemContent> {
  const [card, comments] = await Promise.all([
    get<Card>(ctx, `/cards/${id}`, {
      fields: CARD_FIELDS,
      list: "true",
      list_fields: "name",
      board: "true",
      board_fields: "name",
      members: "true",
      member_fields: "fullName,username",
      checklists: "all",
      checklist_fields: "name",
    }),
    get<Array<{ date?: string; memberCreator?: Member; data?: { text?: string } }>>(ctx, `/cards/${id}/actions`, { filter: "commentCard", limit: "10" }),
  ]);
  const members = card.members ?? [];
  const list = facts({
    Board: card.board?.name,
    List: card.list?.name,
    Due: day(card.due),
    Done: card.dueComplete ? "yes" : null,
    Labels: labelNames(card).join(", "),
    Members: members.map((member) => member.fullName || member.username).join(", "),
    Archived: card.closed ? "yes" : null,
  });
  const checklists = (card.checklists ?? [])
    .map((checklist) => {
      const items = [...(checklist.checkItems ?? [])].sort((a, b) => (a.pos ?? 0) - (b.pos ?? 0));
      return [`### ${checklist.name || "Checklist"}`, ...items.map((row) => `- [${row.state === "complete" ? "x" : " "}] ${row.name ?? ""}`)].join("\n");
    })
    .join("\n\n");
  const thread = [...comments]
    .reverse()
    .map((comment) => `**${comment.memberCreator?.fullName || comment.memberCreator?.username || "Someone"}** (${day(comment.date) ?? ""}):\n${comment.data?.text ?? ""}`)
    .join("\n\n");
  const item = cardItem(card);
  return {
    ...item,
    facts: list,
    people: members.filter((member) => member.fullName || member.username).map((member) => ({ name: member.fullName || member.username!, ...(member.username ? { handle: member.username } : {}) })),
    text: itemMarkdown(item.title, list, [card.desc ?? "", checklists ? `## Checklists\n\n${checklists}` : "", thread ? `## Latest comments\n\n${thread}` : ""].filter(Boolean).join("\n\n")),
  };
}

const LIST_CARDS = 50;

async function readBoard(ctx: ItemContext, id: string): Promise<AppItemContent> {
  const board = await get<Board & { cards?: Card[]; members?: Member[] }>(ctx, `/boards/${id}`, {
    fields: "name,desc,url,dateLastActivity,closed",
    lists: "open",
    list_fields: "name",
    cards: "open",
    card_fields: "name,idList,due,dueComplete",
    members: "all",
    member_fields: "fullName,username",
  });
  const cards = board.cards ?? [];
  const sections = (board.lists ?? []).map((row) => {
    const inList = cards.filter((card) => card.idList === row.id);
    const lines = inList.slice(0, LIST_CARDS).map((card) => `- ${card.name ?? ""}${card.due ? ` (due ${day(card.due)}${card.dueComplete ? ", done" : ""})` : ""}`);
    if (inList.length > LIST_CARDS) lines.push(`- … and ${inList.length - LIST_CARDS} more`);
    return `## ${row.name ?? "List"}\n\n${lines.join("\n") || "(empty)"}`;
  });
  const members = board.members ?? [];
  const list = facts({
    Lists: board.lists?.length,
    "Open cards": cards.length,
    Members: members.slice(0, 10).map((member) => member.fullName || member.username).join(", "),
    Closed: board.closed ? "yes" : null,
  });
  const item = boardItem(board);
  return {
    ...item,
    facts: list,
    people: members.filter((member) => member.fullName || member.username).map((member) => ({ name: member.fullName || member.username!, ...(member.username ? { handle: member.username } : {}) })),
    text: itemMarkdown(item.title, list, [board.desc ?? "", ...sections].filter(Boolean).join("\n\n")),
  };
}

async function read(ctx: ItemContext, ref: { kind: string; id: string }): Promise<AppItemContent> {
  if (!ID.test(ref.id)) throw new ItemError("That is not a Trello card or board id.", 400);
  return ref.kind === "board" ? readBoard(ctx, ref.id) : readCard(ctx, ref.id);
}

export const trelloItems: ItemSource = {
  id: "trello",
  provider: "trello",
  label: LABEL,
  kinds: ["card", "board"],
  async search(ctx, query) {
    const direct = trelloRef(query.q);
    if (direct && (!query.kind || query.kind === direct.kind)) return [hit(await read(ctx, direct))];
    const text = query.q.trim().slice(0, 200);
    const boardCount = query.kind ? query.limit : Math.min(5, query.limit);
    const wantCards = !query.kind || query.kind === "card";
    const wantBoards = !query.kind || query.kind === "board";
    if (text) {
      const found = await get<{ cards?: Card[]; boards?: Board[] }>(ctx, "/search", {
        query: text,
        modelTypes: [wantCards ? "cards" : "", wantBoards ? "boards" : ""].filter(Boolean).join(","),
        cards_limit: String(query.limit),
        boards_limit: String(boardCount),
        card_fields: CARD_FIELDS,
        card_board: "true",
        card_list: "true",
        board_fields: "name,url,dateLastActivity,closed",
        partial: "true",
      });
      return [...(found.cards ?? []).map((card) => cardItem(card)), ...(found.boards ?? []).map(boardItem)];
    }
    const boards = newest(await get<Board[]>(ctx, "/members/me/boards", { filter: "open", fields: "name,url,dateLastActivity,closed" }));
    const out: AppItem[] = [];
    if (wantCards) {
      const names = new Map(boards.map((board) => [board.id, board.name]));
      const cards = newest(await get<Card[]>(ctx, "/members/me/cards", { filter: "visible", fields: CARD_FIELDS }));
      out.push(...cards.slice(0, query.limit).map((card) => cardItem(card, names.get(card.idBoard ?? ""))));
    }
    if (wantBoards) out.push(...boards.slice(0, boardCount).map(boardItem));
    return out;
  },
  read,
  async people(ctx) {
    const boards = newest(await get<Board[]>(ctx, "/members/me/boards", { filter: "open", fields: "name,dateLastActivity" })).slice(0, 25);
    const seen = new Map<string, AppItemPerson>();
    for (let index = 0; index < boards.length && seen.size < MAX_PEOPLE; index += 5) {
      const batches = await Promise.all(boards.slice(index, index + 5).map((board) => get<Member[]>(ctx, `/boards/${board.id}/members`, { fields: "fullName,username" })));
      for (const member of batches.flat()) {
        if (!member.username || seen.has(member.id)) continue;
        seen.set(member.id, { name: member.fullName || member.username, handle: member.username });
      }
    }
    return [...seen.values()].slice(0, MAX_PEOPLE);
  },
  fromUrl(url) {
    const ref = trelloRef(url);
    return ref?.kind === "card" ? ref : null;
  },
  async comment(ctx, ref, body) {
    if (ref.kind !== "card" || !ID.test(ref.id)) throw new ItemError("Only Trello cards take comments.", 400);
    const posted = await itemFetch<{ id?: string; data?: { card?: { shortLink?: string } } }>(
      ctx,
      "trello",
      LABEL,
      `${API}/cards/${ref.id}/actions/comments?${new URLSearchParams({ text: body.slice(0, MAX_COMMENT) })}`,
      { method: "POST", headers: headers(ctx) },
    );
    const short = posted.data?.card?.shortLink;
    return short ? { url: `https://trello.com/c/${short}${posted.id ? `#comment-${posted.id}` : ""}` } : {};
  },
};
