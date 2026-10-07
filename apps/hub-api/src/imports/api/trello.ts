/** Trello REST: boards → projects, lists → status, cards → tasks. Needs an app key and a token. */
import { ImportError, type ApiImportSource, type ImportContainer, type SourceContext } from "../types.js";
import { trelloItems, type TrelloBoard, type TrelloCard } from "../files/trello.js";

const API = "https://api.trello.com/1";

function url(ctx: SourceContext, path: string, params: Record<string, string> = {}): string {
  if (!ctx.auth.key) throw new ImportError("Trello needs an API key with the token. Paste both, or upload the board's JSON export instead.");
  const query = new URLSearchParams({ ...params, key: ctx.auth.key, token: ctx.auth.token });
  return `${API}${path}?${query}`;
}

export const trelloSource: ApiImportSource = {
  id: "trello",
  async listContainers(ctx) {
    const boards = await ctx.http.json<Array<{ id: string; name: string; closed?: boolean; organization?: { displayName?: string } | null }>>(
      url(ctx, "/members/me/boards", { filter: "open", fields: "name,closed", organization: "true", organization_fields: "displayName" }),
    );
    return boards.filter((board) => !board.closed).map((board): ImportContainer => ({
      id: board.id,
      name: board.name,
      kind: "board",
      count: null,
      parent: board.organization?.displayName ?? null,
      importAs: "tasks",
    }));
  },
  async *fetchItems(ctx, containers) {
    for (const container of containers) {
      const board = await ctx.http.json<TrelloBoard>(url(ctx, `/boards/${container.id}`, { fields: "name,url", lists: "all", list_fields: "name,closed", members: "all", member_fields: "fullName,username" }));
      const cards = await ctx.http.json<TrelloCard[]>(
        url(ctx, `/boards/${container.id}/cards`, {
          filter: "open",
          checklists: "all",
          fields: "name,desc,due,start,dueComplete,closed,idList,labels,idMembers,url,shortUrl,dateLastActivity",
        }),
      );
      const items = trelloItems({ ...board, id: container.id, name: board.name ?? container.name }, cards);
      for (let index = 0; index < items.length; index += 100) yield items.slice(index, index + 100);
      if (ctx.signal.aborted) return;
    }
  },
};
