import type { ReactNode } from "react";
import { Pencil, Sparkles } from "lucide-react";
import { Shell, MobileShell, type ShellOpts } from "../kit/shell";
import type { DeskDef } from "./registry";

export function TodayHead({ desk, sub, right }: { desk: DeskDef; sub?: ReactNode; right?: ReactNode }) {
  return (
    <div className="phead">
      <div>
        <div className="kick">Wed, 30 Sept<span className="deskchip"><i />{desk.name}</span></div>
        <h1 className="display">Today</h1>
        <div className="sub">{sub ?? desk.line}</div>
      </div>
      <div className="row gap8">{right ?? (<><span className="btn"><Sparkles size={13} />Ask</span><span className="btn"><Pencil size={13} />Edit layout</span></>)}</div>
    </div>
  );
}

export function shellOpts(desk: DeskDef, active = "Today"): ShellOpts {
  return { accent: desk.accent, active, board: desk.board, dev: desk.dev, deskName: desk.name, needs: desk.needs };
}

export function TodayPage({ desk }: { desk: DeskDef }) {
  return (
    <Shell o={shellOpts(desk)}>
      <div className="page">
        <TodayHead desk={desk} />
        <div className="bento">{desk.tiles()}</div>
      </div>
    </Shell>
  );
}

export function TodayMobile({ desk }: { desk: DeskDef }) {
  return (
    <MobileShell o={shellOpts(desk)}>
      <div style={{ marginBottom: 14 }}>
        <div className="kick row gap8" style={{ fontSize: 12, color: "var(--muted)" }}>Wed, 30 Sept<span className="deskchip"><i />{desk.name}</span></div>
        <h1 className="display" style={{ fontSize: 30, margin: "4px 0 4px" }}>Today</h1>
        <div style={{ color: "var(--muted)", fontSize: 13 }}>{desk.line}</div>
      </div>
      <div className="bento" style={{ gridTemplateColumns: "repeat(4, minmax(0,1fr))", ["--gap" as string]: "10px" }}>{(desk.mobile ?? desk.tiles)()}</div>
    </MobileShell>
  );
}
