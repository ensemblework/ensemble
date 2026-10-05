"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { api, type AskSource } from "@/lib/api";
import { plural } from "@/lib/format";
import { SearchQuery } from "@/components/motion/search-query";
import { useToast } from "../toast";

type Remembered = { answer: string; sources: AskSource[]; undoId: string | null };

export function AskBar() {
  const toast = useToast();
  const client = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const remembered = useRef(new Map<string, Remembered>());
  const [question, setQuestion] = useState("");
  const [open, setOpen] = useState(false);
  const [answer, setAnswer] = useState("");
  const [sources, setSources] = useState<AskSource[]>([]);
  const [undoId, setUndoId] = useState<string | null>(null);

  const undo = () => {
    if (!undoId) return;
    const entryId = undoId;
    void api
      .undo(entryId)
      .then(() => {
        setUndoId(null);
        setAnswer((current) => (current.endsWith("Undone.") ? current : `${current} Undone.`));
        void client.invalidateQueries({ queryKey: ["desk-live"] });
      })
      .catch((error: Error) => toast(error.message, { tone: "error" }));
  };

  useEffect(() => {
    const focus = () => {
      setOpen(true);
      input.current?.focus();
    };
    window.addEventListener("ensemble:ask", focus);
    return () => window.removeEventListener("ensemble:ask", focus);
  }, []);

  const ask = useMutation({
    mutationFn: (key: string) => api.ask(key),
    onSuccess: (result, key) => {
      const row: Remembered = { answer: result.answer, sources: result.sources, undoId: result.undoEntryId ?? null };
      remembered.current.set(key, row);
      setAnswer(row.answer);
      setSources(row.sources);
      setUndoId(row.undoId);
      setOpen(true);
      if (result.undoEntryId) {
        const entryId = result.undoEntryId;
        toast(result.answer, {
          action: {
            label: "Undo",
            run: () => {
              void api
                .undo(entryId)
                .then(() => {
                  setUndoId(null);
                  setAnswer((current) => (current.endsWith("Undone.") ? current : `${current} Undone.`));
                  void client.invalidateQueries({ queryKey: ["desk-live"] });
                })
                .catch((error: Error) => toast(error.message, { tone: "error" }));
            },
          },
        });
        void client.invalidateQueries({ queryKey: ["desk-live"] });
      }
    },
    onError: (error) => toast((error as Error).message, { tone: "error" }),
  });

  function run() {
    const key = question.trim();
    if (!key) return;
    const hit = remembered.current.get(key);
    if (hit) {
      setAnswer(hit.answer);
      setSources(hit.sources);
      setUndoId(hit.undoId);
      setOpen(true);
      return;
    }
    ask.mutate(key);
  }

  const settled = Boolean(answer) && !ask.isPending;
  const show = open && (ask.isPending || Boolean(answer));
  // A write with nothing to cite still needs its answer and Undo. An empty source list used to hide both.
  const answerRow = Boolean(answer) && (sources.length > 0 || Boolean(undoId));
  const count = !show || ask.isPending ? null : answerRow ? sources.length + 1 : 0;

  return (
    <SearchQuery
      className="relative min-w-[140px] max-w-[360px] flex-1"
      pill
      overlay
      inputRef={input}
      value={question}
      onValue={(next) => {
        setQuestion(next);
        if (!next.trim()) {
          setAnswer("");
          setSources([]);
          setUndoId(null);
        }
      }}
      onSubmit={run}
      onFocus={() => {
        if (answer) setOpen(true);
      }}
      placeholder="Ask Ensemble"
      label="Ask Ensemble"
      pending={ask.isPending}
      count={show ? count : null}
      list={show && settled && count !== null && count > 0}
      panelExtra={
        <div className="mb-1 flex justify-end">
          <button type="button" className="btn-ghost py-0 text-[12px]" onClick={() => setOpen(false)}>
            Close
          </button>
        </div>
      }
      status={ask.isPending ? "Looking through your data…" : sources.length ? plural(sources.length, "source") : "Answer"}
      emptyTitle={answer && !answerRow ? answer : question.trim() ? `Nothing came back for “${question.trim()}”.` : "Nothing came back."}
      emptyHint="Try fewer words, or name a person, a task, or a doc."
      results={
        <>
          {answerRow ? (
            <li className="sq-item" role="option" style={{ ["--i" as string]: 0 }}>
              <p className="m-0 min-w-0 flex-1 text-[13px] leading-5">{answer}</p>
              {undoId ? (
                <button type="button" className="btn h-7 shrink-0 px-2 text-[12px]" data-ask-undo onClick={undo}>
                  Undo
                </button>
              ) : null}
            </li>
          ) : null}
          {sources.map((source, index) => (
            <li key={`${source.kind}-${source.id}`} className="sq-item" role="option" style={{ ["--i" as string]: index + 1 }}>
              <Link href={source.path} className="min-w-0 flex-1" onClick={() => setOpen(false)}>
                <div className="text-[12.5px] font-medium">{source.label}</div>
                {source.excerpt ? <div className="line-clamp-2 text-[12px] text-muted">{source.excerpt}</div> : null}
              </Link>
            </li>
          ))}
        </>
      }
    />
  );
}
