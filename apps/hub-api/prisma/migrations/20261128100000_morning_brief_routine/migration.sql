ALTER TABLE assistant_routines ADD COLUMN IF NOT EXISTS built_in_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS assistant_routines_user_id_built_in_key_key
  ON assistant_routines(user_id, built_in_key);

WITH defaults AS (
  SELECT u.id, u.created_at,
    left(regexp_replace(COALESCE(u.profession, ''), E'[\r\n]', ' ', 'g'), 120) AS role,
    COALESCE(z.name, 'Asia/Kolkata') AS zone,
    CASE WHEN p.value #>> '{morningBrief,time}' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
      THEN p.value #>> '{morningBrief,time}' ELSE '08:00' END AS time,
    CASE WHEN p.value #>> '{morningBrief,enabled}' = 'false' THEN 'paused' ELSE 'active' END AS status,
    s.body AS instruction, n.created_at AS last_run_at, n.body AS last_summary
  FROM users u
  LEFT JOIN preferences p ON p.user_id = u.id AND p.key = 'hub.settings' AND p.deleted_at IS NULL
  LEFT JOIN pg_timezone_names z ON z.name = p.value ->> 'timezone'
  LEFT JOIN skills s ON s.user_id = u.id AND s.slug = 'morning-brief'
  LEFT JOIN LATERAL (
    SELECT created_at, body FROM notifications
    WHERE user_id = u.id AND kind = 'morning_brief'
    ORDER BY created_at DESC LIMIT 1
  ) n ON true
  WHERE u.owner_id IS NULL AND NOT EXISTS (
    SELECT 1 FROM preferences marker
    WHERE marker.user_id = u.id AND marker.key = 'ui.morning-brief-routine'
  )
), bodies AS (
  SELECT *,
    COALESCE(instruction,
      E'# Morning brief\n\nPrepare a short morning brief' ||
      CASE WHEN role <> '' THEN ' for someone working as ' || role ELSE '' END ||
      '. Focus on ' ||
      CASE
        WHEN role ~* 'teacher|educat' THEN 'classes, lesson preparation, grading and students'
        WHEN role ~* 'lawyer|legal' THEN 'matters, filing deadlines, client follow-ups and hearings'
        WHEN role ~* 'student' THEN 'coursework, exams, study time and upcoming classes'
        WHEN role ~* 'research|scient' THEN 'experiments, reading, collaborators and research deadlines'
        WHEN role ~* 'engineer|developer' THEN 'deliverables, reviews, blocked tasks and project deadlines'
        ELSE 'priorities, meetings, deadlines and follow-ups'
      END ||
      E'.\n\nStart with the most useful next action. Include today''s focus, items waiting on the person, meetings and upcoming deliverables. Use short sections and plain language. Use only the supplied context. Do not invent tasks or facts. Do not send anything to other people.\n'
    ) AS body,
    (CURRENT_TIMESTAMP AT TIME ZONE zone)::date + time::time AS local_run
  FROM defaults
)
INSERT INTO assistant_routines (
  id, user_id, built_in_key, title, instruction, cron, timezone, status,
  next_run_at, last_run_at, last_status, last_summary, run_count, created_at, updated_at
)
SELECT gen_random_uuid()::text, id, 'morning-brief', 'Morning brief', body,
  split_part(time, ':', 2)::int::text || ' ' || split_part(time, ':', 1)::int::text || ' * * *',
  zone, status,
  (local_run + CASE
    WHEN local_run AT TIME ZONE zone <= CURRENT_TIMESTAMP
      OR (created_at AT TIME ZONE zone)::date >= (CURRENT_TIMESTAMP AT TIME ZONE zone)::date
      OR (last_run_at AT TIME ZONE zone)::date = (CURRENT_TIMESTAMP AT TIME ZONE zone)::date
      THEN interval '1 day' ELSE interval '0 days' END) AT TIME ZONE zone,
  last_run_at, CASE WHEN last_run_at IS NOT NULL THEN 'ok' END, last_summary,
  CASE WHEN last_run_at IS NOT NULL THEN 1 ELSE 0 END, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM bodies
ON CONFLICT (user_id, built_in_key) DO NOTHING;

WITH seeded AS (
  UPDATE assistant_routines SET conversation_id = gen_random_uuid()::text
  WHERE built_in_key = 'morning-brief' AND conversation_id IS NULL
    AND last_run_at IS NOT NULL AND last_summary IS NOT NULL
  RETURNING conversation_id, user_id, last_run_at
)
INSERT INTO assistant_conversations (id, user_id, title, created_at, updated_at)
SELECT conversation_id, user_id, 'Routine: Morning brief', last_run_at, last_run_at FROM seeded;

INSERT INTO assistant_messages (id, user_id, conversation_id, role, content, created_at)
SELECT gen_random_uuid()::text, r.user_id, r.conversation_id, 'assistant', r.last_summary, r.last_run_at
FROM assistant_routines r
WHERE r.built_in_key = 'morning-brief' AND r.last_run_at IS NOT NULL AND r.last_summary IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM assistant_messages m WHERE m.conversation_id = r.conversation_id);

INSERT INTO preferences (id, user_id, key, value, source, created_at, updated_at)
SELECT gen_random_uuid()::text, id, 'ui.morning-brief-routine', 'true'::jsonb, 'system', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM users WHERE owner_id IS NULL
ON CONFLICT (user_id, key) DO NOTHING;

UPDATE preferences SET value = value - 'morningBrief', updated_at = CURRENT_TIMESTAMP
WHERE key = 'hub.settings' AND value ? 'morningBrief';

UPDATE skills SET deleted_at = COALESCE(deleted_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP
WHERE slug = 'morning-brief' AND user_id IN (SELECT user_id FROM assistant_routines WHERE built_in_key = 'morning-brief');

UPDATE notifications SET url = '/routines?routine=morning-brief' WHERE url = '/morning-brief';
