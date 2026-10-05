-- Metrics reads the last 14 days of steps, notes, and assistant replies.
CREATE INDEX "run_steps_started_at_idx" ON "run_steps"("started_at");
CREATE INDEX "meeting_notes_user_id_extracted_at_idx" ON "meeting_notes"("user_id", "extracted_at");
CREATE INDEX "assistant_messages_user_id_role_created_at_idx" ON "assistant_messages"("user_id", "role", "created_at");
