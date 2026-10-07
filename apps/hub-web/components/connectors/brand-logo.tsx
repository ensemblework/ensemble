"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { FileSpreadsheet, Plug } from "lucide-react";
import type { SimpleIcon } from "simple-icons";
import {
  siAirtable,
  siAsana,
  siAtlassian,
  siBox,
  siCaldotcom,
  siCalendly,
  siClickup,
  siCloudflare,
  siConfluence,
  siDiscord,
  siDropbox,
  siFigma,
  siGithub,
  siGitlab,
  siGmail,
  siGoogle,
  siGooglecalendar,
  siGoogledocs,
  siGoogledrive,
  siGooglemeet,
  siGooglesheets,
  siGoogleslides,
  siGrafana,
  siHubspot,
  siHuggingface,
  siIntercom,
  siJira,
  siLinear,
  siLoom,
  siMiro,
  siNotion,
  siSentry,
  siStripe,
  siSupabase,
  siTodoist,
  siTrello,
  siVercel,
  siWebflow,
  siZapier,
  siZoom,
  siEvernote,
  siGreenhouse,
  siMixpanel,
  siPaypal,
  siPosthog,
  siQuickbooks,
  siWhatsapp,
} from "simple-icons";

/**
 * Logos come from simple-icons (CC0), imported one by one so the bundle carries
 * only these paths. Brands whose owners had simple-icons remove them (every
 * Microsoft product, Slack, AWS and others) get a plain monogram tile in the
 * brand colour instead. Never draw an imitation of a removed mark here.
 */
const ICONS: Record<string, SimpleIcon> = {
  airtable: siAirtable,
  asana: siAsana,
  atlassian: siAtlassian,
  box: siBox,
  calendly: siCalendly,
  clickup: siClickup,
  cloudflare: siCloudflare,
  confluence: siConfluence,
  discord: siDiscord,
  dropbox: siDropbox,
  figma: siFigma,
  github: siGithub,
  gitlab: siGitlab,
  gmail: siGmail,
  google: siGoogle,
  googlecalendar: siGooglecalendar,
  googledocs: siGoogledocs,
  googledrive: siGoogledrive,
  googlemeet: siGooglemeet,
  googlesheets: siGooglesheets,
  googleslides: siGoogleslides,
  grafana: siGrafana,
  hubspot: siHubspot,
  huggingface: siHuggingface,
  intercom: siIntercom,
  jira: siJira,
  linear: siLinear,
  loom: siLoom,
  miro: siMiro,
  notion: siNotion,
  sentry: siSentry,
  stripe: siStripe,
  supabase: siSupabase,
  todoist: siTodoist,
  trello: siTrello,
  vercel: siVercel,
  webflow: siWebflow,
  zapier: siZapier,
  zoom: siZoom,
  caldotcom: siCaldotcom,
  evernote: siEvernote,
  greenhouse: siGreenhouse,
  mixpanel: siMixpanel,
  paypal: siPaypal,
  posthog: siPosthog,
  quickbooks: siQuickbooks,
  whatsapp: siWhatsapp,
};

type Monogram = { name: string; text: string; hex?: string };

/** Brands simple-icons does not carry. `hex` is the brand's primary colour; without one the tile is neutral. */
const MONOGRAMS: Record<string, Monogram> = {
  microsoft: { name: "Microsoft 365", text: "M", hex: "0078D4" },
  outlook: { name: "Outlook", text: "O", hex: "0078D4" },
  teams: { name: "Microsoft Teams", text: "T", hex: "5059C9" },
  onedrive: { name: "OneDrive", text: "OD", hex: "0078D4" },
  azure: { name: "Microsoft Azure", text: "Az", hex: "0078D4" },
  slack: { name: "Slack", text: "S", hex: "4A154B" },
  aws: { name: "Amazon Web Services", text: "AWS", hex: "232F3E" },
  docusign: { name: "DocuSign", text: "DS", hex: "4C00FF" },
  canva: { name: "Canva", text: "C", hex: "00C4CC" },
  monday: { name: "monday.com", text: "m", hex: "6161FF" },
  granola: { name: "Granola", text: "G" },
  linkedin: { name: "LinkedIn", text: "in", hex: "0A66C2" },
  // Meeting tools. simple-icons' "Fathom" is Fathom Analytics, a different company, so the recorder gets a tile too.
  fireflies: { name: "Fireflies.ai", text: "F" },
  fathom: { name: "Fathom", text: "F" },
  tldv: { name: "tl;dv", text: "tl" },
  krisp: { name: "Krisp", text: "K" },
  jamie: { name: "Jamie", text: "J" },
  otter: { name: "Otter.ai", text: "O" },
  readai: { name: "Read AI", text: "R" },
  avoma: { name: "Avoma", text: "A" },
  gong: { name: "Gong", text: "G" },
  grain: { name: "Grain", text: "G" },
  fellow: { name: "Fellow", text: "F" },
  supernormal: { name: "Supernormal", text: "S" },
  meetgeek: { name: "MeetGeek", text: "MG" },
  bluedot: { name: "Bluedot", text: "B" },
  tactiq: { name: "Tactiq", text: "T" },
  salesforce: { name: "Salesforce", text: "SF", hex: "00A1E0" },
  readwise: { name: "Readwise", text: "R" },
  guru: { name: "Guru", text: "G" },
  gamma: { name: "Gamma", text: "G" },
  pitch: { name: "Pitch", text: "P" },
  pipedrive: { name: "Pipedrive", text: "P" },
  attio: { name: "Attio", text: "A" },
  close: { name: "Close", text: "C" },
  customerio: { name: "Customer.io", text: "C" },
  amplitude: { name: "Amplitude", text: "A" },
  ashby: { name: "Ashby", text: "A" },
  zendesk: { name: "Zendesk", text: "Z" },
  front: { name: "Front", text: "F" },
  xero: { name: "Xero", text: "X" },
};

