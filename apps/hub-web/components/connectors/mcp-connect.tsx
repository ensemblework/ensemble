"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { connectorsApi, mcpErrorCode, type McpConnectInput, type McpConnectResult, type McpErrorCode } from "@/lib/api-connectors";
import { useToast } from "../toast";
import { Spinner } from "../ui";
import { browser } from "./browser";
import { useRefreshConnections } from "./use-connectors";

/** Codes after which the server will take a pasted token instead of a sign-in. */
const ASKS_FOR_TOKEN = new Set<McpErrorCode>(["MCP_TOKEN_REQUIRED", "MCP_TOKEN_REFUSED", "MCP_PKCE_UNSUPPORTED"]);

export type McpProblem = { code: McpErrorCode; message: string };

/**
 * Connects a remote MCP server. A sign-in redirect leaves the page; when the
 * server needs a token instead, `problem` says so and `connect({ token })`
 * tries again with it.
 */
export function useMcpConnect({
  target,
  label,
  onConnected,
}: {
  target: () => McpConnectInput;
  label: string;
  onConnected?: (result: McpConnectResult) => void;
}) {
  const toast = useToast();
  const refresh = useRefreshConnections();
  const [problem, setProblem] = useState<McpProblem | null>(null);
  const mutation = useMutation({
    mutationFn: (extra: { token?: string } = {}) => connectorsApi.addMcp({ ...target(), ...extra }),
    onMutate: () => setProblem(null),
    onSuccess: (result) => {
      if (result.authorizeUrl) {
        browser.assign(result.authorizeUrl);
        return;
      }
      toast(`${label} tools connected.`, { tone: "ok" });
      refresh();
      onConnected?.(result);
    },
    onError: (error) => {
      const code = mcpErrorCode(error);
      if (code && (ASKS_FOR_TOKEN.has(code) || code === "MCP_URL_REFUSED")) setProblem({ code, message: (error as Error).message });
      else toast((error as Error).message, { tone: "error" });
    },
  });
  return {
    connect: (extra?: { token?: string }) => mutation.mutate(extra ?? {}),
    pending: mutation.isPending,
    problem,
    asksForToken: Boolean(problem && ASKS_FOR_TOKEN.has(problem.code)),
    clear: () => setProblem(null),
  };
}

/** Shown when an MCP server will not do a browser sign-in: paste its token instead. */
export function McpTokenPrompt({
  label,
  problem,
  pending,
  onSubmit,
  onCancel,
}: {
  label: string;
  problem: McpProblem;
  pending: boolean;
  onSubmit: (token: string) => void;
  onCancel: () => void;
}) {
  const [token, setToken] = useState("");
  const ready = token.trim().length >= 8;
  return (
    <form
      className="mt-3 space-y-2 rounded-lg bg-raised p-3"
      data-testid="mcp-token-prompt"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready && !pending) onSubmit(token.trim());
      }}
    >
      <p role="alert" className={problem.code === "MCP_TOKEN_REFUSED" ? "text-[12.5px] text-danger" : "text-[12.5px] text-muted"}>
        {problem.message}
      </p>
      <label className="block text-[12.5px] font-medium">
        {label} personal access token or API key
        <input
          autoFocus
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={token}
          onChange={(event) => setToken(event.target.value)}
          className="field mt-1 w-full font-mono"
        />
      </label>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <span className="mr-auto text-[12px] text-muted">Sent to {label} as a bearer token and stored encrypted.</span>
        <button type="button" className="btn-ghost" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn-primary" disabled={!ready || pending}>
          {pending ? <Spinner size={12} /> : null} Connect with token
        </button>
      </div>
    </form>
  );
}
