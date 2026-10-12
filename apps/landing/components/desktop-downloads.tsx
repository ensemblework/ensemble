"use client";

import { useEffect, useState } from "react";
import { desktopFiles, desktopUrl, DESKTOP_VERSION, osTabs, type OsId } from "@/lib/download";

function detectOs(): OsId {
  const platform = navigator.platform.toLowerCase();
  const agent = navigator.userAgent.toLowerCase();
  if (platform.includes("win") || agent.includes("windows")) return "windows";
  if (platform.includes("mac") || agent.includes("mac os")) return "mac";
  return "linux";
}

/** One card per system, the visitor's own first, each with its installer as a direct download. */
export function DesktopDownloads() {
  const [mine, setMine] = useState<OsId | null>(null);
  useEffect(() => setMine(detectOs()), []);
  const files = desktopFiles();
  const order = mine ? [mine, ...osTabs.map((tab) => tab.id).filter((id) => id !== mine)] : osTabs.map((tab) => tab.id);
  return (
    <div className="desktop-grid">
      {order.map((id) => {
        const tab = osTabs.find((row) => row.id === id)!;
        return (
          <article key={id} className={`desktop-card${id === mine ? " mine" : ""}`}>
            <div className="desktop-card-head">
              <h3>{tab.label}</h3>
              {id === mine ? <span className="pill">Your system</span> : null}
            </div>
            {files[id].map((file) => (
              <a key={file.file} className={file.primary ? "btn" : "btn btn-ghost"} href={desktopUrl(file.file)} download>
                {file.label}
                <span className="desktop-note">{file.note}</span>
              </a>
            ))}
          </article>
        );
      })}
      <p className="desktop-version">Version {DESKTOP_VERSION}. Every build, with checksums, is on the releases page.</p>
    </div>
  );
}
