"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useToast } from "../toast";

export function StaleNudges() {
  const client = useQueryClient();
  const toast = useToast();
  const nudges = useQuery({ queryKey: ["nudges"], queryFn: api.nudges });
  const rows = nudges.data?.nudges ?? [];
  const act = useMutation({
    mutationFn: (input: { id: string; action: "keep" | "snooze" | "done" | "trash" }) => api.nudge(input.id, input.action),
    onSuccess: (_result, input) => {
      const text = { keep: "Kept.", snooze: "Snoozed for a week.", done: "Marked done.", trash: "Moved to Trash." }[input.action];
      toast(text);
      void client.invalidateQueries({ queryKey: ["nudges"] });
      void client.invalidateQueries({ queryKey: ["tasks"] });
    },
    onError: (error) => toast((error as Error).message, { tone: "error" }),
  });
  if (!rows.length) return null;
  return (
    <section id="still-relevant" className="mt-8 scroll-mt-6">
      <p className="mb-2 text-[13px] text-muted">Quiet items, and due items that have not been started.</p>
      <ul className="space-y-2">
        {rows.map((row) => (
          <li key={row.id} className="rounded-xl border border-line bg-panel/70 px-3 py-2.5">
            <div className="text-[13.5px] font-medium">{row.title}</div>
            <p className="mt-0.5 text-[12.5px] text-muted">{row.question}</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {(["keep", "snooze", "done", "trash"] as const).map((action) => (
                <button key={action} type="button" className="btn-ghost capitalize" onClick={() => act.mutate({ id: row.id, action })}>
                  {action === "trash" ? "Trash" : action === "done" ? "Done" : action === "keep" ? "Keep" : "Snooze"}
                </button>
              ))}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
