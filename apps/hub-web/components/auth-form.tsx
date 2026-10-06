"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api, HUB_API } from "@/lib/api";
import { clearBrowserTabSession } from "@/lib/tab-session";
import { INVITE_ONLY, safeLoginNext, showInviteNote, signupPanel } from "@/lib/signup-ui";
import { EnsembleLogo, EnsembleMark } from "./brand/Logo";
import { Spinner } from "./ui";
import { AuthTurnstile } from "./auth-turnstile";

/** Whole Two-voices mark, quiet, in the corner. Never cropped into stripes. */
function LoginStrand() {
  return <EnsembleMark size={140} className="login-strand pointer-events-none absolute" />;
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
      const safe = safeLoginNext(next);
      window.location.href = mode === "signup" ? "/start" : safe ?? "/today";
      void result;
    },
    onError: () => setResetChallenge((value) => value + 1),
  });
  const first = status.data?.bypass && !status.data.hasAccounts;
  const signup = status.data?.signup;
  const closed = signupPanel(mode, signup) === "closed";
  const inviteNote = showInviteNote(signup);
  return (
    <div className="flex min-h-screen items-center justify-center bg-bg px-4">
      <div className="grid w-full max-w-[820px] overflow-hidden rounded-2xl border border-line bg-panel shadow-pop md:grid-cols-[1fr_1.1fr]">
        <div className="relative hidden min-h-[480px] flex-col overflow-hidden bg-sidebar p-8 md:flex">
          <LoginStrand />
          <div className="relative">
            <EnsembleLogo size={32} />
          </div>
          <div className="relative mt-8 max-w-[16rem]">
            <p className="display text-[28px] leading-[1.15]">A shared workspace for you and your agent.</p>
            <p className="mt-3 text-[13px] leading-5 text-muted">
              A board for what is due. A graph for the people, projects, and tasks around it.
            </p>
          </div>
          <p className="relative mt-6 text-[12.5px] text-muted">Nothing leaves without you.</p>
        </div>
      <form
        className="w-full p-6 sm:p-8"
        onSubmit={(event) => {
          event.preventDefault();
          submit.mutate();
        }}
      >
        <div className="mb-5 md:hidden">
          <EnsembleLogo size={20} />
        </div>
        <h1 className="text-[22px] font-semibold tracking-tight">
          {closed ? "Invite only" : mode === "signup" ? "Create your account" : "Sign in"}
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
        {providerError ? <p role="alert" className="mt-3 text-[13px] text-[#ffb4ae]">{providerError}</p> : null}
        {!closed && status.data?.providers.length ? (
          <div className="mt-5 space-y-2">
            {status.data.providers.map((provider) => (
              <a key={provider} href={`${HUB_API}/api/auth/oauth/${provider}/start`} className="btn flex w-full justify-center py-2">
                Continue with {provider === "github" ? "GitHub" : provider === "google" ? "Google" : "Microsoft"}
              </a>
            ))}
            <p className="py-2 text-center text-[12px] text-muted">or continue with email</p>
          </div>
        ) : null}
        {closed ? null : <div className="mt-5 space-y-3">
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
        {mode === "signup" && !closed && status.data?.turnstileSiteKey ? (
          <AuthTurnstile siteKey={status.data.turnstileSiteKey} onToken={setTurnstileToken} resetKey={resetChallenge} />
        ) : null}
        {submit.error ? <div className="mt-3 text-[12.5px] text-[#ffb4ae]">{(submit.error as Error).message}</div> : null}
        {status.error ? <p role="alert" className="mt-3 text-[13px] text-muted">{status.error.message}</p> : null}
        {closed ? null : (
        <button type="submit" className="btn-primary mt-5 w-full justify-center py-1.5" disabled={submit.isPending || status.isPending || status.isError || (mode === "signup" && Boolean(status.data?.turnstileSiteKey) && !turnstileToken)}>
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
