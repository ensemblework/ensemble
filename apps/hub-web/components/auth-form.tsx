"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { api } from "@/lib/api";
import { clearBrowserTabSession } from "@/lib/tab-session";
import { INVITE_ONLY, showInviteNote, signupPanel } from "@/lib/signup-ui";
import { EnsembleLogo, EnsembleMark } from "./brand/Logo";
import { Spinner } from "./ui";

/** Whole Two-voices mark, quiet, in the corner. Never cropped into stripes. */
function LoginStrand() {
  return <EnsembleMark size={140} className="login-strand pointer-events-none absolute" />;
}

export function AuthForm({ mode }: { mode: "login" | "signup" }) {
  const status = useQuery({ queryKey: ["auth-status"], queryFn: api.authStatus });
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const submit = useMutation({
    mutationFn: async () => (mode === "signup" ? api.signup({ email, password, name }) : api.login({ email, password })),
    onSuccess: (result) => {
      clearBrowserTabSession();
      const next = new URLSearchParams(window.location.search).get("next");
      const safe = next && next.startsWith("/") && !next.startsWith("//") ? next : null;
      window.location.href = mode === "signup" ? "/start" : safe ?? "/today";
      void result;
    },
  });
  const first = status.data && !status.data.hasAccounts;
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
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="field mt-1 w-full"
              autoComplete={mode === "signup" ? "new-password" : "current-password"}
            />
          </label>
        </div>}
        {submit.error ? <div className="mt-3 text-[12.5px] text-[#ffb4ae]">{(submit.error as Error).message}</div> : null}
        {closed ? null : (
        <button type="submit" className="btn-primary mt-5 w-full justify-center py-1.5" disabled={submit.isPending}>
          {submit.isPending ? <Spinner size={12} /> : null} {mode === "signup" ? "Create account" : "Sign in"}
        </button>
        )}
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
