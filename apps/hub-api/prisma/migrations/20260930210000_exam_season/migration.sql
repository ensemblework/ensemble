-- Accounts already on a removed desk move to Exam season. Their tasks stay.
UPDATE "users"
SET "active_template_id" = 'mkt.exam-season',
    "template_expires_at" = NULL
WHERE "active_template_id" IN ('mkt.exam-sprint', 'mkt.prelims-season');
