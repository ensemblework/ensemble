"use client";

import { useParams } from "next/navigation";
import { DiagramEditor } from "@/components/diagrams/editor";
import { isBakedParam, useDesktopParam } from "@/lib/desktop-param";

export default function DiagramPage() {
  const params = useParams<{ id: string }>();
  const id = useDesktopParam(params.id);
  if (isBakedParam(id)) return null;
  return <DiagramEditor id={id} />;
}
