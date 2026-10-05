"use client";

import { use, useEffect, useState } from "react";
import { NotePage } from "@/components/pages/note-page";
import { isBakedParam, useDesktopParam } from "@/lib/desktop-param";

export default function StandaloneNotePage({ params }: { params: Promise<{ id: string }> }) {
  const { id: baked } = use(params);
  const id = useDesktopParam(baked);
  const [focusTitle, setFocusTitle] = useState(false);
  useEffect(() => {
    const focus = new URLSearchParams(window.location.search).get("focus");
    setFocusTitle(focus === "title");
  }, [id]);
  if (isBakedParam(id)) return null;
  return <NotePage pageId={id} focusTitle={focusTitle} />;
}
