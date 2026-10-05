/**
 * A scripted agent draws this monorepo from hub_repo_overview alone.
 * The diagram text is built from the tool payload. Names that the overview
 * does not return are not drawn, and another user cannot open the checkout.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import "../config.js";
import { diagramTools } from "../assistant/tools/diagrams.js";
import { repoReadTools } from "../assistant/tools/repos.js";
import type { ToolContext } from "../assistant/types.js";
import { prisma } from "../lib/prisma.js";
import { saveSettings } from "../lib/settings.js";
import { estimateTokens } from "./mirror.js";
import { fileFor, overviewFor } from "./locate.js";
import { RepoReadError } from "./read.js";

const FULL_NAME = "ensemblework/ensemble";
// This checkout, wherever it lives (not always /workspace).
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url)).replace(/[\\/]$/, "");

async function databaseReady(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

async function user(label: string) {
  return prisma.user.create({
    data: { email: `repo-read-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@ensemble.test`, name: label },
  });
}

interface OverviewFacts {
  fullName: string;
  apps: string[];
  compose: Array<{ services: string[] }>;
  notable: string[];
}

/** Boxes and arrows come only from names the overview already returned. */
function diagramFromOverview(overview: OverviewFacts): string {
  const lines = [`title ${overview.fullName}`, "direction right", "curve elbow", ""];
  const ids = new Map<string, string>();
  const shapeFor = (app: string) => {
    if (app === "hub-web") return "rounded";
    if (app === "hub-api" || app === "agent-runtime") return "server";
    if (app === "context-bridge") return "cloud";
    return "rectangle";
  };
  for (const app of overview.apps) {
    const id = app.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "app";
    ids.set(app, id);
    lines.push(`node ${id} "${app}" shape ${shapeFor(app)}`);
  }
  const services = [...new Set(overview.compose.flatMap((item) => item.services))];
  const storeLabel: Record<string, string> = { postgres: "Postgres", redis: "Redis" };
  for (const service of services) {
    const id = service.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    ids.set(service, id);
    lines.push(`node ${id} "${storeLabel[service] ?? service}" shape cylinder`);
  }
  const capture = overview.notable.find((path) => /quick-capture/i.test(path));
  if (capture) {
    ids.set("quick-capture", "quick-capture");
    lines.push(`node quick-capture "quick-capture" shape rectangle`);
  }
  lines.push("");
  const edge = (from: string, to: string, label?: string) => {
    const start = ids.get(from);
    const end = ids.get(to);
    if (!start || !end) return;
    lines.push(label ? `edge ${start} > ${end} : "${label}"` : `edge ${start} > ${end}`);
  };
  edge("hub-web", "hub-api");
  edge("agent-runtime", "hub-api");
  edge("context-bridge", "hub-api", "read");
  if (capture) edge("hub-web", "quick-capture");
  edge("hub-api", "postgres");
  edge("hub-api", "redis");
  lines.push("");
  return lines.join("\n");
}

