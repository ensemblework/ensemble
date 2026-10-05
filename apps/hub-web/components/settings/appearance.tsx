"use client";

import { RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";
import type { AppearanceSettings, MotionTheme } from "@ensemble/shared-types";
import { ACCENT_PRESETS, resolveAccent } from "@/lib/accent";
import { APPEARANCE_KEY, DEFAULT_APPEARANCE, markAccentWrite, publishAppearance, usePersistentState } from "@/lib/prefs";
import { ThinkingStatus } from "@/components/motion/slot";
import { Range, SectionCard, Segmented, SettingRow, Toggle, cx } from "../ui";

const MOTION_CHOICES: Array<{ id: MotionTheme; label: string; detail: string }> = [
  { id: "expressive", label: "Expressive", detail: "Springs, braids and the Ensemble glyph. The default." },
  { id: "minimal-quiet", label: "Minimal · Quiet", detail: "Hairline strokes and one accent. Nothing overshoots." },
  { id: "minimal-dot", label: "Minimal · Dot", detail: "Two dots and at most one line." },
];

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
    const merged = { ...appearance, ...next };
    markAccentWrite();
    publishAppearance(merged);
    patch({ appearance: merged });
  };
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
  const adjusted = custom && /^#[0-9a-fA-F]{6}$/.test(custom) ? resolveAccent(custom, theme) : null;
  const [autoNote, setAutoNote] = useState(false);
  useEffect(() => {
    try {
      setAutoNote(sessionStorage.getItem("ensemble.motion.auto") === "1");
    } catch {
      setAutoNote(false);
    }
  }, [appearance.motion, appearance.reduceMotion]);
  const chooseMotion = (motion: MotionTheme) => {
    try {
      sessionStorage.removeItem("ensemble.motion.auto");
    } catch {
      // private mode
    }
    setAutoNote(false);
    update({ motion });
  };
  return (
    <SectionCard title="Appearance" description="Saved with your account and in this browser, so the next page does not flash the default. System follows your device.">
      <Segmented
        label="Theme"
        value={appearance.theme}
        onChange={(theme) => update({ theme })}
        options={[
          { id: "light", label: "Light" },
          { id: "dark", label: "Dark" },
          { id: "system", label: "System" },
        ]}
      />
      <div className="mt-6">
        <div className="text-[13px] font-medium">Accent</div>
        <p className="mt-0.5 text-[12.5px] text-muted">Indigo is the default. Presets are tuned for dark and light. A custom colour keeps text on it readable.</p>
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
        <button type="button" className="btn-ghost" onClick={() => update(DEFAULT_APPEARANCE)}>
          <RotateCcw size={12} /> Reset appearance
        </button>
      </div>
      <p className="text-[12.5px] text-muted">Applies immediately across this browser, persists on reload, and syncs to other open Ensemble tabs.</p>
      <div className="mt-3 text-[13px] font-medium">Text size: {appearance.textScale}%</div>
      <div className="mt-2">
        <Range label="Text size" min={80} max={130} step={5} value={appearance.textScale} onChange={(textScale) => update({ textScale })} />
      </div>
      <p className="mt-1 text-[12px] text-muted">Default is 100%. Use smaller text on large monitors or larger text when reading long notes.</p>
      <div className="mt-4 text-[13px] font-medium">App font</div>
      <div className="mt-2 grid max-w-xl gap-2">
        {FONTS.map((font) => (
          <button
            key={font.id}
            type="button"
            onClick={() => update({ font: font.id })}
            data-active={appearance.font === font.id || undefined}
            className="tile rounded-md bg-raised px-3 py-2 text-left"
          >
            <div className="text-[13.5px] font-medium">{font.label}</div>
            <div className="text-[12px] text-muted">{font.detail}</div>
            <div className="mt-0.5 text-[14px] font-semibold" style={{ fontFamily: font.family }}>
              Plan today, review tomorrow.
            </div>
          </button>
        ))}
      </div>
      <div className="mt-6">
        <div className="text-[13px] font-medium">Motion</div>
        <p className="mt-0.5 text-[12.5px] text-muted">The same moments, three ways. The choice is saved with your account and applies immediately.</p>
        <div className="mt-2 grid gap-2" role="radiogroup" aria-label="Motion">
          {MOTION_CHOICES.map((choice) => {
            const on = (appearance.motion ?? "expressive") === choice.id;
            return (
              <button
                key={choice.id}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => chooseMotion(choice.id)}
                data-active={on || undefined}
                className="tile rounded-md bg-raised px-3 py-2 text-left"
              >
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-[13.5px] font-medium">{choice.label}</div>
                    <div className="text-[12px] text-muted">{choice.detail}</div>
                  </div>
                  {on ? <ThinkingStatus real={null} active /> : null}
                </div>
              </button>
            );
          })}
        </div>
        {autoNote ? <p className="mt-2 text-[12.5px] text-muted">Reduced motion is on because this device asked for it. You can change it here.</p> : null}
      </div>
      <SettingRow title="Reduce motion" description="Match system follows this device. Turn this on to keep motion still even when the device does not ask.">
        <div className="flex items-center gap-2">
          <span className="text-[12px] text-muted">{appearance.reduceMotion ? "Always" : "Match system"}</span>
          <Toggle
            label="Reduce motion"
            checked={appearance.reduceMotion}
            onChange={(reduceMotion) => {
              try {
                sessionStorage.removeItem("ensemble.motion.auto");
              } catch {
                // private mode
              }
              setAutoNote(false);
              update({ reduceMotion });
            }}
          />
        </div>
      </SettingRow>
    </SectionCard>
  );
}
