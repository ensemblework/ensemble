const ROWS = [
  { l: "Semester", b: "07-today-semester-desk", a: "B-today-semester-1440", n: "Empty Timetable and a lone 4d become a week strip with classes, deadlines and a now line; rings carry the 75% attendance rule." },
  { l: "This week's classes", b: "09-today-classes", a: "B-today-classes-1440", n: "A one-line Next lesson becomes the live period with 20 min left, the next room, and the whole day as a ribbon." },
  { l: "Bench", b: "10-today-bench", a: "B-today-bench-1440", n: "Chips and a one-word Specs tile become a build Gantt, a BOM ring, a pass/fail grid by board, and a build log." },
  { l: "Chambers", b: "05-today-chambers", a: "B-today-chambers-1440", n: "A list with dots becomes a 60-day band with red, amber and calm zones, holiday-aware dates, and pinned matters." },
  { l: "Gallery", b: "01-gallery-1440", a: "E-gallery-1440", n: "Bars in boxes become scaled real desks in each accent; the first row is full: a featured hero plus two in-season picks." },
];
export function Compare() {
  return (
    <div className="sheet" style={{ maxWidth: 1440 }}>
      <div className="cap" style={{ marginBottom: 8 }}>Ensemble · Desk design · Round 2 baseline vs mockup</div>
      <h1 className="display">Before and after</h1>
      <p className="lede">Left: the running build at feature-2 2bfcde5 (round 2 owner set). Right: the mockup for the same desk, same 1440×900 fold.</p>
      {ROWS.map((r) => (
        <div key={r.l} style={{ marginTop: 30 }}>
          <div className="row gap12" style={{ marginBottom: 10 }}><span className="display" style={{ fontSize: 22 }}>{r.l}</span><span className="faint" style={{ fontSize: 13 }}>{r.n}</span></div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
            {[["Round 2 build", `baseline/${r.b}.png`], ["Mockup", `after/${r.a}.png`]].map(([t, src]) => (
              <div key={t} className="col gap6">
                <span className="cap">{t}</span>
                <img src={src} style={{ width: "100%", borderRadius: 10, border: "1px solid var(--line-strong)", display: "block" }} />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
