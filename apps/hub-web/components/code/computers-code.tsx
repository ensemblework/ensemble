"use client";

import { useQuery } from "@tanstack/react-query";
import { FolderGit2, Laptop, TerminalSquare } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Terminal } from "@/components/code/terminal";
import { QueryError, SkeletonRows, Tag } from "@/components/ui";
import { api } from "@/lib/api";
import { deviceCodeApi } from "@/lib/code-target";
import { dateTime } from "@/lib/format";

type Computer = Awaited<ReturnType<typeof api.devices>>["devices"][number];

type Caps = { code?: boolean; browseFiles?: boolean; webEdit?: boolean; webTerminal?: boolean };

function capsOf(device: Computer): Caps {
  return (device.capabilities ?? {}) as Caps;
}

/**
 * The Code tab on Ensemble on the web, computer by computer (protocol 4, docs/16): each paired
 * computer's reviews and repositories, read from that computer, opening in the same editor the Code tab
 * has on the computer itself, and its terminal (unlocked with a passkey here).
 */
export function ComputersCode() {
  const devices = useQuery({ queryKey: ["devices"], queryFn: api.devices, staleTime: 30_000 });
  const [terminal, setTerminal] = useState<string | null>(null);
  if (devices.isLoading) return <SkeletonRows count={2} />;
  if (devices.error) return <QueryError error={devices.error} retry={() => void devices.refetch()} />;
  const paired = devices.data?.devices ?? [];
  if (!paired.length) return null;
  return (
    <div className="mb-8 space-y-4" data-testid="computers-code">
      {paired.map((device) => (
        <ComputerCode key={device.id} device={device} terminalOpen={terminal === device.id} onTerminal={(open) => setTerminal(open ? device.id : null)} />
      ))}
    </div>
  );
}

function ComputerCode({ device, terminalOpen, onTerminal }: { device: Computer; terminalOpen: boolean; onTerminal: (open: boolean) => void }) {
  const caps = capsOf(device);
  const usable = device.online && caps.code === true && caps.browseFiles !== false;
  const code = deviceCodeApi(device.id);
  const reviews = useQuery({ queryKey: ["reviews", `device:${device.id}`, "all"], queryFn: () => code.reviews("all", false), enabled: usable, retry: false, staleTime: 15_000 });
  const repos = useQuery({ queryKey: ["code-repos", `device:${device.id}`], queryFn: () => code.codeRepos(), enabled: usable, retry: false, staleTime: 60_000 });
  const why = !device.online
    ? "Offline. Open Ensemble there, or start it with `ensemble runner start`."
    : caps.code !== true
      ? "Update Ensemble there to review and edit its code from here (the CLI 0.3.8 or the desktop app 0.3.5)."
      : caps.browseFiles === false
        ? "Showing code on the web is turned off there (`ensemble browse on`)."
        : null;
  return (
    <section className="rounded-lg border border-line" data-testid={`computer-code-${device.id}`}>
      <header className="flex items-center gap-2 border-b border-line px-3 py-2">
        <Laptop size={14} className="text-muted" />
        <span className="font-semibold">{device.name}</span>
        <span className={device.online ? "text-[12px] text-ok" : "text-[12px] text-faint"}>{device.online ? "online" : "offline"}</span>
        {usable && caps.webEdit === false ? <Tag tone="gray">view only</Tag> : null}
        <div className="flex-1" />
        {usable && caps.webTerminal !== false ? (
          <button type="button" className="btn gap-1 px-2 py-0.5 text-[12px]" onClick={() => onTerminal(!terminalOpen)} title="The terminal on this computer, unlocked with your passkey">
            <TerminalSquare size={12} /> Terminal
          </button>
        ) : null}
      </header>
      {why ? (
        <div className="px-3 py-2.5 text-[12.5px] text-muted">{why}</div>
      ) : (
        <div className="grid gap-4 p-3 md:grid-cols-2">
          <div>
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-faint">Agent changes to review</div>
            {reviews.isLoading ? (
              <SkeletonRows count={2} />
            ) : reviews.error ? (
              <div className="text-[12.5px] text-danger">{(reviews.error as Error).message}</div>
            ) : (reviews.data?.reviews ?? []).length === 0 ? (
              <div className="text-[12.5px] text-muted">No agent changes kept on this computer.</div>
            ) : (
              <ul className="space-y-0.5">
                {reviews.data!.reviews.slice(0, 12).map((review) => (
                  <li key={review.id}>
                    <Link href={`/code/review?device=${encodeURIComponent(device.id)}&review=${review.id}`} className="row-tile flex items-center gap-2 rounded px-1.5 py-1 text-[12.5px]">
                      <span className="min-w-0 flex-1 truncate font-medium">{review.title}</span>
                      <span className="shrink-0 text-[11px]">
                        <span className="text-ok">+{review.added}</span> <span className="text-danger">−{review.removed}</span>
                      </span>
                      <Tag tone={review.completedAt ? "green" : "blue"}>{review.completedAt ? "Reviewed" : "To review"}</Tag>
                    </Link>
                    <div className="truncate px-1.5 text-[11px] text-faint">
                      {review.repoPath.split("/").slice(-2).join("/")} · {review.branch} · {dateTime(review.createdAt)}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-faint">Repositories</div>
            {repos.isLoading ? (
              <SkeletonRows count={2} />
            ) : repos.error ? (
              <div className="text-[12.5px] text-danger">{(repos.error as Error).message}</div>
            ) : (repos.data?.repos ?? []).length === 0 ? (
              <div className="text-[12.5px] text-muted">No git checkouts in the folders Code may use there.</div>
            ) : (
              <ul className="space-y-0.5">
                {repos.data!.repos.slice(0, 20).map((repo) => (
                  <li key={repo}>
                    <Link href={`/code/review?device=${encodeURIComponent(device.id)}&repo=${encodeURIComponent(repo)}`} className="row-tile flex items-center gap-2 rounded px-1.5 py-1 text-[12.5px]" title={repo}>
                      <FolderGit2 size={12} className="shrink-0 text-muted" />
                      <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{repo.split("/").slice(-2).join("/")}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
      {terminalOpen ? <Terminal target={{ kind: "device", deviceId: device.id }} onClose={() => onTerminal(false)} /> : null}
    </section>
  );
}
