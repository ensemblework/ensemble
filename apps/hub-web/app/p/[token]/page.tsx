"use client";

import { use } from "react";
import { PublicViewer } from "@/components/sharing/shared-viewer";
import { isBakedParam, useDesktopParam } from "@/lib/desktop-param";

export default function PublicLinkPage({ params }: { params: Promise<{ token: string }> }) {
  const { token: baked } = use(params);
  const token = useDesktopParam(baked);
  if (isBakedParam(token)) return null;
  return <PublicViewer token={token} />;
}
