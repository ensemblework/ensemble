import { z } from "zod";
import { defineTool, toolOk } from "../types.js";
import { fileFor, overviewFor } from "../../repo/locate.js";
import { RepoReadError } from "../../repo/read.js";

function fail(error: unknown): never {
  if (error instanceof RepoReadError) throw Object.assign(new Error(error.message), { statusCode: error.statusCode });
  throw error;
}

export const repoReadTools = [
  defineTool({
    name: "hub_repo_overview",
    area: "context",
    description:
      "Read-only facts about a repository: a capped file tree, manifests, entry points, route registrations, schema files, compose services, and README headings. Works for a local checkout or a link-only repo (the server clones a shallow cache, or uses GitHub if git cannot). Call this before drawing a diagram of a repo. Ignores build folders, gitignored paths, and secret files. Does not return absolute paths or secret values.",
    input: z.object({ repoId: z.string().uuid() }),
    isWrite: false,
    risk: "low",
    async run(ctx, input) {
      try {
        const overview = await overviewFor(ctx.prisma, ctx.userId, input.repoId);
        return toolOk(`Overview of ${overview.fullName}.`, overview);
      } catch (error) {
        fail(error);
      }
    },
  }),
  defineTool({
    name: "hub_repo_read_file",
    area: "context",
    description:
      "Read one text file inside a repository checkout this person is allowed to open. path is relative to the repo root. Size is capped. Secret files, ignored paths, and paths that leave the repo are refused. Read-only.",
    input: z.object({
      repoId: z.string().uuid(),
      path: z.string().min(1).max(400),
    }),
    isWrite: false,
    risk: "low",
    async run(ctx, input) {
      try {
        const file = await fileFor(ctx.prisma, ctx.userId, input.repoId, input.path);
        return toolOk(file.truncated ? `Read ${file.path} (truncated).` : `Read ${file.path}.`, file);
      } catch (error) {
        fail(error);
      }
    },
  }),
];
