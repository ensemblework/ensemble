-- "Just do it (undoable)" becomes the assistant's write mode for everyone. "Queue it on Needs me" is kept.
UPDATE preferences
SET value = jsonb_set(value, '{assistant,writePolicy}', '"immediate"'::jsonb, false), updated_at = NOW()
WHERE key = 'hub.settings'
  AND deleted_at IS NULL
  AND jsonb_typeof(value) = 'object'
  AND jsonb_typeof(value->'assistant') = 'object'
  AND value->'assistant'->>'writePolicy' = 'preview';
