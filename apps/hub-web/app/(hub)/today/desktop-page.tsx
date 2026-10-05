"use client";

import { useEffect, useState } from "react";
import { TodayBody } from "./body";

/** Query flags without `searchParams`, which static export cannot read. */
export function TodayDesktop() {
  const [query, setQuery] = useState<URLSearchParams | null>(null);
  useEffect(() => {
    setQuery(new URLSearchParams(window.location.search));
  }, []);
  const params = query ?? new URLSearchParams();
  return (
    <TodayBody
      persona={null}
      layout={null}
      nudges={null}
      cues={null}
      samples={false}
      plots={params.get("plots") === "1"}
      panel={params.get("panel")}
      apply={params.get("apply") === "1"}
      add={params.get("add") === "1"}
      form={params.get("form")}
    />
  );
}
