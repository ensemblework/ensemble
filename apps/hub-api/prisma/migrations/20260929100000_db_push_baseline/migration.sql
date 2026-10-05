-- Marker for a database that already has the pre-assistant schema from `prisma db push`.
-- `migrate deploy` refuses a non-empty database with P3005 until some migration is recorded.
-- Mark this one applied (it does not change tables), then deploy the later migrations:
--
--   pnpm exec prisma migrate resolve --applied 20260929100000_db_push_baseline
--   pnpm exec prisma migrate deploy
--
-- On an empty database this statement is a no-op and the later migrations still expect
-- the tables `db push` created (`tasks`, `page_discussions`, `private_reminders`, …).

SELECT 1;
