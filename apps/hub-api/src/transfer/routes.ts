/**
 * Receiving a computer's local-only data (docs/DESKTOP.md §1.3). Only a `transfer` key reaches these:
 * the desktop app gets one when the person approves "Move this computer's data" in the browser, and it
 * stops working when the move finishes or after a day.
 */
import { z } from "zod";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { appendLedger } from "../lib/ledger.js";
import { sseHub } from "../lib/sse.js";
import { maxFileBytes } from "../files/store.js";
import { isHosted } from "../lib/hosted-access.js";
import { hostedLimits } from "../lib/hosted-limits.js";
import { applyPatches, importBatch } from "./import.js";
import { TRANSFER_TABLES } from "./schema.js";

const Row = z.record(z.string(), z.unknown());
const RowsBody = z.object({
  batch: z.array(z.object({ table: z.string().max(64), rows: z.array(Row).max(1000) })).max(60),
});
const FinishBody = z.object({
  patches: z.array(z.object({ table: z.string().max(64), id: z.string().max(80), column: z.string().max(64), value: z.string().max(80) })).max(20_000).default([]),
  counts: z.record(z.string(), z.object({ added: z.number(), merged: z.number(), skipped: z.number() })).default({}),
});

/** A move's batch can hold one large file: its bytes travel as hex text inside the row. */
const ROWS_BODY_LIMIT = 64 * 1024 * 1024;

function requireTransferKey(request: FastifyRequest): void {
  if (request.authVia === "token" && request.tokenScope === "transfer") return;
  throw Object.assign(new Error("Moving a computer's data needs the key the Ensemble app gets when you approve the move."), { statusCode: 403 });
}

export async function transferRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/transfer", async (request) => {
    requireTransferKey(request);
    const user = await app.prisma.user.findUnique({ where: { id: request.userId }, select: { email: true, name: true } });
    const limits = isHosted() ? hostedLimits() : null;
    return {
      account: user,
      tables: TRANSFER_TABLES,
      maxFileBytes: maxFileBytes(),
      limits: limits ? { files: limits.documents, fileBytes: limits.documentBytes, datasetBytes: limits.datasetBytes } : null,
    };
  });

  app.post("/api/transfer/rows", { bodyLimit: ROWS_BODY_LIMIT }, async (request) => {
    requireTransferKey(request);
    const body = RowsBody.parse(request.body);
    return importBatch(app.prisma, request.userId, body.batch);
  });

  app.post("/api/transfer/finish", async (request) => {
    requireTransferKey(request);
    const body = FinishBody.parse(request.body ?? {});
    const patched = await applyPatches(app.prisma, request.userId, body.patches);
    const totals = Object.values(body.counts).reduce((sum, row) => ({ added: sum.added + row.added, merged: sum.merged + row.merged, skipped: sum.skipped + row.skipped }), { added: 0, merged: 0, skipped: 0 });
    if (request.tokenId) await app.prisma.apiToken.updateMany({ where: { id: request.tokenId, userId: request.userId }, data: { revokedAt: new Date() } });
    await appendLedger({ userId: request.userId, actor: "me", action: "transfer.import", payload: { ...totals, patched, tables: Object.keys(body.counts).length } });
    sseHub.publish(request.userId, { event: "workspace", data: { transfer: true } });
    return { patched, ...totals };
  });
}
