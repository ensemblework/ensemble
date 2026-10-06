"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { EnsembleLogo } from "./brand/Logo";

export function AccountRecovery({ mode }: { mode: "forgot" | "reset" | "verify" }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [token, setToken] = useState("");
  useEffect(() => {
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    setToken(fragment.get("token") ?? "");
    window.history.replaceState(null, "", window.location.pathname);
  }, []);
  const action = useMutation({
    mutationFn: async () => {
      if (mode === "forgot") return api.forgotPassword(email);
      if (mode === "reset") return api.resetPassword(token, password);
      return api.verifyEmail(token);
    },
  });
  const title = mode === "forgot" ? "Forgot your password?" : mode === "reset" ? "Set a new password" : "Verify your email";
  const message = mode === "forgot" ? "If an account exists, a reset link has been sent. Check your inbox."
    : mode === "reset" ? "Password updated. Sign in with your new password." : "Email verified. Agents and connectors are now available.";
  return (
    <main className="flex min-h-screen items-center justify-center bg-bg px-4">
      <form className="w-full max-w-md rounded-2xl border border-line bg-panel p-8" onSubmit={(event) => { event.preventDefault(); action.mutate(); }}>
        <EnsembleLogo size={24} />
        <h1 className="mt-6 text-[22px] font-semibold">{title}</h1>
        {action.isSuccess ? <p role="status" className="mt-4 text-[13px]">{message}</p> : (
          <>
            {mode === "forgot" ? (
              <label className="mt-4 block text-[13px]">Email
                <input type="email" required autoComplete="email" className="field mt-1 w-full" value={email} onChange={(event) => setEmail(event.target.value)} />
              </label>
            ) : !token ? <p role="alert" className="mt-4 text-[13px] text-muted">Open the full link from your email. If it expired, request a new one.</p> : null}
            {mode === "reset" ? (
              <label className="mt-4 block text-[13px]">New password
                <input type="password" required minLength={8} maxLength={256} autoComplete="new-password" className="field mt-1 w-full" value={password} onChange={(event) => setPassword(event.target.value)} />
              </label>
            ) : mode === "verify" && token ? <p className="mt-4 text-[13px] text-muted">Confirm that this email belongs to you.</p> : null}
            {action.error ? <p role="alert" className="mt-4 text-[13px] text-[#ffb4ae]">{action.error.message}</p> : null}
            <button type="submit" className="btn-primary mt-5 w-full justify-center" disabled={action.isPending || (mode !== "forgot" && !token)}>
              {action.isPending ? "Working..." : mode === "forgot" ? "Send reset link" : mode === "reset" ? "Update password" : "Verify email"}
            </button>
          </>
        )}
        <Link href={mode === "verify" && action.isSuccess ? "/today" : "/login"} className="mt-5 block text-center text-[13px] text-accent hover:underline">
          {mode === "verify" && action.isSuccess ? "Continue to Ensemble" : "Back to sign in"}
        </Link>
      </form>
    </main>
  );
}
