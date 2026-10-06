/**
 * The workspace index repair must leave three databases with no Prisma drift:
 * a fresh migrate deploy, a database already at the previous migration, and a
 * database missing the workspace indexes and foreign keys. Rows that point at
 * a real parent stay. Orphans that would reject a foreign key are removed.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { config as loadEnv } from "dotenv";
import test from "node:test";
import { fileURLToPath } from "node:url";

for (const candidate of [path.resolve(process.cwd(), "../../.env"), path.resolve(process.cwd(), ".env")]) {
  if (existsSync(candidate)) loadEnv({ path: candidate, override: false });
}

const exec = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const hubApi = path.resolve(here, "../..");
const migrationsDir = path.join(hubApi, "prisma", "migrations");
const repairName = "20261001180000_workspace_fk_indexes";

function adminUrl(): string | null {
  const raw = process.env.DATABASE_URL;
  if (!raw) return null;
  const url = new URL(raw);
  url.pathname = "/postgres";
  return url.toString();
}

function dbUrl(name: string): string {
  const url = new URL(process.env.DATABASE_URL!);
  url.pathname = `/${name}`;
  return url.toString();
}

async function psql(url: string, sql: string) {
  const { stdout } = await exec("psql", [url, "-q", "-v", "ON_ERROR_STOP=1", "-tA", "-c", sql], { env: process.env });
  return stdout.trim();
}

async function psqlFile(url: string, file: string) {
  await exec("psql", [url, "-q", "-v", "ON_ERROR_STOP=1", "-f", file], { env: process.env });
}

async function canCreate(): Promise<boolean> {
  const admin = adminUrl();
  if (!admin) return false;
  try {
    await exec("psql", [admin, "-c", "SELECT 1"]);
    return true;
  } catch {
    return false;
  }
}

function prisma(url: string, args: string[]) {
  return exec("node", ["scripts/prisma-with-env.mjs", ...args], {
    cwd: hubApi,
    env: { ...process.env, DATABASE_URL: url },
    maxBuffer: 16 * 1024 * 1024,
  });
}

/**
 * 20261006010000_account_data_lifetime adds `<table>_account_lifetime_fkey`
 * cascades to legacy user_id columns in SQL only, so Prisma would drop them.
 * Those statements are the one difference allowed; anything else is drift.
 */
const ACCOUNT_LIFETIME_DROP = /^ALTER TABLE "[a-z0-9_]+" DROP CONSTRAINT "[a-z0-9_]+_account_lifetime_fkey";$/;

async function assertNoDrift(url: string) {
  const { stdout: diff } = await prisma(url, ["migrate", "diff", "--from-url", url, "--to-schema-datamodel", "prisma/schema.prisma", "--script"]);
  const unexpected = diff
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("--") && !ACCOUNT_LIFETIME_DROP.test(line));
  assert.deepEqual(unexpected, [], `Prisma drift:\n${diff}`);
  const { stdout } = await prisma(url, ["migrate", "status"]);
  assert.match(stdout, /Database schema is up to date/);
}

const previousFolders = () =>
  readdirSync(migrationsDir)
    .filter((name) => /^\d/.test(name) && name < repairName)
    .sort();

async function applyPrevious(url: string) {
  for (const folder of previousFolders()) {
    await psqlFile(url, path.join(migrationsDir, folder, "migration.sql"));
  }
  for (const folder of previousFolders()) {
    await prisma(url, ["migrate", "resolve", "--applied", folder]);
  }
}

const KEEP = {
  user: "keep-user",
  task: "keep-task",
  run: "keep-run",
  job: "keep-job",
  session: "keep-session",
  event: "keep-event",
};

async function insertKept(url: string) {
  await psql(
    url,
    `
    INSERT INTO users (id, email) VALUES ('${KEEP.user}', '${KEEP.user}@ensemble.test');
    INSERT INTO tasks (id, user_id, title, updated_at) VALUES ('${KEEP.task}', '${KEEP.user}', 'Keep me', CURRENT_TIMESTAMP);
    INSERT INTO runs (id, task_id, user_id, worker) VALUES ('${KEEP.run}', '${KEEP.task}', '${KEEP.user}', 'coder');
    INSERT INTO workspace_jobs (id, user_id, task_id, run_id, execution_mode, model)
      VALUES ('${KEEP.job}', '${KEEP.user}', '${KEEP.task}', '${KEEP.run}', 'local', 'gemini');
    INSERT INTO workspace_sessions (id, user_id, task_id) VALUES ('${KEEP.session}', '${KEEP.user}', '${KEEP.task}');
    INSERT INTO workspace_events (id, job_id, kind) VALUES ('${KEEP.event}', '${KEEP.job}', 'note');
    `,
  );
}

async function assertKept(url: string) {
  const ids = await psql(
    url,
    `SELECT id FROM users WHERE id = '${KEEP.user}'
     UNION ALL SELECT id FROM tasks WHERE id = '${KEEP.task}'
     UNION ALL SELECT id FROM runs WHERE id = '${KEEP.run}'
     UNION ALL SELECT id FROM workspace_jobs WHERE id = '${KEEP.job}' AND run_id = '${KEEP.run}'
     UNION ALL SELECT id FROM workspace_sessions WHERE id = '${KEEP.session}'
     UNION ALL SELECT id FROM workspace_events WHERE id = '${KEEP.event}'
     ORDER BY 1`,
  );
  assert.deepEqual(ids.split("\n"), [KEEP.event, KEEP.job, KEEP.run, KEEP.session, KEEP.task, KEEP.user]);
}

