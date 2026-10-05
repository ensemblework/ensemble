#!/usr/bin/env node
/**
 * Start hub-api, hub-web, and agent-runtime.
 *
 * Extra arguments are ignored on purpose. The documented start used to put a
 * `#` comment on the same line as `pnpm dev`. Interactive zsh (macOS default)
 * and Windows cmd do not treat `#` as a comment, so pnpm quoted it and
 * forwarded it. Next.js then treated `#` as the project directory
 * (`apps/hub-web/#`). Bash and PowerShell already drop a trailing `#` comment;
 * ignoring leftovers here makes the same command work in all four.
 */
import { spawn } from "node:child_process";

const extra = process.argv.slice(2);
if (extra.length > 0) {
  const shown = extra.map((arg) => JSON.stringify(arg)).join(" ");
  console.error(`pnpm dev: ignoring extra arguments (${shown}). A # comment is not a project directory.`);
}

const child = spawn(
  "pnpm",
  [
    "--parallel",
    "--filter",
    "@ensemble/hub-api",
    "--filter",
    "@ensemble/hub-web",
    "--filter",
    "@ensemble/agent-runtime",
    "run",
    "dev",
  ],
  {
    stdio: "inherit",
    // .cmd shims on Windows need a shell. Unix must not, or a quoted `#`
    // would be parsed again by zsh when SHELL points at it.
    shell: process.platform === "win32",
    env: process.env,
  },
);

child.on("error", (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (!child.killed) child.kill(signal);
  });
}

child.on("exit", (code, signal) => {
  if (signal) process.exit(1);
  process.exit(code ?? 1);
});
