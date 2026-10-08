"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { FEATURES } from "@ensemble/shared-types/features";
import { OPTIONAL_MODULES, hasModule, type OptionalModule } from "@ensemble/shared-types/modules";
import { SectionCard, SettingRow, Toggle } from "@/components/ui";
import { api } from "@/lib/api";
import { setFeature } from "@/lib/features";
import { deskIdFromTemplate } from "@/components/desk/desks";
import { DESK_EXTRAS, resolveExtras, type DeskExtraId } from "@/lib/desk-extras";
import { layoutKey, readLayout } from "@/components/desk/layout";
import { useToast } from "@/components/toast";

export function FeaturesSection() {
  const client = useQueryClient();
  const toast = useToast();
  const shell = useQuery({ queryKey: ["shell"], queryFn: api.shell, staleTime: 30_000 });
  const prefs = useQuery({ queryKey: ["preferences"], queryFn: api.preferences, staleTime: 30_000 });
  const [busy, setBusy] = useState<OptionalModule | null>(null);
  const [extraBusy, setExtraBusy] = useState<DeskExtraId | null>(null);
  const deskId = deskIdFromTemplate(shell.data?.activeTemplateId ?? null);
  const extraValue = prefs.data?.preferences.find((row) => row.key === "desk.extras")?.value;
  const extras = resolveExtras(deskId, prefs.isSuccess ? extraValue : undefined);
  const toggle = async (id: OptionalModule, on: boolean) => {
    setBusy(id);
    try {
      await setFeature(client, id, on);
      if (on) window.dispatchEvent(new CustomEvent("ensemble:feature-tour", { detail: { id } }));
    } catch (error) {
      toast((error as Error).message, { tone: "error" });
    } finally {
      setBusy(null);
    }
  };
  const toggleExtra = async (id: DeskExtraId, on: boolean) => {
    setExtraBusy(id);
    try {
      const next = new Set(extras);
      if (on) next.add(id);
      else next.delete(id);
      const saved = await api.putPreference("desk.extras", [...next]);
      const writes = [saved.preference];
      // A saved Today layout lists tiles by key, so the switch also shows or hides the tile there.
      const tile = DESK_EXTRAS.find((extra) => extra.id === id)?.tile;
      const layout = deskId && tile ? readLayout(prefs.data?.preferences.find((row) => row.key === layoutKey(deskId))?.value) : null;
      if (deskId && tile && layout) {
        const hidden = on ? layout.hidden.filter((key) => key !== tile) : [...new Set([...layout.hidden, tile])];
        const tiles = on ? layout.tiles : layout.tiles.filter((row) => row.key !== tile);
        writes.push((await api.putPreference(layoutKey(deskId), { ...layout, tiles, hidden })).preference);
      }
      client.setQueryData<{ preferences: Array<{ key: string; value: unknown }> }>(["preferences"], (current) => {
        const keys = new Set(writes.map((row) => row.key));
        const list = current?.preferences ?? [];
        return { preferences: [...list.filter((row) => !keys.has(row.key)), ...writes] };
      });
    } catch (error) {
      toast((error as Error).message, { tone: "error" });
    } finally {
      setExtraBusy(null);
    }
  };
  return (
    <SectionCard
      title="Features"
      description="Turn a part of Ensemble on or off. Turning one off hides it. Notes, diagrams, and reviews stay where they are."
    >
      <div data-features>
        {OPTIONAL_MODULES.map((id) => {
          const feature = FEATURES[id];
          const on = hasModule(shell.data?.modules, id);
          return (
            <SettingRow key={id} title={feature.label} description={feature.line}>
              <Toggle
                checked={on}
                disabled={!shell.data || busy === id}
                label={feature.label}
                onChange={(value) => void toggle(id, value)}
              />
            </SettingRow>
          );
        })}
      </div>
      <div className="mt-4 border-t border-line pt-3" data-desk-extras>
        <div className="text-[13px] font-medium">Desk extras</div>
        <p className="mt-0.5 text-[12.5px] text-muted">Optional tiles any desk can turn on. Turning one off hides it. The rows stay.</p>
        {DESK_EXTRAS.map((extra) => (
          <SettingRow key={extra.id} title={extra.label} description={extra.line}>
            <Toggle
              checked={extras.has(extra.id)}
              disabled={!prefs.isSuccess || extraBusy === extra.id}
              label={extra.label}
              onChange={(value) => void toggleExtra(extra.id, value)}
            />
          </SettingRow>
        ))}
      </div>
    </SectionCard>
  );
}
