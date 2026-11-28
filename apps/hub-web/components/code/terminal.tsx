"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { useQuery } from "@tanstack/react-query";
import { Laptop, TerminalSquare, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { API, api } from "@/lib/api";
import type { CodeTarget } from "@/lib/code-target";
import { TerminalMark, TerminalSvg } from "@/components/motion/terminal-mark";
import { QueryError, cx } from "../ui";
import { currentTerminalAccess } from "./terminal-address";
import { TerminalDesktopNote, useDesktopShell } from "./terminal-desktop-note";

type Line = { kind: "in" | "out" | "err" | "info"; text: string };

const HELP = `Allowed: git (no force-push, no config or remote changes), python, pip, uv, conda, node, npm, npx, pnpm, yarn, pytest, make,
ls, cat, head, tail, grep, rg, find, tree, mkdir, touch, cp, mv, rm, echo, diff, sed, awk, tar, unzip, curl, wget.
Built in: cd, pwd, clear, help, exit.  One command at a time: no pipes (|), redirects (>), && or ;.
Everything runs in the macOS sandbox: files can only change inside the folder you are in.`;

function shortPath(path: string, scope: string): string {
  if (!scope || !path.startsWith(scope)) return path;
  const name = scope.split("/").pop();
  const rest = path.slice(scope.length);
  return `${name}${rest}` || name || path;
}

type Status = { enabled: boolean; roots: string[]; home: string };

type RunResult = { confirm: string } | { error: string } | { exitCode: string | null };

/**
 * Where the terminal's commands go. `local`: this Ensemble's own terminal (its page at localhost).
 * `device`: a paired computer, through Ensemble on the web. Either way only the person's signed-in
 * browser session gets in; the server refuses keys, tokens, agents and the assistant.
 */
type Backend = {
  web: boolean;
  status(): Promise<Status>;
  cd(cwd: string, path: string): Promise<{ cwd: string; scope: string }>;
  kill(): Promise<unknown>;
  run(cwd: string, line: string, confirmed: boolean, onText: (text: string) => void): Promise<RunResult>;
};

async function errorText(response: Response): Promise<string> {
  const text = await response.text();
  try {
    return (JSON.parse(text) as { error?: string }).error ?? text;
  } catch {
    return text;
  }
}

const localBackend: Backend = {
  web: false,
  status: () => api.terminalStatus(),
  cd: (cwd, path) => api.terminalCd(cwd, path),
  kill: () => api.terminalKill(),
  async run(cwd, line, confirmed, onText) {
    const response = await fetch(`${API}/api/terminal/run`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd, line, confirmed }),
    });
    if (response.status === 428) return { confirm: ((await response.json()) as { confirm: string }).confirm };
    if (!response.ok || !response.body) return { error: await errorText(response) };
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let code: string | null = null;
    let pending = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      const end = pending.lastIndexOf("\u0000");
      if (end >= 0) {
        code = pending.slice(end + 1).trim();
        pending = pending.slice(0, end);
      }
      if (pending) onText(pending);
      pending = "";
    }
    return { exitCode: code };
  },
};

function deviceBackend(deviceId: string): Backend {
  let current: string | null = null;
  return {
    web: true,
    async status() {
      const there = await api.deviceTerminal<{ roots: string[]; home: string }>(deviceId, { op: "status" });
      return { enabled: true, roots: there.roots, home: there.home };
    },
    cd: (cwd, path) => api.deviceTerminal<{ cwd: string; scope: string }>(deviceId, { op: "cd", cwd, path }),
    kill: () => (current ? api.deviceTerminal(deviceId, { op: "kill", runId: current }) : Promise.resolve()),
    async run(cwd, line, confirmed, onText) {
      const response = await fetch(`${API}/api/devices/${encodeURIComponent(deviceId)}/terminal`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ op: "run", cwd, line, confirmed }),
      });
      if (response.status === 428) return { confirm: ((await response.json()) as { confirm: string }).confirm };
      if (!response.ok) return { error: await errorText(response) };
      const { runId } = (await response.json()) as { runId: string };
      current = runId;
      let after = -1;
      try {
        // Long-polls the output the computer sends, in order, until the command ends.
        for (;;) {
          const out = await api.deviceTerminalOutput(deviceId, runId, after);
          for (const chunk of out.chunks) {
            if (chunk.text) onText(chunk.text);
            after = chunk.seq;
          }
          if (out.done) return { exitCode: out.exitCode === null ? null : String(out.exitCode) };
        }
      } catch (failure) {
        return { error: (failure as Error).message };
      } finally {
        current = null;
      }
    },
  };
}

