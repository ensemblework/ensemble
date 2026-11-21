/** Starts the owner's computer process (computer-main.ts) and talks to it over IPC. */
import { fork } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export type Computer = {
  sandbox: string | null;
  pair(apiBase: string, code: string, name: string): Promise<void>;
  unpair(): Promise<void>;
  /** Shares a folder under a label, as Settings does; resolves to its real path. */
  share(label: string, path: string, access: "read-write" | "review"): Promise<string>;
  unshare(label: string): Promise<void>;
  close(): Promise<void>;
};

type Reply = { id?: number; ok?: boolean; result?: unknown; error?: string; ready?: boolean; sandbox?: string | null };

const BOOT_MS = 180_000;
const CALL_MS = 120_000;

export async function startComputer(root: string): Promise<Computer> {
  mkdirSync(root, { recursive: true });
  const out = createWriteStream(join(root, "computer.out"));
  const child = fork(fileURLToPath(new URL("./computer-main.ts", import.meta.url)), [root], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  child.stdout?.pipe(out);
  child.stderr?.pipe(out);
  const waiting = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  let next = 0;
  let exited: string | null = null;

  const booted = new Promise<Reply>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("The computer process did not start in time.")), BOOT_MS);
    child.on("message", (raw) => {
      const reply = raw as Reply;
      if (reply.ready) {
        clearTimeout(timer);
        resolve(reply);
        return;
      }
      const wait = reply.id === undefined ? undefined : waiting.get(reply.id);
      if (!wait) return;
      waiting.delete(reply.id!);
      if (reply.ok) wait.resolve(reply.result);
      else wait.reject(new Error(reply.error ?? "The computer could not do that."));
    });
    child.on("exit", (code, signal) => {
      exited = `The computer process ended (${signal ?? code}); see computer.out in the scratch folder.`;
      clearTimeout(timer);
      reject(new Error(exited));
      for (const wait of waiting.values()) wait.reject(new Error(exited));
      waiting.clear();
    });
  });
  const ready = await booted.catch((error: unknown) => {
    child.kill("SIGKILL");
    throw error;
  });

  function call(op: string, args: Record<string, unknown> = {}): Promise<unknown> {
    if (exited) return Promise.reject(new Error(exited));
    const id = ++next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(new Error(`The computer did not answer "${op}" in time.`));
      }, CALL_MS);
      waiting.set(id, {
        resolve: (value) => (clearTimeout(timer), resolve(value)),
        reject: (error) => (clearTimeout(timer), reject(error)),
      });
      child.send({ id, op, ...args });
    });
  }

  return {
    sandbox: ready.sandbox ?? null,
    pair: async (apiBase, code, name) => void (await call("pair", { apiBase, code, name })),
    unpair: async () => void (await call("unpair")),
    share: async (label, path, access) => String(await call("share", { label, path, access })),
    unshare: async (label) => void (await call("unshare", { label })),
    async close() {
      if (exited) return;
      const gone = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      await call("close").catch(() => undefined);
      const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
      await gone;
      clearTimeout(timer);
    },
  };
}
