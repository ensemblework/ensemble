UPDATE preferences
SET value = jsonb_set(value, '{timezoneMode}', '"auto"'::jsonb, true), updated_at = NOW()
WHERE key = 'hub.settings' AND jsonb_typeof(value) = 'object' AND deleted_at IS NULL;