const dropDrift = `
ALTER TABLE workspace_events DROP CONSTRAINT IF EXISTS workspace_events_job_id_fkey;
DROP INDEX IF EXISTS workspace_events_job_id_sequence_idx;
DROP INDEX IF EXISTS workspace_jobs_run_id_key;
DROP INDEX IF EXISTS workspace_jobs_status_sequence_idx;
DROP INDEX IF EXISTS workspace_jobs_user_id_task_id_created_at_idx;
ALTER TABLE workspace_jobs DROP CONSTRAINT IF EXISTS workspace_jobs_run_id_fkey;
ALTER TABLE workspace_jobs DROP CONSTRAINT IF EXISTS workspace_jobs_task_id_fkey;
DROP INDEX IF EXISTS workspace_sessions_user_id_status_idx;
ALTER TABLE workspace_sessions DROP CONSTRAINT IF EXISTS workspace_sessions_task_id_fkey;
`;

test("workspace repair applies on a fresh database, the previous migration, and a drifted database", async (t) => {
  if (!(await canCreate())) return t.skip("Cannot create Postgres databases from DATABASE_URL");
  assert.ok(previousFolders().length > 0, "previous migrations must exist");
  assert.ok(existsSync(path.join(migrationsDir, repairName, "migration.sql")));

  const stamp = Date.now().toString(36);
  const names = {
    fresh: `ensemble_ws_fresh_${stamp}`,
    previous: `ensemble_ws_prev_${stamp}`,
    drifted: `ensemble_ws_drift_${stamp}`,
  };
  const admin = adminUrl()!;
  const drop = async (name: string) => {
    await exec("psql", [admin, "-c", `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`]).catch(() => undefined);
  };
  await Promise.all(Object.values(names).map((name) => drop(name)));

  try {
    for (const name of Object.values(names)) {
      await exec("psql", [admin, "-c", `CREATE DATABASE "${name}"`]);
    }
    const freshUrl = dbUrl(names.fresh);
    const previousUrl = dbUrl(names.previous);
    const driftedUrl = dbUrl(names.drifted);

    await prisma(freshUrl, ["migrate", "deploy"]);
    await insertKept(freshUrl);
    const again = await prisma(freshUrl, ["migrate", "deploy"]);
    assert.match(`${again.stdout}\n${again.stderr}`, /No pending migrations/);
    await assertKept(freshUrl);
    await assertNoDrift(freshUrl);

    await applyPrevious(previousUrl);
    await insertKept(previousUrl);
    const previousDeploy = await prisma(previousUrl, ["migrate", "deploy"]);
    assert.match(previousDeploy.stdout + previousDeploy.stderr, new RegExp(repairName));
    const previousLog = await psql(previousUrl, `SELECT logs FROM _prisma_migrations WHERE migration_name = '${repairName}'`);
    assert.match(previousLog, /workspace repair: kept index workspace_sessions_user_id_status_idx/);
    assert.match(previousLog, /workspace repair: cleared run_id on 0 workspace_jobs/);
    await assertKept(previousUrl);
    await assertNoDrift(previousUrl);

    await applyPrevious(driftedUrl);
    await insertKept(driftedUrl);
    await psql(driftedUrl, dropDrift);
    await psql(
      driftedUrl,
      `
      INSERT INTO workspace_jobs (id, user_id, task_id, run_id, execution_mode, model)
        VALUES ('dup-job', '${KEEP.user}', '${KEEP.task}', '${KEEP.run}', 'local', 'gemini');
      INSERT INTO workspace_jobs (id, user_id, task_id, run_id, execution_mode, model)
        VALUES ('bad-run-job', '${KEEP.user}', '${KEEP.task}', 'missing-run', 'local', 'gemini');
      INSERT INTO workspace_jobs (id, user_id, task_id, execution_mode, model)
        VALUES ('orphan-job', '${KEEP.user}', 'missing-task', 'local', 'gemini');
      INSERT INTO workspace_events (id, job_id, kind) VALUES ('orphan-event', 'missing-job', 'note');
      INSERT INTO workspace_events (id, job_id, kind) VALUES ('doomed-event', 'orphan-job', 'note');
      INSERT INTO workspace_sessions (id, user_id, task_id) VALUES ('orphan-session', '${KEEP.user}', 'missing-task');
      `,
    );
    await prisma(driftedUrl, ["migrate", "deploy"]);
    const driftedLog = await psql(driftedUrl, `SELECT logs FROM _prisma_migrations WHERE migration_name = '${repairName}'`);
    assert.match(driftedLog, /workspace repair: cleared run_id on 1 workspace_jobs whose run is missing/);
    assert.match(driftedLog, /workspace repair: cleared duplicate run_id on 1 later workspace_jobs/);
    assert.match(driftedLog, /workspace repair: removed 1 workspace_jobs with a missing task/);
    assert.match(driftedLog, /created index workspace_events_job_id_sequence_idx/);
    assert.match(driftedLog, /added foreign key workspace_jobs_run_id_fkey/);
    await assertKept(driftedUrl);
    const dupRun = await psql(driftedUrl, `SELECT run_id IS NULL FROM workspace_jobs WHERE id = 'dup-job'`);
    assert.equal(dupRun, "t");
    const badRun = await psql(driftedUrl, `SELECT count(*) FROM workspace_jobs WHERE id = 'bad-run-job' AND run_id IS NULL`);
    assert.equal(badRun, "1");
    const gone = await psql(
      driftedUrl,
      `SELECT count(*) FROM (
         SELECT id FROM workspace_jobs WHERE id = 'orphan-job'
         UNION ALL SELECT id FROM workspace_events WHERE id IN ('orphan-event', 'doomed-event')
         UNION ALL SELECT id FROM workspace_sessions WHERE id = 'orphan-session'
       ) AS orphans`,
    );
    assert.equal(gone, "0");
    await assertNoDrift(driftedUrl);
  } finally {
    await Promise.all(Object.values(names).map((name) => drop(name)));
  }
});
