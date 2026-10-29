-- Rooms with other people and a shared Ensemble space (docs/35 §12.11, ensemble-node design C4).

-- A proposed task someone asked for in a room: who asked, the node that relayed it, its peer request.
ALTER TABLE "tasks" ADD COLUMN "requested_by_account_id" TEXT;
ALTER TABLE "tasks" ADD COLUMN "requested_by_node_id" TEXT;
ALTER TABLE "tasks" ADD COLUMN "peer_request_id" TEXT;
CREATE INDEX "tasks_peer_request_id_idx" ON "tasks"("peer_request_id");

-- "@node for person": the node that made or edited an item for a person in a space.
ALTER TABLE "tasks" ADD COLUMN "created_by_account_id" TEXT;
ALTER TABLE "tasks" ADD COLUMN "created_by_node_id" TEXT;
ALTER TABLE "task_pages" ADD COLUMN "editor_node_id" TEXT;
ALTER TABLE "page_discussions" ADD COLUMN "author_node_id" TEXT;

-- A work request's proposed task, and how accepted work runs (private | shared).
ALTER TABLE "node_peer_requests" ADD COLUMN "task_id" TEXT;
ALTER TABLE "node_peer_requests" ADD COLUMN "mode" TEXT;
