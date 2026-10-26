"use client";

import { use } from "react";
import { ProjectPage } from "@/components/project/project-page";
import { useDesktopParam } from "@/lib/desktop-param";

export default function ProjectRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id: baked } = use(params);
  const id = useDesktopParam(baked);
  return <ProjectPage key={id} id={id} />;
}
