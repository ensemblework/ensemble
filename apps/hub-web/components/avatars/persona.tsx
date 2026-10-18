"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { useId } from "react";
import { avatarBackground, parseAvatar, type AvatarBackground, type AvatarGender } from "@ensemble/shared-types";

/** Background gradients, dark then light. Each was a profession's colour before backgrounds could be picked. */
export const AVATAR_BACKGROUND_COLORS: Record<AvatarBackground, [string, string]> = {
  sky: ["#647ce5", "#b9c7fa"],
  mint: ["#408e85", "#b1dbce"],
  peach: ["#c16e55", "#f0c6a9"],
  rose: ["#ba6e99", "#ecc4dd"],
  slate: ["#566a80", "#b8c8d6"],
};
const SKIN = ["#f3cbaa", "#d6a079", "#ae7456", "#784a38", "#e8b991"];
const HAIR = ["#272530", "#513b35", "#a86643", "#d4b08a", "#403239"];
/** Tops are their own colours, so they never melt into the background. */
const SHIRTS = ["#2f3a56", "#3d6b5a", "#7a3346", "#4c6fa8", "#3a3a44", "#a2563f", "#5b4a86", "#2f5e6b"];

type Style = "short" | "swept" | "curls" | "bun" | "buzz" | "afro" | "bob" | "bald" | "scarf";
type Face = {
  skin: number;
  hair: number;
  style: Style;
  long?: boolean;
  glasses?: boolean;
  beard?: boolean;
  mustache?: boolean;
  earrings?: boolean;
  freckles?: boolean;
  /** A knitted hat, in this colour. */
  hat?: string;
  /** The colour of a head scarf (style "scarf"). */
  scarf?: string;
};

/** Faces 6–10 of each group. Faces 1–5 come from `firstFive`, unchanged since avatars shipped. */
const MORE: Record<AvatarGender, Face[]> = {
  f: [
    { skin: 3, hair: 0, style: "bun", earrings: true },
    { skin: 1, hair: 0, style: "scarf", scarf: "#2f6b55" },
    { skin: 4, hair: 2, style: "bob", freckles: true },
    { skin: 2, hair: 0, style: "afro" },
    { skin: 0, hair: 3, style: "short", long: true, glasses: true, earrings: true },
  ],
  m: [
    { skin: 3, hair: 0, style: "buzz", beard: true },
    { skin: 1, hair: 1, style: "bald", glasses: true },
    { skin: 2, hair: 0, style: "afro" },
    { skin: 4, hair: 2, style: "short", hat: "#c99a3b" },
    { skin: 0, hair: 3, style: "short", mustache: true },
  ],
  n: [
    { skin: 2, hair: 4, style: "bob" },
    { skin: 3, hair: 0, style: "short", hat: "#33406b" },
    { skin: 0, hair: 1, style: "buzz", earrings: true },
    { skin: 4, hair: 2, style: "curls", glasses: true },
    { skin: 1, hair: 3, style: "bun", freckles: true },
  ],
};

function firstFive(gender: AvatarGender, n: number): Face {
  const offset = gender === "f" ? 0 : gender === "m" ? 2 : 4;
  const curls = n === 2 || gender === "n" && n === 3;
  return {
    skin: (n + offset) % SKIN.length,
    hair: (n + offset) % HAIR.length,
    style: curls ? "curls" : n === 3 ? "swept" : "short",
    long: gender === "f" && n !== 3 || gender === "n" && n === 5,
    glasses: n === 4,
    beard: gender === "m" && n === 5,
  };
}

function faceFor(gender: AvatarGender, n: number): Face {
  return n <= 5 ? firstFive(gender, n) : MORE[gender][n - 6]!;
}

const SHORT = "M22 33c-5-18 7-24 18-24 13 0 22 9 17 24l-6-13c-7 8-18 9-25 8z";
const SWEPT = "M23 29c-2-15 9-20 18-20 11 0 18 8 16 20-7-9-25-9-34 0";
/** A fringe that follows the hairline, for close-cut and full styles. */
const FRINGE = "M23 31c0-13 7-20 17-20s17 7 17 20c-3-5-9-8-17-8s-14 3-17 8z";

