"use client";

import { createContext, useContext, type ReactNode } from "react";

export type ShellLabels = Record<string, string>;

const EMPTY: ShellLabels = {};
const LabelsContext = createContext<ShellLabels>(EMPTY);

export function ShellLabelsProvider({ labels, children }: { labels?: ShellLabels | null; children: ReactNode }) {
  return <LabelsContext.Provider value={labels ?? EMPTY}>{children}</LabelsContext.Provider>;
}

export function useShellLabels(): ShellLabels {
  return useContext(LabelsContext);
}
