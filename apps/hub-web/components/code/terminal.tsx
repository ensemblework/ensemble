"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Fingerprint, Lock, Maximize2, Minimize2, TerminalSquare, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { API, api } from "@/lib/api";
import { TerminalMark, TerminalSvg } from "@/components/motion/terminal-mark";
import { Spinner, cx } from "../ui";
import { currentTerminalAccess } from "./terminal-address";
import { TerminalDesktopNote, useDesktopShell } from "./terminal-desktop-note";

type Line = { kind: "in" | "out" | "err" | "info"; text: string };

const HELP = `Allowed: git (no force-push, no config or remote changes), python, pip, uv, conda, node, npm, npx, pnpm, yarn, pytest, make,
ls, cat, head, tail, grep, rg, find, tree, mkdir, touch, cp, mv, rm, echo, diff, sed, awk, tar, unzip, curl, wget.
Built in: cd, pwd, clear, help, lock.  One command at a time: no pipes (|), redirects (>), && or ;.
Everything runs in the macOS sandbox: files can only change inside the folder you are in.`;

function shortPath(path: string, scope: string): string {
  if (!scope || !path.startsWith(scope)) return path;
  const name = scope.split("/").pop();
  const rest = path.slice(scope.length);
  return `${name}${rest}` || name || path;
}

function Countdown({ until }: { until: string | null }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);
  if (!until) return null;
  const minutes = Math.max(0, Math.round((new Date(until).getTime() - now) / 60_000));
  return <span title="Locks after 30 minutes idle, 8 hours at most">{minutes} min</span>;
}

