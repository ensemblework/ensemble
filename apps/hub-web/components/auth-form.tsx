"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api, HUB_API } from "@/lib/api";
import { clearBrowserTabSession } from "@/lib/tab-session";
import { INVITE_ONLY, safeLoginNext, showInviteNote, signupPanel } from "@/lib/signup-ui";
import { EnsembleLogo } from "./brand/Logo";
import { Spinner } from "./ui";
import { AuthTurnstile } from "./auth-turnstile";
import { AuthBackdrop } from "./auth-backdrop";

export function authRedirectTarget(mode: "login" | "signup", result: { verificationSent?: boolean; user?: unknown }, next: string | null): string {
  if (mode === "signup") return result.verificationSent ? "/verify?next=/start" : "/start";
  return safeLoginNext(next) ?? "/today";
}

export function AuthForm({ mode }: { mode: "login" | "signup" }) {
  const status = useQuery({ queryKey: ["auth-status"], queryFn: api.authStatus });
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [turnstileToken, setTurnstileToken] = useState("");
  const [resetChallenge, setResetChallenge] = useState(0);
  const [providerError, setProviderError] = useState("");
  useEffect(() => {
    setProviderError(new URLSearchParams(window.location.search).get("error") ?? "");
  }, []);
  const submit = useMutation({
    mutationFn: async () => (mode === "signup" ? api.signup({ email, password, name, turnstileToken: turnstileToken || undefined }) : api.login({ email, password })),
    onSuccess: (result) => {
      clearBrowserTabSession();
      const next = new URLSearchParams(window.location.search).get("next");
      window.location.href = authRedirectTarget(mode, result, next);
    },
    onError: () => setResetChallenge((value) => value + 1),
  });
  const first = status.data?.bypass && !status.data.hasAccounts;
  const signup = status.data?.signup;
  const closed = signupPanel(mode, signup) === "closed";
  const emailAvailable = mode === "login" || status.data?.emailSignupAvailable !== false;
  const unavailable = !closed && !emailAvailable && !status.data?.providers.length;
  const inviteNote = showInviteNote(signup);
  return (
    <div className="auth-shell">
      <div className="auth-brand">
        <EnsembleLogo size={24} />
      </div>
      <AuthBackdrop />
      <div className="auth-main">
      <form
        className="auth-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (emailAvailable && !submit.isPending) submit.mutate();
        }}
      >
        <h1 className="display text-[30px] leading-tight tracking-tight">
          {closed ? "Invite only" : unavailable ? "Signup unavailable" : mode === "signup" ? "Create your account" : "Sign in"}
        </h1>
        <p className="mt-1 text-[13px] text-muted">
          {closed
            ? INVITE_ONLY
            : mode === "signup"
              ? first
                ? "You are the first person on this Ensemble. Anything already here becomes yours."
                : "Your board, context and connections stay private to your account."
              : "Welcome back."}
        </p>
        {inviteNote && !closed ? <p className="mt-2 text-[13px] text-muted">{INVITE_ONLY}</p> : null}
        {!closed && !emailAvailable ? (
          <p role="alert" className="mt-3 text-[13px] text-muted">
            {unavailable
              ? "New accounts are not available on this instance yet. Contact the operator. Existing accounts can still sign in."
              : "Email signup is not available on this instance yet. Use one of the configured providers below."}
          </p>
        ) : null}
        {providerError ? <p role="alert" className="mt-3 text-[13px] text-[#ffb4ae]">{providerError}</p> : null}
        {!closed && status.data?.providers.length ? (
          <div className="mt-5 space-y-2">
            {status.data.providers.map((provider) => (
              <a key={provider} href={`${HUB_API}/api/auth/oauth/${provider}/start`} className="btn flex w-full justify-center py-2">
                Continue with {provider === "github" ? "GitHub" : provider === "google" ? "Google" : "Microsoft"}
              </a>
            ))}
            {emailAvailable ? <p className="py-2 text-center text-[12px] text-muted">or continue with email</p> : null}
          </div>
        ) : null}
        {closed || !emailAvailable ? null : <div className="mt-5 space-y-3">
          {mode === "signup" ? (
            <label className="block text-[13px] font-medium">
              Name
              <input value={name} onChange={(event) => setName(event.target.value)} className="field mt-1 w-full" autoComplete="name" />
            </label>
          ) : null}
          <label className="block text-[13px] font-medium">
            Email
            <input type="email" required value={email} onChange={(event) => setEmail(event.target.value)} className="field mt-1 w-full" autoComplete="email" />
          </label>
          <label className="block text-[13px] font-medium">
            Password
            <input
              type="password"
              required
              minLength={8}
              maxLength={256}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="field mt-1 w-full"
              autoComplete={mode === "signup" ? "new-password" : "current-password"}
            />
          </label>
        </div>}
        {mode === "signup" && !closed && emailAvailable && status.data?.turnstileSiteKey ? (
          <AuthTurnstile siteKey={status.data.turnstileSiteKey} onToken={setTurnstileToken} resetKey={resetChallenge} />
        ) : null}
        {submit.error ? <div className="mt-3 text-[12.5px] text-[#ffb4ae]">{(submit.error as Error).message}</div> : null}
        {status.error ? <p role="alert" className="mt-3 text-[13px] text-muted">{status.error.message}</p> : null}
        {closed || !emailAvailable ? null : (
        <button type="submit" className="btn-primary mt-5 w-full justify-center py-2" disabled={submit.isPending || status.isPending || status.isError || (mode === "signup" && Boolean(status.data?.turnstileSiteKey) && !turnstileToken)}>
          {submit.isPending ? <Spinner size={12} /> : null} {mode === "signup" ? "Create account" : "Sign in"}
        </button>
        )}
        {mode === "login" ? <Link href="/forgot" className="mt-3 block text-center text-[12.5px] text-accent hover:underline">Forgot password?</Link> : null}
        {!closed ? (
          <p className="mt-3 text-center text-[12px] text-muted">
            By continuing, you agree to the <a href="https://ensemblework.com/terms" className="text-accent">Terms</a> and <a href="https://ensemblework.com/privacy" className="text-accent">Privacy policy</a>.
          </p>
        ) : null}
        <div className="mt-4 text-center text-[12.5px] text-muted">
          {mode === "signup" ? (
            <>
              Already have an account?{" "}
              <Link href="/login" className="inline-flex min-h-6 items-center text-accent hover:underline">
                Sign in
              </Link>
            </>
          ) : signup === "closed" ? (
            <span>{INVITE_ONLY}</span>
          ) : (
            <>
              New here?{" "}
              <Link href="/signup" className="inline-flex min-h-6 items-center text-accent hover:underline">
                Create an account
              </Link>
            </>
          )}
        </div>
      </form>
      </div>
    </div>
  );
}
