import { notFound } from "next/navigation";
import { BrandStatus } from "@/components/brand/BrandStatus";
import "@/components/brand/brand-pages.css";
import { desktopExport, desktopPlaceholder } from "@/lib/desktop-export";

export function generateStaticParams() {
  return desktopPlaceholder({ slug: ["_"] });
}

/** Every unknown URL is a real route so the hub shell can render the 404. */
export default function UnknownPage() {
  if (desktopExport()) return <BrandStatus kind="404" shell />;
  notFound();
}
