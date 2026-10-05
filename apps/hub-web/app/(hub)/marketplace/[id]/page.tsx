import { desktopPlaceholder } from "@/lib/desktop-export";
import { MarketplaceDetail } from "./detail";

export function generateStaticParams() {
  return desktopPlaceholder({ id: "_" });
}

export default async function MarketplaceTemplatePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <MarketplaceDetail id={id} />;
}
