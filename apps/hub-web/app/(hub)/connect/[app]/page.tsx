"use client";

import dynamic from "next/dynamic";
import { SkeletonRows } from "@/components/ui";

const Guide = dynamic(() => import("@/components/connect/guide"), {
  loading: () => (
    <div className="mx-auto max-w-[1040px] px-8 pt-8">
      <SkeletonRows count={6} />
    </div>
  ),
});

export default function Page() {
  return <Guide />;
}
