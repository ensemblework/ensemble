"use client";

import { useId } from "react";
import { parseAvatar, type AvatarRole } from "@ensemble/shared-types";

const PALETTES: Record<AvatarRole, [string, string]> = {
  engineer: ["#647ce5", "#b9c7fa"], lawyer: ["#566a80", "#b8c8d6"],
  teacher: ["#c16e55", "#f0c6a9"], student: ["#8271be", "#d8c5f5"],
  manager: ["#408e85", "#b1dbce"], vibe: ["#ba6e99", "#ecc4dd"],
};
const SKIN = ["#f3cbaa", "#d6a079", "#ae7456", "#784a38", "#e8b991"];
const HAIR = ["#272530", "#513b35", "#a86643", "#d4b08a", "#403239"];

/** Original geometric portraits, generated locally from the stable avatar id. */
export function PersonaAvatar({ id, size = 32, className, title }: { id: string; size?: number; className?: string; title?: string }) {
  const uid = useId().replace(/:/g, "");
  const parts = parseAvatar(id);
  if (!parts) return null;
  const { role, gender, n } = parts;
  const [ink, paper] = PALETTES[role];
  const offset = gender === "f" ? 0 : gender === "m" ? 2 : 4;
  const skin = SKIN[(n + offset) % SKIN.length]!;
  const hair = HAIR[(n + offset) % HAIR.length]!;
  const long = gender === "f" && n !== 3 || gender === "n" && n === 5;
  const curls = n === 2 || gender === "n" && n === 3;
  const glasses = n === 4;
  return <svg viewBox="0 0 80 80" width={size} height={size} className={className} role={title ? "img" : undefined} aria-hidden={title ? undefined : true} style={{ display: "block", borderRadius: "50%" }}>
    {title ? <title>{title}</title> : null}
    <defs>
      <linearGradient id={`${uid}-bg`} x2="1" y2="1"><stop stopColor={paper} /><stop offset="1" stopColor={ink} /></linearGradient>
      <clipPath id={`${uid}-clip`}><circle cx="40" cy="40" r="40" /></clipPath>
    </defs>
    <g clipPath={`url(#${uid}-clip)`}>
      <path fill={`url(#${uid}-bg)`} d="M0 0h80v80H0z" />
      <circle cx="66" cy="12" r="26" fill="#fff" opacity=".15" />
      {long ? <path d="M19 35c0-18 10-24 21-24s21 6 21 24v31H19z" fill={hair} /> : null}
      <path d="M5 84c1-19 14-29 35-29s34 10 35 29" fill={ink} />
      <path d="M33 48h14v14c-4 5-10 5-14 0z" fill={skin} />
      <path d="M33 49h14v7c-5 3-10 2-14-1z" fill="#412822" opacity=".12" />
      <ellipse cx="23" cy="36" rx="4" ry="5" fill={skin} /><ellipse cx="57" cy="36" rx="4" ry="5" fill={skin} />
      <path d="M23 29c0-12 7-18 17-18s17 6 17 18v12c0 10-8 16-17 16s-17-6-17-16z" fill={skin} />
      {curls ? <g fill={hair}>{[[25,22],[32,16],[41,15],[50,18],[56,24]].map(([cx,cy]) => <circle key={cx} cx={cx} cy={cy} r="8" />)}</g> :
        <path d={n === 3 ? "M23 29c-2-15 9-20 18-20 11 0 18 8 16 20-7-9-25-9-34 0" : "M22 33c-5-18 7-24 18-24 13 0 22 9 17 24l-6-13c-7 8-18 9-25 8z"} fill={hair} />}
      <path d="M29 34h6m10 0h6" stroke={hair} strokeWidth="1.8" strokeLinecap="round" />
      <ellipse cx="32" cy="38" rx="1.6" ry="2" fill="#272530" /><ellipse cx="48" cy="38" rx="1.6" ry="2" fill="#272530" />
      <path d="M39 39l-1 5h3" fill="none" stroke="#704533" strokeOpacity=".35" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M35 48q5 4 10 0" fill="none" stroke="#61372e" strokeWidth="1.6" strokeLinecap="round" />
      {glasses ? <g fill="none" stroke="#272530" strokeWidth="1.5"><rect x="25" y="34" width="13" height="10" rx="4" /><rect x="42" y="34" width="13" height="10" rx="4" /><path d="M38 37h4" /></g> : null}
      {gender === "m" && n === 5 ? <path d="M26 44c3 17 25 17 28 0-4 8-9 4-14 7-5-3-10 1-14-7" fill={hair} /> : null}
      <path d="M24 63l7 17M56 63l-7 17" stroke="#fff" strokeOpacity=".18" strokeWidth="2" />
      <path d="M32 61q8 8 16 0" fill="none" stroke={paper} strokeWidth="2" />
    </g>
  </svg>;
}
