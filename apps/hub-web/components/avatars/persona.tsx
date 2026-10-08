"use client";

import { parseAvatar, type AvatarGender, type AvatarRole } from "@ensemble/shared-types";

/**
 * Picture avatars, drawn from their id (`role.gender.n`, packages/shared-types/src/avatars.ts):
 * a profession outfit, one of five hair styles per group, skin tones and accessories. Plain SVG,
 * so they are crisp at any size and cost no downloads.
 */

const BG = ["#F4D9C6", "#D7E3F4", "#E3DAF4", "#D6EEDF", "#F6E7B8"];
const SKIN = ["#F7D7BC", "#EDBB95", "#D29A6E", "#A86D4A", "#74482F"];
const HAIR = ["#2A1F1B", "#4B2E1D", "#7A4A28", "#B7834D", "#1E1E26", "#9C3B26"];
const OUTFIT: Record<AvatarRole, string[]> = {
  engineer: ["#3B5BDB", "#2B8A3E", "#495057", "#C2255C", "#1098AD"],
  lawyer: ["#212529", "#343A40", "#1C2E4A", "#3B2F2F", "#2C3E50"],
  teacher: ["#E8590C", "#5C940D", "#862E9C", "#1864AB", "#A61E4D"],
  student: ["#F59F00", "#12B886", "#4C6EF5", "#FA5252", "#7950F2"],
  manager: ["#364FC7", "#495057", "#5F3DC4", "#0B7285", "#A61E4D"],
  vibe: ["#F06595", "#20C997", "#FCC419", "#748FFC", "#FF922B"],
};
const TIE = ["#C92A2A", "#1971C2", "#5F3DC4", "#2B8A3E", "#E67700"];
const HIJAB = ["#7048E8", "#0C8599", "#C2255C", "#5C940D", "#495057"];

const GENDER_INDEX: Record<AvatarGender, number> = { f: 0, m: 1, n: 2 };

function HairBack({ gender, n, color }: { gender: AvatarGender; n: number; color: string }) {
  if (gender === "f" && n === 1) return <path d="M20 27C19 16 25 11.5 32 11.5S45 16 44 27l1.5 19c-5.5 2.5-21.5 2.5-27 0z" fill={color} />;
  if (gender === "f" && n === 2) return <path d="M19.5 31C18.5 17 25 12.5 32 12.5S45.5 17 44.5 31c0 4.5-1.5 7.5-3.5 8.5H23c-2-1-3.5-4-3.5-8.5z" fill={color} />;
  if (gender === "f" && n === 3) return <circle cx="32" cy="11" r="5.2" fill={color} />;
  if (gender === "f" && n === 4) return <path d="M41 20c7 1 8 11 4.5 18-1.5-4-1.3-11-4.5-15z" fill={color} />;
  if (gender === "n" && n === 3) return <circle cx="32" cy="24" r="14.5" fill={color} />;
  if (gender === "n" && n === 5) return <path d="M19.5 28C18.5 16 25 11.8 32 11.8S45.5 16 44.5 28c1.5 5-.5 9 1 14-4.5 2.5-9.5 1-13.5 2-4-1-9 .5-13.5-2 1.5-5-.5-9 1-14z" fill={color} />;
  return null;
}

