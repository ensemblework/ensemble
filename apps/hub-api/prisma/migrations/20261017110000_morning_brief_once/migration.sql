-- Accounts that already received a brief must not get the old recurring introduction again.
INSERT INTO preferences (id, user_id, key, value, source, created_at, updated_at)
SELECT gen_random_uuid()::text, account.id, 'ui.morning-brief-prompt', '{"state":"previous-brief"}'::jsonb, 'system', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM users account
WHERE account.owner_id IS NULL AND EXISTS (
  SELECT 1 FROM notifications n JOIN users space ON space.id = n.user_id
  WHERE n.kind = 'morning_brief' AND COALESCE(space.owner_id, space.id) = account.id
)
ON CONFLICT (user_id, key) DO NOTHING;
