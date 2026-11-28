"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { SectionCard, SettingRow, Toggle } from "@/components/ui";
import { useToast } from "@/components/toast";
import { hideTile, showTile } from "@/components/desk/layout";
import { api } from "@/lib/api";
import { usePreferenceWrite } from "@/lib/preference-write";
import { RECAP_LAYOUT_KEY, RECAP_TILES, recapArrangement, type RecapTileKey } from "./layout";

/** Settings › Account › Weekly recap: which tiles the recap shows. Order and width are changed on the recap itself. */
export function RecapTilesSection() {
  const toast = useToast();
  const prefs = useQuery({ queryKey: ["preferences"], queryFn: api.preferences, staleTime: 30_000 });
  const write = usePreferenceWrite(RECAP_LAYOUT_KEY);
  const [busy, setBusy] = useState<RecapTileKey | "reset" | null>(null);
  const { layout, shown, hidden } = recapArrangement(prefs.data?.preferences.find((row) => row.key === RECAP_LAYOUT_KEY)?.value);
  const on = new Set(shown.map((spec) => spec.key));
  const save = async (which: RecapTileKey | "reset", next: Parameters<typeof write>[0]) => {
    setBusy(which);
    try {
      await write(next);
    } catch (error) {
      toast((error as Error).message, { tone: "error" });
    } finally {
      setBusy(null);
    }
  };
  const arranged = { shown, hidden: hidden.map((spec) => spec.key) };
  return (
    <SectionCard
      title="Weekly recap"
      description="Choose the tiles on your weekly recap."
      info="Move a tile or change its width on the recap itself, with the grip and the corner or its ⋯ menu. A tile with nothing to show that week stays out of the way."
      actions={layout ? <button type="button" className="btn" disabled={!prefs.isSuccess || busy !== null} onClick={() => void save("reset", null)}>Reset layout</button> : undefined}
    >
      <div data-recap-tiles className="divide-y divide-[var(--line)]">
        {RECAP_TILES.map((spec) => (
          <SettingRow key={spec.key} title={spec.title}>
            <Toggle
              label={`Show ${spec.title}`}
              checked={on.has(spec.key)}
              disabled={!prefs.isSuccess || busy !== null}
              onChange={(value) => void save(spec.key, value ? showTile(arranged, spec) : hideTile(arranged, spec.key))}
            />
          </SettingRow>
        ))}
      </div>
    </SectionCard>
  );
}
