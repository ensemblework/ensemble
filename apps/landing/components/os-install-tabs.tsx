"use client";

import { useEffect, useId, useState } from "react";
import { CopyCode } from "@/components/copy-code";
import { installChannels, osTabs, type OsId } from "@/lib/download";

function detectOs(): OsId {
  const platform = navigator.platform.toLowerCase();
  const agent = navigator.userAgent.toLowerCase();
  if (platform.includes("win") || agent.includes("windows")) return "windows";
  if (platform.includes("mac") || agent.includes("mac os")) return "mac";
  return "linux";
}

export function OsInstallTabs() {
  const baseId = useId();
  const [active, setActive] = useState<OsId>("mac");
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setActive(detectOs());
    setHydrated(true);
  }, []);

  return (
    <div className="download-tabs">
      <div className="tab-list" role="tablist" aria-label="Install by operating system">
        {osTabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            id={`${baseId}-${tab.id}-tab`}
            role="tab"
            aria-selected={active === tab.id}
            aria-controls={`${baseId}-${tab.id}-panel`}
            className={active === tab.id ? "active" : ""}
            onClick={() => setActive(tab.id)}
            onKeyDown={(event) => {
              const index = osTabs.findIndex((row) => row.id === active);
              if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
                event.preventDefault();
                const delta = event.key === "ArrowRight" ? 1 : -1;
                setActive(osTabs[(index + delta + osTabs.length) % osTabs.length]!.id);
              }
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {osTabs.map((tab) => (
        <div
          key={tab.id}
          id={`${baseId}-${tab.id}-panel`}
          role="tabpanel"
          aria-labelledby={`${baseId}-${tab.id}-tab`}
          hidden={hydrated && active !== tab.id}
          className="tab-panel"
        >
          <div className="install-grid">
            {installChannels[tab.id].map((channel) => (
              <article key={channel.id} className="install-card">
                <div className="install-card-head">
                  <h3>{channel.label}</h3>
                  {channel.status === "coming-soon" ? <span>coming soon</span> : null}
                </div>
                {channel.note ? <p>{channel.note}</p> : null}
                <CopyCode label="Install" code={channel.commands.join("\n")} />
                {channel.uninstall ? <CopyCode label="Uninstall" code={channel.uninstall.join("\n")} /> : null}
              </article>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
