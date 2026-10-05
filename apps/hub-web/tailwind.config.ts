import type { Config } from "tailwindcss";

const token = (name: string) => `var(--${name})`;
const rgb = (name: string) => `rgb(var(--${name}-rgb) / <alpha-value>)`;

export default {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: rgb("bg"),
        sidebar: rgb("sidebar"),
        panel: rgb("panel"),
        raised: rgb("raised"),
        hover: token("hover"),
        line: token("line"),
        "line-strong": token("line-strong"),
        ink: rgb("ink"),
        muted: rgb("muted"),
        faint: rgb("faint"),
        accent: rgb("accent"),
        "accent-soft": token("accent-soft"),
        ok: rgb("ok"),
        warn: rgb("warn"),
        danger: rgb("danger"),
      },
      fontFamily: {
        sans: ["var(--font-app)"],
        mono: ["var(--font-mono)"],
      },
      fontSize: {
        "2xs": ["0.6875rem", { lineHeight: "1rem" }],
      },
      boxShadow: {
        pop: "0 18px 48px rgba(0,0,0,0.38), 0 0 0 1px var(--line-strong)",
        elev: "var(--elev-1)",
        "elev-2": "var(--elev-2)",
        tile: "var(--elev-tile)",
      },
      borderRadius: {
        lg: "10px",
        xl: "14px",
        tile: "var(--radius-tile)",
        inner: "var(--radius-inner)",
      },
      spacing: {
        "desk-1": "var(--space-1)",
        "desk-2": "var(--space-2)",
        "desk-3": "var(--space-3)",
        "desk-4": "var(--space-4)",
        "desk-5": "var(--space-5)",
      },
    },
  },
  plugins: [],
} satisfies Config;