export function Terminal({ initialCwd, target, fontSize, onClose }: { initialCwd?: string; target?: CodeTarget; fontSize?: number; onClose: () => void }) {
  // Inside the desktop app the terminal shows a note instead (see terminal-desktop-note.tsx).
  const desktop = useDesktopShell();
  const deviceId = target?.kind === "device" ? target.deviceId : null;
  const backend = useMemo(() => (deviceId ? deviceBackend(deviceId) : localBackend), [deviceId]);
  const statusKey = useMemo(() => (deviceId ? ["terminal-status", "device", deviceId] : ["terminal-status"]), [deviceId]);
  const status = useQuery({ queryKey: statusKey, queryFn: () => backend.status(), refetchInterval: 60_000, enabled: desktop === false, retry: false });
  const computers = useQuery({ queryKey: ["devices"], queryFn: api.devices, enabled: Boolean(deviceId), staleTime: 60_000 });
  const computerName = deviceId ? computers.data?.devices.find((row) => row.id === deviceId)?.name ?? "your computer" : null;
  const [lines, setLines] = useState<Line[]>([]);
  const [cwd, setCwd] = useState<string>("");
  const [scope, setScope] = useState<string>("");
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<{ line: string; message: string } | null>(null);
  const history = useRef<string[]>([]);
  const cursor = useRef(-1);
  const out = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const data = status.data;

  // Opens in the folder it was asked for when the terminal may use it (any folder Open a folder accepts), else at home.
  useEffect(() => {
    if (!data?.enabled || cwd) return;
    void backend
      .cd(initialCwd || data.home, ".")
      .catch(() => backend.cd(data.home, "."))
      .then((result) => {
        setCwd(result.cwd || data.home);
        setScope(result.scope || data.home);
      })
      .catch(() => {
        setCwd(data.home);
        setScope(data.home);
      });
  }, [backend, data?.enabled, data?.home, initialCwd, cwd]);

  useEffect(() => {
    out.current?.scrollTo({ top: out.current.scrollHeight });
  }, [lines]);

  const print = useCallback((line: Line) => setLines((current) => [...current.slice(-800), line]), []);

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
    if (word === "exit") return onClose();
    if (word === "cd") {
      try {
        const result = await backend.cd(cwd, rest.join(" "));
        setCwd(result.cwd);
        setScope(result.scope);
      } catch (failure) {
        print({ kind: "err", text: (failure as Error).message });
      }
      return;
    }
    setBusy(true);
    try {
      let buffer = "";
      const result = await backend.run(cwd, trimmed, confirmed, (text) => {
        buffer += text;
        const cut = buffer.lastIndexOf("\n");
        if (cut >= 0) {
          const chunk = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 1);
          if (chunk) print({ kind: "out", text: chunk });
        }
      });
      if (buffer.trim()) print({ kind: "out", text: buffer.replace(/\n$/, "") });
      if ("confirm" in result) {
        setConfirm({ line: trimmed, message: result.confirm });
        print({ kind: "info", text: `${result.confirm} Type yes to run it, anything else to cancel.` });
      } else if ("error" in result) {
        print({ kind: "err", text: result.error });
      } else if (result.exitCode && result.exitCode !== "0") {
        print({ kind: "err", text: `exit ${result.exitCode}` });
      }
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
      if (busy) void backend.kill().then(() => print({ kind: "info", text: "^C" }));
      else setInput("");
    } else if (event.key === "l" && event.ctrlKey) {
      event.preventDefault();
      setLines([]);
    }
  };

  // A paired computer's terminal opens on the web's own address; this Ensemble's own opens only at localhost.
  const access = backend.web ? ({ ok: true } as const) : currentTerminalAccess();

  return (
    <div className="ide-terminal flex h-full min-h-0 flex-col border-t">
      <div className="term-line flex h-8 shrink-0 items-center gap-2 overflow-hidden whitespace-nowrap border-b px-3 text-[12px]">
        <TerminalSquare size={13} className="shrink-0" />
        <span className="shrink-0 font-medium">Terminal</span>
        <span className="term-faint min-w-0 truncate max-sm:hidden">
          · you only · sandboxed
          {computerName ? (
            <>
              {" "}· <Laptop size={11} className="inline" /> {computerName}
            </>
          ) : null}
        </span>
        {cwd ? <span className="term-dim min-w-0 truncate font-mono">{cwd}</span> : null}
        <div className="flex-1" />
        <button type="button" className="term-hover rounded px-1.5 py-0.5" onClick={onClose} title="Close (Ctrl+`)" aria-label="Close the terminal">
          <X size={12} />
        </button>
      </div>

      {desktop ? (
        <TerminalDesktopNote />
      ) : status.error ? (
        <QueryError error={status.error} retry={() => void status.refetch()}>
          <a href="/settings#devices" className="text-accent underline">Set up a paired computer</a>
        </QueryError>
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
      ) : (
        <div className="flex min-h-0 flex-1 flex-col font-mono text-[12.5px] leading-[1.55]" style={fontSize ? { fontSize: `${fontSize}px` } : undefined} onClick={() => field.current?.focus()}>
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
