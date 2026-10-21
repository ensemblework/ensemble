#!/usr/bin/env node
// Builds the operator's Grafana dashboards (docs/07 §1.3) as JSON into the folder given as the first
// argument (setup.sh and update.sh pass ~/ensemble-host/observability/dashboards). Grafana reloads
// them within a minute. Edit the panels here, not in Grafana: provisioned dashboards are read-only.
//
//   node build-dashboards.mjs <out-dir>
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const out = process.argv[2];
if (!out) {
  console.error("Usage: build-dashboards.mjs <out-dir>");
  process.exit(2);
}

const DB = { type: "grafana-postgresql-datasource", uid: "ensemble-db" };
const PROM = { type: "prometheus", uid: "prometheus" };

// People to count: test accounts are left out unless "Test accounts" is Yes. $user narrows to people.
const people = (prefix = "") => `${prefix}account_id IN (SELECT account_id FROM analytics.users WHERE (\${include_test} OR NOT is_test))`;
const chosen = (prefix = "") => `${people(prefix)} AND ${prefix}account_id IN ($user)`;
const PEOPLE = people();
const CHOSEN = chosen();
const DAYS = "generate_series(date_trunc('day', $__timeFrom()::timestamptz), $__timeTo()::timestamptz, interval '1 day')";

let nextId = 1;
function panel(type, title, grid, targets, extra = {}) {
  const [x, y, w, h] = grid;
  return { id: nextId++, type, title, gridPos: { x, y, w, h }, targets, ...extra };
}
const sql = (rawSql, format = "table", refId = "A") => ({ refId, datasource: DB, rawSql, format, rawQuery: true, editorMode: "code" });
const prom = (expr, legendFormat = "", refId = "A", extra = {}) => ({ refId, datasource: PROM, expr, legendFormat, ...extra });
const units = (unit, extra = {}) => ({ fieldConfig: { defaults: { unit, ...extra }, overrides: [] } });
const stat = (title, grid, target, unit = "short", extra = {}) =>
  panel("stat", title, grid, [target], { datasource: target.datasource, ...units(unit, extra.defaults ?? {}), options: { reduceOptions: { calcs: ["lastNotNull"] }, colorMode: "value", graphMode: "none", textMode: "value", ...extra.options }, description: extra.description });
const series = (title, grid, targets, unit = "short", extra = {}) =>
  panel("timeseries", title, grid, targets, { datasource: targets[0].datasource, ...units(unit, { custom: { drawStyle: extra.bars ? "bars" : "line", fillOpacity: extra.bars ? 80 : 15, stacking: { mode: extra.stack ? "normal" : "none" }, lineWidth: 2, showPoints: "never" } }), options: { legend: { displayMode: "list", placement: "bottom" }, tooltip: { mode: "multi" } }, description: extra.description });
const table = (title, grid, target, extra = {}) =>
  panel("table", title, grid, [target], { datasource: target.datasource, options: { showHeader: true, cellHeight: "sm", footer: { show: false } }, fieldConfig: { defaults: { custom: { filterable: true } }, overrides: extra.overrides ?? [] }, description: extra.description });
const bars = (title, grid, target, unit = "short", extra = {}) =>
  panel("barchart", title, grid, [target], { datasource: target.datasource, ...units(unit), options: { orientation: extra.horizontal ? "horizontal" : "auto", showValue: "auto", legend: { showLegend: false }, xTickLabelRotation: extra.horizontal ? 0 : -30 }, description: extra.description });
const pie = (title, grid, target) =>
  panel("piechart", title, grid, [target], { datasource: target.datasource, options: { reduceOptions: { values: true, calcs: ["lastNotNull"] }, pieType: "donut", legend: { displayMode: "table", placement: "right", values: ["value", "percent"] } } });
const text = (title, grid, content) => panel("text", title, grid, [], { options: { mode: "markdown", content } });

const includeTest = { type: "custom", name: "include_test", label: "Test accounts", query: "No : false, Yes : true", current: { text: "No", value: "false" }, options: [], hide: 0 };
const userVar = {
  type: "query",
  name: "user",
  label: "Person",
  datasource: DB,
  query: "SELECT email AS __text, account_id AS __value FROM analytics.users WHERE (${include_test} OR NOT is_test) ORDER BY email",
  includeAll: true,
  multi: true,
  current: { text: ["All"], value: ["$__all"] },
  refresh: 2,
  hide: 0,
};

function dashboard(uid, title, panels, { vars = [], from = "now-30d", description = "" } = {}) {
  return {
    uid,
    title,
    description,
    tags: ["ensemble"],
    timezone: "browser",
    editable: false,
    graphTooltip: 1,
    refresh: "5m",
    time: { from, to: "now" },
    schemaVersion: 41,
    links: [{ type: "dashboards", tags: ["ensemble"], asDropdown: false, includeVars: true, keepTime: true, title: "Ensemble" }],
    templating: { list: vars },
    panels,
  };
}

