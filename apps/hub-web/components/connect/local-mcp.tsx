"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Spinner } from "../ui";
import { CopyBlock } from "./bits";

function toml(value: string): string {
  return JSON.stringify(value);
}

/**
 * The desktop app kept local only: editors on this computer reach Ensemble through MCP with this
 * computer's own runtime (docs/DESKTOP.md §1.2). No key, no account, nothing leaves the computer.
 */
export function LocalMcp() {
  const config = useQuery({ queryKey: ["desktop-mcp"], queryFn: api.desktopMcp, staleTime: Infinity });
  if (config.isLoading) return <Spinner />;
  if (config.isError || !config.data) return <p role="alert" className="text-[13px] text-danger">{(config.error as Error | null)?.message ?? "Could not read this computer's MCP command."}</p>;
  const { command, args } = config.data;
  const json = JSON.stringify({ mcpServers: { ensemble: { command, args } } }, null, 2);
  const vscode = JSON.stringify({ servers: { ensemble: { type: "stdio", command, args } } }, null, 2);
  const codex = `[mcp_servers.ensemble]\ncommand = ${toml(command)}\nargs = [${args.map(toml).join(", ")}]`;
  const claude = `claude mcp add ensemble -- ${[command, ...args].map((part) => (/\s/.test(part) ? JSON.stringify(part) : part)).join(" ")}`;
  return (
    <div className="space-y-3">
      <p className="text-[13px] leading-5 text-muted">
        Add this server to an editor or agent on this computer. It talks to the Ensemble app here, so keep the app open while you use it. Nothing goes to Ensemble&apos;s servers.
      </p>
      <CopyBlock label="Claude Code" text={claude} />
      <CopyBlock label="Cursor, Claude Desktop, Windsurf and most apps (mcpServers JSON)" text={json} />
      <CopyBlock label="VS Code and GitHub Copilot (.vscode/mcp.json)" text={vscode} />
      <CopyBlock label="Codex (~/.codex/config.toml)" text={codex} />
    </div>
  );
}
