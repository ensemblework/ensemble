import { ImageResponse } from "next/og";

export const dynamic = "force-static";
export const alt = "Ensemble: you and your agent, in the same key";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

function wave(phase: number) {
  const points: string[] = [];
  for (let x = 0; x <= 1200; x += 10) {
    const y = 90 + 46 * Math.sin((x / 340) * Math.PI * 2 + phase);
    points.push(`${x === 0 ? "M" : "L"}${x} ${y.toFixed(1)}`);
  }
  return points.join(" ");
}

export default function OpenGraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "72px 80px 0",
          background: "radial-gradient(60% 70% at 78% 20%, rgba(124,106,247,0.35), #141210 70%)",
          color: "#f3eee6",
          fontFamily: "serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 18, fontSize: 36 }}>
          <svg width="52" height="52" viewBox="0 0 32 32">
            <path fill="#9d8fff" d="M4 3H8V17A8 8 0 0 0 24 17V3H28V17A12 12 0 0 1 4 17Z" />
            <path fill="#f3eee6" d="M10 3H14V17A2 2 0 0 0 18 17V3H22V17A6 6 0 0 1 10 17Z" />
          </svg>
          Ensemble
        </div>
        <div style={{ display: "flex", flexDirection: "column", fontSize: 84, lineHeight: 1.05, letterSpacing: -2 }}>
          <span>You and your agent,</span>
          <span style={{ color: "#9d8fff", fontStyle: "italic" }}>in the same key.</span>
        </div>
        <svg width="1200" height="180" viewBox="0 0 1200 180" style={{ marginLeft: -80 }}>
          <path d={wave(0)} fill="none" stroke="rgba(243,238,230,0.6)" strokeWidth="3" />
          <path d={wave(Math.PI)} fill="none" stroke="#9d8fff" strokeWidth="3" />
        </svg>
      </div>
    ),
    size,
  );
}