const dashboards = [];

// ── Overview ────────────────────────────────────────────────────────────────
nextId = 1;
dashboards.push(dashboard("ensemble-overview", "Ensemble · Overview", [
  stat("Registered people", [0, 0, 4, 4], sql(`SELECT count(*) FROM analytics.users WHERE ${PEOPLE}`)),
  stat("New in this period", [4, 0, 4, 4], sql(`SELECT count(*) FROM analytics.users WHERE ${PEOPLE} AND $__timeFilter(registered_at)`)),
  stat("Active today", [8, 0, 4, 4], sql(`SELECT count(DISTINCT account_id) FROM analytics.engagement WHERE ${PEOPLE} AND at >= date_trunc('day', now())`), "short", { description: "Active: any action, opening the Hub, or a screen used for at least 10 seconds." }),
  stat("Active, last 7 days", [12, 0, 4, 4], sql(`SELECT count(DISTINCT account_id) FROM analytics.engagement WHERE ${PEOPLE} AND at >= now() - interval '7 days'`)),
  stat("Active, last 30 days", [16, 0, 4, 4], sql(`SELECT count(DISTINCT account_id) FROM analytics.engagement WHERE ${PEOPLE} AND at >= now() - interval '30 days'`)),
  stat("Live tabs now", [20, 0, 4, 4], prom("ensemble_live_streams"), "short", { description: "Open live event streams: browser tabs and paired computers." }),
  stat("LLM calls in this period", [0, 4, 4, 4], sql(`SELECT count(*) FROM analytics.llm_calls WHERE ${PEOPLE} AND $__timeFilter(at)`)),
  stat("Included-model cost this month", [4, 4, 4, 4], sql(`SELECT coalesce(sum(usd), 0) FROM analytics.included_usage WHERE period = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM')`), "currencyUSD", { defaults: { decimals: 2 }, description: "What included-model calls cost, as the app settled them (USD)." }),
  stat("Azure bill, month to date", [8, 4, 4, 4], prom('sum by (currency) (ensemble_azure_cost{period="month_to_date"})', "{{currency}}"), "currencyINR", { defaults: { decimals: 2 }, description: "All enabled subscriptions, from Azure Cost Management (refreshed every 6 hours, Azure itself lags up to a day)." }),
  stat("Azure estimate for the month", [12, 4, 4, 4], prom("sum by (currency) (ensemble_azure_cost_month_estimate)", "{{currency}}"), "currencyINR", { defaults: { decimals: 2 }, description: "Month to date, projected linearly to the end of the month." }),
  stat("Blob storage", [16, 4, 4, 4], prom('sum(ensemble_blob_bytes{prefix="(total)"})'), "bytes"),
  stat("API requests in this period", [20, 4, 4, 4], prom("sum(increase(ensemble_http_requests_total[$__range]))", "", "A", { instant: true })),
  series("Registered and active people", [0, 8, 16, 9], [
    sql(`SELECT d AS time, (SELECT count(*) FROM analytics.users WHERE ${PEOPLE} AND registered_at < d + interval '1 day') AS "registered", (SELECT count(DISTINCT account_id) FROM analytics.engagement WHERE ${PEOPLE} AND at >= d - interval '6 days' AND at < d + interval '1 day') AS "active, last 7 days", (SELECT count(DISTINCT account_id) FROM analytics.engagement WHERE ${PEOPLE} AND at >= d AND at < d + interval '1 day') AS "active that day" FROM ${DAYS} d ORDER BY 1`, "time_series"),
  ]),
  series("Server", [16, 8, 8, 9], [
    prom('100 * (1 - avg(rate(node_cpu_seconds_total{mode="idle"}[5m])))', "CPU %", "A"),
    prom("100 * (1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)", "RAM %", "B"),
    prom('100 * (1 - node_filesystem_avail_bytes{mountpoint="/"} / node_filesystem_size_bytes{mountpoint="/"})', "Disk %", "C"),
  ], "percent"),
  series("Time in the Hub per day, by area", [0, 17, 16, 9], [
    sql(`SELECT $__timeGroupAlias(at, '1d'), surface AS metric, sum(duration_ms) / 3600000.0 AS value FROM analytics.activity WHERE ${PEOPLE} AND kind = 'view' AND $__timeFilter(at) GROUP BY 1, 2 ORDER BY 1`, "time_series"),
  ], "h", { bars: true, stack: true, description: "Active time only: the tab visible and some input in the last minute." }),
  table("Newest people", [16, 17, 8, 9], sql(`SELECT email, registered_at AS "registered", last_login_at AS "last sign-in" FROM analytics.users WHERE ${PEOPLE} ORDER BY registered_at DESC LIMIT 20`)),
], { vars: [includeTest], description: "The headline numbers. Every tab keeps the time range." }));

