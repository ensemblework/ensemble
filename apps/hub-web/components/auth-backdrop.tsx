import { Sparkles } from "lucide-react";

/**
 * The left half of sign-in and sign-up. Decorative only: a slow context graph and
 * three cards drawn the way the app draws them. Motion stops under reduced motion.
 */
const NODES: Array<{ x: number; y: number; kind: "person" | "task" | "page"; label?: string }> = [
  { x: 120, y: 140, kind: "person", label: "MC" },
  { x: 300, y: 90, kind: "task" },
  { x: 470, y: 170, kind: "page" },
  { x: 230, y: 270, kind: "person", label: "DP" },
  { x: 420, y: 330, kind: "task" },
  { x: 560, y: 260, kind: "person", label: "KT" },
  { x: 90, y: 400, kind: "page" },
  { x: 300, y: 450, kind: "task" },
  { x: 520, y: 470, kind: "page" },
  { x: 180, y: 560, kind: "person", label: "LO" },
  { x: 400, y: 600, kind: "task" },
  { x: 600, y: 610, kind: "person", label: "SW" },
];
const EDGES: Array<[number, number]> = [
  [0, 1], [1, 2], [0, 3], [3, 4], [2, 5], [4, 5], [3, 6], [3, 7], [4, 8], [7, 9], [7, 10], [8, 11], [10, 11], [6, 9], [1, 3],
];

export function AuthBackdrop() {
  return (
    <div className="auth-art" aria-hidden="true">
      <svg className="auth-graph" viewBox="0 0 680 700" preserveAspectRatio="xMidYMid slice">
        <g className="auth-graph-drift">
          {EDGES.map(([a, b]) => (
            <line key={`${a}-${b}`} x1={NODES[a]!.x} y1={NODES[a]!.y} x2={NODES[b]!.x} y2={NODES[b]!.y} />
          ))}
          {NODES.map((node, index) =>
            node.kind === "person" ? (
              <g key={index} className="auth-node person" style={{ animationDelay: `${index * -1.3}s` }}>
                <circle cx={node.x} cy={node.y} r="17" />
                <text x={node.x} y={node.y + 4} textAnchor="middle">{node.label}</text>
              </g>
            ) : node.kind === "task" ? (
              <rect key={index} className="auth-node task" x={node.x - 7} y={node.y - 7} width="14" height="14" rx="3" transform={`rotate(45 ${node.x} ${node.y})`} style={{ animationDelay: `${index * -1.1}s` }} />
            ) : (
              <rect key={index} className="auth-node page" x={node.x - 8} y={node.y - 10} width="16" height="20" rx="3" style={{ animationDelay: `${index * -0.9}s` }} />
            ),
          )}
        </g>
      </svg>

      <div className="auth-cards">
        <div className="auth-card-ui auth-card-task">
          <div className="auth-card-row">
            <span className="auth-dot" />
            <span className="auth-card-title">Review the cache PR</span>
          </div>
          <div className="auth-card-meta">
            <span className="auth-avatar">MC</span>
            Mira · due Friday
            <span className="auth-chip">In progress</span>
          </div>
        </div>
        <div className="auth-card-ui auth-card-ask">
          <div className="auth-card-row">
            <Sparkles size={13} />
            <span>
              <b>@ensemble</b> summarize this page
            </span>
          </div>
          <div className="auth-card-answer">Three decisions, two open questions, and Dev owes the latency numbers.</div>
        </div>
        <div className="auth-card-ui auth-card-plot">
          <div className="auth-card-title">Accuracy by epoch</div>
          <svg viewBox="0 0 220 64" className="auth-spark">
            <path d="M0 58 C 30 52, 40 40, 60 34 S 100 22, 120 18 S 170 10, 220 7" />
            <path className="area" d="M0 58 C 30 52, 40 40, 60 34 S 100 22, 120 18 S 170 10, 220 7 L 220 64 L 0 64 Z" />
          </svg>
        </div>
      </div>

      <div className="auth-art-copy">
        <p className="display">Your work, and everything around it.</p>
        <p>Tasks, pages, people, and an assistant that knows the context. Nothing leaves without you.</p>
      </div>
    </div>
  );
}
