"use client";

import { useEffect, useState } from "react";
import { ArrowUpRight, Check, Sparkles } from "lucide-react";
import { currentLink } from "@/lib/api";
import { Modal } from "../settings/modal";
import { BrandMorph } from "../motion/brand-morph";

/** Public editing is free of model calls; this guard explains the server's boundary. */
export function inviteForPublicAI(): boolean {
  if (!currentLink()) return false;
  window.dispatchEvent(new CustomEvent("ensemble:join-invitation"));
  return true;
}

export function JoinInvitation() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener("ensemble:join-invitation", show);
    return () => window.removeEventListener("ensemble:join-invitation", show);
  }, []);
  return <Modal open={open} onClose={() => setOpen(false)} title="A little more room to think" width={480}>
    <div className="rounded-xl bg-accent-soft px-6 py-8 text-center">
      <div className="mx-auto mb-5 flex size-16 items-center justify-center rounded-2xl border border-line bg-panel"><BrandMorph size={40} /></div>
      <h3 className="text-[25px] font-semibold leading-tight tracking-tight">Bring your ideas to life<br />with Ensemble.</h3>
      <p className="mx-auto mt-3 max-w-[32ch] text-[14px] leading-6 text-muted">Turn a question into a clear answer, sketch a diagram, and connect the pieces of your work.</p>
    </div>
    <ul className="my-5 space-y-2 text-[13px] text-muted">{["Your own workspace and AI assistant", "Diagrams and pages that grow with your ideas", "Keep editing this shared page without joining"].map(line => <li key={line} className="flex items-center gap-2"><Check size={14} className="text-accent" />{line}</li>)}</ul>
    <a className="btn-primary flex w-full justify-center py-2.5" href="/signup"><Sparkles size={15} />Create your Ensemble account<ArrowUpRight size={14} /></a>
    <div className="mt-3 flex items-center justify-center gap-3 text-[12px] text-muted"><a href="/login" className="hover:underline">Already a member? Sign in</a><span>·</span><button type="button" onClick={() => setOpen(false)} className="hover:underline">Keep writing</button></div>
    <p className="mt-4 text-center text-[11px] text-faint">AI is available in your own workspace after sign-in and model setup.</p>
  </Modal>;
}
