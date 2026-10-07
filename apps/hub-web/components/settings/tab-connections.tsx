"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { Settings } from "@ensemble/shared-types";
import { ConnectionsOverview } from "@/components/connectors/featured";
import { ImportLauncher } from "@/components/connectors/import-launcher";
import { RecentImports } from "@/components/imports/recent-imports";
import { importsApi } from "@/lib/api-imports";
import { ConnectorStore } from "@/components/connectors/store-dialog";
import { DevicesSection } from "./devices";
import { FetchSection } from "./fetching";
import { EditorsSection } from "./setup";
import { navigateSettings, useSettingsLocation } from "./url-state";

type Plain = Record<string, unknown>;

export function ConnectionsTab({ settings, patch }: { settings: Settings; patch: (value: Plain) => void }) {
  const location = useSettingsLocation();
  const [importing, setImporting] = useState<{ source?: string } | null>(null);
  return (
    <>
      <div id="connections" className="scroll-mt-6">
        <ConnectionsOverview
          onOpenConnector={(id) => navigateSettings({ connector: id, store: null })}
          onBrowse={(category) => navigateSettings({ store: category ?? "all", connector: null })}
          onImport={() => setImporting({})}
          onCustom={() => navigateSettings({ connector: "custom", store: null })}
        />
      </div>
      <div id="imports" className="scroll-mt-6 empty:hidden">
        <ImportsCard onImport={() => setImporting({})} />
      </div>
      <div id="fetch" className="scroll-mt-6">
        <FetchSection settings={settings} patch={patch} />
      </div>
      <div id="editors" className="scroll-mt-6">
        <span id="connect" className="block scroll-mt-6" aria-hidden />
        <EditorsSection />
      </div>
      <div id="devices" className="scroll-mt-6">
        <DevicesSection />
      </div>
      <ConnectorStore
        open={Boolean(location.store || location.connector)}
        category={location.store}
        connectorId={location.connector}
        settings={settings}
        patch={patch}
        onNavigate={(view) => navigateSettings(view)}
        onClose={() => navigateSettings({ store: null, connector: null })}
        onImport={(source) => setImporting({ source })}
      />
      <ImportLauncher open={importing !== null} source={importing?.source} onClose={() => setImporting(null)} />
    </>
  );
}

/** Recent imports, shown once there is one so Settings stays short. */
function ImportsCard({ onImport }: { onImport: () => void }) {
  const jobs = useQuery({ queryKey: ["imports"], queryFn: importsApi.jobs, retry: false });
  if (!jobs.data?.jobs.length) return null;
  return (
    <div className="tile section">
      <RecentImports limit={3} onImport={onImport} />
    </div>
  );
}
