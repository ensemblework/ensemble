-- Ensemble Node runtime (docs/35 §6.3; ensemble-node docs/design): missions and steps as tables with
-- separate execution and outcome, a transactional outbox, run settings and worker reports, lanes and
-- audiences on turns. Existing plan cards become contract-1 missions with the same ids, so planId keeps naming them.

-- AlterTable
ALTER TABLE "workspace_jobs" ADD COLUMN     "operation_id" TEXT,
ADD COLUMN     "queue_position" INTEGER,
ADD COLUMN     "report" JSONB;

-- AlterTable
ALTER TABLE "node_runs" ADD COLUMN     "attempt" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "settings" JSONB;

-- AlterTable
ALTER TABLE "node_turns" ADD COLUMN     "audience" TEXT NOT NULL DEFAULT 'owner',
ADD COLUMN     "lane" TEXT,
ADD COLUMN     "operation_id" TEXT,
ADD COLUMN     "side_effects_at" TIMESTAMP(3),
ADD COLUMN     "space_id" TEXT;

-- CreateTable
CREATE TABLE "node_missions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "lead_node_id" TEXT NOT NULL,
    "origin_room_id" TEXT NOT NULL,
    "origin_private" BOOLEAN NOT NULL DEFAULT false,
    "lead_turn_id" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'plan',
    "contract" INTEGER NOT NULL DEFAULT 3,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "revision" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "goal" TEXT,
    "constraints" JSONB NOT NULL DEFAULT '{}',
    "requirements" JSONB NOT NULL DEFAULT '[]',
    "deferred" JSONB NOT NULL DEFAULT '[]',
    "space_id" TEXT,
    "requested_by" JSONB,
    "deliver_to" JSONB,
    "principals" JSONB NOT NULL DEFAULT '{}',
    "reported_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "ended_at" TIMESTAMP(3),

    CONSTRAINT "node_missions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "node_steps" (
    "mission_id" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "node_id" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'other',
    "executor" TEXT NOT NULL DEFAULT 'node',
    "brief" TEXT NOT NULL,
    "after" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "verifies" TEXT,
    "requirement_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "run" JSONB,
    "status" TEXT NOT NULL DEFAULT 'waiting',
    "outcome" TEXT NOT NULL DEFAULT 'unknown',
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "attempts" JSONB NOT NULL DEFAULT '[]',
    "report" JSONB,
    "result" TEXT,
    "progress" TEXT,
    "session_id" TEXT,
    "nudged" BOOLEAN NOT NULL DEFAULT false,
    "started_at" TIMESTAMP(3),
    "ended_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "node_steps_pkey" PRIMARY KEY ("mission_id","id")
);

-- CreateTable
CREATE TABLE "node_outbox" (
    "id" TEXT NOT NULL,
    "operation_id" TEXT NOT NULL,
    "mission_id" TEXT,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "available_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "claimed_until" TIMESTAMP(3),
    "delivered_at" TIMESTAMP(3),
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "node_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "node_missions_user_id_status_idx" ON "node_missions"("user_id", "status");

-- CreateIndex
CREATE INDEX "node_missions_lead_node_id_status_idx" ON "node_missions"("lead_node_id", "status");

-- CreateIndex
CREATE INDEX "node_missions_origin_room_id_idx" ON "node_missions"("origin_room_id");

-- CreateIndex
CREATE INDEX "node_steps_node_id_status_idx" ON "node_steps"("node_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "node_steps_mission_id_position_key" ON "node_steps"("mission_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "node_outbox_operation_id_key" ON "node_outbox"("operation_id");

-- CreateIndex
CREATE INDEX "node_outbox_delivered_at_available_at_idx" ON "node_outbox"("delivered_at", "available_at");

-- CreateIndex
CREATE INDEX "node_outbox_mission_id_idx" ON "node_outbox"("mission_id");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_jobs_operation_id_key" ON "workspace_jobs"("operation_id");

-- CreateIndex
CREATE UNIQUE INDEX "node_turns_operation_id_key" ON "node_turns"("operation_id");

-- AddForeignKey
ALTER TABLE "node_steps" ADD CONSTRAINT "node_steps_mission_id_fkey" FOREIGN KEY ("mission_id") REFERENCES "node_missions"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Existing plans (their JSON on the plan card) become contract-1 missions, so a running plan goes on.
INSERT INTO "node_missions" ("id", "user_id", "lead_node_id", "origin_room_id", "origin_private", "lead_turn_id", "kind", "contract", "status", "version", "created_at", "updated_at", "ended_at")
SELECT
  m."id",
  m."user_id",
  m."data"->>'leadNodeId',
  COALESCE(m."data"->>'originRoomId', m."room_id"),
  COALESCE((m."data"->>'originPrivate')::boolean, false),
  m."data"->>'leadTurnId',
  'plan',
  1,
  CASE m."data"->>'status'
    WHEN 'done' THEN CASE WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(m."data"->'steps') s WHERE s->>'status' <> 'done') THEN 'partially_completed' ELSE 'succeeded' END
    WHEN 'stopped' THEN 'stopped'
    WHEN 'reporting' THEN 'reporting'
    WHEN 'running' THEN 'running'
    ELSE 'draft'
  END,
  COALESCE((m."data"->>'version')::int, 0),
  m."created_at",
  CURRENT_TIMESTAMP,
  CASE WHEN m."data"->>'status' IN ('done', 'stopped') THEN CURRENT_TIMESTAMP ELSE NULL END
FROM "node_messages" m
WHERE m."kind" = 'plan' AND m."data"->>'type' = 'plan' AND m."data"->>'leadNodeId' IS NOT NULL
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "node_steps" ("mission_id", "id", "position", "node_id", "handle", "name", "kind", "executor", "brief", "after", "run", "status", "outcome", "attempt", "attempts", "result", "progress", "started_at", "ended_at", "created_at", "updated_at")
SELECT
  m."id",
  s.value->>'id',
  s.ordinality::int,
  s.value->>'nodeId',
  COALESCE(s.value->>'handle', ''),
  COALESCE(s.value->>'name', ''),
  'other',
  'node',
  COALESCE(s.value->>'brief', ''),
  COALESCE(ARRAY(SELECT jsonb_array_elements_text(COALESCE(s.value->'after', '[]'::jsonb))), ARRAY[]::TEXT[]),
  s.value->'run',
  COALESCE(s.value->>'status', 'waiting'),
  CASE s.value->>'status' WHEN 'done' THEN 'done' WHEN 'blocked' THEN 'blocked' ELSE 'unknown' END,
  1,
  '[]'::jsonb,
  s.value->>'result',
  s.value->>'progress',
  ((s.value->>'startedAt')::timestamptz AT TIME ZONE 'UTC')::timestamp(3),
  ((s.value->>'endedAt')::timestamptz AT TIME ZONE 'UTC')::timestamp(3),
  m."created_at",
  CURRENT_TIMESTAMP
FROM "node_messages" m
CROSS JOIN LATERAL jsonb_array_elements(m."data"->'steps') WITH ORDINALITY AS s(value, ordinality)
WHERE m."kind" = 'plan' AND m."data"->>'type' = 'plan' AND m."data"->>'leadNodeId' IS NOT NULL AND s.value->>'id' IS NOT NULL
ON CONFLICT DO NOTHING;
