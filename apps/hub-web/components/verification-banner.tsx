"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { api } from "@/lib/api";

export function VerificationBanner() {
  const me = useQuery({ queryKey: ["me"], queryFn: api.me, staleTime: 30_000 });
  const resend = useMutation({ mutationFn: api.resendVerification });
  if (!me.data || me.data.verificationRequired !== true) return null;
  return (
    <div role="status" className="border-b border-line bg-panel px-4 py-2 text-[13px]">
      <span>Enter the code we emailed to {me.data.user.email} to enable agents and connectors. You can keep using your notes.</span>{" "}
      <Link href="/verify" className="text-accent hover:underline">Enter code</Link>{" "}
      <button type="button" className="text-accent hover:underline" disabled={resend.isPending || resend.isSuccess} onClick={() => resend.mutate()}>
        {resend.isPending ? "Sending..." : resend.isSuccess ? "Sent" : "Send a new code"}
      </button>
      {resend.error ? <span role="alert" className="ml-2 text-[#ffb4ae]">{resend.error.message}</span> : null}
    </div>
  );
}
