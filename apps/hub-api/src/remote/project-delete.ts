/**
 * The person deleted an Ensemble project (docs/30, In the agents' own apps): the Codex projects Ensemble
 * made for it on this computer, found by Ensemble's id in their metadata, leave the ChatGPT app's sidebar
 * and then Codex (`removeCodexAppProjects`). The project's folder and its agents' sessions stay.
 */
import { z } from "zod";
import { listCodexProjects, removeCodexAppProjects, type CodexProjectRow, type SidebarOptions } from "../workspace/engines/app-sessions.js";
import { noCodexProjects, withCodexServer } from "../workspace/engines/delete-session.js";
import type { HostedClient } from "./client.js";
import type { CodeAnswer } from "./contract.js";

const Request = z.object({ id: z.string().min(1).max(100), projectId: z.string().uuid() }).strict();

/** Codex's projects on this computer: none without Codex, or with a Codex older than its projects. */
async function codexProjects(): Promise<CodexProjectRow[]> {
  const found = await withCodexServer(async (server) => {
    try {
      return await listCodexProjects(server);
    } catch (error) {
      if (noCodexProjects(error)) return [];
      throw error;
    }
  });
  return found?.value ?? [];
}

export type RemoveOptions = SidebarOptions & { projects?: () => Promise<CodexProjectRow[]> };

/**
 * Removes the Codex projects Ensemble made here for a deleted Ensemble project: only those carrying its id,
 * never the person's own project for the same folder. `owed`: one waits for the ChatGPT app to close,
 * which this computer keeps and tries again on its own.
 */
export async function removeProjectHere(projectId: string, options: RemoveOptions = {}): Promise<{ found: number; owed: boolean }> {
  const ids = (await (options.projects ?? codexProjects)()).filter((row) => row.metadata?.ensembleProjectId === projectId).map((row) => row.id);
  return { found: ids.length, owed: (await removeCodexAppProjects(ids, options)) === "owed" };
}

export async function answerProjectDelete(client: Pick<HostedClient, "answerCode">, input: unknown, remove: (projectId: string) => Promise<{ found: number; owed: boolean }> = removeProjectHere): Promise<void> {
  const parsed = Request.safeParse(input);
  const id = parsed.success ? parsed.data.id : typeof input === "object" && input && "id" in input && typeof input.id === "string" ? input.id : null;
  if (!id) return;
  let answer: CodeAnswer;
  try {
    if (!parsed.success) throw new Error("Invalid project deletion request.");
    answer = { status: 200, body: { deleted: true, ...(await remove(parsed.data.projectId)) } };
  } catch (error) {
    answer = { status: 409, body: { error: error instanceof Error ? error.message : "This computer could not delete the project's Codex projects." } };
  }
  await client.answerCode(id, answer);
}
