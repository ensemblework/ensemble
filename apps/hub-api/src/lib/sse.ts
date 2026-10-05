import { EventEmitter } from "node:events";
import type { FastifyReply, FastifyRequest } from "fastify";
import { streamCorsHeaders } from "./cors-origin.js";
import { hubCorsPolicy } from "./hub-cors.js";

type Frame = { event: string; data: unknown };

class SseHub {
  private readonly channels = new Map<string, Set<FastifyReply>>();
  private readonly bus = new EventEmitter();

  subscribe(userId: string, reply: FastifyReply): void {
    let set = this.channels.get(userId);
    if (!set) {
      set = new Set();
      this.channels.set(userId, set);
    }
    set.add(reply);
    reply.raw.on("close", () => this.unsubscribe(userId, reply));
  }

  unsubscribe(userId: string, reply: FastifyReply): void {
    const set = this.channels.get(userId);
    if (!set) return;
    set.delete(reply);
    if (set.size === 0) this.channels.delete(userId);
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
    for (const reply of close ? [...set] : set) {
      if (close) this.unsubscribe(userId, reply);
      const socket = reply.raw;
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

export async function sseHandler(request: FastifyRequest, reply: FastifyReply, userId: string): Promise<void> {
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
  sseHub.subscribe(userId, reply);
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
