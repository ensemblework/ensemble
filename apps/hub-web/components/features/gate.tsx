"use client";

import { useQuery } from "@tanstack/react-query";
import { usePathname } from "next/navigation";
import { useEffect, useSyncExternalStore } from "react";
import { hasModule, moduleForPath, type OptionalModule } from "@ensemble/shared-types/modules";
import { SkeletonRows } from "@/components/ui";
import { api } from "@/lib/api";
import { readModuleCache, syncModuleCache } from "@/lib/tab-session";
import { FeatureLanding } from "./landing";

function Closed({ title, detail, onRetry }: { title: string; detail: string; onRetry?: () => void }) {
  return (
    <div className="mx-auto max-w-md px-6 pt-16">
      <h1 className="text-[18px] font-semibold">{title}</h1>
      <p className="mt-2 text-[14px] text-muted">{detail}</p>
      {onRetry ? (
        <button type="button" className="btn mt-4" onClick={onRetry}>
          Try again
        </button>
      ) : null}
    </div>
  );
}

/** A module that is off stays on its own URL and shows an enable landing. The real page does not mount. */
export function FeatureGate({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const shell = useQuery({ queryKey: ["shell"], queryFn: api.shell, staleTime: 30_000 });
  // Per space: two spaces of one account can have different modules.
  const userId = shell.data?.space?.id ?? shell.data?.user.id ?? null;
  const cached = useSyncExternalStore(
    () => () => {},
    () => (typeof window === "undefined" ? null : readModuleCache(window.sessionStorage, userId)),
    () => null,
  );
  useEffect(() => {
    const owner = shell.data?.space?.id ?? shell.data?.user.id;
    if (!owner) return;
    syncModuleCache(window.sessionStorage, owner, shell.data?.modules ?? "");
  }, [shell.data]);
  let gate: OptionalModule | null = null;
  try {
    gate = moduleForPath(pathname);
  } catch {
    return <Closed title="That address isn't valid." detail="Check the link and try again." />;
  }
  if (!gate) return children;
  const modules = shell.data ? (shell.data.modules ?? "") : cached;
  if (modules == null) {
    if (shell.isError) {
      return (
        <Closed
          title="Couldn't check features"
          detail="Ensemble didn't answer, so this page stays closed."
          onRetry={() => void shell.refetch()}
        />
      );
    }
    return (
      <div className="mx-auto max-w-[760px] px-8 pt-8">
        <SkeletonRows count={5} />
      </div>
    );
  }
  if (!hasModule(modules, gate)) return <FeatureLanding id={gate} />;
  return children;
}
