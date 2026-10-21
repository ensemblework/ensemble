-- Read-only views for the operator's dashboards (infra/deploy/home/observability, docs/07 §1.3).
-- Grafana signs in as ensemble_grafana, which may read this schema and nothing else. The views run
-- with their owner's rights, so they decide what is visible: activity, usage, sizes and kinds. Never
-- content (titles, text, file names, prompts), password hashes or tokens.
--
-- update.sh drops the schema before migrations (a view would block a column change) and runs this
-- file again after them. Run with: psql -v reader_password=... -f analytics.sql
\set ON_ERROR_STOP on

DROP SCHEMA IF EXISTS analytics CASCADE;
CREATE SCHEMA analytics;

-- A space is a users row with owner_id; its activity belongs to the person who owns it.
CREATE VIEW analytics.accounts AS
SELECT u.id AS user_id, COALESCE(u.owner_id, u.id) AS account_id
FROM users u;

CREATE VIEW analytics.users AS
SELECT
  u.id AS account_id,
  u.email,
  u.name,
  u.created_at AT TIME ZONE 'UTC' AS registered_at,
  u.email_verified_at AT TIME ZONE 'UTC' AS verified_at,
  u.last_login_at AT TIME ZONE 'UTC' AS last_login_at,
  u.onboarding_role,
  u.profession,
  u.organization,
  u.heard_from,
  u.tester,
  (u.tester OR u.email ~* '@(ensemble\.com|ensemble\.test|example\.(com|org|test))$') AS is_test,
  (SELECT count(*) FROM users s WHERE s.owner_id = u.id) AS spaces,
  (SELECT a.payload->>'provider' FROM audit_ledger a WHERE a.user_id = u.id AND a.action = 'auth.oauth' ORDER BY a.ts LIMIT 1) AS first_oauth_provider
FROM users u
WHERE u.owner_id IS NULL;

-- Every action a person took: screens and actions in the Hub (web) and what the server recorded (server).
CREATE VIEW analytics.activity AS
SELECT
  e.at AT TIME ZONE 'UTC' AS at,
  e.user_id AS account_id,
  'web'::text AS source,
  e.kind,
  e.surface,
  COALESCE(e.action, e.kind || ':' || e.surface) AS action,
  e.duration_ms,
  e.client
FROM interaction_events e
UNION ALL
SELECT
  l.ts AT TIME ZONE 'UTC',
  a.account_id,
  'server',
  'action',
  split_part(l.action, '.', 1),
  l.action,
  NULL,
  NULL
FROM audit_ledger l
JOIN analytics.accounts a ON a.user_id = l.user_id
WHERE l.actor = 'me';

-- What counts as being active: any action, opening the Hub, or a screen used for at least 10 s.
CREATE VIEW analytics.engagement AS
SELECT at, account_id, source, surface
FROM analytics.activity
WHERE source = 'server' OR kind IN ('action', 'session') OR (kind = 'view' AND duration_ms >= 10000);

CREATE VIEW analytics.interactions AS
SELECT
  e.at AT TIME ZONE 'UTC' AS at,
  e.user_id AS account_id,
  e.session_key,
  e.kind,
  e.surface,
  e.route,
  e.action,
  e.duration_ms,
  e.props,
  e.client,
  e.viewport
FROM interaction_events e;

CREATE VIEW analytics.server_actions AS
SELECT l.ts AT TIME ZONE 'UTC' AS at, a.account_id, l.actor::text AS actor, l.action
FROM audit_ledger l
JOIN analytics.accounts a ON a.user_id = l.user_id;

-- Every model call the Hub made (its own keys or included models). The prompt's title is left out.
CREATE VIEW analytics.llm_calls AS
SELECT
  m.ts AT TIME ZONE 'UTC' AS at,
  a.account_id,
  m.payload->>'model' AS model,
  m.payload->>'provider' AS provider,
  m.payload->>'purpose' AS purpose,
  COALESCE((m.payload->>'tokensIn')::bigint, 0) AS tokens_in,
  COALESCE((m.payload->>'tokensOut')::bigint, 0) AS tokens_out,
  (m.payload->>'credits')::double precision AS credits,
  (m.payload->>'estimatedUsd')::double precision AS estimated_usd
FROM metric_events m
JOIN analytics.accounts a ON a.user_id = m.user_id
WHERE m.kind = 'model.call';

-- Included-model calls the operator pays for, with their settled cost in USD.
CREATE VIEW analytics.included_usage AS
SELECT
  i.created_at AT TIME ZONE 'UTC' AS at,
  i.account_id,
  i.period,
  i.model,
  i.purpose,
  i.status,
  i.input_tokens,
  i.output_tokens,
  i.usd::double precision AS usd
