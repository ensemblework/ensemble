export function Mark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <path fill="var(--agent)" d="M4 3H8V17A8 8 0 0 0 24 17V3H28V17A12 12 0 0 1 4 17Z" />
      <path fill="var(--ink)" d="M10 3H14V17A2 2 0 0 0 18 17V3H22V17A6 6 0 0 1 10 17Z" />
    </svg>
  );
}

export function Wordmark() {
  return (
    <span className="wordmark">
      <Mark />
      <span>Ensemble</span>
    </span>
  );
}
