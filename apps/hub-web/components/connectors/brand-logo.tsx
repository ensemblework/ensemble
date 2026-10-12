"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { FileSpreadsheet, Plug } from "lucide-react";
import { useEffect, useState } from "react";
import { BRAND_INDEX } from "./brand-index.generated";

/**
 * Connector logos are each vendor's own mark, kept as files in ./brands (sources
 * in brands/manifest.json) and built into two modules by scripts/build-brand-logos.mjs.
 * The images load lazily in one chunk the first time any logo is on screen.
 * `fit: "pad"` marks sit on a white tile; `fit: "fill"` files are already an app icon.
 */
type Images = Readonly<Record<string, string>>;

let images: Images | null = null;
let loading: Promise<Images> | null = null;

/** Loads every logo once. Tests await it so the first render already has pictures. */
export function loadBrandImages(): Promise<Images> {
  if (images) return Promise.resolve(images);
  loading ??= import("./brand-images.generated").then((module) => (images = module.BRAND_IMAGES));
  return loading;
}

function useBrandImages(): Images | null {
  const [value, setValue] = useState<Images | null>(images);
  useEffect(() => {
    if (value) return;
    let live = true;
    void loadBrandImages().then((loaded) => {
      if (live) setValue(loaded);
    });
    return () => {
      live = false;
    };
  }, [value]);
  return value;
}

const ALIASES: Record<string, string> = {
  googleworkspace: "google",
  microsoft365: "microsoft",
  office365: "microsoft",
  microsoftteams: "teams",
  microsoftazure: "azure",
  amazonwebservices: "aws",
  mondaydotcom: "monday",
  githubissues: "github",
};

const GENERIC: Record<string, { name: string; icon: "file" | "plug" }> = {
  csv: { name: "CSV or spreadsheet", icon: "file" },
  file: { name: "File", icon: "file" },
  custom: { name: "Custom connector", icon: "plug" },
  mcp: { name: "Custom connector", icon: "plug" },
};

export type BrandKind = "image" | "generic" | "fallback";

function brandKey(id: string): string {
  const flat = id.toLowerCase().replace(/[^a-z0-9]/g, "");
  return ALIASES[flat] ?? flat;
}

/** Which kind of mark BrandLogo draws for a logo key. */
export function brandKind(id: string): BrandKind {
  const k = brandKey(id);
  if (BRAND_INDEX[k]) return "image";
  if (GENERIC[k]) return "generic";
  return "fallback";
}

/** Readable name for a logo key, used as the accessible label. */
export function brandName(id: string, fallback?: string): string {
  const k = brandKey(id);
  return fallback ?? BRAND_INDEX[k]?.name ?? GENERIC[k]?.name ?? id;
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
  const loaded = useBrandImages();
  const k = brandKey(id);
  const label = brandName(id, name);
  const known = BRAND_INDEX[k];
  const generic = GENERIC[k];
  const kind: BrandKind = known ? "image" : generic ? "generic" : "fallback";
  const a11y = decorative ? { "aria-hidden": true as const } : { role: "img" as const, "aria-label": label };
  const radius = Math.max(4, Math.round(size * 0.24));
  const base = ["inline-flex shrink-0 select-none items-center justify-center overflow-hidden", className ?? ""].join(" ");
  if (known) {
    const src = loaded?.[k];
    const pad = known.fit === "pad";
    const inner = pad ? Math.round(size * 0.68) : size;
    return (
      <span
        {...a11y}
        data-brand={k}
        data-brand-kind={kind}
        className={`${base} ${pad ? "border border-black/10 bg-white" : ""}`}
        style={{ width: size, height: size, borderRadius: radius }}
      >
        {src ? (
          // eslint-disable-next-line @next/next/no-img-element -- a data URI, nothing to optimise.
          <img src={src} alt="" aria-hidden width={inner} height={inner} draggable={false} style={{ width: inner, height: inner, objectFit: "contain" }} />
        ) : null}
      </span>
    );
  }
  const style: React.CSSProperties = { width: size, height: size, borderRadius: radius };
  const tile = `${base} border border-line bg-raised text-muted`;
  if (generic) {
    const Icon = generic.icon === "file" ? FileSpreadsheet : Plug;
    return (
      <span {...a11y} data-brand={k} data-brand-kind={kind} className={tile} style={style}>
        <Icon size={Math.round(size * 0.55)} aria-hidden />
      </span>
    );
  }
  const text = initials(label);
  const fontSize = Math.max(8, Math.round(size * (text.length > 1 ? 0.4 : 0.5)));
  return (
    <span {...a11y} data-brand={k} data-brand-kind={kind} className={`${tile} font-semibold tracking-tight`} style={{ ...style, fontSize, lineHeight: 1 }}>
      {text}
    </span>
  );
}

export const TRADEMARK_NOTICE =
  "Product names, logos and brands are property of their respective owners and are used only to identify the services you can connect. Ensemble is not affiliated with or endorsed by them.";
