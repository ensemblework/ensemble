"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { useId } from "react";
import { AVATAR_PALETTES, avatarId, parseAvatar } from "@ensemble/shared-types";
import { AVATAR_DOTS, avatarScenery } from "./pixel-art";

/** One circular avatar renderer for accounts, shared pages, comments and presence. */
export function PersonaAvatar({ id, size = 32, className, title }: { id: string; size?: number; className?: string; title?: string }) {
  const clip = `avatar-${useId().replace(/:/g, "")}`;
  const parts = parseAvatar(id);
  if (!parts) return null;
  const palette = AVATAR_PALETTES.find(row => row.id === parts.palette)!;
  return <svg viewBox="0 0 72 72" width={size} height={size} className={className} role={title ? "img" : undefined} aria-hidden={title ? undefined : true} focusable="false" data-persona-avatar={avatarId(parts)} style={{ display: "block", borderRadius: "50%", flexShrink: 0 }}>
    {title ? <title>{title}</title> : null}
    <defs><clipPath id={clip}><circle cx={36} cy={36} r={36} /></clipPath></defs>
    <g clipPath={`url(#${clip})`}>
      <circle cx={36} cy={36} r={36} fill={palette.paper} />
      <g data-avatar-scenery={parts.scenery} shapeRendering="crispEdges">
        {avatarScenery(parts.character, parts.scenery).map(pixel => <rect key={`${pixel.x}:${pixel.y}`} x={pixel.x} y={pixel.y} width={6} height={6} fill={pixel.related ? palette.related : palette.ink} opacity={pixel.opacity} />)}
      </g>
      <g data-avatar-character={parts.character}>
        {AVATAR_DOTS.get(parts.character)!.map(dot => <circle key={`${dot.x}:${dot.y}`} cx={dot.x} cy={dot.y} r={2.35} fill={dot.tone === "a" ? palette.accent : dot.tone === "o" ? palette.related : palette.ink} data-accent={dot.tone === "a" || undefined} />)}
      </g>
    </g>
  </svg>;
}
