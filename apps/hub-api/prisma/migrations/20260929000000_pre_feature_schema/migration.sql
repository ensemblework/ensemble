-- Idempotent current schema so `prisma migrate deploy` bootstraps an empty database.
-- Creates are IF NOT EXISTS. Enums and foreign keys ignore duplicate_object.
-- A database that already has these tables (db push, or a later deploy) is unchanged.
--
-- Empty database:
--   pnpm exec prisma migrate deploy
--
-- Database created with `prisma db push` and no migration history (P3005):
--   pnpm exec prisma migrate resolve --applied 20260929100000_db_push_baseline
--   pnpm exec prisma migrate deploy
-- Resolve does not run SQL. Deploy still runs this file (the statements are
-- idempotent) and the feature migrations, including the reminder backfill.
-- Do not resolve this migration or the feature migrations if their columns
-- or the reminder backfill are still missing.
-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "vector";

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "TaskSource" AS ENUM ('email', 'teams', 'slack', 'meeting', 'github', 'manual', 'notion', 'linear', 'other');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "TaskOwner" AS ENUM ('me', 'agent', 'unassigned');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "TaskStatus" AS ENUM ('proposed', 'todo', 'in_progress', 'waiting_approval', 'blocked', 'done', 'dropped');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "Priority" AS ENUM ('p0', 'p1', 'p2');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "TaskComplexity" AS ENUM ('easy', 'medium', 'high', 'max');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "ComplexitySource" AS ENUM ('agent', 'me', 'default');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "Actor" AS ENUM ('agent', 'me', 'system');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "StepStatus" AS ENUM ('pending', 'running', 'done', 'failed', 'needs_approval', 'skipped');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "RunOutcome" AS ENUM ('success', 'failed', 'cancelled', 'needs_info', 'waiting_approval');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "ApprovalKind" AS ENUM ('send_email', 'open_pr', 'post_teams', 'other');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "ApprovalDecision" AS ENUM ('approved', 'edited', 'rejected');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "AutonomyLevel" AS ENUM ('assist', 'supervised', 'autonomous');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "ArtifactKind" AS ENUM ('email', 'chat_msg', 'channel_msg', 'event', 'transcript', 'transcript_segment', 'file', 'pr', 'pr_comment', 'commit', 'issue', 'meeting_note');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "RepoRole" AS ENUM ('owner', 'maintainer', 'contributor');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "RepoProvider" AS ENUM ('github', 'other');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "ProjectStatus" AS ENUM ('active', 'done');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "DeliverableStatus" AS ENUM ('upcoming', 'completed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "WorkspaceJobStatus" AS ENUM ('queued', 'running', 'stopping', 'waiting_approval', 'blocked', 'succeeded', 'failed', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "SkillProvenance" AS ENUM ('bootstrap', 'provisional', 'mined', 'declared');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "tasks" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "notes" TEXT NOT NULL DEFAULT '',
    "board_order" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "today_focus" TEXT NOT NULL DEFAULT 'auto',
    "skill_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "source_kind" "TaskSource" NOT NULL DEFAULT 'manual',
    "source_ref" TEXT NOT NULL DEFAULT '',
    "source_url" TEXT,
    "excerpt" TEXT,
    "owner" "TaskOwner" NOT NULL DEFAULT 'unassigned',
    "status" "TaskStatus" NOT NULL DEFAULT 'proposed',
    "priority" "Priority" NOT NULL DEFAULT 'p1',
    "complexity" "TaskComplexity" NOT NULL DEFAULT 'medium',
    "complexity_source" "ComplexitySource" NOT NULL DEFAULT 'agent',
    "autonomy" "AutonomyLevel" NOT NULL DEFAULT 'assist',
    "due" TIMESTAMP(3),
    "project_id" TEXT,
    "repo_id" TEXT,
    "work_item_id" TEXT,
    "deliverable_id" TEXT,
    "people" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "rationale" TEXT,
    "confidence" DOUBLE PRECISION,
    "agent_suitability" DOUBLE PRECISION,
    "task_type" TEXT,
    "estimate" TEXT,
    "snoozed_until" TIMESTAMP(3),
    "blocked_question" JSONB,
    "created_by" "Actor" NOT NULL DEFAULT 'agent',
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "pinned" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "task_pages" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "content" JSONB,
    "annotations" JSONB NOT NULL DEFAULT '[]',
    "notes_snapshot" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "task_pages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "task_page_mentions" (
    "id" TEXT NOT NULL,
    "page_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "label" TEXT NOT NULL,

    CONSTRAINT "task_page_mentions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "page_discussions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "task_id" TEXT,
    "project_id" TEXT,
    "deliverable_id" TEXT,
    "page_kind" TEXT NOT NULL,
    "page_id" TEXT NOT NULL,
    "source_kind" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "anchor" JSONB,
    "body" JSONB NOT NULL,
    "mentions" JSONB NOT NULL DEFAULT '[]',
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'open',
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "answer" TEXT,
    "error" TEXT,
    "tool_calls" JSONB NOT NULL DEFAULT '[]',
    "conversation_id" TEXT,
    "assistant_message_id" TEXT,
    "request_id" TEXT,
    "lease_at" TIMESTAMP(3),
    "parent_id" TEXT,
    "author_kind" TEXT NOT NULL DEFAULT 'human',
    "mark_id" TEXT,
    "quote" TEXT NOT NULL DEFAULT '',
    "deleted_at" TIMESTAMP(3),
    "model" TEXT,
    "tier" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "page_discussions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "plan_steps" (
    "id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "status" "StepStatus" NOT NULL DEFAULT 'pending',
    "notes" TEXT,
    "tool_calls" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plan_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "runs" (
    "id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "worker" TEXT NOT NULL,
    "skill_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "skill_signatures" JSONB NOT NULL DEFAULT '[]',
    "context_pack_id" TEXT,
    "prompt_version" TEXT,
    "assignment_instructions" TEXT,
    "cursor" INTEGER NOT NULL DEFAULT 0,
    "waiting_approval_id" TEXT,
    "checkpoint" JSONB,
    "question" JSONB,
    "trace_id" TEXT,
    "complexity" "TaskComplexity",
    "requested_model" TEXT,
    "planner_model" TEXT,
    "planner_credits" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMP(3),
    "outcome" "RunOutcome",
    "error" TEXT,
    "deleted_at" TIMESTAMP(3),
    "result" TEXT,

    CONSTRAINT "runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "task_transitions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "from_status" "TaskStatus",
    "to_status" "TaskStatus" NOT NULL,
    "from_owner" "TaskOwner",
    "to_owner" "TaskOwner",
    "actor" "Actor" NOT NULL,
    "reason" TEXT,
    "run_id" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_transitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "workspace_sessions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "repo_full_name" TEXT,
    "repo_path" TEXT,
    "branch" TEXT,
    "context_json" JSONB NOT NULL DEFAULT '{}',
    "context_pack_id" TEXT,
    "handoff_note" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMP(3),

    CONSTRAINT "workspace_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "workspace_jobs" (
    "id" TEXT NOT NULL,
    "sequence" BIGSERIAL NOT NULL,
    "user_id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "run_id" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'code',
    "status" "WorkspaceJobStatus" NOT NULL DEFAULT 'queued',
    "phase" TEXT NOT NULL DEFAULT 'execute',
    "execution_mode" TEXT NOT NULL,
    "delivery" TEXT NOT NULL DEFAULT 'local',
    "ask_before_publish" BOOLEAN NOT NULL DEFAULT true,
    "use_credentials" BOOLEAN NOT NULL DEFAULT false,
    "mark_done" BOOLEAN NOT NULL DEFAULT true,
    "unattended" BOOLEAN NOT NULL DEFAULT false,
    "network_access" BOOLEAN NOT NULL DEFAULT true,
    "external_root" TEXT,
    "include_pre_run_changes" BOOLEAN NOT NULL DEFAULT false,
    "create_branch" BOOLEAN NOT NULL DEFAULT false,
    "branch_mode" TEXT NOT NULL DEFAULT 'as-is',
    "continue_from_job_id" TEXT,
    "repo_url" TEXT,
    "provider" TEXT,
    "model" TEXT NOT NULL,
    "reasoning_effort" TEXT,
    "instructions" TEXT NOT NULL DEFAULT '',
    "repo_path" TEXT NOT NULL DEFAULT '',
    "branch" TEXT NOT NULL DEFAULT '',
    "base_branch" TEXT NOT NULL DEFAULT '',
    "source_branch" TEXT,
    "max_tool_calls" INTEGER NOT NULL DEFAULT 80,
    "turns" INTEGER NOT NULL DEFAULT 0,
    "tool_calls" INTEGER NOT NULL DEFAULT 0,
    "tokens_in" INTEGER NOT NULL DEFAULT 0,
    "tokens_out" INTEGER NOT NULL DEFAULT 0,
    "progress" TEXT,
    "summary" TEXT,
    "resource_keys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "repository" JSONB NOT NULL DEFAULT '{}',
    "max_turns" INTEGER NOT NULL DEFAULT 40,
    "max_minutes" INTEGER NOT NULL DEFAULT 60,
    "complete_deliverable" BOOLEAN NOT NULL DEFAULT false,
    "context" JSONB,
    "evidence" JSONB,
    "publish_request" JSONB,
    "active_process" JSONB,
    "lease_owner" TEXT,
    "lease_until" TIMESTAMP(3),
    "cancel_requested_at" TIMESTAMP(3),
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "workspace_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "code_reviews" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "repo_path" TEXT NOT NULL,
    "initial_head" TEXT NOT NULL,
    "start_tree" TEXT NOT NULL,
    "end_tree" TEXT NOT NULL,
    "start_commit" TEXT,
    "end_commit" TEXT,
    "exact_start" BOOLEAN NOT NULL DEFAULT true,
    "agent_paths" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "attributed" BOOLEAN NOT NULL DEFAULT false,
    "ignored_changed" JSONB NOT NULL DEFAULT '[]',
    "chunk_total" INTEGER,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "expired_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "code_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "code_review_decisions" (
    "review_id" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "chunk_key" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "code_review_decisions_pkey" PRIMARY KEY ("review_id","path","chunk_key")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "terminal_passkeys" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "rp_id" TEXT NOT NULL,
    "public_key" BYTEA NOT NULL,
    "counter" INTEGER NOT NULL DEFAULT 0,
    "transports" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "label" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMP(3),

    CONSTRAINT "terminal_passkeys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "terminal_settings" (
    "user_id" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "allow_tunnel" BOOLEAN NOT NULL DEFAULT false,
    "roots" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "trusted_hooks" JSONB NOT NULL DEFAULT '{}',
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "terminal_settings_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "workspace_events" (
    "id" TEXT NOT NULL,
    "sequence" BIGSERIAL NOT NULL,
    "job_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "notifications" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL DEFAULT '',
    "channel" TEXT NOT NULL DEFAULT 'hub',
    "task_id" TEXT,
    "url" TEXT,
    "urgent" BOOLEAN NOT NULL DEFAULT false,
    "read_at" TIMESTAMP(3),
    "deferred_until" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "run_steps" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "status" "StepStatus" NOT NULL DEFAULT 'pending',
    "output" TEXT,
    "tool_calls" JSONB NOT NULL DEFAULT '[]',
    "reasoning" TEXT,
    "reasoning_source" TEXT,
    "model" TEXT,
    "tokens_in" INTEGER,
    "tokens_out" INTEGER,
    "credits" DOUBLE PRECISION,
    "started_at" TIMESTAMP(3),
    "ended_at" TIMESTAMP(3),
    "error" TEXT,

    CONSTRAINT "run_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "approvals" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "task_id" TEXT,
    "user_id" TEXT NOT NULL,
    "kind" "ApprovalKind" NOT NULL,
    "title" TEXT NOT NULL,
    "step_index" INTEGER,
    "preview" JSONB NOT NULL,
    "edited_payload" JSONB,
    "decision" "ApprovalDecision",
    "reason" TEXT,
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),

    CONSTRAINT "approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "people" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "upn" TEXT,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "role" TEXT,
    "team" TEXT,
    "relationship_weight" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "typical_response_hours" DOUBLE PRECISION,
    "last_interaction" TIMESTAMP(3),
    "evidence" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "people_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "projects" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "summary" TEXT NOT NULL DEFAULT '',
    "notes" TEXT NOT NULL DEFAULT '',
    "status" "ProjectStatus" NOT NULL DEFAULT 'active',
    "aliases" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "work_item_root" TEXT,
    "created_by" "Actor" NOT NULL DEFAULT 'agent',
    "evidence" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "content" JSONB,
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "project_people" (
    "project_id" TEXT NOT NULL,
    "person_id" TEXT NOT NULL,
    "role" TEXT,
    "added_by" "Actor" NOT NULL DEFAULT 'agent',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_people_pkey" PRIMARY KEY ("project_id","person_id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "project_repos" (
    "project_id" TEXT NOT NULL,
    "repo_id" TEXT NOT NULL,
    "added_by" "Actor" NOT NULL DEFAULT 'agent',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_repos_pkey" PRIMARY KEY ("project_id","repo_id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "deliverables" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" "DeliverableStatus" NOT NULL DEFAULT 'upcoming',
    "due" TIMESTAMP(3),
    "owner" TEXT,
    "notes" TEXT NOT NULL DEFAULT '',
    "source_ref" TEXT,
    "created_by" "Actor" NOT NULL DEFAULT 'agent',
    "completed_at" TIMESTAMP(3),
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "deliverables_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "repos" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "provider" "RepoProvider" NOT NULL DEFAULT 'github',
    "url" TEXT,
    "description" TEXT,
    "default_branch" TEXT,
    "tracked" BOOLEAN NOT NULL DEFAULT false,
    "last_synced_at" TIMESTAMP(3),
    "my_role" "RepoRole" NOT NULL DEFAULT 'contributor',
    "languages" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "pr_stats" JSONB NOT NULL DEFAULT '{}',
    "codeowners_paths" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "evidence" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "repos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "preferences" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "evidence" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "source" TEXT NOT NULL DEFAULT 'agent',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "preferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "context_suppressions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL DEFAULT '',
    "reason" TEXT NOT NULL DEFAULT 'deleted by the engineer',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "context_suppressions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "meeting_notes" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "title_source" TEXT NOT NULL DEFAULT 'derived',
    "prompt" TEXT NOT NULL DEFAULT '',
    "answer" TEXT NOT NULL DEFAULT '',
    "model" TEXT,
    "took_seconds" DOUBLE PRECISION,
    "asked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "occurred_at" TIMESTAMP(3),
    "person_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "project_id" TEXT,
    "repo_id" TEXT,
    "comment" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ready',
    "source" TEXT NOT NULL DEFAULT 'paste',
    "error" TEXT,
    "extraction" JSONB,
    "extraction_model" TEXT,
    "extraction_credits" DOUBLE PRECISION,
    "extracted_at" TIMESTAMP(3),
    "applied_at" TIMESTAMP(3),
    "artifact_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "meeting_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "artifacts" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "task_id" TEXT,
    "kind" "ArtifactKind" NOT NULL,
    "external_id" TEXT NOT NULL,
    "url" TEXT,
    "ts" TIMESTAMP(3) NOT NULL,
    "actor_id" TEXT,
    "participants" JSONB NOT NULL DEFAULT '[]',
    "title" TEXT NOT NULL DEFAULT '',
    "text" TEXT NOT NULL DEFAULT '',
    "thread_id" TEXT,
    "parent_id" TEXT,
    "project_id" TEXT,
    "repo_id" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "authored_by_me" BOOLEAN NOT NULL DEFAULT false,
    "search_vector" tsvector,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "artifacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "context_documents" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "artifact_id" TEXT,
    "filename" TEXT NOT NULL,
    "media_type" TEXT NOT NULL,
    "byte_size" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "original" BYTEA NOT NULL,
    "format" TEXT NOT NULL,
    "parse_status" TEXT NOT NULL DEFAULT 'queued',
    "parse_error" JSONB,
    "parser_version" TEXT,
    "text_characters" INTEGER NOT NULL DEFAULT 0,
    "page_count" INTEGER,
    "warnings" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "parsed_at" TIMESTAMP(3),
    "enrichment_status" TEXT NOT NULL DEFAULT 'queued',
    "enrichment_error" JSONB,
    "summary" TEXT,
    "enriched_at" TIMESTAMP(3),
    "manual_tags" JSONB NOT NULL DEFAULT '{}',
    "matched_tags" JSONB NOT NULL DEFAULT '{}',
    "project_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "repo_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "person_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "task_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "work_item_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "deliverable_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "generation" INTEGER NOT NULL DEFAULT 1,
    "parse_attempts" INTEGER NOT NULL DEFAULT 0,
    "enrichment_attempts" INTEGER NOT NULL DEFAULT 0,
    "lease_token" TEXT,
    "lease_expires_at" TIMESTAMP(3),
    "model_usage" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "context_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "extractions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "artifact_id" TEXT NOT NULL,
    "items" JSONB NOT NULL DEFAULT '[]',
    "model" TEXT,
    "method" TEXT NOT NULL DEFAULT 'heuristic',
    "extracted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "extractions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "sync_state" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "connector" TEXT NOT NULL,
    "cursor" TEXT,
    "last_sync_at" TIMESTAMP(3),
    "last_error" TEXT,
    "item_count" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sync_state_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "artifact_chunks" (
    "id" TEXT NOT NULL,
    "artifact_id" TEXT NOT NULL,
    "index" INTEGER NOT NULL DEFAULT 0,
    "text" TEXT NOT NULL,
    "embedding" vector(3072),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "artifact_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "context_packs" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "task_id" TEXT,
    "summary" TEXT NOT NULL,
    "items" JSONB NOT NULL DEFAULT '[]',
    "skills_suggested" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "token_estimate" INTEGER,
    "built_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "context_packs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "skills" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "scope" JSONB NOT NULL DEFAULT '{}',
    "version" INTEGER NOT NULL DEFAULT 1,
    "body" TEXT NOT NULL,
    "evidence" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "provenance" "SkillProvenance" NOT NULL DEFAULT 'bootstrap',
    "style_profile" JSONB NOT NULL DEFAULT '{}',
    "mined_from" INTEGER NOT NULL DEFAULT 0,
    "acceptance_rate" DOUBLE PRECISION,
    "accepted_count" INTEGER NOT NULL DEFAULT 0,
    "edited_count" INTEGER NOT NULL DEFAULT 0,
    "rejected_count" INTEGER NOT NULL DEFAULT 0,
    "last_used_at" TIMESTAMP(3),
    "proposed_body" TEXT,
    "proposed_changes" JSONB,
    "proposed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "skills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "skill_feedback" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "skill_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "run_id" TEXT,
    "approval_id" TEXT,
    "original" JSONB,
    "edited" JSONB,
    "reason" TEXT,
    "folded" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "skill_feedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "skill_versions" (
    "id" TEXT NOT NULL,
    "skill_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "body" TEXT NOT NULL,
    "evidence" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "skill_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "audit_ledger" (
    "id" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "user_id" TEXT NOT NULL,
    "actor" "Actor" NOT NULL,
    "action" TEXT NOT NULL,
    "task_id" TEXT,
    "run_id" TEXT,
    "approval_id" TEXT,
    "input_hash" TEXT,
    "output_hash" TEXT,
    "prev_hash" TEXT,
    "hash" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "audit_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "metric_events" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "kind" TEXT NOT NULL,
    "task_id" TEXT,
    "run_id" TEXT,
    "seconds" DOUBLE PRECISION,
    "payload" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "metric_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "metric_baselines" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "seconds" DOUBLE PRECISION NOT NULL,
    "sample_size" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "metric_baselines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "oauth_tokens" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "access_token" TEXT NOT NULL,
    "refresh_token" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "account" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "oauth_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "assistant_conversations" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT 'New chat',
    "started_on" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assistant_conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "assistant_messages" (
    "id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL DEFAULT '',
    "tool_calls" JSONB NOT NULL DEFAULT '[]',
    "model" TEXT,
    "credits" DOUBLE PRECISION,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assistant_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "undo_entries" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "seq" BIGINT NOT NULL,
    "label" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "actor" "Actor" NOT NULL DEFAULT 'me',
    "subject" TEXT NOT NULL,
    "href" TEXT,
    "inverse" JSONB NOT NULL,
    "forward" JSONB NOT NULL,
    "undone_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "undo_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "private_reminders" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "title_content" JSONB NOT NULL,
    "due_date" TEXT NOT NULL,
    "due_time" TEXT,
    "time_zone" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "next_notification_at" TIMESTAMP(3),
    "last_notified_at" TIMESTAMP(3),
    "notification_sequence" INTEGER NOT NULL DEFAULT 0,
    "action_token_hash" TEXT NOT NULL,
    "claim_token" TEXT,
    "claim_until" TIMESTAMP(3),
    "delivery_error" TEXT,
    "dismissed_at" TIMESTAMP(3),
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "private_reminders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "completion_records" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "entity_kind" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL DEFAULT '',
    "skill_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "people" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "project_id" TEXT,
    "project_name" TEXT,
    "repo_id" TEXT,
    "repo_full_name" TEXT,
    "outcome" TEXT NOT NULL,
    "completed_at" TIMESTAMP(3),
    "source_json" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "completion_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "model_probes" (
    "user_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "detail" TEXT NOT NULL DEFAULT '',
    "checked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "model_probes_pkey" PRIMARY KEY ("user_id","provider","model")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "watchers" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "surface" TEXT NOT NULL DEFAULT 'deliverable',
    "prompt" TEXT NOT NULL DEFAULT '',
    "scope_kind" TEXT NOT NULL,
    "scope_id" TEXT NOT NULL,
    "condition" TEXT NOT NULL,
    "days_before" INTEGER,
    "action" TEXT NOT NULL DEFAULT 'notify',
    "message" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'active',
    "fired_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "watchers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "ensemble_replies" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "surface" TEXT NOT NULL,
    "anchor_key" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "content" TEXT NOT NULL DEFAULT '',
    "tool_calls" JSONB NOT NULL DEFAULT '[]',
    "citations" JSONB NOT NULL DEFAULT '[]',
    "act_as" TEXT NOT NULL DEFAULT 'general',
    "model" TEXT NOT NULL DEFAULT '',
    "tier" TEXT NOT NULL DEFAULT 'medium',
    "status" TEXT NOT NULL DEFAULT 'open',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ensemble_replies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "private_reminder_desktops" (
    "host_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "private_reminder_desktops_pkey" PRIMARY KEY ("host_id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "password_hash" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_login_at" TIMESTAMP(3),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "sessions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "user_agent" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "api_tokens" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "last_used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "api_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "model_credentials" (
    "user_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "hint" TEXT NOT NULL DEFAULT '',
    "base_url" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "model_credentials_pkey" PRIMARY KEY ("user_id","provider")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "connector_apps" (
    "provider" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "client_secret" TEXT NOT NULL,
    "updated_by" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "connector_apps_pkey" PRIMARY KEY ("provider")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "agent_decisions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "tool_name" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "detail" JSONB NOT NULL DEFAULT '{}',
    "session_id" TEXT,
    "cwd" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "decision" TEXT,
    "scope" TEXT,
    "reason" TEXT,
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "decision_rules" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "tool_name" TEXT NOT NULL,
    "pattern" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "session_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "decision_rules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "tasks_user_id_status_idx" ON "tasks"("user_id", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "tasks_user_id_owner_idx" ON "tasks"("user_id", "owner");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "tasks_user_id_created_at_idx" ON "tasks"("user_id", "created_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "tasks_user_id_status_board_order_idx" ON "tasks"("user_id", "status", "board_order");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "tasks_user_id_due_idx" ON "tasks"("user_id", "due");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "tasks_user_id_deleted_at_idx" ON "tasks"("user_id", "deleted_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "tasks_user_id_completed_at_idx" ON "tasks"("user_id", "completed_at");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "task_pages_task_id_key" ON "task_pages"("task_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "task_pages_user_id_idx" ON "task_pages"("user_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "task_page_mentions_kind_entity_id_idx" ON "task_page_mentions"("kind", "entity_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "task_page_mentions_page_id_kind_entity_id_key" ON "task_page_mentions"("page_id", "kind", "entity_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "page_discussions_scope_idx" ON "page_discussions"("user_id", "page_kind", "page_id", "source_kind", "source_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "page_discussions_parent_id_idx" ON "page_discussions"("parent_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "page_discussions_user_id_deleted_at_idx" ON "page_discussions"("user_id", "deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "plan_steps_task_id_index_key" ON "plan_steps"("task_id", "index");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "runs_user_id_started_at_idx" ON "runs"("user_id", "started_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "runs_task_id_idx" ON "runs"("task_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "task_transitions_user_id_at_idx" ON "task_transitions"("user_id", "at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "task_transitions_task_id_at_idx" ON "task_transitions"("task_id", "at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "workspace_sessions_user_id_status_idx" ON "workspace_sessions"("user_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "workspace_jobs_run_id_key" ON "workspace_jobs"("run_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "workspace_jobs_status_sequence_idx" ON "workspace_jobs"("status", "sequence");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "workspace_jobs_user_id_task_id_created_at_idx" ON "workspace_jobs"("user_id", "task_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "code_reviews_job_id_key" ON "code_reviews"("job_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "code_reviews_user_id_created_at_idx" ON "code_reviews"("user_id", "created_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "code_reviews_expires_at_idx" ON "code_reviews"("expires_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "terminal_passkeys_user_id_idx" ON "terminal_passkeys"("user_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "workspace_events_job_id_sequence_idx" ON "workspace_events"("job_id", "sequence");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "notifications_user_id_created_at_idx" ON "notifications"("user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "run_steps_run_id_index_key" ON "run_steps"("run_id", "index");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "approvals_user_id_decision_requested_at_idx" ON "approvals"("user_id", "decision", "requested_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "approvals_user_id_decision_idx" ON "approvals"("user_id", "decision");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "approvals_run_id_step_index_key" ON "approvals"("run_id", "step_index");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "people_user_id_name_idx" ON "people"("user_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "people_user_id_upn_key" ON "people"("user_id", "upn");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "projects_user_id_status_idx" ON "projects"("user_id", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "projects_user_id_completed_at_idx" ON "projects"("user_id", "completed_at");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "projects_user_id_name_key" ON "projects"("user_id", "name");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "project_people_person_id_idx" ON "project_people"("person_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "project_repos_repo_id_idx" ON "project_repos"("repo_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "deliverables_user_id_status_due_idx" ON "deliverables"("user_id", "status", "due");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "deliverables_project_id_status_idx" ON "deliverables"("project_id", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "repos_user_id_tracked_idx" ON "repos"("user_id", "tracked");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "repos_user_id_full_name_key" ON "repos"("user_id", "full_name");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "preferences_user_id_key_key" ON "preferences"("user_id", "key");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "context_suppressions_user_id_kind_idx" ON "context_suppressions"("user_id", "kind");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "context_suppressions_user_id_kind_key_key" ON "context_suppressions"("user_id", "kind", "key");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "meeting_notes_user_id_asked_at_idx" ON "meeting_notes"("user_id", "asked_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "meeting_notes_user_id_project_id_idx" ON "meeting_notes"("user_id", "project_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "meeting_notes_user_id_status_idx" ON "meeting_notes"("user_id", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "artifacts_user_id_task_id_idx" ON "artifacts"("user_id", "task_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "artifacts_user_id_ts_idx" ON "artifacts"("user_id", "ts");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "artifacts_user_id_thread_id_idx" ON "artifacts"("user_id", "thread_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "artifacts_user_id_authored_by_me_kind_idx" ON "artifacts"("user_id", "authored_by_me", "kind");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "artifacts_user_id_kind_ts_idx" ON "artifacts"("user_id", "kind", "ts");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "artifacts_user_id_project_id_idx" ON "artifacts"("user_id", "project_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "artifacts_user_id_kind_external_id_key" ON "artifacts"("user_id", "kind", "external_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "context_documents_artifact_id_key" ON "context_documents"("artifact_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "context_documents_user_id_created_at_id_idx" ON "context_documents"("user_id", "created_at", "id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "context_documents_parse_status_enrichment_status_created_at_idx" ON "context_documents"("parse_status", "enrichment_status", "created_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "context_documents_lease_expires_at_idx" ON "context_documents"("lease_expires_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "context_documents_project_ids_idx" ON "context_documents" USING GIN ("project_ids");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "context_documents_repo_ids_idx" ON "context_documents" USING GIN ("repo_ids");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "context_documents_person_ids_idx" ON "context_documents" USING GIN ("person_ids");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "context_documents_task_ids_idx" ON "context_documents" USING GIN ("task_ids");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "context_documents_work_item_ids_idx" ON "context_documents" USING GIN ("work_item_ids");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "context_documents_deliverable_ids_idx" ON "context_documents" USING GIN ("deliverable_ids");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "extractions_artifact_id_key" ON "extractions"("artifact_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "extractions_user_id_extracted_at_idx" ON "extractions"("user_id", "extracted_at");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "sync_state_user_id_connector_key" ON "sync_state"("user_id", "connector");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "artifact_chunks_artifact_id_index_key" ON "artifact_chunks"("artifact_id", "index");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "context_packs_user_id_built_at_idx" ON "context_packs"("user_id", "built_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "skills_user_id_enabled_idx" ON "skills"("user_id", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "skills_user_id_slug_key" ON "skills"("user_id", "slug");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "skill_versions_skill_id_version_key" ON "skill_versions"("skill_id", "version");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "audit_ledger_user_id_ts_idx" ON "audit_ledger"("user_id", "ts");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "audit_ledger_run_id_idx" ON "audit_ledger"("run_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "metric_events_user_id_kind_ts_idx" ON "metric_events"("user_id", "kind", "ts");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "metric_baselines_user_id_kind_key" ON "metric_baselines"("user_id", "kind");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "oauth_tokens_user_id_provider_key" ON "oauth_tokens"("user_id", "provider");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "assistant_conversations_user_id_updated_at_idx" ON "assistant_conversations"("user_id", "updated_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "assistant_messages_conversation_id_created_at_idx" ON "assistant_messages"("conversation_id", "created_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "undo_entries_user_id_undone_at_seq_idx" ON "undo_entries"("user_id", "undone_at", "seq");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "undo_entries_user_id_seq_key" ON "undo_entries"("user_id", "seq");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "private_reminders_due_idx" ON "private_reminders"("user_id", "deleted_at", "dismissed_at", "next_notification_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "completion_records_user_id_created_at_idx" ON "completion_records"("user_id", "created_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "watchers_user_id_status_idx" ON "watchers"("user_id", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ensemble_replies_user_id_surface_anchor_key_idx" ON "ensemble_replies"("user_id", "surface", "anchor_key");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "sessions_user_id_idx" ON "sessions"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "api_tokens_token_hash_key" ON "api_tokens"("token_hash");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "api_tokens_user_id_idx" ON "api_tokens"("user_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "agent_decisions_user_id_status_requested_at_idx" ON "agent_decisions"("user_id", "status", "requested_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "decision_rules_user_id_source_tool_name_idx" ON "decision_rules"("user_id", "source", "tool_name");

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "tasks" ADD CONSTRAINT "tasks_deliverable_id_fkey" FOREIGN KEY ("deliverable_id") REFERENCES "deliverables"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "tasks" ADD CONSTRAINT "tasks_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "tasks" ADD CONSTRAINT "tasks_repo_id_fkey" FOREIGN KEY ("repo_id") REFERENCES "repos"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "task_pages" ADD CONSTRAINT "task_pages_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "task_page_mentions" ADD CONSTRAINT "task_page_mentions_page_id_fkey" FOREIGN KEY ("page_id") REFERENCES "task_pages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "page_discussions" ADD CONSTRAINT "page_discussions_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "page_discussions" ADD CONSTRAINT "page_discussions_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "page_discussions" ADD CONSTRAINT "page_discussions_deliverable_id_fkey" FOREIGN KEY ("deliverable_id") REFERENCES "deliverables"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "page_discussions" ADD CONSTRAINT "page_discussions_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "page_discussions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "plan_steps" ADD CONSTRAINT "plan_steps_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "runs" ADD CONSTRAINT "runs_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "runs" ADD CONSTRAINT "runs_context_pack_id_fkey" FOREIGN KEY ("context_pack_id") REFERENCES "context_packs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "task_transitions" ADD CONSTRAINT "task_transitions_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "workspace_sessions" ADD CONSTRAINT "workspace_sessions_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "workspace_jobs" ADD CONSTRAINT "workspace_jobs_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "workspace_jobs" ADD CONSTRAINT "workspace_jobs_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "code_reviews" ADD CONSTRAINT "code_reviews_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "workspace_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "code_review_decisions" ADD CONSTRAINT "code_review_decisions_review_id_fkey" FOREIGN KEY ("review_id") REFERENCES "code_reviews"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "workspace_events" ADD CONSTRAINT "workspace_events_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "workspace_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "run_steps" ADD CONSTRAINT "run_steps_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "approvals" ADD CONSTRAINT "approvals_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "project_people" ADD CONSTRAINT "project_people_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "project_people" ADD CONSTRAINT "project_people_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "people"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "project_repos" ADD CONSTRAINT "project_repos_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "project_repos" ADD CONSTRAINT "project_repos_repo_id_fkey" FOREIGN KEY ("repo_id") REFERENCES "repos"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "deliverables" ADD CONSTRAINT "deliverables_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "meeting_notes" ADD CONSTRAINT "meeting_notes_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "meeting_notes" ADD CONSTRAINT "meeting_notes_repo_id_fkey" FOREIGN KEY ("repo_id") REFERENCES "repos"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_repo_id_fkey" FOREIGN KEY ("repo_id") REFERENCES "repos"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "context_documents" ADD CONSTRAINT "context_documents_artifact_id_fkey" FOREIGN KEY ("artifact_id") REFERENCES "artifacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "extractions" ADD CONSTRAINT "extractions_artifact_id_fkey" FOREIGN KEY ("artifact_id") REFERENCES "artifacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "artifact_chunks" ADD CONSTRAINT "artifact_chunks_artifact_id_fkey" FOREIGN KEY ("artifact_id") REFERENCES "artifacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "skill_feedback" ADD CONSTRAINT "skill_feedback_skill_id_fkey" FOREIGN KEY ("skill_id") REFERENCES "skills"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "skill_versions" ADD CONSTRAINT "skill_versions_skill_id_fkey" FOREIGN KEY ("skill_id") REFERENCES "skills"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "assistant_messages" ADD CONSTRAINT "assistant_messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "assistant_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

