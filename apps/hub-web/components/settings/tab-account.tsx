"use client";

import dynamic from "next/dynamic";
import type { Settings } from "@ensemble/shared-types";
import { FeaturesSection } from "@/components/features/section";
import { AccountSection } from "./account";
import { AppearanceSection } from "./appearance";
import { useSpaceAccess } from "@/lib/access";

// sections.tsx carries every other tab's sections too; keep it out of the first paint.
const IdentitySection = dynamic(() => import("./sections").then((mod) => mod.IdentitySection), { ssr: false });
const RemoteMacSection = dynamic(() => import("./remote-mac").then((mod) => mod.RemoteMacSection), { ssr: false });

type Plain = Record<string, unknown>;

export function AccountTab({ settings, patch }: { settings: Settings; patch: (value: Plain) => void }) {
  // Which features a space has is its owner's choice.
  const guest = useSpaceAccess().guest;
  return (
    <>
      <div id="account" className="scroll-mt-6"><AccountSection /></div>
      <div id="you" className="scroll-mt-6"><IdentitySection settings={settings} patch={patch} /></div>
      <div id="appearance" className="scroll-mt-6"><AppearanceSection patch={patch} /></div>
      {guest ? null : <div id="features" className="scroll-mt-6"><FeaturesSection /></div>}
      <div id="this-mac" className="scroll-mt-6 empty:hidden"><RemoteMacSection /></div>
    </>
  );
}
