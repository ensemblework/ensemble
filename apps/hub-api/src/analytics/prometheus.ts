/**
 * Prometheus metrics for the operator (docs/07 §1.3): requests by route pattern, status and whether
 * they came through the Hub's Vercel rewrite, their latency, open live streams, and Node's own
 * process metrics. Served on a separate listener, ENSEMBLE_METRICS_PORT on 127.0.0.1, so the public
 * API (and the tunnel in front of it) never exposes it. Off when the port is unset.
 */
import { createServer, type Server } from "node:http";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from "prom-client";
import { sseHub } from "../lib/sse.js";

export const registry = new Registry();
collectDefaultMetrics({ register: registry, prefix: "ensemble_api_" });

const requests = new Counter({
  name: "ensemble_http_requests_total",
  help: "API requests by route pattern, method, status class and whether they came through the Hub on Vercel.",
  labelNames: ["route", "method", "status", "via"] as const,
  registers: [registry],
});
const duration = new Histogram({
  name: "ensemble_http_request_duration_seconds",
  help: "API response time by route pattern (the event stream is not timed).",
  labelNames: ["route", "method"] as const,
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
  registers: [registry],
});
new Gauge({
  name: "ensemble_live_streams",
  help: "Open live event streams (browser tabs and paired computers).",
  registers: [registry],
  collect() {
    this.set(sseHub.stats().streams);
  },
});
new Gauge({
  name: "ensemble_live_channels",
  help: "Spaces with at least one open live stream.",
  registers: [registry],
  collect() {
    this.set(sseHub.stats().channels);
  },
});

const STREAMS = new Set(["/api/events", "/api/devices/self/events"]);

/** Vercel adds x-vercel-* headers to what its rewrites forward; a browser's own calls do not have them. */
export function viaOf(headers: Record<string, unknown>): "vercel" | "direct" {
  return Object.keys(headers).some((name) => name.startsWith("x-vercel-")) ? "vercel" : "direct";
}

export function recordRequest(request: FastifyRequest, reply: FastifyReply): void {
  const route = request.routeOptions.url ?? "unmatched";
  const method = request.method;
  requests.inc({ route, method, status: `${Math.floor(reply.statusCode / 100)}xx`, via: viaOf(request.headers) });
  if (!STREAMS.has(route)) duration.observe({ route, method }, reply.elapsedTime / 1000);
}

export function instrument(app: FastifyInstance): void {
  app.addHook("onResponse", async (request, reply) => recordRequest(request, reply));
}

/** Starts the loopback metrics listener when ENSEMBLE_METRICS_PORT is set. */
export function startMetricsServer(env: NodeJS.ProcessEnv = process.env): Server | null {
  const port = Number(env.ENSEMBLE_METRICS_PORT);
  if (!Number.isInteger(port) || port <= 0) return null;
  const server = createServer((req, res) => {
    if (req.url !== "/metrics") {
      res.writeHead(404).end();
      return;
    }
    registry
      .metrics()
      .then((body) => res.writeHead(200, { "Content-Type": registry.contentType }).end(body))
      .catch(() => res.writeHead(500).end());
  });
  server.listen(port, "127.0.0.1");
  server.unref();
  return server;
}
