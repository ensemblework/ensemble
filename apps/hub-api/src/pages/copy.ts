import type { Prisma } from "@prisma/client";
import { EMPTY_PAGE, markdownToNodes, type PageDocument, type PageNode } from "@ensemble/shared-types";

/** Copies writing and static AI answers, without linking the new page to old discussions or actions. */
export async function copyPageDocument(db: Prisma.TransactionClient, userId: string, doc: PageDocument | null, preserveComments = false): Promise<PageDocument> {
  if (!doc) return EMPTY_PAGE;
  const ids: string[] = [];
  const collect = (node: PageNode) => { if (node.type === "ensembleReply" && typeof node.attrs?.threadId === "string") ids.push(node.attrs.threadId); node.content?.forEach(collect); };
  collect(doc);
  const answers = ids.length ? await db.pageDiscussion.findMany({ where: { userId, id: { in: ids }, deletedAt: null }, select: { id: true, answer: true } }) : [];
  const byId = new Map(answers.map(row => [row.id, row.answer]));
  const copy = (node: PageNode): PageNode[] => {
    if (node.type === "agentBlock") return node.content?.flatMap(copy) ?? [];
    if (node.type === "ensembleReply") {
      const answer = byId.get(String(node.attrs?.threadId ?? ""));
      return answer ? markdownToNodes(answer) : [];
    }
    return [{ ...node, ...(node.marks ? { marks: node.marks.filter(mark => preserveComments || !/comment/i.test(mark.type)) } : {}), ...(node.content ? { content: node.content.flatMap(copy) } : {}) }];
  };
  return { type: "doc", content: doc.content?.flatMap(copy) ?? EMPTY_PAGE.content };
}
