"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { connectorsApi, mcpErrorCode, type McpConnection } from "@/lib/api-connectors";
import { useToast } from "../toast";
import { Spinner } from "../ui";
import { BrandLogo } from "./brand-logo";
import { browser } from "./browser";
import { McpPanel } from "./connector-detail";
import { useRefreshConnections } from "./use-connectors";

/** A remote MCP server URL is https (http only for this computer). */
export function validMcpUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

type AuthMode = "signin" | "token" | "client";

const ASKS_FOR_TOKEN = new Set(["MCP_TOKEN_REQUIRED", "MCP_PKCE_UNSUPPORTED"]);

export function CustomConnectorForm({ onAdded, headingRef }: { onAdded: (id: string) => void; headingRef?: React.Ref<HTMLHeadingElement> }) {
  const toast = useToast();
  const refresh = useRefreshConnections();
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [touched, setTouched] = useState(false);
  const [auth, setAuth] = useState<AuthMode>("signin");
  const [token, setToken] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [problem, setProblem] = useState<{ field: "url" | "auth"; message: string } | null>(null);
  const add = useMutation({
    mutationFn: () =>
      connectorsApi.addMcp({
        url: url.trim(),
        name: name.trim(),
        returnTo: `${typeof window === "undefined" ? "/settings" : window.location.pathname}?tab=connections&store=connected`,
        ...(auth === "token" ? { token: token.trim() } : {}),
        ...(auth === "client" ? { clientId: clientId.trim(), ...(clientSecret.trim() ? { clientSecret: clientSecret.trim() } : {}) } : {}),
      }),
    onMutate: () => setProblem(null),
    onSuccess: (result) => {
      if (result.authorizeUrl) {
        browser.assign(result.authorizeUrl);
        return;
      }
      toast(`${name.trim()} added.`, { tone: "ok" });
      refresh();
      onAdded(result.id);
    },
    onError: (error) => {
      const code = mcpErrorCode(error);
      const message = (error as Error).message;
      if (code === "MCP_URL_REFUSED") setProblem({ field: "url", message });
      else if (code && ASKS_FOR_TOKEN.has(code)) {
        if (auth === "signin") setAuth("token");
        setProblem({ field: "auth", message });
      } else if (code === "MCP_TOKEN_REFUSED") setProblem({ field: "auth", message });
      else toast(message, { tone: "error" });
    },
  });
  const urlOk = validMcpUrl(url);
  const authOk = auth === "signin" || (auth === "token" ? token.trim().length >= 8 : clientId.trim().length > 0);
  const ready = name.trim().length > 0 && urlOk && authOk;
  const urlMessage = problem?.field === "url" ? problem.message : touched && url.trim() && !urlOk ? "Use an https:// address." : null;
  return (
    <div className="mx-auto max-w-[560px] p-4 sm:p-6" data-testid="custom-connector">
      <div className="flex items-start gap-3">
        <BrandLogo id="custom" size={44} decorative />
        <div>
          <h3 ref={headingRef} tabIndex={-1} className="text-[18px] font-semibold outline-none">
            Add a custom connector
          </h3>
          <p className="text-[13px] text-muted">Any remote MCP server: your team's own, or one a vendor gave you. Ensemble reads its tools; changes still wait for your Apply.</p>
        </div>
      </div>
      <form
        className="mt-5 space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          setTouched(true);
          if (ready && !add.isPending) add.mutate();
        }}
      >
        <label className="block text-[13px] font-medium">
          Name
          <input data-autofocus autoFocus name="name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Fieldnote tools" className="field mt-1 w-full" maxLength={80} />
        </label>
        <label className="block text-[13px] font-medium">
          Server URL
          <input
            name="url"
            value={url}
            onChange={(event) => {
              setUrl(event.target.value);
              if (problem?.field === "url") setProblem(null);
            }}
            onBlur={() => setTouched(true)}
            placeholder="https://mcp.example.com/mcp"
            inputMode="url"
            spellCheck={false}
            className="field mt-1 w-full font-mono text-[12.5px]"
            aria-invalid={Boolean(urlMessage)}
            aria-describedby="custom-url-help"
          />
          <span id="custom-url-help" role={urlMessage ? "alert" : undefined} className={`mt-1 block text-[12px] font-normal ${urlMessage ? "text-danger" : "text-muted"}`}>
            {urlMessage ?? "Streamable HTTP or SSE. If the server needs a sign-in, you approve it on its own page next."}
          </span>
        </label>
        <fieldset className="rounded-lg border border-line px-3 pb-3 pt-2">
          <legend className="px-1 text-[12.5px] font-medium">How it signs in</legend>
          <div className="space-y-1.5 text-[13px]" role="radiogroup">
            {(
              [
                ["signin", "Sign in on the server's page, if it asks"],
                ["token", "A personal access token or API key"],
                ["client", "An OAuth client ID and secret the server gave you"],
              ] as const
            ).map(([value, text]) => (
              <label key={value} className="flex cursor-pointer items-center gap-2">
                <input type="radio" name="custom-auth" value={value} checked={auth === value} onChange={() => setAuth(value)} className="accent-[rgb(var(--accent-rgb))]" />
                {text}
              </label>
            ))}
          </div>
          {auth === "token" ? (
            <input
              name="token"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={token}
              onChange={(event) => setToken(event.target.value)}
              aria-label="Token"
              placeholder="Paste the token"
              className="field mt-2 w-full font-mono"
            />
          ) : null}
          {auth === "client" ? (
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              <input name="clientId" value={clientId} onChange={(event) => setClientId(event.target.value)} aria-label="Client ID" placeholder="Client ID" autoComplete="off" spellCheck={false} className="field font-mono" />
              <input
                name="clientSecret"
                type="password"
                value={clientSecret}
                onChange={(event) => setClientSecret(event.target.value)}
                aria-label="Client secret (optional)"
                placeholder="Client secret (optional)"
                autoComplete="off"
                className="field font-mono"
              />
            </div>
          ) : null}
          {problem?.field === "auth" ? (
            <p role="alert" className="mt-2 text-[12px] text-danger">
              {problem.message}
            </p>
          ) : null}
        </fieldset>
        <div className="flex justify-end gap-2 pt-1">
          <button type="submit" className="btn-primary" disabled={!ready || add.isPending}>
            {add.isPending ? <Spinner size={12} /> : null} Add connector
          </button>
        </div>
      </form>
      <p className="mt-4 text-[12px] text-faint">Only add servers you trust. A server's tool descriptions are shown to the model, and a malicious server can try to steer it.</p>
    </div>
  );
}

export function CustomConnectionDetail({ connection, headingRef }: { connection: McpConnection; headingRef?: React.Ref<HTMLHeadingElement> }) {
  return (
    <div className="space-y-4 p-4 sm:p-5" data-testid="custom-connection" data-connection={connection.id}>
      <header className="flex items-start gap-3">
        <BrandLogo id="custom" name={connection.name} size={44} decorative />
        <div className="min-w-0">
          <h3 ref={headingRef} tabIndex={-1} className="text-[18px] font-semibold outline-none">
            {connection.name}
          </h3>
          <div className="truncate font-mono text-[12px] text-muted">{connection.url}</div>
        </div>
      </header>
      <McpPanel
        entry={{ id: connection.id, name: connection.name, vendor: connection.name, state: { connected: false, account: null, appReady: true, products: {}, sources: {} } }}
        connection={connection}
      />
    </div>
  );
}