// ── Users ───────────────────────────────────────────────────────────────────
nextId = 1;
dashboards.push(dashboard("ensemble-users", "Ensemble · Users", [
  table("Everyone who registered", [0, 0, 24, 12], sql(`
SELECT u.email, u.name, u.registered_at AS "registered", u.verified_at IS NOT NULL AS "verified",
  coalesce(u.first_oauth_provider, 'email') AS "signed up with", u.last_login_at AS "last sign-in",
  (SELECT max(at) FROM analytics.engagement e WHERE e.account_id = u.account_id) AS "last active",
  (SELECT count(DISTINCT date_trunc('day', at)) FROM analytics.engagement e WHERE e.account_id = u.account_id) AS "active days",
  round(coalesce((SELECT sum(duration_ms) FROM analytics.interactions i WHERE i.account_id = u.account_id AND i.kind = 'view'), 0) / 3600000.0, 2) AS "hours in Hub",
  (SELECT count(*) FROM analytics.server_actions s WHERE s.account_id = u.account_id AND s.actor = 'me') AS "actions",
  (SELECT count(*) FROM analytics.llm_calls l WHERE l.account_id = u.account_id) AS "LLM calls",
  (SELECT count(*) FROM analytics.files f WHERE f.account_id = u.account_id AND f.deleted_at IS NULL) AS "files",
  u.onboarding_role AS "role", u.profession, u.organization, u.heard_from AS "heard from", u.spaces, u.is_test AS "test"
FROM analytics.users u WHERE (\${include_test} OR NOT u.is_test) ORDER BY u.registered_at DESC`), { description: "Every column can be filtered (the funnel in its header) and sorted." }),
  series("Sign-ups per day", [0, 12, 12, 8], [sql(`SELECT $__timeGroupAlias(registered_at, '1d'), count(*) AS "sign-ups" FROM analytics.users WHERE ${PEOPLE} AND $__timeFilter(registered_at) GROUP BY 1 ORDER BY 1`, "time_series")], "short", { bars: true }),
  series("Registered people over time", [12, 12, 12, 8], [sql(`SELECT d AS time, (SELECT count(*) FROM analytics.users WHERE ${PEOPLE} AND registered_at < d + interval '1 day') AS "registered", (SELECT count(*) FROM analytics.users WHERE ${PEOPLE} AND verified_at < d + interval '1 day') AS "verified" FROM ${DAYS} d ORDER BY 1`, "time_series")]),
  pie("Role at sign-up", [0, 20, 6, 8], sql(`SELECT coalesce(onboarding_role, 'not chosen') AS metric, count(*) AS value FROM analytics.users WHERE ${PEOPLE} GROUP BY 1`)),
  pie("Heard about Ensemble from", [6, 20, 6, 8], sql(`SELECT coalesce(nullif(heard_from, ''), 'not said') AS metric, count(*) AS value FROM analytics.users WHERE ${PEOPLE} GROUP BY 1`)),
  pie("Signed up with", [12, 20, 6, 8], sql(`SELECT coalesce(first_oauth_provider, 'email') AS metric, count(*) AS value FROM analytics.users WHERE ${PEOPLE} GROUP BY 1`)),
  pie("Sign-ins by client (this period)", [18, 20, 6, 8], sql(`SELECT client AS metric, count(*) AS value FROM analytics.logins WHERE ${PEOPLE} AND $__timeFilter(at) GROUP BY 1`)),
  bars("Paired computers by platform", [0, 28, 12, 7], sql(`SELECT coalesce(platform, 'unknown') AS platform, count(*) AS computers FROM analytics.devices WHERE ${PEOPLE} AND revoked_at IS NULL GROUP BY 1 ORDER BY 2 DESC`)),
  bars("Spaces per person", [12, 28, 12, 7], sql(`SELECT spaces::text AS "spaces", count(*) AS people FROM analytics.users WHERE ${PEOPLE} GROUP BY spaces ORDER BY spaces`)),
], { vars: [includeTest], from: "now-90d" }));

