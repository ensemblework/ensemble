"use client";

import { use } from "react";
import { SharedViewer } from "@/components/sharing/shared-viewer";
import { isBakedParam, useDesktopParam } from "@/lib/desktop-param";

export default function SharedItemPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: baked } = use(params);
  const id = useDesktopParam(baked);
  if (isBakedParam(id)) return null;
  return <SharedViewer shareId={id} />;
}