export function Terminal({ initialCwd, onClose }: { initialCwd?: string; onClose: () => void }) {
  const client = useQueryClient();
  // Inside the desktop app the terminal shows a note instead (see terminal-desktop-note.tsx).
  const desktop = useDesktopShell();
  const status = useQuery({ queryKey: ["terminal-status"], queryFn: api.terminalStatus, refetchInterval: 60_000, enabled: desktop === false });
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [cwd, setCwd] = useState<string>("");
  const [scope, setScope] = useState<string>("");
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<{ line: string; message: string } | null>(null);
  const [big, setBig] = useState(false);
  const history = useRef<string[]>([]);
  const cursor = useRef(-1);
  const out = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const data = status.data;

  useEffect(() => {
    if (!data?.unlocked || cwd) return;
    const start = initialCwd && data.roots.some((root) => initialCwd.startsWith(root)) ? initialCwd : data.home;
    void api
      .terminalCd(start, ".")
      .then((result) => {
        setCwd(result.cwd);
        setScope(result.scope);
      })
      .catch(() => {
        setCwd(data.home);
        setScope(data.home);
      });
  }, [data?.unlocked, data?.home, data?.roots, initialCwd, cwd]);

  useEffect(() => {
    out.current?.scrollTo({ top: out.current.scrollHeight });
  }, [lines]);

  const print = useCallback((line: Line) => setLines((current) => [...current.slice(-800), line]), []);

  const enrol = useMutation({
    mutationFn: async () => {
      setError(null);
      const options = await api.terminalPasskeyOptions(password);
      const response = await startRegistration({ optionsJSON: options as never });
      await api.terminalPasskeyVerify(response, navigator.platform.includes("Mac") ? "This Mac (Touch ID)" : "This device");
    },
    onSuccess: () => {
      setPassword("");
      void client.invalidateQueries({ queryKey: ["terminal-status"] });
    },
    onError: (failure) => setError((failure as Error).message),
  });

  const unlock = useMutation({
    mutationFn: async () => {
      setError(null);
      const options = await api.terminalUnlockOptions();
      const response = await startAuthentication({ optionsJSON: options as never });
      return api.terminalUnlockVerify(response);
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["terminal-status"] });
      window.setTimeout(() => field.current?.focus(), 50);
    },
    onError: (failure) => setError((failure as Error).message.includes("NotAllowed") ? "Touch ID was cancelled." : (failure as Error).message),
  });

  const lock = async () => {
    await api.terminalLock();
    setCwd("");
    void client.invalidateQueries({ queryKey: ["terminal-status"] });
  };

  const run = async (line: string, confirmed = false) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (!confirmed) {
      history.current = [trimmed, ...history.current.filter((entry) => entry !== trimmed)].slice(0, 100);
      cursor.current = -1;
      print({ kind: "in", text: `${shortPath(cwd, scope)} $ ${trimmed}` });
    }
    const [word, ...rest] = trimmed.split(/\s+/);
    if (word === "clear") return setLines([]);
    if (word === "help") return print({ kind: "info", text: HELP });
    if (word === "pwd") return print({ kind: "out", text: cwd });
    if (word === "lock" || word === "exit") return void lock();
    if (word === "cd") {
      try {
        const result = await api.terminalCd(cwd, rest.join(" "));
        setCwd(result.cwd);
        setScope(result.scope);
      } catch (failure) {
        print({ kind: "err", text: (failure as Error).message });
      }
      return;
    }
    setBusy(true);
    try {
      const response = await fetch(`${API}/api/terminal/run`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, line: trimmed, confirmed }),
      });
      if (response.status === 428) {
        const body = (await response.json()) as { confirm: string };
        setConfirm({ line: trimmed, message: body.confirm });
        print({ kind: "info", text: `${body.confirm} Type yes to run it, anything else to cancel.` });
        return;
      }
      if (response.status === 401) {
        print({ kind: "err", text: "Locked. Unlock with Touch ID." });
        void client.invalidateQueries({ queryKey: ["terminal-status"] });
        return;
      }
      if (!response.ok || !response.body) {
        const text = await response.text();
        let message = text;
        try {
          message = (JSON.parse(text) as { error?: string }).error ?? text;
        } catch {
          // plain text
        }
        print({ kind: "err", text: message });
        return;
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let code: string | null = null;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const end = buffer.lastIndexOf("\u0000");
        if (end >= 0) {
          code = buffer.slice(end + 1).trim();
          buffer = buffer.slice(0, end);
        }
        const cut = buffer.lastIndexOf("\n");
        if (cut >= 0) {
          const chunk = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 1);
          if (chunk) print({ kind: "out", text: chunk });
        }
      }
      if (buffer.trim()) print({ kind: "out", text: buffer.replace(/\n$/, "") });
      if (code && code !== "0") print({ kind: "err", text: `exit ${code}` });
    } catch (failure) {
      print({ kind: "err", text: (failure as Error).message });
    } finally {
      setBusy(false);
      window.setTimeout(() => field.current?.focus(), 10);
    }
  };

  const onKey = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      const line = input;
      setInput("");
      if (confirm) {
        const pending = confirm;
        setConfirm(null);
        print({ kind: "in", text: `> ${line}` });
        if (line.trim().toLowerCase() === "yes") void run(pending.line, true);
        else print({ kind: "info", text: "Cancelled." });
        return;
      }
      void run(line);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      cursor.current = Math.min(cursor.current + 1, history.current.length - 1);
      setInput(history.current[cursor.current] ?? "");
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      cursor.current = Math.max(cursor.current - 1, -1);
      setInput(cursor.current < 0 ? "" : history.current[cursor.current] ?? "");
    } else if (event.key === "c" && event.ctrlKey) {
      event.preventDefault();
      if (busy) void api.terminalKill().then(() => print({ kind: "info", text: "^C" }));
      else setInput("");
    } else if (event.key === "l" && event.ctrlKey) {
      event.preventDefault();
      setLines([]);
    }
  };

  const access = currentTerminalAccess();

  return (
    <div className={cx("ide-terminal flex shrink-0 flex-col border-t", big ? "h-[60vh]" : "h-[280px]")}>
      <div className="term-line flex h-8 shrink-0 items-center gap-2 border-b px-3 text-[12px]">
        <TerminalSquare size={13} />
        <span className="font-medium">Terminal</span>
        <span className="term-faint">· you only · sandboxed</span>
        {data?.unlocked ? <span className="term-dim truncate font-mono">{cwd}</span> : null}
        <div className="flex-1" />
        {data?.unlocked ? (
          <>
            <Countdown until={data.expiresAt} />
            <button type="button" className="term-hover rounded px-1.5 py-0.5" onClick={() => void lock()} title="Lock now">
              <Lock size={12} />
            </button>
          </>
        ) : null}
        <button type="button" className="term-hover rounded px-1.5 py-0.5" onClick={() => setBig(!big)} title={big ? "Smaller" : "Bigger"}>
          {big ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
        </button>
        <button type="button" className="term-hover rounded px-1.5 py-0.5" onClick={onClose} title="Close (Ctrl+`)">
          <X size={12} />
        </button>
      </div>

      {desktop ? (
        <TerminalDesktopNote />
      ) : status.isLoading || !data ? (
        <div className="flex items-center gap-2 p-4 text-[13px] text-muted">
          <TerminalSvg state="working" />
          <span aria-live="polite">Opening the terminal…</span>
        </div>
      ) : !data.enabled ? (
        <div className="term-dim p-4 text-[13px]">The terminal is turned off in Settings → Terminal and commits.</div>
      ) : !access.ok ? (
        <div className="term-dim p-4 text-[13px]" data-testid="terminal-address-note" data-reason={access.reason}>
          {access.message}
        </div>
      ) : !data.unlocked ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-4 text-center">
          <Fingerprint size={28} className="term-dim" />
          {data.passkeys.length ? (
            <>
              <div className="term-dim max-w-md text-[13px]">This terminal is for you only. Unlock it with Touch ID; it locks again after 30 minutes idle.</div>
              <button type="button" className="btn-primary" onClick={() => unlock.mutate()} disabled={unlock.isPending}>
                {unlock.isPending ? <Spinner size={12} /> : <Fingerprint size={14} />} Unlock with Touch ID
              </button>
            </>
          ) : (
            <>
              <div className="term-dim max-w-md text-[13px]">
                Set up Touch ID once. After that only your fingerprint opens this terminal — no agent, script or API token can. Confirm your Ensemble password to start.
              </div>
              <div className="flex gap-2">
                <input
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  onKeyDown={(event) => event.key === "Enter" && password && enrol.mutate()}
                  placeholder="Ensemble password"
                  className="field term-line w-56 bg-transparent"
                />
                <button type="button" className="btn-primary" disabled={!password || enrol.isPending} onClick={() => enrol.mutate()}>
                  {enrol.isPending ? <Spinner size={12} /> : <Fingerprint size={14} />} Set up Touch ID
                </button>
              </div>
            </>
          )}
          {error ? <div className="term-err text-[12.5px]">{error}</div> : null}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col font-mono text-[12.5px] leading-[1.55]" onClick={() => field.current?.focus()}>
          <div ref={out} className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
            {lines.length === 0 ? <div className="term-faint">Type help to see what is allowed. Commands run in the folder shown above.</div> : null}
            {lines.map((line, index) => (
              <div
                key={index}
                className={cx("whitespace-pre-wrap break-words", line.kind === "in" ? "term-in" : line.kind === "err" ? "term-err" : line.kind === "info" ? "term-info" : undefined)}
              >
                {line.text}
              </div>
            ))}
          </div>
          <div className="term-line flex items-center gap-2 border-t px-3 py-1.5">
            <span className="term-in shrink-0">{confirm ? ">" : `${shortPath(cwd, scope)} $`}</span>
            <input
              ref={field}
              autoFocus
              value={input}
              disabled={busy && !confirm}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={onKey}
              spellCheck={false}
              autoComplete="off"
              className="min-w-0 flex-1 bg-transparent text-inherit outline-none placeholder:text-current placeholder:opacity-40"
              placeholder={busy ? "Running… Ctrl+C to stop" : "git status"}
            />
            {busy ? <TerminalMark state="working" label="Running" /> : null}
          </div>
        </div>
      )}
    </div>
  );
}
