"use client";

import dynamic from "next/dynamic";
import { useParams } from "next/navigation";
import { isBakedParam, useDesktopParam } from "@/lib/desktop-param";
import { useDelayedFlag } from "@/lib/motion/use-delayed-flag";

const Studio = dynamic(() => import("@/components/plots/studio").then((mod) => mod.PlotStudio), {
  ssr: false,
  loading: () => <PlotLoading />,
});

function PlotLoading() {
  const shown = useDelayedFlag(true);
  if (!shown) return <div className="px-8 pt-8" />;
  return <div className="px-8 pt-8 text-[14px] text-muted">Opening the plot…</div>;
}

export default function PlotPage() {
  const params = useParams<{ id: string }>();
  const id = useDesktopParam(params.id);
  if (isBakedParam(id)) return <PlotLoading />;
  return <Studio plotId={id} />;
}
