"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";

/** A season ends in the open. Nothing switches back until they ask. */
export function SeasonBanner() {
  const router = useRouter();
  const client = useQueryClient();
  const shell = useQuery({ queryKey: ["shell"], queryFn: api.shell, staleTime: 30_000 });
  const ended = shell.data?.seasonEnded;
  const back = useMutation({
    mutationFn: () => api.revertTemplate(),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["shell"] });
      await client.invalidateQueries({ queryKey: ["layout"] });
      router.push("/today?applied=1");
      router.refresh();
    },
  });
  if (!ended) return null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-panel/80 px-4 py-2 text-[13px]">
      <p>
        <span className="font-medium">{ended.name}</span> has ended.
      </p>
      <button type="button" className="btn" disabled={back.isPending} onClick={() => back.mutate()}>
        Switch back
      </button>
    </div>
  );
}
