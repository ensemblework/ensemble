"use client";

import { use } from "react";
import { FileScreen } from "@/components/files/file-screen";
import { isBakedParam, useDesktopParam } from "@/lib/desktop-param";

export default function FilePage({ params }: { params: Promise<{ id: string }> }) {
  const { id: baked } = use(params);
  const id = useDesktopParam(baked);
  if (isBakedParam(id)) return null;
  return <FileScreen id={id} />;
}
