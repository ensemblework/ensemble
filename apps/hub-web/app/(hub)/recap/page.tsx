"use client";

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { RecapView } from "@/components/recap/recap-view";

/** The weekly recap. `?date=YYYY-MM-DD` opens the Monday-to-Sunday week that contains it. */
function RecapPage() {
  const date = useSearchParams().get("date");
  return <RecapView date={date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null} />;
}

export default function Page() {
  return (
    <Suspense fallback={null}>
      <RecapPage />
    </Suspense>
  );
}
