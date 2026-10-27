"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect } from "react";
import { Spinner } from "@/components/ui";

export default function WorkspacePage() {
  const router = useRouter();
  const search = useSearchParams().toString();
  useEffect(() => { router.replace(`/runs${search ? `?${search}` : ""}`, { scroll: false }); }, [router, search]);
  return <div className="flex justify-center p-8" role="status" aria-label="Opening Runs"><Spinner /></div>;
}