// ── Activity ────────────────────────────────────────────────────────────────
nextId = 1;
dashboards.push(dashboard("ensemble-activity", "Ensemble · Activity", [
  text("How activity is measured", [0, 0, 24, 3], "**Active** = any action, opening the Hub, or a screen used for at least 10 s. **Time** counts only while the tab is visible and there was input in the last minute (`lib/telemetry.ts`). *web* rows come from the browser, *server* rows from the audit ledger. Nothing here is content: routes keep their shape (`/pages/:id`)."),
  series("Daily, weekly and monthly active people", [0, 3, 16, 9], [
    sql(`SELECT d AS time, (SELECT count(DISTINCT account_id) FROM analytics.engagement WHERE ${CHOSEN} AND at >= d AND at < d + interval '1 day') AS "daily", (SELECT count(DISTINCT account_id) FROM analytics.engagement WHERE ${CHOSEN} AND at >= d - interval '6 days' AND at < d + interval '1 day') AS "weekly (7 days)", (SELECT count(DISTINCT account_id) FROM analytics.engagement WHERE ${CHOSEN} AND at >= d - interval '29 days' AND at < d + interval '1 day') AS "monthly (30 days)" FROM ${DAYS} d ORDER BY 1`, "time_series"),
  ]),
  bars("Hours in each area (this period)", [16, 3, 8, 9], sql(`SELECT surface AS area, round(sum(duration_ms) / 3600000.0, 2) AS hours FROM analytics.interactions WHERE ${CHOSEN} AND kind = 'view' AND $__timeFilter(at) GROUP BY 1 ORDER BY 2 DESC`), "h", { horizontal: true }),
  series("Time per day by area", [0, 12, 16, 9], [
    sql(`SELECT $__timeGroupAlias(at, '1d'), surface AS metric, sum(duration_ms) / 3600000.0 AS value FROM analytics.interactions WHERE ${CHOSEN} AND kind = 'view' AND $__timeFilter(at) GROUP BY 1, 2 ORDER BY 1`, "time_series"),
  ], "h", { bars: true, stack: true }),
  bars("When people use Ensemble (hour of day, IST)", [16, 12, 8, 9], sql(`SELECT lpad(extract(hour FROM at AT TIME ZONE 'Asia/Kolkata')::int::text, 2, '0') AS hour, count(*) AS events FROM analytics.engagement WHERE ${CHOSEN} AND $__timeFilter(at) GROUP BY 1 ORDER BY 1`)),
  series("Visits per day and their length", [0, 21, 16, 8], [
    sql(`SELECT $__timeGroupAlias(first, '1d'), count(*) AS "visits", avg(extract(epoch FROM last - first) / 60) AS "average minutes" FROM (SELECT session_key, min(at) AS first, max(at + coalesce(duration_ms, 0) * interval '1 millisecond') AS last FROM analytics.interactions WHERE ${CHOSEN} AND $__timeFilter(at) GROUP BY session_key) v GROUP BY 1 ORDER BY 1`, "time_series"),
  ], "short", { description: "A visit is one browser tab's events." }),
  pie("Device and screen (this period)", [16, 21, 8, 8], sql(`SELECT CASE WHEN split_part(viewport, 'x', 1)::int < 768 THEN 'phone' WHEN split_part(viewport, 'x', 1)::int < 1200 THEN 'tablet / small' ELSE 'desktop' END || ' · ' || client AS metric, count(DISTINCT session_key) AS value FROM analytics.interactions WHERE ${CHOSEN} AND viewport IS NOT NULL AND $__timeFilter(at) GROUP BY 1`)),
  table("Most used actions (this period)", [0, 29, 12, 10], sql(`SELECT action, source, count(*) AS times, count(DISTINCT account_id) AS people FROM analytics.activity WHERE ${CHOSEN} AND kind <> 'view' AND $__timeFilter(at) GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 100`)),
  table("Screens (this period)", [12, 29, 12, 10], sql(`SELECT route, surface AS area, count(*) AS views, count(DISTINCT account_id) AS people, round(sum(duration_ms) / 60000.0, 1) AS "minutes", round(avg(duration_ms) / 1000.0, 1) AS "average seconds" FROM analytics.interactions WHERE ${CHOSEN} AND kind = 'view' AND $__timeFilter(at) GROUP BY 1, 2 ORDER BY 5 DESC`)),
  table("Weekly retention: share of each sign-up week still active N weeks later", [0, 39, 24, 9], sql(`
WITH cohort AS (SELECT account_id, date_trunc('week', registered_at) AS week FROM analytics.users WHERE ${PEOPLE} AND $__timeFilter(registered_at)),
active AS (SELECT DISTINCT account_id, date_trunc('week', at) AS week FROM analytics.engagement)
SELECT to_char(c.week, 'YYYY-MM-DD') AS "sign-up week", count(DISTINCT c.account_id) AS people,
  ${[0, 1, 2, 3, 4, 6, 8, 12].map((n) => `round(100.0 * count(DISTINCT a.account_id) FILTER (WHERE a.week = c.week + interval '${n} weeks') / nullif(count(DISTINCT c.account_id), 0)) AS "week ${n} %"`).join(",\n  ")}
FROM cohort c LEFT JOIN active a ON a.account_id = c.account_id GROUP BY c.week ORDER BY c.week DESC`)),
  series("Things people made per day", [0, 48, 12, 8], [sql(`SELECT $__timeGroupAlias(at, '1d'), kind AS metric, count(*) AS value FROM analytics.created_items WHERE ${CHOSEN} AND $__timeFilter(at) GROUP BY 1, 2 ORDER BY 1`, "time_series")], "short", { bars: true, stack: true }),
  table("Each person (this period)", [12, 48, 12, 8], sql(`SELECT u.email, count(DISTINCT date_trunc('day', e.at)) AS "active days", max(e.at) AS "last active", round(coalesce((SELECT sum(duration_ms) FROM analytics.interactions i WHERE i.account_id = u.account_id AND i.kind = 'view' AND $__timeFilter(i.at)), 0) / 3600000.0, 2) AS hours, (SELECT surface FROM analytics.interactions i WHERE i.account_id = u.account_id AND i.kind = 'view' AND $__timeFilter(i.at) GROUP BY surface ORDER BY sum(duration_ms) DESC LIMIT 1) AS "most time in" FROM analytics.users u JOIN analytics.engagement e ON e.account_id = u.account_id AND $__timeFilter(e.at) WHERE ${chosen("u.")} GROUP BY u.account_id, u.email ORDER BY 3 DESC`)),
  table("Event log (newest 500)", [0, 56, 24, 12], sql(`SELECT a.at, u.email, a.source, a.kind, a.surface AS area, a.action, round(a.duration_ms / 1000.0, 1) AS seconds, a.client FROM analytics.activity a JOIN analytics.users u ON u.account_id = a.account_id WHERE ${chosen("a.")} AND $__timeFilter(a.at) ORDER BY a.at DESC LIMIT 500`), { description: "Every event in the period for the chosen people. Use the Person filter for one person's path." }),
], { vars: [includeTest, userVar] }));

