"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { safeLoginNext } from "@/lib/signup-ui";
import { EnsembleLogo } from "./brand/Logo";

export function AccountRecovery({ mode }: { mode: "forgot" | "reset" | "verify" }) {
  if (mode === "verify") return <EmailCodeVerification />;
  return <PasswordRecovery mode={mode} />;
}

export function verificationSuccessTarget(next: string | null, onboardingComplete: boolean | undefined): string {
  return safeLoginNext(next) ?? (onboardingComplete === false ? "/start" : "/today");
}

function PasswordRecovery({ mode }: { mode: "forgot" | "reset" }) {
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
      return api.resetPassword(token, password);
    },
  });
  const title = mode === "forgot" ? "Forgot your password?" : "Set a new password";
  const message = mode === "forgot" ? "If an account exists, a reset link has been sent. Check your inbox."
    : "Password updated. Sign in with your new password.";
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
            ) : null}
            {action.error ? <p role="alert" className="mt-4 text-[13px] text-[#ffb4ae]">{action.error.message}</p> : null}
            <button type="submit" className="btn-primary mt-5 w-full justify-center" disabled={action.isPending || (mode !== "forgot" && !token)}>
              {action.isPending ? "Working..." : mode === "forgot" ? "Send reset link" : "Update password"}
            </button>
          </>
        )}
        <Link href="/login" className="mt-5 block text-center text-[13px] text-accent hover:underline">
          Back to sign in
        </Link>
      </form>
    </main>
  );
}

function EmailCodeVerification() {
  const [code, setCode] = useState("");
  const me = useQuery({ queryKey: ["me"], queryFn: api.me, retry: false });
  const verify = useMutation({
    mutationFn: () => api.verifyEmail(code),
    onSuccess: () => {
      const next = safeLoginNext(new URLSearchParams(window.location.search).get("next"));
      window.location.href = verificationSuccessTarget(next, me.data?.onboardingComplete);
    },
  });
  const resend = useMutation({ mutationFn: api.resendVerification });
  const signedOut = !me.data && (me.isPending || ((me.error as { status?: number } | null)?.status ?? 401) === 401);
  return (
    <main className="flex min-h-screen items-center justify-center bg-bg px-4">
      <form className="w-full max-w-md rounded-2xl border border-line bg-panel p-8" onSubmit={(event) => { event.preventDefault(); verify.mutate(); }}>
        <EnsembleLogo size={24} />
        <h1 className="mt-6 text-[22px] font-semibold">Enter your verification code</h1>
        {signedOut ? (
          <p role="alert" className="mt-4 text-[13px] text-muted">
            Sign in first to the account you are verifying.{" "}
            <Link href="/login?next=/verify" className="text-accent hover:underline">Sign in first</Link>
          </p>
        ) : (
          <>
            <p className="mt-3 text-[13px] text-muted">
              We emailed a 4-character code{me.data?.user.email ? <> to <span className="font-medium text-ink">{me.data.user.email}</span></> : null}.
            </p>
            <input
              aria-label="Verification code"
              autoComplete="one-time-code"
              inputMode="text"
              maxLength={4}
              className="field mt-5 w-full text-center font-mono text-[22px] uppercase tracking-[0.5em]"
              value={code}
              onChange={(event) => setCode(event.target.value.toUpperCase().replace(/[\s-]+/g, "").slice(0, 4))}
            />
            {verify.error ? <p role="alert" className="mt-4 text-[13px] text-[#ffb4ae]">{verify.error.message}</p> : null}
            <button type="submit" className="btn-primary mt-5 w-full justify-center" disabled={verify.isPending || code.length !== 4 || me.isPending}>
              {verify.isPending ? "Checking..." : "Verify"}
            </button>
            <button type="button" className="btn mt-3 w-full justify-center" disabled={resend.isPending || resend.isSuccess} onClick={() => resend.mutate()}>
              {resend.isPending ? "Sending..." : resend.isSuccess ? "Sent" : "Send a new code"}
            </button>
            {resend.error ? <p role="alert" className="mt-3 text-[13px] text-[#ffb4ae]">{resend.error.message}</p> : null}
          </>
        )}
      </form>
    </main>
  );
}
