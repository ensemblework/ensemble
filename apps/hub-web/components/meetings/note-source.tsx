"use client";

import { FileText, MessageSquare } from "lucide-react";
import { BrandLogo } from "../connectors/brand-logo";

const LOGO: Record<string, string> = {
  teams: "teams",
  google_meet: "googlemeet",
  zoom: "zoom",
  fireflies: "fireflies",
  fathom: "fathom",
  granola: "granola",
  tldv: "tldv",
  krisp: "krisp",
  jamie: "jamie",
  otter: "otter",
};

/** Where a meeting note came from, as a small mark: the app's logo, a file, or Ensemble's own notes. */
export function NoteSourceMark({ source, label, size = 14 }: { source: string; label: string; size?: number }) {
  const logo = LOGO[source];
  if (logo) return <BrandLogo id={logo} name={label} size={size} decorative />;
  if (source === "transcript") return <FileText size={size} aria-hidden className="note-source-icon" />;
  return <MessageSquare size={size} aria-hidden className="note-source-icon" />;
}
