// Two lines that keep crossing: you and your agent, in the same key.
// The path is drawn twice the visible width so a CSS translate can loop it seamlessly.
const WIDTH = 1200;
const HEIGHT = 160;

function wave(phase: number, amplitude: number, wavelength: number) {
  const mid = HEIGHT / 2;
  const points: string[] = [];
  for (let x = 0; x <= WIDTH * 2; x += 8) {
    const y = mid + amplitude * Math.sin((x / wavelength) * Math.PI * 2 + phase);
    points.push(`${x === 0 ? "M" : "L"}${x} ${y.toFixed(2)}`);
  }
  return points.join(" ");
}

const you = wave(0, 34, 300);
const agent = wave(Math.PI, 34, 300);
const hum = wave(Math.PI / 2, 12, 150);

export function Voices({ className = "" }: { className?: string }) {
  return (
    <div className={`voices ${className}`} aria-hidden="true">
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none">
        <defs>
          <linearGradient id="fade" x1="0" x2="1" y1="0" y2="0">
            <stop offset="0" stopColor="#fff" stopOpacity="0" />
            <stop offset="0.15" stopColor="#fff" stopOpacity="1" />
            <stop offset="0.85" stopColor="#fff" stopOpacity="1" />
            <stop offset="1" stopColor="#fff" stopOpacity="0" />
          </linearGradient>
          <mask id="fade-mask">
            <rect width={WIDTH} height={HEIGHT} fill="url(#fade)" />
          </mask>
        </defs>
        <g mask="url(#fade-mask)">
          <g className="voices-track voices-slow">
            <path d={hum} className="voice voice-hum" />
          </g>
          <g className="voices-track">
            <path d={you} className="voice voice-you" />
            <path d={agent} className="voice voice-agent" />
          </g>
        </g>
      </svg>
    </div>
  );
}
