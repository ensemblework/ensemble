"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { PageHeader } from "@/components/ui";
import { useToast } from "@/components/toast";
import { api } from "@/lib/api";

export default function RecapPage() {
  const toast = useToast();
  const recap = useQuery({ queryKey: ["weekly-recap"], queryFn: () => api.weeklyRecap() });
  const [copied, setCopied] = useState(false);
  const data = recap.data;

  const copy = async () => {
    if (!data) return;
    try {
      await navigator.clipboard.writeText(data.markdown);
      setCopied(true);
      toast("Copied the week.");
    } catch {
      toast("Could not copy. Select the text instead.", { tone: "error" });
    }
  };

  const download = () => {
    if (!data) return;
    const blob = new Blob([data.markdown], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `ensemble-week-${data.start}.md`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="page-read mx-auto max-w-[760px] px-6 pb-24 pt-8">
      <PageHeader
        title="Weekly recap"
        description={data ? data.label : "What got done, what was decided, and what slipped."}
        actions={
          <div className="flex gap-2">
            <button type="button" className="btn" onClick={() => void copy()} disabled={!data}>
              {copied ? "Copied" : "Copy"}
            </button>
            <button type="button" className="btn-ghost" onClick={download} disabled={!data}>
              Download
            </button>
          </div>
        }
      />
      {!data ? <p className="text-[13px] text-muted">Loading the week…</p> : null}
      {data ? (
        <div className="space-y-6">
          <Section title="Done" empty="Nothing was marked done." rows={data.done} />
          <Section title="Decided" empty="No decisions were recorded." rows={data.decided} />
          <Section title="Slipped" empty="Nothing past due is still open." rows={data.slipped} />
          <section>
            <h2 className="text-[15px] font-semibold">Meetings</h2>
            {data.meetings.length === 0 ? <p className="mt-1 text-[13px] text-muted">No meeting recaps this week.</p> : null}
            <ul className="mt-2 space-y-3">
              {data.meetings.map((meeting) => (
                <li key={meeting.href} className="rounded-xl border border-line px-3 py-2">
                  <Link href={meeting.href} className="text-[13.5px] font-medium hover:underline">
                    {meeting.title}
                  </Link>
                  <div className="text-[12px] text-muted">{meeting.when}</div>
                  {meeting.summary ? <p className="mt-1 text-[13px] leading-5">{meeting.summary}</p> : null}
                </li>
              ))}
            </ul>
          </section>
        </div>
      ) : null}
    </div>
  );
}

function Section({ title, empty, rows }: { title: string; empty: string; rows: Array<{ title: string; href: string; detail?: string }> }) {
  return (
    <section>
      <h2 className="text-[15px] font-semibold">{title}</h2>
      {rows.length === 0 ? <p className="mt-1 text-[13px] text-muted">{empty}</p> : null}
      <ul className="mt-2 space-y-1.5">
        {rows.map((row) => (
          <li key={`${row.href}-${row.title}`}>
            <Link href={row.href} className="record-row text-[13.5px] hover:border-line-strong">
              <span className="min-w-0 flex-1 truncate">{row.title}</span>
              {row.detail ? <span className="text-[12px] text-muted">{row.detail}</span> : null}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
