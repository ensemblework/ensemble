"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { createContext, useContext } from "react";
import type { MotionTheme } from "@ensemble/shared-types";
export type MotionContextValue = { theme: MotionTheme; reduce: boolean };

const MotionContext = createContext<MotionContextValue>({ theme: "expressive", reduce: false });

export function MotionContextProvider({ value, children }: { value: MotionContextValue; children: React.ReactNode }) {
  return <MotionContext.Provider value={value}>{children}</MotionContext.Provider>;
}

export function useMotion(): MotionContextValue {
  return useContext(MotionContext);
}
