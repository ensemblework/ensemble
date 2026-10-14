"use client";
/* Branded 404 / 500 / offline body. Import "./brand-pages.css" once (or paste it into globals.css). */
import Link from "next/link";
import { EnsembleMark } from "./Logo";


export type BrandStatusKind = "404" | "500" | "offline";

const COPY: Record<BrandStatusKind, { code: string; h: string; p: string; art: string }> = {
  "404": {
    "code": "404",
    "h": "This thread doesn’t lead anywhere.",
    "p": "The page may have moved, or the link was cut short. Your work is where you left it.",
    "art": "Ensemble Woven Chorus"
  },
  "500": {
    "code": "500 · error",
    "h": "We dropped a stitch.",
    "p": "Something broke on our side. Try again in a moment.",
    "art": "Ensemble Woven Chorus"
  },
  "offline": {
    "code": "offline",
    "h": "You’re offline.",
    "p": "Check your connection, then try again.",
    "art": "Ensemble Woven Chorus"
  }
};

function Art({ kind }: { kind: BrandStatusKind }) {
  return <div className="ub-art" data-status={kind}><EnsembleMark size={160} title="Ensemble" /></div>;
}

export function BrandStatus({ kind, reset, shell = false }: { kind: BrandStatusKind; reset?: () => void; shell?: boolean }) {
  const c = COPY[kind];
  const card = (
    <div className="ub-card">
      <Art kind={kind} />
      <p className="ub-code">{c.code}</p>
      <h1 className="ub-h">{c.h}</h1>
      <p className="ub-p">{c.p}</p>
      <div className="ub-act">
        {kind === "404" ? (<><Link className="ub-btn pri" href="/today">Go to Today</Link><button type="button" className="ub-btn" onClick={() => history.back()}>Go back</button></>) : null}
        {kind === "500" ? (<><button type="button" className="ub-btn pri" onClick={() => (reset ? reset() : location.reload())}>Try again</button><Link className="ub-btn" href="/today">Go to Today</Link></>) : null}
        {kind === "offline" ? <button type="button" className="ub-btn pri" onClick={() => location.reload()}>Try again</button> : null}
      </div>
    </div>
  );
  if (shell) {
    return (
      <div className="ub ub-shell">
        <div className="ub-main">{card}</div>
      </div>
    );
  }
  return (
    <div className="ub">
      <header className="ub-top">
        <Link className="ub-brand" href="/today" aria-label="Ensemble home"><EnsembleMark size={20} /><span>Ensemble</span></Link>
      </header>
      <main className="ub-main">{card}</main>
      <footer className="ub-foot">Ensemble · A shared workspace for you and your agent.</footer>
    </div>
  );
}
