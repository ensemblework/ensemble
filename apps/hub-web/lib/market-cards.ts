import { templateByMarketId } from "@ensemble/shared-types/marketplace";
import { MARKET_CARDS } from "@ensemble/shared-types/marketplace-manifest";
import { spanFor } from "@ensemble/shared-types/widgets";

export type GalleryCard = {
  id: string;
  persona: string;
  name: string;
  blurb: string;
  removes: string[];
  expiresInDays: number | null;
  accent: string | null;
  preview: Array<{ w: number; h: number }>;
};

/** Server-only. The client receives boxes, not starter rows. */
export function galleryCards(): GalleryCard[] {
  return MARKET_CARDS.map((card) => {
    const template = templateByMarketId(card.id);
    const preview = (template?.layouts.today.placements ?? []).map((row) => {
      const span = spanFor(row.size, 12, false);
      return { w: span.w, h: span.h };
    });
    return {
      id: card.id,
      persona: card.persona,
      name: card.name,
      blurb: card.blurb,
      removes: [...card.removes],
      expiresInDays: card.expiresInDays,
      accent: card.accent,
      preview,
    };
  });
}