function HairFront({ gender, n, color, hat }: { gender: AvatarGender; n: number; color: string; hat: string }) {
  if (gender === "m") {
    if (n === 1) return <path d="M21.2 26.5C20.6 18 26 14.2 32 14.2s11.4 3.8 10.8 12.3c-1.3-4.1-4.2-6.1-8.2-6.5-4-.4-7.2.6-10 2.6-1.8 1.3-2.8 2.6-3.4 3.9z" fill={color} />;
    if (n === 2) return <path d="M21 27c-1.2-9.5 4.6-14.4 10.5-14.6 4.9-.2 9.1 1.4 11.3 5.2 1.4 2.6 1 6 .2 9.4-1-4.4-3.2-6.4-6.4-6.8-3.6-.4-6.8-1.6-9-2.8-1.2 2.6-4 5.2-6.6 9.6z" fill={color} />;
    if (n === 3) return <path d="M21.6 25c.4-6.6 5-9.6 10.4-9.6s10 3 10.4 9.6c-2.4-3.2-6-4.2-10.4-4.2s-8 1-10.4 4.2z" fill={color} opacity="0.85" />;
    if (n === 4)
      return (
        <g fill={color}>
          {[[24, 19, 4], [28, 16, 4.2], [32, 15, 4.4], [36, 16, 4.2], [40, 19, 4], [22, 23, 3], [42, 23, 3]].map(([x, y, r]) => (
            <circle key={`${x}-${y}`} cx={x} cy={y} r={r} />
          ))}
        </g>
      );
    return (
      <g fill={color}>
        <path d="M21.2 26.5C20.6 18 26 14.2 32 14.2s11.4 3.8 10.8 12.3c-1.3-4.1-4.2-6.1-8.2-6.5-4-.4-7.2.6-10 2.6-1.8 1.3-2.8 2.6-3.4 3.9z" />
        <path d="M21.8 29c.2 8.5 4.4 12.5 10.2 12.5S42 37.5 42.2 29c-1.2 4.5-4.2 6.8-7.2 6.6-1.4-.1-2.2-.8-3-.8s-1.6.7-3 .8c-3 .2-6-2.1-7.2-6.6z" />
      </g>
    );
  }
  if (gender === "f") {
    if (n === 1) return <path d="M21 26c0-8 5-12 11-12s11 4 11 12c-2-5-5-6.5-8-7-3 2.5-8 4-14 7z" fill={color} />;
    if (n === 2) return <path d="M21.2 25c.3-7.5 4.8-10.4 10.8-10.4s10.5 2.9 10.8 10.4c-4.8-2-16.8-2-21.6 0z" fill={color} />;
    return <path d="M21.4 26C21 18 26 14.4 32 14.4S43 18 42.6 26c-2.1-4.5-6.1-6.2-10.6-6.2s-8.5 1.7-10.6 6.2z" fill={color} />;
  }
  if (n === 1)
    return (
      <g>
        <path d="M20.5 25c0-9.5 5.5-13.5 11.5-13.5S43.5 15.5 43.5 25z" fill={hat} />
        <rect x="20" y="22.5" width="24" height="4.2" rx="2" fill="#000" opacity="0.2" />
        <circle cx="32" cy="10.6" r="2.4" fill={hat} />
      </g>
    );
  if (n === 2) return <path d="M21 27c-1-9 4-13.5 10-14 6.5-.5 12.5 3.5 12 9-5-2-10-1-15 2.5-2.5 1.7-5 3-7 2.5z" fill={color} />;
  if (n === 3) return <path d="M22 24c2-5 6-7.5 10-7.5s8 2.5 10 7.5c-3-2-6.5-3-10-3s-7 1-10 3z" fill={color} />;
  if (n === 4) return <path d="M21 26c-.5-7 2-10.5 5-11l1.5-2.2 2.5 1.7 2.5-2.5 2.5 2.4 3-1.6.8 2.8c3.2 1.4 4.6 5.4 4.2 10.4-3-4-7-5.4-11-5.4s-8 1.4-11 5.4z" fill={color} />;
  return (
    <g fill={color}>
      <path d="M21 25c.5-7.5 5.5-10.5 10.5-10.5L32 20c-4 .5-8 2.5-11 5z" />
      <path d="M32.5 14.5c5 0 10 3 10.5 10.5-3-2.5-7-4.5-10.5-5z" />
    </g>
  );
}

function Torso({ role, color, n }: { role: AvatarRole; color: string; n: number }) {
  const base = <path d="M8 64c1-13 11-19 24-19s23 6 24 19z" fill={color} />;
  switch (role) {
    case "engineer":
      return (
        <g>
          {base}
          <path d="M22 47c3 5 17 5 20 0-2-1.5-5-2-10-2s-8 .5-10 2z" fill="#000" opacity="0.18" />
          <path d="M29 50l-.5 7M35 50l.5 7" stroke="#fff" strokeWidth="1.1" strokeLinecap="round" />
        </g>
      );
    case "lawyer":
      return (
        <g>
          {base}
          <path d="M27 45.5L32 55l5-9.5z" fill="#fff" />
          <path d="M31 49h2l1 7-2 2.5-2-2.5z" fill={TIE[n - 1]} />
          <path d="M27 45.5l3 11M37 45.5l-3 11" stroke="#fff" strokeOpacity="0.25" strokeWidth="0.8" />
        </g>
      );
    case "teacher":
      return (
        <g>
          {base}
          <path d="M28.5 45.6L32 51l3.5-5.4z" fill="#fff" />
          <circle cx="32" cy="55" r="1" fill="#fff" opacity="0.7" />
          <circle cx="32" cy="59.5" r="1" fill="#fff" opacity="0.7" />
        </g>
      );
    case "student":
      return (
        <g>
          {base}
          <path d="M27 45.5c2 2.5 8 2.5 10 0" stroke="#000" strokeOpacity="0.25" strokeWidth="1.2" fill="none" />
          <path d="M20 49l3 15M44 49l-3 15" stroke="#343A40" strokeWidth="3" strokeLinecap="round" />
        </g>
      );
    case "manager":
      return (
        <g>
          {base}
          <path d="M28 45.5l4 6 4-6z" fill="#fff" />
          <path d="M27.5 46.5L31 56M36.5 46.5L33 56" stroke="#FCC419" strokeWidth="0.9" />
          <rect x="29.8" y="55.5" width="4.4" height="5.5" rx="0.8" fill="#fff" />
        </g>
      );
    case "vibe":
      return (
        <g>
          {base}
          <path d="M26.5 44c1.5 3 9.5 3 11 0v3.5c-2.5 2-8.5 2-11 0z" fill="#000" opacity="0.18" />
        </g>
      );
  }
}

