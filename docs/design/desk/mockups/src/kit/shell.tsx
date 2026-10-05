import type { ReactNode } from "react";
import {
  Activity, Archive, BarChart3, Bell, BookOpen, Briefcase, CalendarCheck, CalendarDays, CircleCheck, Code2, Columns3,
  LayoutGrid, ListChecks, PanelRight, Plug, Redo2, RefreshCw, Search, Settings, Sun, Undo2, Users, Sparkles, Menu,
} from "lucide-react";
import { accentVars, type AccentId, Av } from "./ui";

export type ShellOpts = {
  accent: AccentId; active?: string; board?: string; dev?: boolean; crumb?: string; deskName?: string; user?: string; needs?: number;
};

export function Shell({ o, children }: { o: ShellOpts; children: ReactNode }) {
  const active = o.active ?? "Today";
  const primary = [
    { l: "Today", i: CalendarDays },
    { l: o.board ?? "Board", i: Columns3 },
    { l: "Needs me", i: CircleCheck, b: o.needs ?? 2 },
  ];
  const ws = [
    ...(o.dev ? [{ l: "Runs", i: Activity }] : []),
    { l: "Context", i: Users },
    ...(o.dev ? [{ l: "Skills", i: BookOpen }, { l: "Workspace", i: Briefcase }, { l: "Code", i: Code2 }, { l: "Metrics", i: BarChart3 }] : []),
    { l: "Meeting notes", i: CalendarCheck },
    { l: "Weekly recap", i: ListChecks },
    { l: "Templates", i: LayoutGrid },
    { l: "Trash", i: Archive },
  ];
  return (
    <div className="app" style={accentVars(o.accent)}>
      <aside className="side">
        <div className="brand"><span className="mark"><i /><i /><i /></span>Ensemble</div>
        <div className="jump"><span>Jump to…</span><span className="kbd">Ctrl K</span></div>
        <div className="grp">Desk</div>
        {primary.map((n) => (
          <div key={n.l} className="nav" data-on={active === n.l || undefined}>
            <n.i size={16} strokeWidth={1.8} />{n.l}{n.b ? <span className="badge">{n.b}</span> : null}
          </div>
        ))}
        <div className="grp" style={{ marginTop: 8 }}>Workspace</div>
        {ws.map((n) => (
          <div key={n.l} className="nav" data-on={active === n.l || undefined}><n.i size={16} strokeWidth={1.8} />{n.l}</div>
        ))}
        <div className="foot">
          {o.deskName && (
            <div className="deskpill">
              <div className="row gap6" style={{ fontSize: 12, fontWeight: 600 }}>
                <span className="deskchip" style={{ padding: 0, border: 0, background: "none" }}><i /></span>{o.deskName}
              </div>
              <div style={{ fontSize: 11.5, color: "var(--faint)", marginTop: 3 }}>Desk template · Switch</div>
            </div>
          )}
          <div className="nav"><Plug size={16} strokeWidth={1.8} />Connect</div>
          <div className="nav"><Settings size={16} strokeWidth={1.8} />Settings</div>
          <div className="me"><Av n={o.user ?? "Prajwal Bhagwat"} s={22} /><span className="trunc">prajwal@local.test</span></div>
        </div>
      </aside>
      <div className="main">
        <div className="top">
          <Menu size={16} color="var(--muted)" />
          <span className="crumb">{o.crumb ?? active}</span>
          <div className="ask"><Sparkles size={13} />Ask Ensemble<span style={{ marginLeft: "auto" }} className="kbd">Ctrl J</span></div>
          <div className="sp" />
          <span className="icon-btn"><Bell size={15} /></span>
          <span className="icon-btn"><Undo2 size={15} /></span>
          <span className="icon-btn"><Redo2 size={15} /></span>
          <span className="status"><RefreshCw size={13} />Fetch now</span>
          <span className="status"><span className="dot" />Idle</span>
          <span className="icon-btn"><PanelRight size={15} /></span>
          <span className="icon-btn"><Sun size={15} /></span>
        </div>
        {children}
      </div>
    </div>
  );
}

export function MobileShell({ o, children }: { o: ShellOpts; children: ReactNode }) {
  const tabs = [
    { l: "Today", i: CalendarDays }, { l: o.board ?? "Board", i: Columns3 }, { l: "Needs me", i: CircleCheck }, { l: "Context", i: Users }, { l: "Search", i: Search },
  ];
  return (
    <div style={{ ...accentVars(o.accent), minHeight: "100vh", background: "radial-gradient(420px 260px at 0% -5%, rgb(var(--a-rgb)/0.14), transparent 70%), var(--bg)" }}>
      <div className="row sb" style={{ height: 52, padding: "0 16px", borderBottom: "1px solid var(--line)", position: "sticky", top: 0, zIndex: 5, background: "rgba(20,18,16,0.8)", backdropFilter: "blur(14px)" }}>
        <div className="row gap8" style={{ fontWeight: 600 }}><span className="mark"><i /><i /><i /></span>Ensemble</div>
        <div className="row gap8"><span className="icon-btn"><Bell size={16} /></span><Av n="Prajwal Bhagwat" s={26} /></div>
      </div>
      <div style={{ padding: "18px 14px 96px" }}>{children}</div>
      <div style={{ position: "sticky", margin: "-82px 12px 0", bottom: 14, height: 58, borderRadius: 18, background: "rgba(34,30,26,0.9)", border: "1px solid var(--line-strong)", backdropFilter: "blur(16px)", display: "flex", alignItems: "center", justifyContent: "space-around", boxShadow: "0 18px 40px rgba(0,0,0,0.5)" }}>
        {tabs.map((t, i) => (
          <div key={t.l} className="col" style={{ alignItems: "center", gap: 3, fontSize: 10.5, color: i === 0 ? "var(--ink)" : "var(--faint)" }}>
            <t.i size={18} strokeWidth={1.8} color={i === 0 ? "var(--a)" : undefined} />{t.l}
          </div>
        ))}
      </div>
    </div>
  );
}