// ── LLMs ────────────────────────────────────────────────────────────────────
nextId = 1;
dashboards.push(dashboard("ensemble-llms", "Ensemble · LLMs", [
  stat("Calls in this period", [0, 0, 4, 4], sql(`SELECT count(*) FROM analytics.llm_calls WHERE ${CHOSEN} AND $__timeFilter(at)`)),
  stat("Tokens in", [4, 0, 4, 4], sql(`SELECT coalesce(sum(tokens_in), 0) FROM analytics.llm_calls WHERE ${CHOSEN} AND $__timeFilter(at)`)),
  stat("Tokens out", [8, 0, 4, 4], sql(`SELECT coalesce(sum(tokens_out), 0) FROM analytics.llm_calls WHERE ${CHOSEN} AND $__timeFilter(at)`)),
  stat("Included models, cost in this period", [12, 0, 4, 4], sql(`SELECT coalesce(sum(usd), 0) FROM analytics.included_usage WHERE ${CHOSEN} AND $__timeFilter(at)`), "currencyUSD", { defaults: { decimals: 2 } }),
  stat("Azure AI (Foundry) bill, month to date", [16, 0, 4, 4], prom('sum by (currency) (ensemble_azure_cost{period="month_to_date", service=~".*(Foundry|Cognitive|OpenAI).*"})', "{{currency}}"), "currencyINR", { defaults: { decimals: 2 } }),
  stat("Assistant turns in this period", [20, 0, 4, 4], sql(`SELECT count(*) FROM analytics.assistant_turns WHERE ${CHOSEN} AND $__timeFilter(at)`)),
  series("Calls per day by model", [0, 4, 12, 9], [sql(`SELECT $__timeGroupAlias(at, '1d'), model AS metric, count(*) AS value FROM analytics.llm_calls WHERE ${CHOSEN} AND $__timeFilter(at) GROUP BY 1, 2 ORDER BY 1`, "time_series")], "short", { bars: true, stack: true }),
  series("Calls per day by purpose", [12, 4, 12, 9], [sql(`SELECT $__timeGroupAlias(at, '1d'), coalesce(purpose, 'other') AS metric, count(*) AS value FROM analytics.llm_calls WHERE ${CHOSEN} AND $__timeFilter(at) GROUP BY 1, 2 ORDER BY 1`, "time_series")], "short", { bars: true, stack: true }),
  series("Tokens per day", [0, 13, 12, 8], [sql(`SELECT $__timeGroupAlias(at, '1d'), sum(tokens_in) AS "in", sum(tokens_out) AS "out" FROM analytics.llm_calls WHERE ${CHOSEN} AND $__timeFilter(at) GROUP BY 1 ORDER BY 1`, "time_series")]),
  series("Included-model cost per day (USD)", [12, 13, 12, 8], [sql(`SELECT $__timeGroupAlias(at, '1d'), model AS metric, sum(usd) AS value FROM analytics.included_usage WHERE ${CHOSEN} AND $__timeFilter(at) GROUP BY 1, 2 ORDER BY 1`, "time_series")], "currencyUSD", { bars: true, stack: true }),
  pie("Whose key paid (this period)", [0, 21, 8, 8], sql(`SELECT CASE WHEN provider = 'ensemble' THEN 'included (you pay)' ELSE provider || ' (their key)' END AS metric, count(*) AS value FROM analytics.llm_calls WHERE ${CHOSEN} AND $__timeFilter(at) GROUP BY 1`)),
  table("By person (this period)", [8, 21, 16, 8], sql(`SELECT u.email, count(*) AS calls, sum(l.tokens_in) AS "tokens in", sum(l.tokens_out) AS "tokens out", round(coalesce(sum(l.credits), 0)::numeric, 2) AS credits, (SELECT round(coalesce(sum(usd), 0)::numeric, 4) FROM analytics.included_usage i WHERE i.account_id = u.account_id AND $__timeFilter(i.at)) AS "included USD", string_agg(DISTINCT l.model, ', ') AS models FROM analytics.llm_calls l JOIN analytics.users u ON u.account_id = l.account_id WHERE ${chosen("l.")} AND $__timeFilter(l.at) GROUP BY u.email, u.account_id ORDER BY 2 DESC`)),
  series("Agent runs per day by status", [0, 29, 12, 8], [sql(`SELECT $__timeGroupAlias(created_at, '1d'), status AS metric, count(*) AS value FROM analytics.jobs WHERE ${CHOSEN} AND $__timeFilter(created_at) GROUP BY 1, 2 ORDER BY 1`, "time_series")], "short", { bars: true, stack: true }),
  series("Assistant: tool calls and writes per day", [12, 29, 12, 8], [sql(`SELECT $__timeGroupAlias(at, '1d'), count(*) AS turns, sum(tool_calls) AS "tool calls", sum(writes) AS writes FROM analytics.assistant_turns WHERE ${CHOSEN} AND $__timeFilter(at) GROUP BY 1 ORDER BY 1`, "time_series")]),
], { vars: [includeTest, userVar] }));

