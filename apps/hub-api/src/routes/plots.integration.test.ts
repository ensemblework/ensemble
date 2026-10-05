/**
 * Plot routes against Postgres. Skips when the database is down.
 * A second user must not read the first user's plot or dataset.
 */
import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { ZodError } from "zod";
import "../config.js";
import { prisma } from "../lib/prisma.js";
import { plotRoutes } from "./plots.js";
import "../types.js";

const MODULES = "code,diagrams,metrics,plots,runs,skills,workspace";

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
    data: { email: `plot-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@ensemble.test`, name: label },
  });
}

async function appFor(userId: string, modules = MODULES) {
  const app = Fastify();
  app.decorate("prisma", prisma);
  app.addHook("onRequest", async (request) => {
    request.userId = userId;
    request.modules = modules;
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({ error: error.issues.map((issue) => issue.message).join("; ") });
    }
    const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
    const message = error instanceof Error ? error.message : String(error);
    return reply.code(statusCode).send({ error: message });
  });
  await app.register(plotRoutes);
  return app;
}

test("plots and datasets stay on the owner's account", async (t) => {
  if (!(await databaseReady())) return t.skip("Postgres is not reachable");
  const owner = await user("owner");
  const other = await user("other");
  const own = await appFor(owner.id);
  const theirs = await appFor(other.id);
  const closed = await appFor(owner.id, "code,diagrams,metrics,runs,skills,workspace");
  try {
    const denied = await closed.inject({ method: "GET", url: "/api/plots" });
    assert.equal(denied.statusCode, 404);

    const created = await own.inject({
      method: "POST",
      url: "/api/plots/datasets",
      payload: { name: "sales", filename: "sales.csv", text: "month,revenue,cost\nJan,12000,8000\nFeb,15000,9000\n" },
    });
    assert.equal(created.statusCode, 201, created.body);
    const dataset = created.json().dataset as { id: string; rowCount: number; columns: Array<{ name: string; type: string }> };
    assert.equal(dataset.rowCount, 2);
    assert.equal(dataset.columns.find((column) => column.name === "revenue")?.type, "number");

    const plot = await own.inject({
      method: "POST",
      url: "/api/plots",
      payload: {
        title: "Revenue",
        datasetId: dataset.id,
        config: { chart: "combo", x: "month", series: [{ y: "revenue", axis: "left", mark: "bar" }, { y: "cost", axis: "right", mark: "line" }] },
      },
    });
    assert.equal(plot.statusCode, 201, plot.body);
    const id = plot.json().plot.id as string;

    const listed = await own.inject({ method: "GET", url: "/api/plots" });
    assert.equal(listed.json().plots.some((row: { id: string }) => row.id === id), true);
    assert.equal((await theirs.inject({ method: "GET", url: `/api/plots/${id}` })).statusCode, 404);
    assert.equal((await theirs.inject({ method: "GET", url: `/api/plots/datasets/${dataset.id}` })).statusCode, 404);

    const code = await own.inject({ method: "POST", url: `/api/plots/${id}/matplotlib` });
    assert.equal(code.statusCode, 200);
    assert.match(code.json().code as string, /twinx/);
    assert.match(code.json().code as string, /load\("sales"\)/);

    const csv = await own.inject({ method: "POST", url: `/api/plots/${id}/export.csv` });
    assert.equal(csv.statusCode, 200);
    assert.match(csv.json().csv as string, /revenue/);

    const pickle = await own.inject({
      method: "POST",
      url: "/api/plots/datasets",
      payload: { filename: "frame.pkl", fileBase64: Buffer.from("not-a-pickle").toString("base64") },
    });
    assert.equal(pickle.statusCode, 400);
    assert.match(pickle.json().error as string, /Pickle/);

    const ssrf = await own.inject({
      method: "POST",
      url: "/api/plots/datasets",
      payload: { url: "http://127.0.0.1/secret.csv" },
    });
    assert.equal(ssrf.statusCode, 400);
    assert.match(ssrf.json().error as string, /https/i);

    const copy = await own.inject({ method: "POST", url: `/api/plots/${id}/duplicate` });
    assert.equal(copy.statusCode, 201);
    assert.match(copy.json().plot.title as string, /copy/);
  } finally {
    await prisma.plot.deleteMany({ where: { userId: { in: [owner.id, other.id] } } });
    await prisma.plotDataset.deleteMany({ where: { userId: { in: [owner.id, other.id] } } });
    await prisma.user.deleteMany({ where: { id: { in: [owner.id, other.id] } } });
    await own.close();
    await theirs.close();
    await closed.close();
  }
});
