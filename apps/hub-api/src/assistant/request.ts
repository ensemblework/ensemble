import type { FastifyRequest } from "fastify";
import type { ToolContext } from "./types.js";

export function assistantHeaders(request: Pick<FastifyRequest, "headers">): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const key of ["authorization", "cookie", "origin", "x-ensemble-share", "x-ensemble-link", "x-ensemble-visitor", "x-ensemble-user", "x-ensemble-internal"]) {
    const value = request.headers[key];
    if (typeof value === "string") headers[key] = value;
  }
  return headers;
}

/** Reuse the web route's validation, access checks, quotas and side effects. */
export async function assistantRequest(ctx: ToolContext, method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload?: unknown, contentType?: string): Promise<any> {
  if (!ctx.requestHeaders) throw new Error("Open this action in the signed-in Ensemble assistant.");
  const response = await ctx.app.inject({ method, url, headers: { ...ctx.requestHeaders, ...(contentType ? { "content-type": contentType } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) });
  let result: any;
  try { result = response.json(); } catch { result = {}; }
  if (response.statusCode >= 400) throw Object.assign(new Error(result.error ?? result.message ?? `The action failed (${response.statusCode}).`), { statusCode: response.statusCode });
  return result;
}
