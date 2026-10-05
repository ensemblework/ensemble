/**
 * Expired device leases become `interrupted`. They are not queued again.
 *
 * One conditional UPDATE … RETURNING, the same idea as `claimSlot`: Postgres
 * hands each row to a single statement, so several API processes can run the
 * sweep and only the winner emits the event. This is not log retention.
 *
 * `lease_until` and `finished_at` are `timestamp without time zone`. Prisma
 * writes them as UTC wall-clock values. `NOW()` is `timestamptz`, and comparing
 * it casts into the session TimeZone, so a database in IST expires every live
 * lease. Compare and store `(NOW() AT TIME ZONE 'UTC')` instead.
 */
import type { FastifyInstance } from "fastify";
import { appendLedger } from "../lib/ledger.js";
import { sseHub } from "../lib/sse.js";
import { INTERRUPTED_ERROR } from "./constants.js";
import { publishBrowserDevice } from "./publish.js";
import { blockInProgressTasks, expireDeviceDecisions } from "./settle.js";

type ExpiredRow = { id: string; user_id: string; device_id: string; task_id: string };

export async function sweepExpiredDeviceLeases(app: FastifyInstance): Promise<number> {
  const rows = await app.prisma.$queryRaw<ExpiredRow[]>`
    UPDATE workspace_jobs
    SET
      status = 'interrupted'::"WorkspaceJobStatus",
      finished_at = (NOW() AT TIME ZONE 'UTC'),
      progress = 'Interrupted',
      error = ${INTERRUPTED_ERROR},
      lease_token = NULL
    WHERE device_id IS NOT NULL
      AND status IN (
        'claimed'::"WorkspaceJobStatus",
        'running'::"WorkspaceJobStatus",
        'waiting_approval'::"WorkspaceJobStatus"
      )
      AND lease_until < (NOW() AT TIME ZONE 'UTC')
    RETURNING id, user_id, device_id, task_id
  `;
  for (const row of rows) {
    await expireDeviceDecisions(app.prisma, [row.id]);
    await blockInProgressTasks(app.prisma, [row.task_id]);
    await app.prisma.workspaceEvent.create({ data: { jobId: row.id, kind: "interrupted", data: { reason: "lease_expired" } } });
    await appendLedger({
      userId: row.user_id,
      actor: "system",
      action: "workspace.job.interrupted",
      taskId: row.task_id,
      payload: { jobId: row.id, deviceId: row.device_id, reason: "lease_expired" },
    });
    sseHub.publish(row.user_id, { event: "workspace", data: { id: row.id } });
    publishBrowserDevice(row.user_id, row.device_id);
  }
  return rows.length;
}
