"use client";

import { ChevronDown, Search, X } from "lucide-react";
import { useDeferredValue, useId, useMemo, useState } from "react";
import type { TranscriptLine } from "@/lib/api-meetings";

const SPEAKER_TONES = ["var(--kind-project)", "var(--kind-people)", "var(--kind-repo)", "var(--kind-deliverable)", "var(--kind-task)", "var(--kind-artifact)"];

/** Each speaker keeps one colour for the whole transcript, in order of first appearance. */
export function speakerTones(lines: readonly TranscriptLine[]): Map<string, string> {
  const tones = new Map<string, string>();
  for (const line of lines) if (line.speaker && !tones.has(line.speaker)) tones.set(line.speaker, SPEAKER_TONES[tones.size % SPEAKER_TONES.length]!);
  return tones;
}

/** Matches of `query` in `text`, case-insensitive, as alternating plain and marked parts. */
export function marked(text: string, query: string): Array<{ text: string; hit: boolean }> {
  const wanted = query.trim().toLowerCase();
  if (!wanted) return [{ text, hit: false }];
  const parts: Array<{ text: string; hit: boolean }> = [];
  const lower = text.toLowerCase();
  let from = 0;
  for (let at = lower.indexOf(wanted); at >= 0; at = lower.indexOf(wanted, at + wanted.length)) {
    if (at > from) parts.push({ text: text.slice(from, at), hit: false });
    parts.push({ text: text.slice(at, at + wanted.length), hit: true });
    from = at + wanted.length;
  }
  if (from < text.length) parts.push({ text: text.slice(from), hit: false });
  return parts;
}

/**
 * The whole transcript of a meeting: speaker-labelled, timestamped turns behind a disclosure,
 * with a search that keeps only the turns that match (by words or by speaker).
 */
export function TranscriptView({ lines, defaultOpen = false }: { lines: readonly TranscriptLine[]; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const [query, setQuery] = useState("");
  const deferred = useDeferredValue(query);
  const id = useId();
  const tones = useMemo(() => speakerTones(lines), [lines]);
  const wanted = deferred.trim().toLowerCase();
  const shown = useMemo(
    () => (wanted ? lines.filter((line) => line.text.toLowerCase().includes(wanted) || line.speaker.toLowerCase().includes(wanted)) : lines),
    [lines, wanted],
  );
  if (!lines.length) return null;
  return (
    <section className="transcript" aria-labelledby={`${id}-title`}>
      <button type="button" className="transcript-toggle" aria-expanded={open} aria-controls={`${id}-body`} onClick={() => setOpen((value) => !value)}>
        <ChevronDown size={15} className="transcript-chevron" aria-hidden />
        <span id={`${id}-title`} className="font-semibold">Transcript</span>
        <span className="text-muted">
          {lines.length.toLocaleString()} {lines.length === 1 ? "turn" : "turns"} · {tones.size} {tones.size === 1 ? "speaker" : "speakers"}
        </span>
      </button>
      {open ? (
        <div id={`${id}-body`} className="transcript-body">
          <div className="transcript-search">
            <Search size={14} aria-hidden />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search the transcript…" aria-label="Search the transcript" onKeyDown={(event) => { if (event.key === "Escape" && query) { event.stopPropagation(); setQuery(""); } }} />
            {query ? (
              <>
                <span className="transcript-count" aria-live="polite">{shown.length ? `${shown.length} ${shown.length === 1 ? "turn" : "turns"}` : "No matches"}</span>
                <button type="button" className="icon-btn size-6" aria-label="Clear search" onClick={() => setQuery("")}><X size={13} /></button>
              </>
            ) : null}
          </div>
          <ol className="transcript-lines" tabIndex={0} aria-label="Transcript turns">
            {shown.map((line, index) => (
              <li key={`${line.at ?? ""}-${index}`} className="transcript-line">
                <div className="transcript-who">
                  {line.speaker ? <span className="transcript-speaker" style={{ ["--speaker" as string]: tones.get(line.speaker) }}>{marked(line.speaker, wanted).map((part, at) => (part.hit ? <mark key={at}>{part.text}</mark> : part.text))}</span> : null}
                  {line.at ? <time className="transcript-at">{line.at}</time> : null}
                </div>
                <p>{marked(line.text, wanted).map((part, at) => (part.hit ? <mark key={at}>{part.text}</mark> : part.text))}</p>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </section>
  );
}
