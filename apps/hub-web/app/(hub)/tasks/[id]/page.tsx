"use client";

import { use } from "react";
import { TaskPage } from "@/components/task/task-page";
import { isBakedParam, useDesktopParam } from "@/lib/desktop-param";

export default function TaskFullPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: baked } = use(params);
  const id = useDesktopParam(baked);
  if (isBakedParam(id)) return null;
  return <TaskPage taskId={id} variant="page" />;
}
