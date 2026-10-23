-- CreateTable
CREATE TABLE "node_agents" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "space_id" TEXT,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'assistant',
    "avatar" JSONB NOT NULL DEFAULT '{}',
    "charter" TEXT NOT NULL DEFAULT '',
    "provider" TEXT,
    "model" TEXT,
    "run_profile_id" TEXT,
    "autonomy" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'active',
    "template_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "node_agents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "node_rooms" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "last_seq" INTEGER NOT NULL DEFAULT 0,
    "last_message_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archived_at" TIMESTAMP(3),

    CONSTRAINT "node_rooms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "node_room_members" (
    "id" TEXT NOT NULL,
    "room_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "node_id" TEXT,
    "handle" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'member',
    "representative" BOOLEAN NOT NULL DEFAULT false,
    "conversation_id" TEXT,
    "seen_seq" INTEGER NOT NULL DEFAULT 0,
    "private_conversation_id" TEXT,
    "private_seen_seq" INTEGER NOT NULL DEFAULT 0,
    "read_seq" INTEGER NOT NULL DEFAULT 0,
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "node_room_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "node_messages" (
    "id" TEXT NOT NULL,
    "room_id" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "user_id" TEXT NOT NULL,
    "author_kind" TEXT NOT NULL,
    "author_node_id" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'text',
    "body" TEXT NOT NULL DEFAULT '',
    "data" JSONB NOT NULL DEFAULT '{}',
    "visible_to" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "mentions" JSONB NOT NULL DEFAULT '[]',
    "root_message_id" TEXT,
    "bot_depth" INTEGER NOT NULL DEFAULT 0,
    "client_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "node_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "node_runs" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "node_id" TEXT NOT NULL,
    "room_id" TEXT NOT NULL,
    "message_id" TEXT,
    "job_id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "reported_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "node_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "node_turns" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "node_id" TEXT NOT NULL,
    "room_id" TEXT,
    "reason" TEXT NOT NULL,
    "private" BOOLEAN NOT NULL DEFAULT false,
    "trigger_message_id" TEXT,
    "note" TEXT,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "model" TEXT,
    "credits" DOUBLE PRECISION,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "node_turns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "node_memories" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "node_id" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "node_memories_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "node_agents_user_id_slug_key" ON "node_agents"("user_id", "slug");

-- CreateIndex
CREATE INDEX "node_rooms_user_id_idx" ON "node_rooms"("user_id");

-- CreateIndex
CREATE INDEX "node_room_members_user_id_idx" ON "node_room_members"("user_id");

-- CreateIndex
CREATE INDEX "node_room_members_node_id_idx" ON "node_room_members"("node_id");

-- CreateIndex
CREATE UNIQUE INDEX "node_room_members_room_id_handle_key" ON "node_room_members"("room_id", "handle");

-- CreateIndex
CREATE INDEX "node_messages_root_message_id_idx" ON "node_messages"("root_message_id");

-- CreateIndex
CREATE UNIQUE INDEX "node_messages_room_id_seq_key" ON "node_messages"("room_id", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "node_messages_room_id_client_id_key" ON "node_messages"("room_id", "client_id");

-- CreateIndex
CREATE UNIQUE INDEX "node_runs_job_id_key" ON "node_runs"("job_id");

-- CreateIndex
CREATE INDEX "node_runs_status_idx" ON "node_runs"("status");

-- CreateIndex
CREATE INDEX "node_runs_user_id_created_at_idx" ON "node_runs"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "node_turns_status_created_at_idx" ON "node_turns"("status", "created_at");

-- CreateIndex
CREATE INDEX "node_turns_node_id_created_at_idx" ON "node_turns"("node_id", "created_at");

-- CreateIndex
CREATE INDEX "node_memories_node_id_created_at_idx" ON "node_memories"("node_id", "created_at");

-- AddForeignKey
ALTER TABLE "node_room_members" ADD CONSTRAINT "node_room_members_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "node_rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "node_room_members" ADD CONSTRAINT "node_room_members_node_id_fkey" FOREIGN KEY ("node_id") REFERENCES "node_agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "node_messages" ADD CONSTRAINT "node_messages_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "node_rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "node_runs" ADD CONSTRAINT "node_runs_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "node_rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "node_turns" ADD CONSTRAINT "node_turns_node_id_fkey" FOREIGN KEY ("node_id") REFERENCES "node_agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "node_memories" ADD CONSTRAINT "node_memories_node_id_fkey" FOREIGN KEY ("node_id") REFERENCES "node_agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