// ── Cost & storage ──────────────────────────────────────────────────────────
nextId = 1;
dashboards.push(dashboard("ensemble-cost", "Ensemble · Cost & storage", [
  stat("Azure, month to date", [0, 0, 6, 4], prom('sum by (currency) (ensemble_azure_cost{period="month_to_date"})', "{{currency}}"), "currencyINR", { defaults: { decimals: 2 } }),
  stat("Azure, estimate for the month", [6, 0, 6, 4], prom("sum by (currency) (ensemble_azure_cost_month_estimate)", "{{currency}}"), "currencyINR", { defaults: { decimals: 2 } }),
  stat("Azure, last month", [12, 0, 6, 4], prom('sum by (currency) (ensemble_azure_cost{period="previous_month"})', "{{currency}}"), "currencyINR", { defaults: { decimals: 2 } }),
  stat("Cost data refreshed", [18, 0, 6, 4], prom("ensemble_azure_metrics_last_run_timestamp_seconds * 1000"), "dateTimeFromNow", { description: "azure-metrics.py runs every 6 hours (ensemble-azure-metrics.timer)." }),
  table("Azure cost by subscription and service", [0, 4, 12, 9], prom('sum by (subscription, service, period, currency) (ensemble_azure_cost)', "", "A", { instant: true, format: "table" })),
  series("Azure month-to-date cost over time", [12, 4, 12, 9], [prom("sum by (subscription, currency) (ensemble_azure_cost{period=\"month_to_date\"})", "{{subscription}} ({{currency}})")], "currencyINR"),
  stat("Blob storage (all)", [0, 13, 6, 4], prom('sum(ensemble_blob_bytes{prefix="(total)"})'), "bytes"),
  stat("Blob objects (all)", [6, 13, 6, 4], prom('sum(ensemble_blob_objects{prefix="(total)"})')),
  stat("Database size", [12, 13, 6, 4], prom('pg_database_size_bytes{datname="ensemble"}'), "bytes"),
  stat("This machine's disk free", [18, 13, 6, 4], prom('node_filesystem_avail_bytes{mountpoint="/"}'), "bytes"),
  table("Blob storage by container and kind", [0, 17, 12, 8], prom('sum by (container, prefix) (ensemble_blob_bytes)', "", "A", { instant: true, format: "table" }), { overrides: [{ matcher: { id: "byName", options: "Value" }, properties: [{ id: "unit", value: "bytes" }, { id: "displayName", value: "size" }] }] }),
  series("Blob and database size over time", [12, 17, 12, 8], [prom('sum by (container) (ensemble_blob_bytes{prefix="(total)"})', "blob {{container}}", "A"), prom('pg_database_size_bytes{datname="ensemble"}', "database", "B")], "bytes"),
  bars("Files kept, by format (bytes)", [0, 25, 12, 8], sql(`SELECT coalesce(format, '?') AS format, sum(byte_size) AS bytes FROM analytics.files WHERE ${PEOPLE} AND deleted_at IS NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 20`), "bytes"),
  series("Files and plot data added per day", [12, 25, 12, 8], [sql(`SELECT $__timeGroupAlias(created_at, '1d'), 'files' AS metric, count(*) AS value FROM analytics.files WHERE ${PEOPLE} AND $__timeFilter(created_at) GROUP BY 1 UNION ALL SELECT $__timeGroupAlias(created_at, '1d'), 'plot datasets', count(*) FROM analytics.plot_datasets WHERE ${PEOPLE} AND $__timeFilter(created_at) GROUP BY 1 ORDER BY 1`, "time_series")], "short", { bars: true, stack: true }),
  table("Storage by person", [0, 33, 24, 8], sql(`SELECT u.email, (SELECT count(*) FROM analytics.files f WHERE f.account_id = u.account_id AND f.deleted_at IS NULL) AS files, (SELECT coalesce(sum(byte_size), 0) FROM analytics.files f WHERE f.account_id = u.account_id AND f.deleted_at IS NULL) AS "file bytes", (SELECT count(*) FROM analytics.plot_datasets p WHERE p.account_id = u.account_id AND p.deleted_at IS NULL) AS datasets, (SELECT coalesce(sum(byte_size), 0) FROM analytics.plot_datasets p WHERE p.account_id = u.account_id AND p.deleted_at IS NULL) AS "dataset bytes" FROM analytics.users u WHERE ${people("u.")} ORDER BY 3 DESC`), { overrides: [{ matcher: { id: "byRegexp", options: ".*bytes" }, properties: [{ id: "unit", value: "bytes" }] }] }),
], { vars: [includeTest] }));

