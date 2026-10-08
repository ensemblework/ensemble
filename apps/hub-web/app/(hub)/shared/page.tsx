"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { ArrowUpRight, BookOpen, Briefcase, CalendarCheck, CheckSquare, Columns3, FileText, FolderGit2, LineChart, Users, Workflow } from "lucide-react";
import { api, type ShareKind } from "@/lib/api";
import { switchSpace } from "@/lib/spaces";
import { Avatar } from "@/components/sharing/people";
import { SpaceIcon } from "@/components/shell/space-switcher";
import { PageHeader, SkeletonRows } from "@/components/ui";

const ICON: Record<ShareKind, typeof FileText> = {
  page: FileText,
  task: CheckSquare,
  board: Columns3,
  diagram: Workflow,
  plot_space: LineChart,
  plot: LineChart,
  meeting: CalendarCheck,
  skill: BookOpen,
  workspace: Briefcase,
  code: FolderGit2,
};

const LABEL: Record<ShareKind, string> = {
  page: "Page",
  task: "Task",
  board: "Board",
  diagram: "Diagram",
  plot_space: "Plot space",
  plot: "Plot",
  meeting: "Meeting notes",
  skill: "Skill",
  workspace: "Workspace",
  code: "Code",
};

function since(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  return days <= 0 ? "today" : days === 1 ? "yesterday" : days < 30 ? `${days} days ago` : new Date(iso).toLocaleDateString();
}

/** Everything other people shared with you: whole spaces, and single items. */
export default function SharedWithYouPage() {
  const data = useQuery({ queryKey: ["shared-with-me"], queryFn: api.sharedWithMe });
  const spaces = data.data?.spaces ?? [];
  const items = data.data?.items ?? [];
  return (
    <div className="mx-auto w-full max-w-[1000px] px-6 pb-16 pt-8">
      <PageHeader title="Shared with you" description="Spaces and items people shared with you. Their settings, keys and connected apps stay theirs; your own stay yours." />
      {data.isLoading ? <SkeletonRows count={4} /> : null}
      {data.isSuccess && !spaces.length && !items.length ? (
        <div className="mt-10 rounded-xl border border-dashed border-line px-6 py-12 text-center">
          <Users size={26} className="mx-auto text-faint" />
          <p className="mt-3 text-[14px] font-medium">Nothing is shared with you yet</p>
          <p className="mx-auto mt-1 max-w-sm text-[13px] text-muted">When someone shares a space, a page or a diagram with you, it shows up here, and you'll get a notification.</p>
        </div>
      ) : null}

      {spaces.length ? (
        <section className="mt-8">
          <h2 className="mb-3 text-[12px] font-medium uppercase tracking-wide text-faint">Spaces</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            {spaces.map((space) => (
              <button
                key={space.id}
                type="button"
                onClick={() => void switchSpace(space.id, "/board")}
                className="group flex items-center gap-3 rounded-xl border border-line bg-panel/50 p-4 text-left transition-colors hover:border-line-strong hover:bg-panel"
              >
                <SpaceIcon space={space} size={40} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-[15px] font-semibold">{space.name}</span>
                    <span className="rounded border border-line px-1 text-[10px] text-faint">Shared</span>
                  </span>
                  <span className="mt-1 flex items-center gap-1.5 text-[12px] text-muted">
                    <Avatar person={space.owner} size={16} />
                    {space.owner.name} · you {space.role === "editor" ? "can edit" : "can view"} · since {since(space.since)}
                  </span>
                </span>
                <ArrowUpRight size={16} className="text-faint transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
              </button>
            ))}
          </div>
        </section>
      ) : null}

      {items.length ? (
        <section className="mt-8">
          <h2 className="mb-3 text-[12px] font-medium uppercase tracking-wide text-faint">Items</h2>
          <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
            {items.map((item) => {
              const Icon = ICON[item.kind];
              return (
                <Link
                  key={item.id}
                  href={`/shared/${item.id}`}
                  className="group flex flex-col rounded-xl border border-line bg-panel/40 p-3.5 transition-colors hover:border-line-strong hover:bg-panel"
                >
                  <span className="flex items-center gap-1.5 text-2xs text-muted">
                    <Icon size={12} /> {LABEL[item.kind]}
                    {!item.openedAt ? <span className="ml-auto rounded bg-accent-soft px-1.5 text-[10px] font-medium text-ink">New</span> : null}
                  </span>
                  <span className="mt-2 line-clamp-2 text-[14px] font-medium leading-5">{item.title}</span>
                  <span className="mt-auto flex items-center gap-1.5 pt-3 text-2xs text-muted">
                    <Avatar person={item.owner} size={16} />
                    <span className="truncate">
                      {item.owner.name.split(" ")[0]} · {item.role === "edit" ? "can edit" : "view only"} · {since(item.since)}
                    </span>
                  </span>
                </Link>
              );
            })}
          </div>
        </section>
      ) : null}
    </div>
  );
}
