-- Morning-brief quiet period, and keyboard meeting notes.
-- nudge_paused_until keeps a "still relevant?" card quiet after Keep or Snooze.
-- meeting_sessions are soft-deleted into Trash. Calendar attach writes metadata
-- on the Ensemble event only; connectors stay read-only.

ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "nudge_paused_until" TIMESTAMP(3);

CREATE TABLE IF NOT EXISTS "meeting_sessions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "artifact_id" TEXT,
    "meeting_note_id" TEXT,
    "title" TEXT NOT NULL,
    "notes" TEXT NOT NULL DEFAULT '',
    "recap" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'live',
    "attach_state" TEXT NOT NULL DEFAULT 'none',
    "person_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMP(3),
    "recap_at" TIMESTAMP(3),
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "meeting_sessions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "meeting_sessions_user_id_status_idx" ON "meeting_sessions"("user_id", "status");
CREATE INDEX IF NOT EXISTS "meeting_sessions_user_id_deleted_at_idx" ON "meeting_sessions"("user_id", "deleted_at");
CREATE INDEX IF NOT EXISTS "meeting_sessions_user_id_artifact_id_idx" ON "meeting_sessions"("user_id", "artifact_id");
CREATE INDEX IF NOT EXISTS "meeting_sessions_user_id_started_at_idx" ON "meeting_sessions"("user_id", "started_at");