/** Original geometric portraits, generated locally from the stable avatar id. */
export function PersonaAvatar({ id, size = 32, className, title }: { id: string; size?: number; className?: string; title?: string }) {
  const uid = useId().replace(/:/g, "");
  const parts = parseAvatar(id);
  if (!parts) return null;
  const { gender, n } = parts;
  const [ink, paper] = AVATAR_BACKGROUND_COLORS[avatarBackground(parts)];
  const face = faceFor(gender, n);
  const skin = SKIN[face.skin]!;
  const hair = HAIR[face.hair]!;
  const offset = gender === "f" ? 0 : gender === "m" ? 3 : 5;
  const shirt = SHIRTS[(n * 3 + offset) % SHIRTS.length]!;
  const style = face.style;
  return <svg viewBox="0 0 80 80" width={size} height={size} className={className} role={title ? "img" : undefined} aria-hidden={title ? undefined : true} style={{ display: "block", borderRadius: "50%" }}>
    {title ? <title>{title}</title> : null}
    <defs>
      <linearGradient id={`${uid}-bg`} x2="1" y2="1"><stop stopColor={paper} /><stop offset="1" stopColor={ink} /></linearGradient>
      <clipPath id={`${uid}-clip`}><circle cx="40" cy="40" r="40" /></clipPath>
    </defs>
    <g clipPath={`url(#${uid}-clip)`}>
      <path fill={`url(#${uid}-bg)`} d="M0 0h80v80H0z" />
      <circle cx="66" cy="12" r="26" fill="#fff" opacity=".15" />
      {/* Behind the head */}
      {face.long ? <path d="M19 35c0-18 10-24 21-24s21 6 21 24v31H19z" fill={hair} /> : null}
      {style === "afro" ? <g fill={hair}>{[[21, 24, 10], [29, 14, 10], [40, 10, 11], [51, 14, 10], [59, 24, 10], [61, 34, 8], [19, 34, 8]].map(([cx, cy, r]) => <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={r} />)}</g> : null}
      {style === "bob" ? <path d="M19 31c0-16 9-22 21-22s21 6 21 22v17c-4 3-9 3-12 0H31c-3 3-8 3-12 0z" fill={hair} /> : null}
      {style === "bun" ? <circle cx="40" cy="8" r="7" fill={hair} /> : null}
      {style === "scarf" ? <path d="M14 46c0-24 11-36 26-36s26 12 26 36v38H14z" fill={face.scarf} /> : null}
      <path d="M5 84c1-19 14-29 35-29s34 10 35 29" fill={shirt} />
      <path d="M33 48h14v14c-4 5-10 5-14 0z" fill={skin} />
      <path d="M33 49h14v7c-5 3-10 2-14-1z" fill="#412822" opacity=".12" />
      {style === "scarf" ? null : <><ellipse cx="23" cy="36" rx="4" ry="5" fill={skin} /><ellipse cx="57" cy="36" rx="4" ry="5" fill={skin} /></>}
      <path d="M23 29c0-12 7-18 17-18s17 6 17 18v12c0 10-8 16-17 16s-17-6-17-16z" fill={skin} />
      {/* Hair on top */}
      {style === "curls" ? <g fill={hair}>{[[25, 22], [32, 16], [41, 15], [50, 18], [56, 24]].map(([cx, cy]) => <circle key={cx} cx={cx} cy={cy} r="8" />)}</g> : null}
      {style === "short" || style === "bun" ? <path d={SHORT} fill={hair} /> : null}
      {style === "swept" ? <path d={SWEPT} fill={hair} /> : null}
      {style === "buzz" ? <path d={FRINGE} fill={hair} opacity=".85" /> : null}
      {style === "afro" ? <path d={FRINGE} fill={hair} /> : null}
      {style === "bob" ? <path d="M23 32c-1-14 7-21 17-21s18 7 17 21c-3-6-9-9-17-9-5 0-12 2-17 9z" fill={hair} /> : null}
      {style === "bald" ? <ellipse cx="46" cy="17" rx="5" ry="2.5" fill="#fff" opacity=".25" /> : null}
      {style === "scarf" ? <>
        <path d="M22 31c0-13 8-20 18-20s18 7 18 20c-5-5-11-7-18-7s-13 2-18 7z" fill={face.scarf} />
        <path d="M24 50c5 9 27 9 32 0l4 14c-8 6-32 6-40 0z" fill={face.scarf} />
      </> : null}
      {face.hat ? <g fill={face.hat}>
        <path d="M21 31c0-14 8-22 19-22s19 8 19 22z" />
        <circle cx="40" cy="8" r="4" />
        <rect x="20" y="25" width="40" height="7" rx="3.5" />
        <rect x="20" y="25" width="40" height="7" rx="3.5" fill="#000" opacity=".15" />
      </g> : null}
      {/* Face */}
      <path d="M29 34h6m10 0h6" stroke={style === "scarf" ? "#3a2a26" : hair} strokeWidth="1.8" strokeLinecap="round" />
      <ellipse cx="32" cy="38" rx="1.6" ry="2" fill="#272530" /><ellipse cx="48" cy="38" rx="1.6" ry="2" fill="#272530" />
      <path d="M39 39l-1 5h3" fill="none" stroke="#704533" strokeOpacity=".35" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M35 48q5 4 10 0" fill="none" stroke="#61372e" strokeWidth="1.6" strokeLinecap="round" />
      {face.freckles ? <g fill="#8a4b34" opacity=".45">{[[28, 43], [31, 44.5], [27, 45.5], [52, 43], [49, 44.5], [53, 45.5]].map(([cx, cy]) => <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r=".8" />)}</g> : null}
      {face.glasses ? <g fill="none" stroke="#272530" strokeWidth="1.5"><rect x="25" y="34" width="13" height="10" rx="4" /><rect x="42" y="34" width="13" height="10" rx="4" /><path d="M38 37h4" /></g> : null}
      {face.beard ? <path d="M26 44c3 17 25 17 28 0-4 8-9 4-14 7-5-3-10 1-14-7" fill={hair} /> : null}
      {face.mustache ? <path d="M33 45.5c2.5-2 5-2 7-.5 2-1.5 4.5-1.5 7 .5-2.5 1.5-5 1.5-7 0-2 1.5-4.5 1.5-7 0z" fill={hair} /> : null}
      {face.earrings ? <g fill="#e2b64a"><circle cx="21.5" cy="42.5" r="1.8" /><circle cx="58.5" cy="42.5" r="1.8" /></g> : null}
      <path d="M24 63l7 17M56 63l-7 17" stroke="#fff" strokeOpacity=".18" strokeWidth="2" />
      <path d="M32 61q8 8 16 0" fill="none" stroke="#fff" strokeOpacity=".55" strokeWidth="2" />
    </g>
  </svg>;
}
