"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

export function VerificationBanner() {
  const me = useQuery({ queryKey: ["me"], queryFn: api.me, staleTime: 30_000 });
  const resend = useMutation({ mutationFn: api.resendVerification });
  if (!me.data || me.data.verificationRequired !== true) return null;
  return (
    <div role="status" className="border-b border-line bg-panel px-4 py-2 text-[13px]">
      <span>Check your inbox to verify {me.data.user.email} and enable agents and connectors. You can keep using your notes.</span>{" "}
      <button type="button" className="text-accent hover:underline" disabled={resend.isPending || resend.isSuccess} onClick={() => resend.mutate()}>
        {resend.isPending ? "Sending..." : resend.isSuccess ? "Email sent. Check your inbox." : "Resend verification"}
      </button>
      {resend.error ? <span role="alert" className="ml-2 text-[#ffb4ae]">{resend.error.message}</span> : null}
    </div>
  );
}
