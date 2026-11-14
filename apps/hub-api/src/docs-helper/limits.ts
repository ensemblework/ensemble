import { createHash } from "node:crypto";
import { isIP } from "node:net";
import type { FastifyRequest } from "fastify";
import type { Redis } from "ioredis";

// Atomic admission across API processes. Failed calls still consume their slot; no paid retry.
export const ADMIT = `
for i = 1, #KEYS do
  if tonumber(redis.call('GET', KEYS[i]) or '0') >= tonumber(ARGV[i * 2 - 1]) then
    return math.max(1, redis.call('TTL', KEYS[i]))
  end
end
for i = 1, #KEYS do
  if redis.call('INCR', KEYS[i]) == 1 then redis.call('EXPIRE', KEYS[i], ARGV[i * 2]) end
end
return 0`;

export function docsAddress(request: FastifyRequest): string {
  const peer = request.ip;
  // The hosted tunnel connects on loopback. Never trust caller-controlled X-Forwarded-For.
  const forwarded = request.headers["cf-connecting-ip"];
  const address = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(peer) && typeof forwarded === "string" && isIP(forwarded) ? forwarded : peer;
  // Group IPv6 privacy addresses by /64.
  if (isIP(address) === 6) {
    const [left, right = ""] = address.split("::");
    const first = left!.split(":").filter(Boolean);
    const last = right.split(":").filter(Boolean);
    return [...first, ...Array(Math.max(0, 8 - first.length - last.length)).fill("0"), ...last].slice(0, 4).map((part) => parseInt(part, 16).toString(16)).join(":");
  }
  return address;
}
export async function admitDocs(redis: Redis, address: string): Promise<number> {
  if (redis.status === "wait") await redis.connect();
  const digest = createHash("sha256").update(`docs-helper:${address}`).digest("hex");
  // Fixed rolling windows: 6/minute and 30/day per address, 100/day and 1,000/31 days globally.
  return Number(await redis.eval(ADMIT, 4, `docs:minute:${digest}`, `docs:day:${digest}`, "docs:global:day", "docs:global:month", 6, 60, 30, 86400, 100, 86400, 1000, 2678400));
}
