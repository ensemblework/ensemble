import { galleryCards } from "@/lib/market-cards";
import { loadActiveTemplateId } from "@/lib/server-layout";
import { MarketplaceGallery } from "./gallery";

export default async function MarketplacePage() {
  const activeTemplateId = await loadActiveTemplateId();
  return <MarketplaceGallery cards={galleryCards()} activeTemplateId={activeTemplateId} />;
}
