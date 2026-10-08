import type { AppId } from "@/lib/connect/catalog";
import { BRAND_GLYPHS, BRAND_IMAGES } from "./brand-logos";

/** The app's own logo, so each guide is recognisable at a glance. Decorative. */
export function AppMark({ id, size = 28 }: { id: AppId; size?: number }) {
  const image = BRAND_IMAGES[id];
  if (image) {
    // eslint-disable-next-line @next/next/no-img-element -- a data URI, no network request to optimise.
    return <img src={image} width={size} height={size} alt="" aria-hidden className="shrink-0" style={{ width: size, height: size }} />;
  }
  const glyph = BRAND_GLYPHS[id];
  if (!glyph) return <span aria-hidden className="shrink-0 rounded-md bg-hover" style={{ width: size, height: size }} />;
  if (glyph.tile) {
    const inner = Math.round(size * 0.6);
    return (
      <span aria-hidden className="app-mark-tile shrink-0" style={{ width: size, height: size, borderRadius: Math.round(size * 0.24) }}>
        <svg width={inner} height={inner} viewBox={glyph.viewBox ?? "0 0 24 24"}>
          <path fill="#fff" d={glyph.d} />
        </svg>
      </span>
    );
  }
  return (
    <svg width={size} height={size} viewBox={glyph.viewBox ?? "0 0 24 24"} aria-hidden className="shrink-0">
      <path fill={glyph.hex} d={glyph.d} />
    </svg>
  );
}