const ALIASES: Record<string, string> = {
  googleworkspace: "google",
  microsoft365: "microsoft",
  office365: "microsoft",
  microsoftteams: "teams",
  microsoftazure: "azure",
  amazonwebservices: "aws",
  mondaydotcom: "monday",
};

const GENERIC: Record<string, { name: string; icon: "file" | "plug" }> = {
  csv: { name: "CSV or spreadsheet", icon: "file" },
  file: { name: "File", icon: "file" },
  custom: { name: "Custom connector", icon: "plug" },
  mcp: { name: "Custom connector", icon: "plug" },
};

export type BrandKind = "icon" | "monogram" | "generic" | "fallback";

function brandKey(id: string): string {
  const flat = id.toLowerCase().replace(/[^a-z0-9]/g, "");
  return ALIASES[flat] ?? flat;
}

/** Which kind of mark BrandLogo draws for a logo key. */
export function brandKind(id: string): BrandKind {
  const k = brandKey(id);
  if (ICONS[k]) return "icon";
  if (MONOGRAMS[k]) return "monogram";
  if (GENERIC[k]) return "generic";
  return "fallback";
}

/** Readable name for a logo key, used as the accessible label. */
export function brandName(id: string, fallback?: string): string {
  const k = brandKey(id);
  return fallback ?? ICONS[k]?.title ?? MONOGRAMS[k]?.name ?? GENERIC[k]?.name ?? id;
}

export function initials(name: string): string {
  const words = name.replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  const lettered = words.filter((word) => /^\p{L}/u.test(word));
  return (lettered.length ? lettered : words)
    .slice(0, 2)
    .map((word) => word[0]!.toUpperCase())
    .join("");
}

/** Dark text on light brand colours, white on dark ones (relative luminance). */
function inkFor(hex: string): string {
  const channel = (offset: number) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
  return luminance > 0.45 ? "#1c1915" : "#ffffff";
}

/**
 * The logo for a connector (`entry.logo`). Pass `decorative` when the brand name
 * is written right beside it, so screen readers do not hear it twice.
 */
export function BrandLogo({
  id,
  size = 28,
  name,
  decorative = false,
  className,
}: {
  id: string;
  size?: number;
  /** Label, and the initials source when the key is unknown. */
  name?: string;
  decorative?: boolean;
  className?: string;
}) {
  const k = brandKey(id);
  const label = brandName(id, name);
  const icon = ICONS[k];
  const monogram = MONOGRAMS[k];
  const generic = GENERIC[k];
  const hex = icon?.hex ?? monogram?.hex;
  const kind: BrandKind = icon ? "icon" : monogram ? "monogram" : generic ? "generic" : "fallback";
  const a11y = decorative ? { "aria-hidden": true as const } : { role: "img" as const, "aria-label": label };
  const style: React.CSSProperties = {
    width: size,
    height: size,
    borderRadius: Math.max(4, Math.round(size * 0.24)),
    ...(hex ? { background: `#${hex}`, color: inkFor(hex), boxShadow: "inset 0 0 0 1px rgb(255 255 255 / 0.1)" } : {}),
  };
  const base = [
    "inline-flex shrink-0 select-none items-center justify-center overflow-hidden",
    hex ? "" : "border border-line bg-raised text-muted",
    className ?? "",
  ].join(" ");
  if (icon) {
    const glyph = Math.round(size * 0.58);
    return (
      <span {...a11y} data-brand={k} data-brand-kind={kind} className={base} style={style}>
        <svg viewBox="0 0 24 24" width={glyph} height={glyph} fill="currentColor" aria-hidden focusable="false">
          <path d={icon.path} />
        </svg>
      </span>
    );
  }
  if (generic) {
    const Icon = generic.icon === "file" ? FileSpreadsheet : Plug;
    return (
      <span {...a11y} data-brand={k} data-brand-kind={kind} className={base} style={style}>
        <Icon size={Math.round(size * 0.55)} aria-hidden />
      </span>
    );
  }
  const text = monogram?.text ?? initials(label);
  const fontSize = Math.max(8, Math.round(size * (text.length > 2 ? 0.3 : text.length > 1 ? 0.4 : 0.5)));
  return (
    <span {...a11y} data-brand={k} data-brand-kind={kind} className={`${base} font-semibold tracking-tight`} style={{ ...style, fontSize, lineHeight: 1 }}>
      {text}
    </span>
  );
}

export const TRADEMARK_NOTICE =
  "Product names, logos and brands are property of their respective owners and are used only to identify the services you can connect. Ensemble is not affiliated with or endorsed by them.";