// ── Traffic ─────────────────────────────────────────────────────────────────
nextId = 1;
dashboards.push(dashboard("ensemble-traffic", "Ensemble · Traffic", [
  text("About Vercel's free requests", [0, 0, 24, 3], "Vercel's Hobby plan includes about **1,000,000 edge requests a month per project**. Every Hub `/api` call goes through the Hub on Vercel (counted below as *via vercel*); page loads and static files are counted by Vercel too, so the true number is higher. *Hub visits* is the number of browser tabs that opened the Hub. The live event stream goes straight to the API and does not count."),
  stat("API calls through Vercel, last 30 days", [0, 3, 6, 4], prom('sum(increase(ensemble_http_requests_total{via="vercel"}[30d]))', "", "A", { instant: true }), "short", { defaults: { thresholds: { mode: "absolute", steps: [{ color: "green", value: null }, { color: "orange", value: 600000 }, { color: "red", value: 900000 }] } } }),
  stat("Share of 1M (API calls only)", [6, 3, 6, 4], prom('sum(increase(ensemble_http_requests_total{via="vercel"}[30d])) / 1000000', "", "A", { instant: true }), "percentunit", { defaults: { thresholds: { mode: "absolute", steps: [{ color: "green", value: null }, { color: "orange", value: 0.6 }, { color: "red", value: 0.9 }] } } }),
  stat("Hub visits, last 30 days", [12, 3, 6, 4], sql("SELECT count(*) FROM analytics.interactions WHERE kind = 'session' AND at >= now() - interval '30 days'")),
  stat("Server errors (5xx) in this period", [18, 3, 6, 4], prom('sum(increase(ensemble_http_requests_total{status="5xx"}[$__range]))', "", "A", { instant: true }), "short", { defaults: { thresholds: { mode: "absolute", steps: [{ color: "green", value: null }, { color: "red", value: 1 }] } } }),
  series("Requests per minute", [0, 7, 12, 9], [prom('sum by (via) (rate(ensemble_http_requests_total[5m])) * 60', "{{via}}")], "short"),
  series("Responses by status", [12, 7, 12, 9], [prom("sum by (status) (rate(ensemble_http_requests_total[5m])) * 60", "{{status}}")], "short"),
  table("Busiest routes (this period)", [0, 16, 12, 10], prom("sort_desc(sum by (route, method) (increase(ensemble_http_requests_total[$__range])))", "", "A", { instant: true, format: "table" })),
  table("Slowest routes, 95th percentile seconds (this period)", [12, 16, 12, 10], prom("sort_desc(histogram_quantile(0.95, sum by (le, route) (rate(ensemble_http_request_duration_seconds_bucket[$__range]))))", "", "A", { instant: true, format: "table" })),
  series("Latency (seconds)", [0, 26, 12, 8], [prom("histogram_quantile(0.5, sum by (le) (rate(ensemble_http_request_duration_seconds_bucket[5m])))", "median", "A"), prom("histogram_quantile(0.95, sum by (le) (rate(ensemble_http_request_duration_seconds_bucket[5m])))", "95th percentile", "B")], "s"),
  series("Live tabs and spaces", [12, 26, 12, 8], [prom("ensemble_live_streams", "streams", "A"), prom("ensemble_live_channels", "spaces", "B")]),
], { from: "now-7d" }));

