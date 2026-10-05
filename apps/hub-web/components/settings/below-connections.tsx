"use client";

import type { Settings } from "@ensemble/shared-types";
import { ConnectPage } from "@/components/connect/connect-page";
import { ConnectionsSection } from "@/components/settings/setup";

type Plain = Record<string, unknown>;

export function ConnectionSettings({ settings, patch }: { settings: Settings; patch: (value: Plain) => void }) {
  const props = { settings, patch };
  return (
    <>
      <h2 className="page-kicker pt-2">Connections</h2>
      <ConnectionsSection {...props} />
      <div id="connect" className="scroll-mt-6"><ConnectPage embedded /></div>
    </>
  );
}
