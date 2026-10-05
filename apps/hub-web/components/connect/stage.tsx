import type { ReactNode } from "react";
import type { Scene } from "@/lib/connect/guides";

/** A small fake window that shows where to click. Decorative; the step text is the accessible instruction. */
export function Stage({ scene, hotspot }: { scene: Scene; hotspot: string }) {
  return (
    <div className="connect-stage tile overflow-hidden rounded-xl bg-panel" aria-hidden>
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <span className="h-2 w-2 rounded-full bg-danger/80" />
        <span className="h-2 w-2 rounded-full bg-warn/80" />
        <span className="h-2 w-2 rounded-full bg-ok/80" />
        <span className="ml-2 truncate text-[11px] text-faint">{titleFor(scene)}</span>
      </div>
      <div className="relative min-h-[240px] p-4">
        {scene === "key" ? <KeyScene hotspot={hotspot} /> : null}
        {scene === "terminal" ? <TerminalScene hotspot={hotspot} /> : null}
        {scene === "menu" ? <MenuScene hotspot={hotspot} /> : null}
        {scene === "paste" ? <PasteScene hotspot={hotspot} /> : null}
        {scene === "chat" ? <ChatScene hotspot={hotspot} /> : null}
        {scene === "test" ? <LinkScene live={false} hotspot={hotspot} /> : null}
        {scene === "success" ? <LinkScene live hotspot={hotspot} /> : null}
      </div>
    </div>
  );
}

function titleFor(scene: Scene): string {
  if (scene === "terminal") return "Terminal";
  if (scene === "chat") return "Chat";
  if (scene === "paste") return "Settings file";
  if (scene === "success" || scene === "test") return "Ensemble";
  if (scene === "key") return "Connect your apps";
  return "Your app";
}

function Hot({ children }: { children: ReactNode }) {
  return <span className="connect-hot relative z-[1] rounded-md ring-2 ring-accent">{children}</span>;
}

function KeyScene({ hotspot }: { hotspot: string }) {
  return (
    <div className="flex h-[210px] flex-col justify-center gap-3">
      <div className="text-[12px] text-muted">Read-only key</div>
      <div className="rounded-lg border border-line bg-raised px-3 py-2 font-mono text-[12px] text-faint">ens_••••••••</div>
      <div>
        <Hot>
          <span className="inline-flex rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-white">{hotspot}</span>
        </Hot>
      </div>
    </div>
  );
}

function TerminalScene({ hotspot }: { hotspot: string }) {
  return (
    <div className="rounded-lg bg-bg/80 p-3 font-mono text-[12px] leading-6">
      <div className="text-faint">~/ensemble</div>
      <div>
        <span className="text-ok">$</span>{" "}
        <Hot>
          <span className="text-ink">{hotspot}</span>
        </Hot>
        <span className="connect-caret ml-0.5 inline-block h-3 w-1.5 translate-y-0.5 bg-accent" />
      </div>
      <div className="text-muted">done</div>
    </div>
  );
}

function MenuScene({ hotspot }: { hotspot: string }) {
  const rows = ["Settings", hotspot, "Chat", "Help"];
  return (
    <div className="grid grid-cols-[120px_minmax(0,1fr)] gap-3">
      <div className="space-y-1">
        {rows.map((row) =>
          row === hotspot ? (
            <Hot key={row}>
              <div className="rounded-md bg-accent-soft px-2 py-1 text-[12px] font-medium text-ink">{row}</div>
            </Hot>
          ) : (
            <div key={row} className="rounded-md px-2 py-1 text-[12px] text-muted">
              {row}
            </div>
          ),
        )}
      </div>
      <div className="rounded-lg border border-dashed border-line p-3 text-[12px] text-muted">The highlighted row is the one to open.</div>
    </div>
  );
}

function PasteScene({ hotspot }: { hotspot: string }) {
  return (
    <div className="overflow-hidden rounded-lg border border-line bg-bg/70 font-mono text-[11.5px] leading-5">
      <div className="border-b border-line px-3 py-1 text-faint">{hotspot}</div>
      <div className="space-y-0.5 px-3 py-2">
        <div className="text-muted">{"{"}</div>
        <div className="pl-3 text-muted">&quot;ensemble&quot;: {"{"}</div>
        <Hot>
          <div className="pl-6 text-ink">command: node</div>
        </Hot>
        <div className="pl-6 text-muted">your key is filled in</div>
        <div className="pl-3 text-muted">{"}"}</div>
        <div className="text-muted">{"}"}</div>
      </div>
    </div>
  );
}

function ChatScene({ hotspot }: { hotspot: string }) {
  return (
    <div className="flex h-[210px] flex-col justify-end gap-2">
      <div className="ml-auto max-w-[80%] rounded-xl bg-accent-soft px-3 py-2 text-[12.5px]">What’s on my plate today?</div>
      <div className="max-w-[90%] rounded-xl border border-line bg-raised px-3 py-2 text-[12.5px] text-muted">
        <Hot>
          <span className="mb-1 inline-flex rounded-md bg-panel px-1.5 py-0.5 text-[11px] font-medium text-ink">{hotspot}</span>
        </Hot>
        <div className="mt-1">Two tasks are open, and Priya is waiting on the notes.</div>
      </div>
    </div>
  );
}

function LinkScene({ live, hotspot }: { live: boolean; hotspot: string }) {
  return (
    <div className="flex h-[210px] flex-col items-center justify-center gap-3">
      <svg width="220" height="72" viewBox="0 0 220 72">
        <circle cx="36" cy="36" r="18" fill="rgb(var(--accent-rgb) / 0.18)" stroke="rgb(var(--accent-rgb))" />
        <text x="36" y="40" textAnchor="middle" fontSize="10" fill="currentColor">You</text>
        <circle cx="184" cy="36" r="18" fill="rgb(var(--ok-rgb) / 0.18)" stroke="rgb(var(--ok-rgb))" />
        <text x="184" y="40" textAnchor="middle" fontSize="10" fill="currentColor">App</text>
        <path className={live ? "connect-dash" : undefined} d="M58 36h104" stroke="rgb(var(--accent-rgb))" strokeWidth="2" fill="none" />
      </svg>
      <div className={live ? "text-[13px] font-medium text-ok" : "text-[13px] text-muted"}>{live ? "Connected" : hotspot}</div>
    </div>
  );
}