// ── Server ──────────────────────────────────────────────────────────────────
nextId = 1;
dashboards.push(dashboard("ensemble-server", "Ensemble · Server", [
  stat("Up for", [0, 0, 4, 4], prom("time() - node_boot_time_seconds"), "s"),
  stat("CPU", [4, 0, 4, 4], prom('100 * (1 - avg(rate(node_cpu_seconds_total{mode="idle"}[5m])))'), "percent"),
  stat("RAM used", [8, 0, 4, 4], prom("100 * (1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)"), "percent"),
  stat("Disk used", [12, 0, 4, 4], prom('100 * (1 - node_filesystem_avail_bytes{mountpoint="/"} / node_filesystem_size_bytes{mountpoint="/"})'), "percent"),
  stat("Power (platform)", [16, 0, 4, 4], prom("sum(rate(node_rapl_psys_joules_total[5m])) or sum(rate(node_rapl_package_joules_total[5m]))"), "watt", { description: "Intel RAPL psys: the whole platform as the chip measures it (CPU, memory, chipset). Not a wall meter: the power supply, disk and fans add a few watts. Falls back to the CPU package where psys is missing." }),
  stat("Hottest sensor", [20, 0, 4, 4], prom("max(node_hwmon_temp_celsius)"), "celsius"),
  series("CPU by mode", [0, 4, 12, 8], [prom('100 * sum by (mode) (rate(node_cpu_seconds_total{mode!="idle"}[5m])) / count(count by (cpu) (node_cpu_seconds_total))', "{{mode}}")], "percent", { stack: true }),
  series("Memory", [12, 4, 12, 8], [prom("node_memory_MemTotal_bytes - node_memory_MemAvailable_bytes", "used", "A"), prom("node_memory_Cached_bytes + node_memory_Buffers_bytes", "cache", "B"), prom("node_memory_SwapTotal_bytes - node_memory_SwapFree_bytes", "swap used", "C")], "bytes"),
  series("Power (watts)", [0, 12, 12, 8], [prom("rate(node_rapl_package_joules_total[5m])", "package {{index}}", "A"), prom("rate(node_rapl_core_joules_total[5m])", "cores {{index}}", "B"), prom("rate(node_rapl_dram_joules_total[5m])", "memory {{index}}", "C"), prom("rate(node_rapl_psys_joules_total[5m])", "platform {{index}}", "D")], "watt"),
  series("Temperatures", [12, 12, 12, 8], [prom("node_hwmon_temp_celsius", "{{chip}} {{sensor}}")], "celsius"),
  series("Disk I/O", [0, 20, 12, 8], [prom('sum(rate(node_disk_read_bytes_total{device!~"loop.*"}[5m]))', "read", "A"), prom('sum(rate(node_disk_written_bytes_total{device!~"loop.*"}[5m]))', "write", "B")], "Bps"),
  series("Network", [12, 20, 12, 8], [prom('sum(rate(node_network_receive_bytes_total{device!~"lo|docker.*|veth.*|br-.*"}[5m]))', "in", "A"), prom('sum(rate(node_network_transmit_bytes_total{device!~"lo|docker.*|veth.*|br-.*"}[5m]))', "out", "B")], "Bps"),
  series("Ensemble API process", [0, 28, 12, 8], [prom("ensemble_api_process_resident_memory_bytes", "memory", "A")], "bytes"),
  series("API event-loop delay (seconds)", [12, 28, 12, 8], [prom("ensemble_api_nodejs_eventloop_lag_p99_seconds", "99th percentile", "A")], "s"),
  series("Postgres connections", [0, 36, 12, 8], [prom('sum by (state) (pg_stat_activity_count{datname="ensemble"})', "{{state}}")]),
  table("Scrape targets", [12, 36, 12, 8], prom("up", "", "A", { instant: true, format: "table" })),
], { from: "now-24h" }));

mkdirSync(out, { recursive: true });
for (const board of dashboards) {
  const file = join(out, `${board.uid}.json`);
  writeFileSync(file, `${JSON.stringify(board, null, 2)}\n`);
}
console.log(`Wrote ${dashboards.length} dashboards to ${out}`);
