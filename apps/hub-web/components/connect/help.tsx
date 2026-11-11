"use client";

import { ArrowUpRight } from "lucide-react";
import { attachToAssistant } from "@/lib/assistant-attach";
import { helpContext, helpQuestions, type HelpPlace } from "@/lib/connect/help";
import { Mark } from "../mark";

/**
 * "Need a hand?" on the Connect pages: each question opens the assistant and sends it at once, in a
 * new chat at the person's Medium tier, with the setup facts for where they are as its reference.
 */
export function ConnectHelp({ place, className = "" }: { place: HelpPlace; className?: string }) {
  const questions = helpQuestions(place);
  return (
    <section className={`connect-help ${className}`} aria-labelledby="connect-help-title">
      <div className="flex items-start gap-3">
        <Mark size={22} aria-hidden />
        <div>
          <h2 id="connect-help-title" className="text-[16px] font-semibold tracking-tight">
            Need a hand?
          </h2>
          <p className="mt-0.5 text-[13px] leading-5 text-muted">Ask Ensemble. It answers with the steps for your app and your way of connecting, in a new chat.</p>
        </div>
      </div>
      <ul className="mt-3 grid gap-2 md:grid-cols-2">
        {questions.map((question) => (
          <li key={question.id}>
            <button
              type="button"
              className="connect-question group"
              onClick={() => attachToAssistant({ prompt: question.prompt, send: true, context: helpContext(place), tier: "medium", fresh: true })}
            >
              <span className="min-w-0 flex-1">{question.label}</span>
              <ArrowUpRight size={14} className="shrink-0 text-faint transition-colors group-hover:text-accent" aria-hidden />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