FROM included_usage i;

CREATE VIEW analytics.assistant_turns AS
SELECT
  m.ts AT TIME ZONE 'UTC' AS at,
  a.account_id,
  m.payload->>'model' AS model,
  COALESCE((m.payload->>'toolCalls')::int, 0) AS tool_calls,
  COALESCE((m.payload->>'writes')::int, 0) AS writes,
  COALESCE((m.payload->>'typedWords')::int, 0) AS typed_words
FROM metric_events m
JOIN analytics.accounts a ON a.user_id = m.user_id
WHERE m.kind = 'assistant.turn';

CREATE VIEW analytics.files AS
SELECT
  d.created_at AT TIME ZONE 'UTC' AS created_at,
  d.deleted_at AT TIME ZONE 'UTC' AS deleted_at,
  a.account_id,
  d.format,
  d.byte_size,
  d.page_count,
  d.parse_status,
  CASE WHEN d.blob_key IS NOT NULL THEN 'blob' ELSE 'database' END AS stored_in,
  d.source->>'app' AS source_app
FROM context_documents d
JOIN analytics.accounts a ON a.user_id = d.user_id;

CREATE VIEW analytics.plot_datasets AS
SELECT
  p.created_at AT TIME ZONE 'UTC' AS created_at,
  p.deleted_at AT TIME ZONE 'UTC' AS deleted_at,
  a.account_id,
  p.format,
  p.row_count,
  p.byte_size
FROM plot_datasets p
JOIN analytics.accounts a ON a.user_id = p.user_id;

CREATE VIEW analytics.jobs AS
SELECT
  j.created_at AT TIME ZONE 'UTC' AS created_at,
  j.started_at AT TIME ZONE 'UTC' AS started_at,
  j.finished_at AT TIME ZONE 'UTC' AS finished_at,
  a.account_id,
  j.kind,
  j.status::text AS status,
  j.provider,
  j.model,
  (j.device_id IS NOT NULL) AS on_computer,
  j.turns,
  j.tool_calls,
  j.tokens_in,
  j.tokens_out
FROM workspace_jobs j
JOIN analytics.accounts a ON a.user_id = j.user_id;

CREATE VIEW analytics.devices AS
SELECT
  d.created_at AT TIME ZONE 'UTC' AS paired_at,
  d.last_seen_at AT TIME ZONE 'UTC' AS last_seen_at,
  d.revoked_at AT TIME ZONE 'UTC' AS revoked_at,
  d.user_id AS account_id,
  d.platform,
  d.app_version
FROM devices d;

CREATE VIEW analytics.logins AS
SELECT
  s.created_at AT TIME ZONE 'UTC' AS at,
  s.user_id AS account_id,
  CASE
    WHEN s.user_agent ~* 'ensemble|tauri' THEN 'desktop app'
    WHEN s.user_agent ~* 'iphone|ipad|android|mobile' THEN 'mobile browser'
    WHEN s.user_agent = '' THEN 'unknown'
    ELSE 'desktop browser'
  END AS client
FROM sessions s;

-- How much each person has made, by kind (counts only).
CREATE VIEW analytics.created_items AS
SELECT t.created_at AT TIME ZONE 'UTC' AS at, a.account_id, 'task'::text AS kind FROM tasks t JOIN analytics.accounts a ON a.user_id = t.user_id
UNION ALL
SELECT p.created_at AT TIME ZONE 'UTC', a.account_id, 'page' FROM task_pages p JOIN analytics.accounts a ON a.user_id = p.user_id
UNION ALL
SELECT m.created_at AT TIME ZONE 'UTC', a.account_id, 'meeting' FROM meeting_sessions m JOIN analytics.accounts a ON a.user_id = m.user_id
UNION ALL
SELECT c.created_at AT TIME ZONE 'UTC', a.account_id, 'assistant chat' FROM assistant_conversations c JOIN analytics.accounts a ON a.user_id = c.user_id;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ensemble_grafana') THEN
    CREATE ROLE ensemble_grafana LOGIN;
  END IF;
END
$$;
ALTER ROLE ensemble_grafana WITH LOGIN PASSWORD :'reader_password' NOSUPERUSER NOCREATEDB NOCREATEROLE;
REVOKE ALL ON SCHEMA public FROM ensemble_grafana;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ensemble_grafana;
GRANT USAGE ON SCHEMA analytics TO ensemble_grafana;
GRANT SELECT ON ALL TABLES IN SCHEMA analytics TO ensemble_grafana;
