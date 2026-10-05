"use client";

import { useEffect, useState } from "react";

type Column = "proposed" | "you" | "agent" | "needs" | "done";
type Card = { id: string; title: string; source: string };
type Frame = Record<string, { col: Column; status?: string }>;

const CARDS: Card[] = [
  { id: "priya", title: "Reply to Priya with the p95 numbers", source: "Mail · due today" },
  { id: "adr", title: "Write the ranker ADR", source: "Design review · you agreed" },
  { id: "retry", title: "Bump the retry library in service-x", source: "GitHub · issue #212" },
];

// One morning, start to finish. Each frame is a beat of the story.
const FRAMES: Frame[] = [
  { priya: { col: "proposed" }, adr: { col: "proposed" }, retry: { col: "proposed" } },
  { priya: { col: "agent", status: "Gathering context" }, adr: { col: "proposed" }, retry: { col: "proposed" } },
  { priya: { col: "agent", status: "Drafting in your tone" }, adr: { col: "you" }, retry: { col: "proposed" } },
  { priya: { col: "agent", status: "Drafting in your tone" }, adr: { col: "you" }, retry: { col: "agent", status: "Reading the repo" } },
  { priya: { col: "needs", status: "Draft ready" }, adr: { col: "you" }, retry: { col: "agent", status: "Running tests" } },
  { priya: { col: "done", status: "Sent" }, adr: { col: "you" }, retry: { col: "agent", status: "Running tests" } },
  { priya: { col: "done", status: "Sent" }, adr: { col: "you" }, retry: { col: "needs", status: "PR ready to open" } },
  { priya: { col: "done", status: "Sent" }, adr: { col: "you" }, retry: { col: "done", status: "PR opened" } },
];

const STILL_FRAME = 4;
const BEAT_MS = 2300;

const COLUMNS: { col: Exclude<Column, "proposed">; label: string }[] = [
  { col: "you", label: "You" },
  { col: "agent", label: "Agent" },
  { col: "needs", label: "Needs you" },
];

export function LiveBoard() {
  const [frame, setFrame] = useState(STILL_FRAME);
  const [animate, setAnimate] = useState(false);

  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (reduce.matches) return;
    setAnimate(true);
    setFrame(0);
    const timer = window.setInterval(() => {
      if (document.hidden) return;
      setFrame((f) => (f + 1) % FRAMES.length);
    }, BEAT_MS);
    return () => window.clearInterval(timer);
  }, []);

  const state = FRAMES[frame];
  const inCol = (col: Column) => CARDS.filter((c) => state[c.id].col === col || (col === "needs" && state[c.id].col === "done"));
  const proposed = inCol("proposed");

  return (
    <div className={`board ${animate ? "is-live" : ""}`} role="img" aria-label="A task board where proposed todos are assigned to you or the agent, and the agent's finished drafts wait in Needs you for approval.">
      <div className="board-chrome">
        <span className="dot" />
        <span className="dot" />
        <span className="dot" />
        <span className="board-title">Today · Monday</span>
        <span className="board-sync">
          <span className="pulse" /> Read 14 emails, 2 meetings, 3 PRs overnight
        </span>
      </div>

      <div className="briefing">
        <div className="briefing-head">
          <span className="eyebrow">Morning briefing</span>
          <span className="faint">{proposed.length ? `${proposed.length} proposed` : "Triage done"}</span>
        </div>
        <ul className="briefing-list">
          {proposed.map((card) => (
            <li key={`${card.id}-p`} className="proposal enter">
              <div>
                <div className="card-title">{card.title}</div>
                <div className="card-source">{card.source}</div>
              </div>
              <div className="choices">
                <span>I&apos;ll do it</span>
                <span className="choice-agent">Agent</span>
              </div>
            </li>
          ))}
          {!proposed.length && <li className="proposal empty enter">Nothing waiting. Two focus blocks left today.</li>}
        </ul>
      </div>

      <div className="lanes">
        {COLUMNS.map(({ col, label }) => (
          <div key={col} className={`lane lane-${col}`}>
            <div className="lane-head">
              <span className={`lane-dot lane-dot-${col}`} />
              {label}
              <span className="faint">{inCol(col).length}</span>
            </div>
            {inCol(col).map((card) => {
              const { col: at, status } = state[card.id];
              return (
                <div key={`${card.id}-${at}`} className={`task enter ${at === "done" ? "task-done" : ""}`}>
                  <div className="card-title">{card.title}</div>
                  {status && (
                    <div key={status} className={`status status-${at} fade`}>
                      {at === "agent" && <span className="spinner" />}
                      {at === "done" && <span className="check">✓</span>}
                      {status}
                    </div>
                  )}
                  {at === "needs" && (
                    <div className="approve">
                      <span className="btn-approve">Approve</span>
                      <span>Edit</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