test("hub_repo_overview of this monorepo is enough to draw its architecture", async (t) => {
  if (!(await databaseReady())) return t.skip("Postgres is not reachable");
  const owner = await user("owner");
  const other = await user("other");
  const tool = (name: string) => [...repoReadTools, ...diagramTools].find((item) => item.name === name)!;
  const ctx = (userId: string): ToolContext => ({ prisma, userId, actor: "agent" }) as ToolContext;
  let repoId = "";
  try {
    await saveSettings(prisma, owner.id, { terminal: { roots: [REPO_ROOT, dirname(REPO_ROOT)] } });
    const repo = await prisma.repo.create({ data: { userId: owner.id, fullName: FULL_NAME, provider: "github" } });
    repoId = repo.id;

    const result = await tool("hub_repo_overview").run(ctx(owner.id), { repoId });
    const overview = result.data as OverviewFacts & { tree: string[]; files: number };
    assert.equal(overview.fullName, FULL_NAME);
    for (const app of ["hub-web", "hub-api", "agent-runtime", "context-bridge"]) {
      assert.ok(overview.apps.includes(app), `missing app ${app}`);
    }
    const services = overview.compose.flatMap((item) => item.services);
    assert.ok(services.includes("postgres"), "missing postgres");
    assert.ok(services.includes("redis"), "missing redis");
    assert.ok(overview.notable.some((path) => path.includes("quick-capture")), "missing quick-capture");
    const dumped = JSON.stringify(overview);
    const { execFile } = await import("node:child_process");
    const { readFile } = await import("node:fs/promises");
    const { promisify } = await import("node:util");
    const listing = await promisify(execFile)("git", ["ls-files"], { cwd: REPO_ROOT, maxBuffer: 8 * 1024 * 1024 });
    const interesting = listing.stdout
      .split("\n")
      .filter((path) => /(^|\/)(package\.json|readme\.md|schema\.prisma|docker-compose[^/]*\.ya?ml|routes?\.(ts|js))$/i.test(path))
      .slice(0, 40);
    let dump = listing.stdout;
    for (const path of interesting) {
      try {
        dump += await readFile(`${REPO_ROOT}/${path}`, "utf8");
      } catch {
        /* a listed file can be missing from the work tree */
      }
    }
    const compactTokens = estimateTokens(dumped);
    const pathTokens = estimateTokens(listing.stdout);
    const dumpTokens = estimateTokens(dump);
    let githubTokens = 0;
    try {
      const response = await fetch("https://api.github.com/repos/ensemblework/ensemble/git/trees/HEAD?recursive=1", {
        headers: { Accept: "application/vnd.github+json", "User-Agent": "Ensemble" },
        signal: AbortSignal.timeout(8_000),
      });
      if (response.ok) githubTokens = estimateTokens(await response.text());
    } catch {
      githubTokens = 0;
    }
    console.log(
      `TOKEN compact=${compactTokens} path-listing=${pathTokens} file-dump=${dumpTokens} github-tree=${githubTokens || "skipped"}`,
    );
    assert.ok(compactTokens < dumpTokens);
    assert.equal(dumped.includes("x-access-token"), false);
    assert.equal(dumped.toLowerCase().includes("postgres_password"), false);
    const paths = [
      ...overview.tree,
      ...overview.notable,
      ...(overview as { entryPoints?: string[] }).entryPoints ?? [],
      ...((overview as { manifests?: Array<{ path: string }> }).manifests ?? []).map((item) => item.path),
    ];
    for (const path of paths) {
      assert.equal(path.startsWith("/") || /^[a-zA-Z]:/.test(path), false, path);
    }

    const text = diagramFromOverview(overview);
    for (const label of ["hub-web", "hub-api", "agent-runtime", "context-bridge", "Postgres", "Redis", "quick-capture"]) {
      assert.match(text, new RegExp(label));
    }
    const validated = await tool("hub_validate_diagram").run(ctx(owner.id), { text });
    const report = validated.data as { ok: boolean; errors: number; warnings: number; diagnostics: Array<{ message: string }> };
    assert.equal(report.ok, true, report.diagnostics?.map((item) => item.message).join("\n"));
    assert.equal(report.errors, 0);
    assert.equal(report.warnings, 0);

    const created = await tool("hub_create_diagram").run(ctx(owner.id), {
      title: FULL_NAME,
      text,
      links: [{ kind: "repo", id: repoId }],
    });
    const diagramId = (created.data as { id: string }).id;
    const saved = await tool("hub_get_diagram").run(ctx(owner.id), { diagramId });
    const source = (saved.data as { source: string }).source;
    for (const label of ["hub-web", "hub-api", "agent-runtime", "context-bridge", "Postgres", "Redis", "quick-capture"]) {
      assert.match(source, new RegExp(label));
    }
    await assert.rejects(() => tool("hub_get_diagram").run(ctx(other.id), { diagramId }));

    const compose = await tool("hub_repo_read_file").run(ctx(owner.id), { repoId, path: "infra/docker-compose.yml" });
    const composeText = (compose.data as { text: string }).text;
    assert.match(composeText, /postgres/);
    assert.match(composeText, /redis/);
    assert.match(composeText, /POSTGRES_PASSWORD:\s*\[redacted\]/);
    assert.doesNotMatch(composeText, /POSTGRES_PASSWORD:\s*ensemble/);

    await assert.rejects(() => fileFor(prisma, owner.id, repoId, "../.env"), RepoReadError);
    await assert.rejects(() => fileFor(prisma, owner.id, repoId, "package.json/../../.env"), RepoReadError);
    await assert.rejects(() => fileFor(prisma, owner.id, repoId, ".env"), RepoReadError);
    await assert.rejects(
      () => overviewFor(prisma, other.id, repoId),
      (error: unknown) => error instanceof RepoReadError && error.statusCode === 404 && /not on your account/i.test(error.message),
    );

    const foreign = await prisma.repo.create({
      data: { userId: other.id, fullName: "example/missing", url: "file:///tmp/ensemble-missing-repo.git", provider: "github" },
    });
    await assert.rejects(
      () => tool("hub_repo_overview").run(ctx(other.id), { repoId: foreign.id }),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : "";
        return /could not fetch|not available|private or not visible/i.test(message) && !/not on your account/i.test(message) && !/x-access-token|ghp_/i.test(message);
      },
    );
  } finally {
    await prisma.diagramLink.deleteMany({ where: { userId: { in: [owner.id, other.id] } } });
    await prisma.blockDiagram.deleteMany({ where: { userId: { in: [owner.id, other.id] } } });
    await prisma.preference.deleteMany({ where: { userId: { in: [owner.id, other.id] } } });
    await prisma.repo.deleteMany({ where: { userId: { in: [owner.id, other.id] } } });
    await prisma.user.deleteMany({ where: { id: { in: [owner.id, other.id] } } });
  }
});
