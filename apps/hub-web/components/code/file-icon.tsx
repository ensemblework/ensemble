"use client";

import { Archive, AudioLines, Book, Braces, Database, FileImage, FileText, FilePlay, KeyRound, Lock, NotebookPen, Scale, Settings, Sheet, SquareTerminal, Type, GitBranch, Container } from "lucide-react";
import { memo, type ComponentType } from "react";
import { fileKind, type FileMark } from "@/lib/file-kinds";

type Glyph = Extract<FileMark, { kind: "glyph" }>["glyph"];
type IconLike = ComponentType<{ size?: number; strokeWidth?: number; color?: string; className?: string; "aria-hidden"?: boolean }>;

const LUCIDE: Partial<Record<Glyph, IconLike>> = {
  image: FileImage,
  archive: Archive,
  lock: Lock,
  gear: Settings,
  terminal: SquareTerminal,
  database: Database,
  table: Sheet,
  text: FileText,
  git: GitBranch,
  docker: Container,
  key: KeyRound,
  book: Book,
  law: Scale,
  braces: Braces,
  font: Type,
  audio: AudioLines,
  video: FilePlay,
  notebook: NotebookPen,
};

function Drawn({ glyph, color, size }: { glyph: Glyph; color: string; size: number }) {
  if (glyph === "react") {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth="1" aria-hidden>
        <ellipse cx="8" cy="8" rx="7" ry="2.7" />
        <ellipse cx="8" cy="8" rx="7" ry="2.7" transform="rotate(60 8 8)" />
        <ellipse cx="8" cy="8" rx="7" ry="2.7" transform="rotate(120 8 8)" />
        <circle cx="8" cy="8" r="1.3" fill={color} stroke="none" />
      </svg>
    );
  }
  if (glyph === "python") {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden>
        <path d="M7.9 1C5 1 5.2 2.3 5.2 2.3v1.3H8v.4H3.9S2 3.8 2 6.7s1.7 2.8 1.7 2.8h1V8.1s-.1-1.7 1.6-1.7h2.8s1.6 0 1.6-1.6V2.6S11 1 7.9 1Zm-1.5.9a.5.5 0 1 1 0 1 .5.5 0 0 1 0-1Z" fill="#3776ab" />
        <path d="M8.1 15c2.9 0 2.7-1.3 2.7-1.3v-1.3H8V12h4.1s1.9.2 1.9-2.7-1.7-2.8-1.7-2.8h-1v1.4s.1 1.7-1.6 1.7H6.9s-1.6 0-1.6 1.6v2.2S5 15 8.1 15Zm1.5-.9a.5.5 0 1 1 0-1 .5.5 0 0 1 0 1Z" fill="#ffd43b" />
      </svg>
    );
  }
  if (glyph === "markdown") {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <rect x="1" y="3" width="14" height="10" rx="2" strokeWidth="1.1" />
        <path d="M3.8 10.3V5.8l1.9 2.3 1.9-2.3v4.5M11.2 5.8v4.4m-1.6-1.6 1.6 1.7 1.6-1.7" />
      </svg>
    );
  }
  if (glyph === "next") {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden>
        <circle cx="8" cy="8" r="7" fill="#0b0d10" stroke={color} strokeOpacity="0.35" strokeWidth="0.8" />
        <path d="M5.6 11V5h.9l4.2 6.2M10.4 5v3.6" stroke="#fff" strokeWidth="1.1" fill="none" strokeLinecap="round" />
      </svg>
    );
  }
  if (glyph === "pdf") {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden>
        <rect x="1.5" y="2" width="13" height="12" rx="2.5" fill={color} />
        <text x="8" y="10.4" textAnchor="middle" fontSize="5.4" fontWeight="700" fill="#fff" fontFamily="ui-sans-serif, system-ui, sans-serif">PDF</text>
      </svg>
    );
  }
  const Icon = LUCIDE[glyph] ?? FileText;
  return <Icon size={size} strokeWidth={1.8} color={color} aria-hidden />;
}

/** A file's mark in the explorer and on its tab: a language badge or a symbol, by its name. */
export const FileIcon = memo(function FileIcon({ name, size = 14, className = "" }: { name: string; size?: number; className?: string }) {
  const mark = fileKind(name).mark;
  return (
    <span className={`file-icon inline-flex shrink-0 items-center justify-center ${className}`} style={{ width: size, height: size }} aria-hidden>
      {mark.kind === "glyph" ? (
        <Drawn glyph={mark.glyph} color={mark.color} size={size} />
      ) : (
        <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden>
          <rect x="1" y="2" width="14" height="12" rx="3" fill={mark.bg} />
          <text
            x="8"
            y={mark.text.length > 2 ? 10.3 : 10.9}
            textAnchor="middle"
            fontSize={mark.text.length > 2 ? 5.6 : mark.text.length === 2 ? 7 : 8.6}
            fontWeight="700"
            fill={mark.fg ?? "#fff"}
            fontFamily="ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif"
            letterSpacing={mark.text.length > 1 ? "-0.2" : undefined}
          >
            {mark.text}
          </text>
        </svg>
      )}
    </span>
  );
});