function Accessories({ role, n, gender }: { role: AvatarRole; n: number; gender: AvatarGender }) {
  const glasses =
    (role === "teacher" && (n === 1 || n === 3 || n === 5)) || (role === "engineer" && n === 3) || (role === "lawyer" && n === 4) || (role === "manager" && n === 2);
  // Not over a hijab.
  const headphones = ((role === "vibe" && (n === 2 || n === 4)) || (role === "engineer" && n === 5)) && !(gender === "f" && n === 5);
  const neckphones = role === "engineer" && n === 2;
  const cap = role === "student" && n === 4;
  return (
    <g>
      {glasses ? (
        <g stroke="#212529" strokeWidth="1.1" fill="none">
          <rect x="24.6" y="26.6" width="6.4" height="5" rx="2" />
          <rect x="33" y="26.6" width="6.4" height="5" rx="2" />
          <path d="M31 28.6h2" />
        </g>
      ) : null}
      {headphones ? (
        <g>
          <path d="M20 29c0-14 24-14 24 0" stroke="#212529" strokeWidth="2.4" fill="none" />
          <rect x="18.5" y="26" width="4" height="7" rx="2" fill="#212529" />
          <rect x="41.5" y="26" width="4" height="7" rx="2" fill="#212529" />
        </g>
      ) : null}
      {neckphones ? (
        <g>
          <path d="M23 47c0 7 18 7 18 0" stroke="#212529" strokeWidth="2.2" fill="none" />
          <rect x="21" y="45" width="4" height="6" rx="2" fill="#212529" />
          <rect x="39" y="45" width="4" height="6" rx="2" fill="#212529" />
        </g>
      ) : null}
      {cap ? (
        <g>
          <path d="M20 17l12-5.5L44 17l-12 5.5z" fill="#212529" />
          <path d="M40 18.5v6" stroke="#FCC419" strokeWidth="1" />
          <circle cx="40" cy="25" r="1" fill="#FCC419" />
        </g>
      ) : null}
      {role === "vibe" ? <path d="M51 10l1.2 3 3 1.2-3 1.2L51 18.4l-1.2-3-3-1.2 3-1.2z" fill="#fff" opacity="0.85" /> : null}
    </g>
  );
}

export function PersonaAvatar({ id, size = 32, className, title }: { id: string; size?: number; className?: string; title?: string }) {
  const parts = parseAvatar(id);
  if (!parts) return null;
  const { role, gender, n } = parts;
  const g = GENDER_INDEX[gender];
  const skin = SKIN[(n * 3 + g) % SKIN.length]!;
  const hair = HAIR[(n * 2 + g * 3) % HAIR.length]!;
  const outfit = OUTFIT[role][n - 1]!;
  const hijab = gender === "f" && n === 5;
  const clip = `persona-${role}-${gender}-${n}`;
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} className={className} role={title ? "img" : undefined} aria-hidden={title ? undefined : true} style={{ display: "block" }}>
      {title ? <title>{title}</title> : null}
      <defs>
        <clipPath id={clip}>
          <circle cx="32" cy="32" r="32" />
        </clipPath>
      </defs>
      <g clipPath={`url(#${clip})`}>
        <rect width="64" height="64" fill={BG[(n + g) % BG.length]} />
        {hijab ? null : <HairBack gender={gender} n={n} color={hair} />}
        <Torso role={role} color={outfit} n={n} />
        <path d="M28 38h8l.8 8c-2.3 1.5-7.3 1.5-9.6 0z" fill={skin} />
        <path d="M28 38h8l.3 3.5c-2.6 1.3-6 1.3-8.6 0z" fill="#000" opacity="0.08" />
        {hijab ? (
          <>
            <path d="M18 30c0-14 7-19 14-19s14 5 14 19c0 10-4 16-14 17-10-1-14-7-14-17z" fill={HIJAB[(n + g) % HIJAB.length]} />
            <ellipse cx="32" cy="29.5" rx="9" ry="10.6" fill={skin} />
          </>
        ) : (
          <>
            <circle cx="21.6" cy="29.5" r="2.4" fill={skin} />
            <circle cx="42.4" cy="29.5" r="2.4" fill={skin} />
            <ellipse cx="32" cy="28" rx="10.5" ry="12" fill={skin} />
            <HairFront gender={gender} n={n} color={hair} hat={outfit} />
          </>
        )}
        <path d="M26.2 26q1.8-1 3.6 0M34.2 26q1.8-1 3.6 0" stroke={hijab ? "#2A1F1B" : hair} strokeWidth="1" fill="none" strokeLinecap="round" />
        <circle cx="28" cy="29.4" r="1.25" fill="#2B2420" />
        <circle cx="36" cy="29.4" r="1.25" fill="#2B2420" />
        <circle cx="25.5" cy="32.5" r="1.6" fill="#FF8787" opacity="0.25" />
        <circle cx="38.5" cy="32.5" r="1.6" fill="#FF8787" opacity="0.25" />
        {gender === "m" && n === 5 ? (
          <ellipse cx="32" cy="36.2" rx="2.2" ry="1" fill={skin} />
        ) : (
          <path d="M29 34q3 2.6 6 0" stroke="#7A3B2E" strokeWidth="1.2" fill="none" strokeLinecap="round" />
        )}
        <Accessories role={role} n={n} gender={gender} />
      </g>
    </svg>
  );
}
