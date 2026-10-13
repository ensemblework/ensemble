"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { Check } from "lucide-react";
import { useRef, type CSSProperties } from "react";
import type { AppearanceSettings, AppColorTheme } from "@ensemble/shared-types";
import { COLOR_THEMES, colorThemeTokens, colorThemeSurfaces, type ColorMode } from "@/lib/color-themes";
import { accentChoice, resolveAccent } from "@/lib/accent";

export function ColorThemePicker({ appearance, onChange }: { appearance: AppearanceSettings; onChange: (id: AppColorTheme) => void }) {
  const group = useRef<HTMLDivElement>(null);
  const selected = Math.max(0, COLOR_THEMES.findIndex((theme) => theme.id === appearance.colorTheme));
  const choose = (index: number) => {
    onChange(COLOR_THEMES[index]!.id);
    group.current?.querySelector<HTMLButtonElement>(`[data-color-theme-option="${COLOR_THEMES[index]!.id}"]`)?.focus({ preventScroll: true });
  };
  return <div className="color-theme-section" data-jump-label="Color theme">
    <div className="color-theme-heading"><div><h3>Color theme</h3><p>A different atmosphere. Your accent stays yours.</p></div><span>Light & dark in every theme</span></div>
    <div ref={group} className="color-theme-grid" role="radiogroup" aria-label="Color theme">
      {COLOR_THEMES.map((theme, index) => <button key={theme.id} type="button" role="radio" aria-checked={index === selected} tabIndex={index === selected ? 0 : -1} data-color-theme-option={theme.id} onClick={() => onChange(theme.id)} onKeyDown={(event) => {
        const delta = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
        if (delta || event.key === "Home" || event.key === "End") { event.preventDefault(); choose(event.key === "Home" ? 0 : event.key === "End" ? COLOR_THEMES.length - 1 : (index + delta + COLOR_THEMES.length) % COLOR_THEMES.length); }
      }}>
        <div className="color-theme-pair" aria-hidden>{(["light", "dark"] as ColorMode[]).map((mode) => {
          const accent = resolveAccent(accentChoice(appearance, mode), mode, colorThemeSurfaces(theme.id, mode));
          return <div key={mode} className="color-theme-miniature" style={{ ...colorThemeTokens(theme, mode), "--accent": accent.hex, "--accent-fg": accent.fg } as CSSProperties}>
            <aside><i /><span /><span /><span /><span /></aside><div className="color-theme-mini-main"><header><span /><i /></header><div className="color-theme-mini-body"><b /><div className="color-theme-mini-tiles"><div><i /><span /><span /></div><div><i /><em /></div></div><small>{mode}</small></div></div>
          </div>;
        })}</div>
        <div className="color-theme-card-copy"><strong>{theme.name}{index === selected && <Check size={14} aria-hidden />}</strong><span>{theme.description}</span><small>{theme.detail}</small></div>
      </button>)}
    </div>
  </div>;
}
