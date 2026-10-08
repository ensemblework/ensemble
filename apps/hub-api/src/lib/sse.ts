import { EventEmitter } from "node:events";
import type { FastifyReply, FastifyRequest } from "fastify";
import { streamCorsHeaders } from "./cors-origin.js";
import { hubCorsPolicy } from "./hub-cors.js";
import { currentScope } from "../sharing/context.js";

/**
 * `to` limits a frame to one person (an account id). `about` names the one item a frame is
 * about, so a person with a single shared item hears only about that item.
 */
export type Frame = { event: string; data: unknown; to?: string; about?: { kind: string; id: string }; ownerOnly?: boolean };

/** Who is listening. Without it (device streams, older callers) the listener is the owner. */
export type Listener = {
  accountId?: string;
  owner?: boolean;
  /** Set for a single shared item: only frames about it get through. */
  share?: { kind: string; resourceId: string; shareId?: string };
  /** The account channel of someone working in another space: personal frames only. */
  personalOnly?: boolean;
};

type Subscriber = { reply: FastifyReply; listener: Listener };

/** Frames for the person who acted: an assistant reply streams to them, not to the space. */
const ACTOR_EVENTS = new Set(["assistant.frame", "assistant.acted", "undo.changed"]);
/** The owner's private surfaces: reminders, connected-app syncs, their computers. */
const OWNER_EVENTS = new Set(["reminder.due", "sync", "device"]);
/** Reach you on your account channel wherever you are working. */
const PERSONAL_EVENTS = new Set(["sharing.changed", "notification"]);

function ids(data: unknown): string[] {
  if (!data || typeof data !== "object") return [];
  const row = data as Record<string, unknown>;
  return [row.id, row.taskId, row.pageId, row.resourceId].filter((value): value is string => typeof value === "string");
}

/** Whether one shared item's viewer may see a frame. Unknown frames stay out. */
function shareSees(share: NonNullable<Listener["share"]>, frame: Frame): boolean {
  if (frame.about) return frame.about.kind === share.kind && frame.about.id === share.resourceId;
  const about = ids(frame.data);
  switch (share.kind) {
    case "page":
    case "task":
      return (frame.event === "page" || frame.event === "task") && about.includes(share.resourceId);
    case "board":
      return frame.event === "task" || (frame.event === "page" && Boolean((frame.data as { taskId?: string } | null)?.taskId));
    case "diagram":
    case "plot":
    case "plot_space":
      return frame.event === "context" && about.includes(share.resourceId);
    case "workspace":
      return frame.event === "workspace" || frame.event === "agent";
    default:
      return false;
  }
}

export function delivers(listener: Listener, frame: Frame, actor: string | undefined): boolean {
  if (listener.personalOnly) return PERSONAL_EVENTS.has(frame.event) && (!frame.to || frame.to === listener.accountId);
  const owner = listener.owner ?? true;
  if (frame.ownerOnly && !owner) return false;
  if (frame.to) return frame.to === listener.accountId || (!listener.accountId && owner);
  if (ACTOR_EVENTS.has(frame.event)) return actor ? actor === listener.accountId || (!listener.accountId && owner) : owner;
  if (OWNER_EVENTS.has(frame.event)) return owner;
  if (listener.share) return shareSees(listener.share, frame);
  return true;
}

class SseHub {
  private readonly channels = new Map<string, Set<Subscriber>>();
  private readonly bus = new EventEmitter();

  subscribe(userId: string, reply: FastifyReply, listener: Listener = {}): void {
    let set = this.channels.get(userId);
    if (!set) {
      set = new Set();
      this.channels.set(userId, set);
    }
    const subscriber = { reply, listener };
    set.add(subscriber);
    reply.raw.on("close", () => this.drop(userId, subscriber));
  }

  private drop(userId: string, subscriber: Subscriber): void {
    const set = this.channels.get(userId);
    if (!set) return;
    set.delete(subscriber);
    if (set.size === 0) this.channels.delete(userId);
  }

  unsubscribe(userId: string, reply: FastifyReply): void {
    const set = this.channels.get(userId);
    if (!set) return;
    for (const subscriber of set) if (subscriber.reply === reply) this.drop(userId, subscriber);
  }

  /**
   * Closes the streams on a channel that match, for example everyone someone stopped sharing
   * with. Their tab reconnects with a fresh ticket, which checks access again.
   */
  close(channel: string, match: (listener: Listener) => boolean = () => true): number {
    const set = this.channels.get(channel);
    if (!set) return 0;
    let closed = 0;
    for (const subscriber of [...set]) {
      if (!match(subscriber.listener)) continue;
      this.drop(channel, subscriber);
      closed += 1;
      try {
        subscriber.reply.raw.end("event: sharing.changed\ndata: {}\n\n");
      } catch {
        // Already gone.
      }
    }
    return closed;
  }

  /** How many streams are open on a channel. */
  listeners(userId: string): number {
    return this.channels.get(userId)?.size ?? 0;
  }

  publish(userId: string, frame: Frame): void {
    this.write(userId, frame, false);
  }

  /** Write one frame to every subscriber on `userId`, then close those streams. */
  end(userId: string, frame: Frame): void {
    this.write(userId, frame, true);
  }

  private write(userId: string, frame: Frame, close: boolean): void {
    this.bus.emit("frame", { userId, frame });
    const set = this.channels.get(userId);
    if (!set) return;
    const payload = `event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`;
    const actor = ACTOR_EVENTS.has(frame.event) ? currentScope()?.accountId : undefined;
    for (const subscriber of close ? [...set] : set) {
      if (!delivers(subscriber.listener, frame, actor)) continue;
      if (close) this.drop(userId, subscriber);
      const socket = subscriber.reply.raw;
      if (close) {
        if (socket.destroyed || socket.writableEnded) continue;
        try {
          socket.end(payload);
        } catch {
          // The computer already hung up.
        }
        continue;
      }
      socket.write(payload);
    }
  }

  /** Test hook. Production callers use `publish` and `end`. */
  onFrame(listener: (event: { userId: string; frame: Frame }) => void): () => void {
    this.bus.on("frame", listener);
    return () => this.bus.off("frame", listener);
  }
}

export const sseHub = new SseHub();

export async function sseHandler(request: FastifyRequest, reply: FastifyReply, userId: string, listener: Listener = {}): Promise<void> {
  reply.hijack();
  const headers: Record<string, string> = {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  };
  // hijack() skips @fastify/cors, so the stream adds the same allowlist itself.
  Object.assign(headers, streamCorsHeaders(request.headers.origin, hubCorsPolicy()));
  reply.raw.writeHead(200, headers);
  reply.raw.write(":\n\n");
  sseHub.subscribe(userId, reply, listener);
  // Working in a space that is not your account: your own notices still reach you.
  if (listener.accountId && listener.accountId !== userId) sseHub.subscribe(listener.accountId, reply, { accountId: listener.accountId, personalOnly: true });
  const ping = setInterval(() => {
    if (reply.raw.destroyed || reply.raw.writableEnded) {
      clearInterval(ping);
      return;
    }
    try {
      reply.raw.write("event: ping\ndata: {}\n\n");
    } catch {
      clearInterval(ping);
    }
  }, 25_000);
  reply.raw.on("close", () => clearInterval(ping));
}
