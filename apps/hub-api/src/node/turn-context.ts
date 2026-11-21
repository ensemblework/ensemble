/**
 * Which node turn is running in this async context (node/brain.ts `runNodeTurn`), so every message that
 * turn posts as its node, its reply or a card a tool posts, carries `data.turnId` (node/store.ts
 * `postMessage`) and the turn's trace lists it. Work the turn started that goes on after it ends (a
 * background wait, a timer) posts without it.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export type PostedMessage = { id: string; kind: string; type?: string };

type TurnContext = { turnId: string; nodeId: string; live: boolean; posted: PostedMessage[] };

const current = new AsyncLocalStorage<TurnContext>();

/** Runs a turn with its context; what it posted is in `posted` afterwards. */
export async function inTurn<T>(turn: { id: string; nodeId: string }, run: (posted: readonly PostedMessage[]) => Promise<T>): Promise<T> {
  const context: TurnContext = { turnId: turn.id, nodeId: turn.nodeId, live: true, posted: [] };
  try {
    return await current.run(context, () => run(context.posted));
  } finally {
    context.live = false;
  }
}

/** The running turn of this node in this context, when a message it posts belongs to that turn. */
export function postingTurn(authorNodeId: string | null | undefined): { turnId: string; noted: (message: PostedMessage) => void } | null {
  const context = current.getStore();
  if (!context?.live || !authorNodeId || context.nodeId !== authorNodeId) return null;
  return {
    turnId: context.turnId,
    noted(message) {
      if (context.live && context.posted.length < 40) context.posted.push(message);
    },
  };
}
