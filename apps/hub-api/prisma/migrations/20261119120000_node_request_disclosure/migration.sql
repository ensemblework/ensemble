-- A peer request's public card shows only what the requester wrote and how the request stands (docs/35 §12.6).
ALTER TABLE "node_peer_requests" ADD COLUMN "answer_message_id" TEXT, ADD COLUMN "brief" TEXT;

-- Answers are linked, not copied.
UPDATE "node_peer_requests" r SET "answer_message_id" = m."data"->>'answerMessageId'
FROM "node_messages" m
WHERE m."id" = r."card_id" AND m."data"->>'answerMessageId' IS NOT NULL;

-- Nothing from the accepted work, and no copies of answers.
UPDATE "node_peer_requests" SET "answer" = NULL WHERE "status" IN ('answered', 'done');

-- Public cards made before: without the work's outcome and requirements, the answer or the decline note.
UPDATE "node_messages"
SET "data" = "data" - 'answer' - 'outcome' - 'requirements',
    "body" = regexp_replace("body", E'\n(Done|Declined)( \\(|: ).*$', E'\n\\1')
WHERE "kind" = 'request' AND "data"->>'type' = 'peer_request';
