"use client";

import { useEffect, useState } from "react";
import type { SaveConflict } from "@ensemble/shared-types/save-merge";
import { answerSaveChoice, listenSaveChoices, pendingSaveChoice, saveValueLabel } from "@/lib/save-conflict";
import { Dialog } from "./ui";

export function SaveConflictHost() {
  const [conflict, setConflict] = useState<SaveConflict | null>(null);
  useEffect(() => listenSaveChoices(() => setConflict(pendingSaveChoice())), []);
  if (!conflict) return null;
  return <Dialog open title="Choose which version to save" width={680} onClose={() => answerSaveChoice(null)}>
    <p className="mb-4 text-sm text-muted">This changed in another place. Both versions are kept until you choose.</p>
    <div className="max-h-[55dvh] space-y-4 overflow-y-auto">
      {conflict.conflicts.map((clash) => <section key={clash.path.join(".")}>
        <h3 className="mb-2 text-sm font-medium">{clash.path.filter((key, index) => key !== clash.path[index - 1]).join(" › ").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, letter => letter.toUpperCase())}</h3>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-lg border border-line p-3"><h4 className="mb-2 text-sm font-medium">Saved in the other place</h4><pre className="whitespace-pre-wrap break-words font-sans text-sm text-muted">{saveValueLabel(clash.saved)}</pre></div>
          <div className="rounded-lg border border-line p-3"><h4 className="mb-2 text-sm font-medium">Your changes</h4><pre className="whitespace-pre-wrap break-words font-sans text-sm text-muted">{saveValueLabel(clash.yours)}</pre></div>
        </div>
      </section>)}
    </div>
    <div className="mt-5 flex flex-wrap justify-end gap-2">
      <button type="button" className="btn-ghost min-h-11" onClick={() => answerSaveChoice(null)}>Decide later</button>
      <button type="button" className="btn min-h-11" onClick={() => answerSaveChoice("saved")}>Keep saved version</button>
      <button type="button" className="btn-primary min-h-11" onClick={() => answerSaveChoice("yours")}>Save my version</button>
    </div>
  </Dialog>;
}
