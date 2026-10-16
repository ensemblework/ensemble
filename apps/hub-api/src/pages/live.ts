/**
 * The live documents of this API process (docs/29 §5): one `CollabHub` over the page store and
 * the event stream. Routes and tools that move pages to Trash or convert them write it back first.
 */
import { prisma } from "../lib/prisma.js";
import { sseHub } from "../lib/sse.js";
import { CollabHub, type DocKey } from "./collab.js";
import { readCollabPage, writeCollabPage, type CollabTarget } from "./store.js";

const target = (key: DocKey): CollabTarget => (key.kind === "page" ? { pageId: key.id } : { taskId: key.id });

export const collabHub = new CollabHub(
  {
    read: (key) => readCollabPage(prisma, key.space, target(key)),
    write: (key, decide) => writeCollabPage(prisma, key.space, target(key), decide),
  },
  (space, event, data) => sseHub.publish(space, { event, data }),
);
