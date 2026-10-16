"use client";

import { Check, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { AppearanceSettings } from "@ensemble/shared-types";
import { colorThemeSurfaces } from "@/lib/color-themes";
import { ColorThemePicker } from "./color-theme-picker";
import { ACCENT_PRESETS, resolveAccent } from "@/lib/accent";
import { APPEARANCE_KEY, DEFAULT_APPEARANCE, markAccentWrite, publishAppearance, readAppearance, usePersistentState } from "@/lib/prefs";
import { radioKeyTarget } from "@/lib/radio-keys";
import { useToast } from "../toast";
import { Range, SectionCard, Segmented, SettingRow, Toggle, cx } from "../ui";

type Patch = (patch: Record<string, unknown>) => void;

const FONTS: Array<{ id: AppearanceSettings["font"]; label: string; detail: string; family: string }> = [
  { id: "system", label: "Ensemble", detail: "Figtree, the default face.", family: "var(--font-sans), ui-sans-serif, sans-serif" },
  { id: "inter", label: "Inter", detail: "Clean grotesque UI face when installed; falls back safely.", family: "Inter, ui-sans-serif, sans-serif" },
  { id: "plex", label: "IBM Plex Sans", detail: "Friendly, readable sans for long task notes.", family: "'IBM Plex Sans', ui-sans-serif, sans-serif" },
  { id: "georgia", label: "Georgia", detail: "Readable serif for people who prefer book-like text.", family: "Georgia, serif" },
  { id: "mono", label: "Monospace", detail: "Everything in a code face, for the terminal-minded.", family: "var(--font-mono)" },
];

export function AppearanceSection({ patch }: { patch: Patch }) {
  const [appearance] = usePersistentState<AppearanceSettings>(APPEARANCE_KEY, DEFAULT_APPEARANCE);
  const update = (next: Partial<AppearanceSettings>) => {
    const merged = { ...readAppearance(), ...next };
    markAccentWrite();
    publishAppearance(merged);
    patch({ appearance: merged });
  };
  const toast = useToast();
  const fonts = useRef<HTMLDivElement>(null);
  const reset = () => {
    const before = appearance;
    update(DEFAULT_APPEARANCE);
    toast("Appearance reset to the defaults.", { action: { label: "Undo", run: () => update(before) } });
  };
  const selectedFont = Math.max(0, FONTS.findIndex((font) => font.id === appearance.font));
  const custom = appearance.accentCustom;
  const [theme, setTheme] = useState<"light" | "dark">("dark");
  useEffect(() => {
    const read = () => {
      if (appearance.theme === "light" || appearance.theme === "dark") return appearance.theme;
      return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
    };
    setTheme(read());
    if (appearance.theme !== "system") return;
    const media = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = () => setTheme(read());
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [appearance.theme]);
  const adjusted = custom && /^#[0-9a-fA-F]{6}$/.test(custom) ? resolveAccent(custom, theme, colorThemeSurfaces(appearance.colorTheme, theme)) : null;
  return (
    <SectionCard title="Appearance" description="Saved with your account and in this browser, so the next page does not flash the default. System follows your device.">
      <div data-jump-label="Theme"><Segmented
        label="Mode"
        value={appearance.theme}
        onChange={(theme) => update({ theme })}
        options={[
          { id: "light", label: "Light" },
          { id: "dark", label: "Dark" },
          { id: "system", label: "System" },
        ]}
      /></div>
      <ColorThemePicker appearance={appearance} onChange={(colorTheme) => update({ colorTheme })} />
      <div className="mt-6">
        <div data-jump-label="Accent" className="text-[13px] font-medium">Accent</div>
        <p className="mt-0.5 text-[12.5px] text-muted">Satin Gold is the default. Presets are tuned for dark and light. A custom color keeps text on it readable.</p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {ACCENT_PRESETS.map((preset) => {
            const on = !custom && appearance.accent === preset.id;
            return (
              <button
                key={preset.id}
                type="button"
                aria-label={`Accent ${preset.label}`}
                aria-pressed={on}
                onClick={() => update({ accent: preset.id, accentCustom: null })}
                className={cx("flex items-center gap-2 rounded-full border px-2.5 py-1 text-[13px]", on ? "border-accent bg-accent-soft" : "border-line hover:border-line-strong")}
              >
                <span className="h-3.5 w-3.5 rounded-full" style={{ background: theme === "light" ? preset.light : preset.dark }} />
                {preset.label}
              </button>
            );
          })}
          <label className={cx("flex items-center gap-2 rounded-full border px-2.5 py-1 text-[13px]", custom ? "border-accent bg-accent-soft" : "border-line")}>
            <span className="relative h-3.5 w-3.5 overflow-hidden rounded-full border border-line-strong">
              <input
                type="color"
                aria-label="Custom accent"
                value={custom ?? (ACCENT_PRESETS.find((preset) => preset.id === appearance.accent) ?? ACCENT_PRESETS[0]!)[theme === "light" ? "light" : "dark"]}
                onChange={(event) => update({ accentCustom: event.target.value })}
                className="absolute -left-1 -top-1 h-6 w-6 cursor-pointer border-0 p-0"
              />
            </span>
            Custom
          </label>
        </div>
        {adjusted && custom && adjusted.hex.toLowerCase() !== custom.toLowerCase() ? (
          <p className="mt-2 text-[12px] text-muted">Adjusted so text on it stays readable.</p>
        ) : null}
      </div>
      <div className="mt-6 flex items-center justify-between">
        <h3 className="text-[15px] font-semibold">Text and font</h3>
        <button type="button" className="btn-ghost" onClick={reset}>
          <RotateCcw size={12} /> Reset appearance
        </button>
      </div>
      <p className="text-[12.5px] text-muted">Applies immediately across this browser, persists on reload, and syncs to other open Ensemble tabs.</p>
      <div className="mt-3 text-[13px] font-medium">Text size: {appearance.textScale}%</div>
      <div className="mt-2">
        <Range label="Text size" min={80} max={130} step={5} value={appearance.textScale} onChange={(textScale) => update({ textScale })} />
      </div>
      <p className="mt-1 text-[12px] text-muted">Default is 100%. Use smaller text on large monitors or larger text when reading long notes.</p>
      <div data-jump-label="App font" id="app-font-label" className="mt-4 text-[13px] font-medium">App font</div>
      <div ref={fonts} role="radiogroup" aria-labelledby="app-font-label" className="mt-2 grid max-w-xl gap-2">
        {FONTS.map((font, index) => (
          <button
            key={font.id}
            type="button"
            role="radio"
            aria-checked={index === selectedFont}
            tabIndex={index === selectedFont ? 0 : -1}
            onClick={() => update({ font: font.id })}
            onKeyDown={(event) => {
              const next = radioKeyTarget(event.key, index, FONTS.length);
              if (next === null) return;
              event.preventDefault();
              update({ font: FONTS[next]!.id });
              fonts.current?.querySelectorAll<HTMLButtonElement>("[role=radio]")[next]?.focus();
            }}
            data-active={index === selectedFont || undefined}
            className={cx("tile rounded-md bg-raised px-3 py-2 text-left", index === selectedFont && "!border-accent shadow-[0_0_0_1px_rgb(var(--accent-rgb))]")}
          >
            <div className="flex items-center justify-between text-[13.5px] font-medium">
              {font.label}
              {index === selectedFont ? <Check size={14} className="text-accent" aria-hidden /> : null}
            </div>
            <div className="text-[12px] text-muted">{font.detail}</div>
            <div className="mt-0.5 text-[14px] font-semibold" style={{ fontFamily: font.family }}>
              Plan today, review tomorrow.
            </div>
          </button>
        ))}
      </div>
      <h3 className="mt-7 text-[15px] font-semibold">Navigation</h3>
      <SettingRow title="Auto-collapse sidebar" description="Keep the app icons visible. Move to the sidebar or focus its controls to expand it without moving your page.">
        <Toggle label="Auto-collapse sidebar" checked={appearance.sidebarAutoCollapse} onChange={(sidebarAutoCollapse) => update({ sidebarAutoCollapse })} />
      </SettingRow>
      <SettingRow title="Pages panel position" description="A dedicated browser for pages and their nested pages. On the left, the main navigation becomes an icon rail.">
        <Segmented label="Pages panel position" value={appearance.pagesPanelSide} options={[{ id: "left", label: "Left" }, { id: "right", label: "Right" }]} onChange={(pagesPanelSide) => update({ pagesPanelSide })} />
      </SettingRow>
      <SettingRow title="Reduce motion" description="Match system follows this device. Turn this on to keep motion still even when the device does not ask.">
        <div className="flex items-center gap-2">
          <span className="text-[12px] text-muted">{appearance.reduceMotion ? "Always" : "Match system"}</span>
          <Toggle
            label="Reduce motion"
            checked={appearance.reduceMotion}
            onChange={(reduceMotion) => update({ reduceMotion })}
          />
        </div>
      </SettingRow>
    </SectionCard>
  );
}
