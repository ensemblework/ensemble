"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { useState } from "react";
import { BrandLogo } from "../connectors/brand-logo";
import { AppItemPicker } from "./app-item-picker";
import { useAppItemSources } from "./use-app-items";

/** "Pick from GitHub" beside a repository field. Hidden until GitHub is connected. */
export function PickGitHubRepo({ onPick }: { onPick: (fullName: string) => void }) {
  const { sources } = useAppItemSources();
  const [open, setOpen] = useState(false);
  if (!sources.some((source) => source.id === "github")) return null;
  return (
    <>
      <button type="button" className="btn shrink-0" onClick={() => setOpen(true)}>
        <BrandLogo id="github" name="GitHub" size={14} decorative /> Pick from GitHub
      </button>
      <AppItemPicker
        open={open}
        onClose={() => setOpen(false)}
        title="Pick a GitHub repository"
        sources={["github"]}
        kinds={["repo"]}
        actionLabel="Use this repo"
        onPick={(item) => {
          onPick(item.id);
          setOpen(false);
        }}
      />
    </>
  );
}
