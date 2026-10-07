"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ApiError, api, type CliAuthRequest, type CliAuthScope } from "@/lib/api";
import { cx, Spinner } from "./ui";

const SCOPE_LABELS: Record<CliAuthScope, string> = {
  mcp: "Read your Ensemble context in editors (read-only)",
  runner: "Run tasks you assign to this computer",
};

function cleanCode(value: string): string {
  return value.trim().toUpperCase();
}

function platformName(value: string): string {
  const text = value.toLowerCase();
  if (text.includes("darwin") || text.includes("mac")) return "macOS";
  if (text.includes("win")) return "Windows";
  if (text.includes("linux")) return "Linux";
  return value || "Unknown platform";
}

/** Without `initialCode` the code comes from `?code=` in the address, read in the browser so the page can be exported statically for the desktop app. */
export function CliLink({ initialCode }: { initialCode?: string }) {
  const [code, setCode] = useState(cleanCode(initialCode ?? ""));
  const [loadedCode, setLoadedCode] = useState("");
  const [request, setRequest] = useState<CliAuthRequest | null>(null);
  const [loading, setLoading] = useState(false);
  const [acting, setActing] = useState<"approve" | "deny" | "mcp" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [emailUnverified, setEmailUnverified] = useState(false);
  const [done, setDone] = useState<{ decision: "approved" | "denied"; scopes: CliAuthScope[] } | null>(null);
  const [confirmed, setConfirmed] = useState(false);

  const canApproveMcpOnly = useMemo(() => Boolean(request?.scopes.includes("mcp") && request.scopes.includes("runner")), [request]);

  async function load(nextCode = code) {
    const userCode = cleanCode(nextCode);
    if (!userCode) {
      setError("Enter the code shown by `ensemble login`.");
      return;
    }
    setLoading(true);
    setError(null);
    setEmailUnverified(false);
    setDone(null);
    setConfirmed(false);
    try {
      const next = await api.cliAuthRequest(userCode);
      setRequest(next);
      setCode(userCode);
      setLoadedCode(userCode);
    } catch (caught) {
      setRequest(null);
      if (caught instanceof ApiError && caught.status === 404) setError("That code expired, was already used, or was typed incorrectly. Run `ensemble login` again.");
      else setError(caught instanceof Error ? caught.message : "Could not load that code.");
    } finally {
      setLoading(false);
    }
  }

  async function decide(decision: "approve" | "deny", scopes: CliAuthScope[]) {
    if (!loadedCode) return;
    setActing(decision === "approve" && scopes.length === 1 && scopes[0] === "mcp" ? "mcp" : decision);
    setError(null);
    setEmailUnverified(false);
    try {
      const result = await api.approveCliAuth({ userCode: loadedCode, scopes, decision });
      setDone({ decision: decision === "approve" ? "approved" : "denied", scopes: result.scopes ?? scopes });
      setRequest(null);
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 403 && /EMAIL_UNVERIFIED/i.test(caught.message)) {
        setEmailUnverified(true);
        setError("Verify your email before approving runner access for this computer.");
      } else {
        setError(caught instanceof Error ? caught.message : "Could not submit your decision.");
      }
    } finally {
      setActing(null);
    }
  }

  useEffect(() => {
    const start = initialCode ?? new URLSearchParams(window.location.search).get("code") ?? "";
    if (!start) return;
    setCode(cleanCode(start));
    void load(start);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialCode]);

  return (
    <main className="min-h-screen bg-bg px-6 py-10 text-ink">
      <div className="mx-auto max-w-[680px]">
        <Link href="/today" className="text-[13px] text-muted hover:text-ink">
          Ensemble
        </Link>
        <section className="tile mt-5 rounded-2xl bg-panel p-5 shadow-lg md:p-7" aria-labelledby="cli-link-title">
          <h1 id="cli-link-title" className="display text-[30px] leading-none">
            Link the Ensemble CLI
          </h1>
          <p className="mt-3 text-[14px] leading-6 text-muted">
            Approve a sign-in request from `ensemble login`. You can approve editor context only, or editor context plus the runner when requested.
          </p>

          <form
            className="mt-6 flex flex-col gap-2 sm:flex-row"
            onSubmit={(event) => {
              event.preventDefault();
              void load();
            }}
          >
            <label className="min-w-0 flex-1 text-[13px] font-medium">
              Code
              <input
                value={code}
                onChange={(event) => setCode(event.target.value)}
                className="field mt-1 w-full font-mono uppercase tracking-[0.18em]"
                placeholder="ABCD-EFGH"
                autoComplete="one-time-code"
              />
            </label>
            <button type="submit" className="btn-primary self-end" disabled={loading}>
              {loading ? <Spinner size={12} /> : null} Load request
            </button>
          </form>

          {error ? (
            <div className="mt-4 rounded-xl border border-warn/40 bg-bg/70 px-3 py-3 text-[13px] leading-5 text-muted" role="alert">
              {error}
              {emailUnverified ? (
                <div className="mt-3 flex flex-wrap gap-2">
                  {canApproveMcpOnly ? (
                    <button type="button" className="btn-primary" disabled={acting !== null || !confirmed} onClick={() => void decide("approve", ["mcp"])}>
                      {acting === "mcp" ? "Approving…" : "Approve MCP only"}
                    </button>
                  ) : null}
                  <Link href="/verify" className="btn">
                    Verify email
                  </Link>
                </div>
              ) : null}
            </div>
          ) : null}

          {done ? (
            <div className={cx("mt-5 rounded-xl border px-4 py-4", done.decision === "approved" ? "border-ok/40 bg-ok/10" : "border-line bg-bg/70")} role="status">
              <h2 className="text-[16px] font-semibold">{done.decision === "approved" ? "Approved" : "Denied"}</h2>
              <p className="mt-1 text-[14px] text-muted">Return to your terminal.</p>
              {done.scopes.length ? (
                <ul className="mt-2 list-disc space-y-1 pl-5 text-[13px] text-muted">
                  {done.scopes.map((scope) => (
                    <li key={scope}>{SCOPE_LABELS[scope]}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}

          {request ? (
            <div className="mt-6 space-y-5">
              <div className="rounded-xl border border-line bg-bg/70 p-4">
                <div className="text-[12px] uppercase tracking-[0.14em] text-faint">Sign-in request</div>
                <h2 className="mt-2 text-[18px] font-semibold">Ensemble CLI on {request.clientName || "an unnamed computer"}</h2>
                <dl className="mt-3 grid gap-2 text-[13px] text-muted sm:grid-cols-2">
                  <div>
                    <dt className="text-faint">Platform</dt>
                    <dd>{platformName(request.platform)}</dd>
                  </div>
                  <div>
                    <dt className="text-faint">CLI version</dt>
                    <dd>{request.version || "Unknown"}</dd>
                  </div>
                  <div>
                    <dt className="text-faint">Code</dt>
                    <dd className="font-mono tracking-[0.18em] text-ink">{loadedCode}</dd>
                  </div>
                  <div>
                    <dt className="text-faint">Expires</dt>
                    <dd>{new Date(request.expiresAt).toLocaleTimeString()}</dd>
                  </div>
                  {request.requestedFrom ? (
                    <div className="sm:col-span-2">
                      <dt className="text-faint">Started from</dt>
                      <dd className="font-mono">{request.requestedFrom}</dd>
                    </div>
                  ) : null}
                </dl>
                {request.sameNetwork === false ? (
                  <p className="mt-3 rounded-lg border border-warn/40 px-3 py-2 text-[13px] leading-5 text-muted" role="note">
                    This login was started from a different network address than this browser. That is normal on a VPN, a phone hotspot or another computer of
                    yours. If you did not just run <code>ensemble login</code> yourself, deny it.
                  </p>
                ) : null}
              </div>

              <div>
                <h2 className="text-[15px] font-semibold">Requested access</h2>
                <ul className="mt-2 space-y-2">
                  {request.scopes.map((scope) => (
                    <li key={scope} className="rounded-lg border border-line bg-bg/50 px-3 py-2 text-[13.5px]">
                      {SCOPE_LABELS[scope]}
                    </li>
                  ))}
                </ul>
              </div>

              <div className="rounded-xl border border-warn/40 bg-bg/70 px-4 py-3 text-[13.5px] leading-6 text-muted">
                <span className="font-semibold text-ink">Security check:</span> Approving gives that terminal access to your Ensemble account. Never approve a
                code someone sent you.
                <label className="mt-2 flex items-start gap-2 text-ink">
                  <input type="checkbox" className="mt-1" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
                  <span>
                    I ran <code>ensemble login</code> myself and my terminal shows <span className="font-mono tracking-[0.12em]">{loadedCode}</span>.
                  </span>
                </label>
              </div>

              <div className="flex flex-wrap gap-2">
                <button type="button" className="btn-primary" disabled={acting !== null || !confirmed} onClick={() => void decide("approve", request.scopes)}>
                  {acting === "approve" ? "Approving…" : "Approve"}
                </button>
                <button type="button" className="btn" disabled={acting !== null} onClick={() => void decide("deny", [])}>
                  {acting === "deny" ? "Denying…" : "Deny"}
                </button>
              </div>
            </div>
          ) : null}
        </section>
      </div>
    </main>
  );
}
