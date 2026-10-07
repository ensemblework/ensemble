"use client";

import { useQuery } from "@tanstack/react-query";
import { ExternalLink, FileText, GitPullRequest, Mail, MessageSquare, NotebookPen, Video } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { api } from "@/lib/api";
import { dateTime, plural, relative } from "@/lib/format";
import { Empty, Spinner, Tag } from "../ui";

/** The official place each source lives. Links always go there, never to a pasted copy. */
const OFFICIAL: Record<string, { label: string; url: string }> = {
  gmail: { label: "Gmail", url: "https://mail.google.com" },
  google_calendar: { label: "Google Calendar", url: "https://calendar.google.com" },
  outlook: { label: "Outlook", url: "https://outlook.office.com/mail" },
  outlook_calendar: { label: "Outlook calendar", url: "https://outlook.office.com/calendar" },
  teams: { label: "Teams", url: "https://teams.microsoft.com" },
  github: { label: "GitHub", url: "https://github.com/notifications" },
  slack: { label: "Slack", url: "https://app.slack.com" },
  linear: { label: "Linear", url: "https://linear.app" },
  meeting_notes: { label: "Meeting notes", url: "/context?tab=artifacts" },
};

const KINDS: Array<{ id: string; label: string; icon: typeof Mail }> = [
  { id: "email", label: "Email", icon: Mail },
  { id: "chat_msg", label: "Teams & chat", icon: MessageSquare },
  { id: "channel_msg", label: "Channels", icon: MessageSquare },
  { id: "meeting_note", label: "Meeting notes", icon: NotebookPen },
  { id: "transcript", label: "Transcripts", icon: Video },
  { id: "pr", label: "Pull requests", icon: GitPullRequest },
  { id: "issue", label: "Issues", icon: GitPullRequest },
  { id: "file", label: "Files", icon: FileText },
];

export function SourcesTab() {
  const [kind, setKind] = useState("email");
  const connections = useQuery({ queryKey: ["connections"], queryFn: api.connections });
  const artifacts = useQuery({ queryKey: ["artifacts", kind], queryFn: () => api.artifacts({ kind }) });
  const counts = new Map((artifacts.data?.counts ?? []).map((row) => [row.kind, row.count]));

  return (
    <div className="space-y-8">
      <section>
        <h3 className="mb-1 text-[15px] font-semibold">Connected sources</h3>
        <p className="mb-3 text-[12.5px] text-muted">
          Every item links back to where it lives, the email in your mail client, the thread in Teams, the PR on GitHub.
        </p>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-2">
          {(connections.data?.connections ?? []).map((row) => (
            <div key={row.id} className="tile rounded-md bg-panel px-3 py-2.5 text-[13px]">
              <div className="flex items-center justify-between">
                <span className="font-semibold">{row.label}</span>
                <Tag tone={!row.enabled ? "gray" : row.needsAttention ? "red" : "green"}>
                  {!row.enabled ? "off" : row.needsAttention ? "needs attention" : "on"}
                </Tag>
              </div>
              <div className="mt-1 text-[12px] text-muted">
                {plural(row.itemCount, "item")} · synced {relative(row.lastSyncAt)}
              </div>
              <div className="mt-2 flex items-center gap-3 text-[12px]">
                {OFFICIAL[row.id] ? (
                  <a
                    href={OFFICIAL[row.id]!.url}
                    target={OFFICIAL[row.id]!.url.startsWith("http") ? "_blank" : undefined}
                    rel="noreferrer"
                    className="flex items-center gap-1 text-accent hover:underline"
                  >
                    Open {OFFICIAL[row.id]!.label} <ExternalLink size={11} />
                  </a>
                ) : null}
                <Link href="/settings#connections" className="text-muted hover:text-ink">
                  Settings
                </Link>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section>
        <div className="mb-3 flex flex-wrap items-center gap-1">
          {KINDS.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setKind(item.id)}
              className={`row-tile flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[13px] ${kind === item.id ? "bg-hover font-medium" : "text-muted"}`}
            >
              <item.icon size={13} />
              {item.label}
              <span className="text-2xs text-faint">{counts.get(item.id) ?? 0}</span>
            </button>
          ))}
        </div>
        {artifacts.isLoading ? (
          <Spinner />
        ) : (artifacts.data?.artifacts ?? []).length === 0 ? (
          <Empty>Nothing of this kind has been ingested yet.</Empty>
        ) : (
          <div className="divide-y divide-[var(--line)] rounded-md border border-line">
            {artifacts.data!.artifacts.map((artifact) => (
              <div key={artifact.id} className="row-tile flex items-center gap-3 px-3 py-2 text-[13px]">
                <span className="min-w-0 flex-1 truncate font-medium">{artifact.title || "(untitled)"}</span>
                <span className="shrink-0 text-[12px] text-muted">{dateTime(artifact.ts)}</span>
                {artifact.url ? (
                  <a href={artifact.url} target="_blank" rel="noreferrer" className="flex shrink-0 items-center gap-1 text-[12px] text-accent hover:underline">
                    Open original <ExternalLink size={11} />
                  </a>
                ) : (
                  <span className="shrink-0 text-[12px] text-faint">no link</span>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
