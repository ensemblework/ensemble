"use client";

import { Check, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { AppearanceSettings } from "@ensemble/shared-types";
import { colorThemeSurfaces } from "@/lib/color-themes";
import { ColorThemePicker } from "./color-theme-picker";
import { DoodlePicker } from "./doodle-picker";
import { ACCENT_PRESETS, resolveAccent } from "@/lib/accent";
import { APPEARANCE_KEY, DEFAULT_APPEARANCE, markAccentWrite, publishAppearance, readAppearance, usePersistentState } from "@/lib/prefs";
import { radioKeyTarget } from "@/lib/radio-keys";
import { useToast } from "../toast";
import { InfoTip, Range, SectionCard, Segmented, SettingRow, Toggle, cx } from "../ui";

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
  const swatch = (preset: (typeof ACCENT_PRESETS)[number]) => (theme === "light" ? preset.light : preset.dark);
  return (
    <div className="space-y-5">
      <SectionCard title="Theme" description="Light or dark, the palette, the pattern behind your work and the accent." info="Applies at once in this browser, stays after a reload, and reaches your other open Ensemble tabs.">
        <SettingRow title="Mode" description={appearance.theme === "system" ? `Follows this device: ${theme} now.` : `Always ${appearance.theme}.`}>
          <Segmented
            label="Mode"
            value={appearance.theme}
            onChange={(theme) => update({ theme })}
            options={[
              { id: "light", label: "Light" },
              { id: "dark", label: "Dark" },
              { id: "system", label: "System" },
            ]}
          />
        </SettingRow>
        <ColorThemePicker appearance={appearance} onChange={(colorTheme) => update({ colorTheme })} />
        <DoodlePicker value={appearance.doodle ?? "theme"} onChange={(doodle) => update({ doodle })} />
        <div className="mt-6" data-jump-label="Accent">
          <div className="flex items-center gap-1.5">
            <h3 className="text-[14px] font-[550]">Accent</h3>
            <InfoTip text="Satin Gold is the default. Presets are tuned for dark and light. A custom color is adjusted so text on it stays readable." />
          </div>
          <p className="mt-[3px] text-[12px] text-muted">The highlight on buttons, selections and focus.</p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
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
                  <span className="h-3.5 w-3.5 rounded-full" style={{ background: swatch(preset) }} />
                  {preset.label}
                </button>
              );
            })}
            <label className={cx("flex items-center gap-2 rounded-full border px-2.5 py-1 text-[13px]", custom ? "border-accent bg-accent-soft" : "border-line hover:border-line-strong")}>
              <span className="relative h-3.5 w-3.5 overflow-hidden rounded-full border border-line-strong">
                <input
                  type="color"
                  aria-label="Custom accent"
                  value={custom ?? swatch(ACCENT_PRESETS.find((preset) => preset.id === appearance.accent) ?? ACCENT_PRESETS[0]!)}
                  onChange={(event) => update({ accentCustom: event.target.value })}
                  className="absolute -left-1 -top-1 h-6 w-6 cursor-pointer border-0 p-0"
                />
              </span>
              Custom
            </label>
          </div>
          {adjusted && custom && adjusted.hex.toLowerCase() !== custom.toLowerCase() ? <p className="mt-2 text-[12px] text-muted">Adjusted so text on it stays readable.</p> : null}
        </div>
      </SectionCard>

      <SectionCard title="Text" description="Size and typeface for this browser.">
        <div className="divide-y divide-[var(--line)]">
          <SettingRow title="Text size" description={appearance.textScale === 100 ? "The default." : "The default is 100%."}>
            <div className="flex w-56 max-w-full items-center gap-3">
              <div className="min-w-0 flex-1">
                <Range label="Text size" min={80} max={130} step={5} value={appearance.textScale} onChange={(textScale) => update({ textScale })} />
              </div>
              <span className="w-10 shrink-0 text-right text-[12.5px] tabular-nums text-muted" aria-hidden>
                {appearance.textScale}%
              </span>
            </div>
          </SettingRow>
          <div className="py-3">
            <div data-jump-label="App font" id="app-font-label" className="text-[13.5px] font-medium">
              App font
            </div>
            <div ref={fonts} role="radiogroup" aria-labelledby="app-font-label" className="mt-2.5 grid gap-2 sm:grid-cols-2">
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
                  <div className="truncate text-[12px] text-muted">{font.detail}</div>
                  <div className="mt-0.5 truncate text-[14px] font-semibold" style={{ fontFamily: font.family }}>
                    Plan today, review tomorrow.
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>
      </SectionCard>

      <SectionCard title="Layout and motion" description="How the sidebar, panels and menus behave in this browser.">
        <div className="divide-y divide-[var(--line)]">
          <SettingRow title="Auto-collapse sidebar" description="An icon rail that opens when you point at it." info="Keep an icon rail; hover or focus to expand it.">
            <Toggle label="Auto-collapse sidebar" checked={appearance.sidebarAutoCollapse} onChange={(sidebarAutoCollapse) => update({ sidebarAutoCollapse })} />
          </SettingRow>
          <SettingRow title="Pages panel position" description="Which side the Pages browser opens on." info="The left position keeps main navigation as an icon rail.">
            <Segmented label="Pages panel position" value={appearance.pagesPanelSide} options={[{ id: "left", label: "Left" }, { id: "right", label: "Right" }]} onChange={(pagesPanelSide) => update({ pagesPanelSide })} />
          </SettingRow>
          <SettingRow title="Ensemble's right-click menu" description="Actions for text, blocks, cards and pages." info="Actions for what you right-click: text, blocks, cards, pages. Off, the browser's own menu shows instead. Shift + right-click always gives the browser's.">
            <Toggle label="Ensemble's right-click menu" checked={appearance.contextMenu !== false} onChange={(contextMenu) => update({ contextMenu })} />
          </SettingRow>
          <SettingRow title="Reduce motion" description={appearance.reduceMotion ? "On: animation is kept to a minimum." : "Off: follows this device's setting."} info="Reduce animation here, whatever the device says.">
            <Toggle label="Reduce motion" checked={appearance.reduceMotion} onChange={(reduceMotion) => update({ reduceMotion })} />
          </SettingRow>
        </div>
      </SectionCard>

      <div className="flex justify-end">
        <button type="button" className="btn-ghost text-[12.5px]" onClick={reset}>
          <RotateCcw size={12} /> Reset appearance
        </button>
      </div>
    </div>
  );
}
