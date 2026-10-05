import { Sparkles, Upload, CalendarPlus, Check, X } from "lucide-react";
import { Shell } from "../kit/shell";
import { shellOpts, TodayHead } from "../desks/today";
import type { DeskDef } from "../desks/registry";

const STEPS: Record<string, { l: string; s: string }[]> = {
  chambers: [
    { l: "Add a matter", s: "with its order date" },
    { l: "Connect your calendar", s: "hearings fill in" },
    { l: "Set a billable target", s: "40 h is typical" },
  ],
  semester: [
    { l: "Add your timetable", s: "a photo of the PDF works" },
    { l: "Forward one Moodle email", s: "deadlines pin themselves" },
    { l: "Name your group", s: "for the mini-project" },
  ],
};

export function NewUserToday({ desk }: { desk: DeskDef }) {
  const steps = STEPS[desk.id] ?? STEPS.chambers;
  return (
    <Shell o={shellOpts(desk)}>
      <div className="page">
        <TodayHead desk={desk} sub={<>You're on {desk.name}. Every tile below is waiting for its first entry.</>} />
        <div className="tile hero" style={{ marginBottom: 12, padding: "16px 18px", flexDirection: "row", alignItems: "center", gap: 20 }}>
          <div style={{ position: "relative", width: 54, height: 54, borderRadius: 14, display: "grid", placeItems: "center", background: "rgb(var(--a-rgb) / 0.14)", boxShadow: "inset 0 0 0 1px rgb(var(--a-rgb) / 0.3), 0 0 30px rgb(var(--a-rgb) / 0.2)", color: "var(--a)", flexShrink: 0 }}><Sparkles size={24} /></div>
          <div className="col" style={{ gap: 3, minWidth: 0, flex: "0 1 330px" }}>
            <span className="display" style={{ fontSize: 21 }}>See it full before you fill it</span>
            <span style={{ fontSize: 13, color: "var(--muted)" }}>Load a sample {desk.id === "chambers" ? "docket of 7 matters" : "semester of 5 courses"}. It's marked as sample and clears in one click.</span>
          </div>
          <div className="row gap8" style={{ marginLeft: 8 }}>
            <span className="btn-p" style={{ padding: "8px 14px", fontSize: 13 }}><Sparkles size={14} />Try with sample data</span>
          </div>
          <div className="row" style={{ marginLeft: "auto", gap: 18, paddingLeft: 18, borderLeft: "1px solid var(--line)" }}>
            {steps.map((st, i) => (
              <div key={st.l} className="row gap8">
                <span style={{ width: 22, height: 22, borderRadius: 99, display: "grid", placeItems: "center", fontSize: 11, fontWeight: 700, border: "1.5px solid " + (i === 0 ? "var(--a)" : "var(--line-strong)"), color: i === 0 ? "var(--a)" : "var(--faint)" }}>{i + 1}</span>
                <div className="col" style={{ whiteSpace: "nowrap" }}><span style={{ fontSize: 12.5, fontWeight: 600 }}>{st.l}</span><span style={{ fontSize: 11, color: "var(--faint)" }}>{st.s}</span></div>
              </div>
            ))}
            <X size={14} color="var(--faint)" style={{ marginLeft: 4 }} />
          </div>
        </div>
        <div className="bento">{desk.tiles("empty")}</div>
      </div>
    </Shell>
  );
}
export { Check };
