"use client";

import { createContext, useContext } from "react";
import type { IdeTheme } from "@ensemble/ide-theme";

export const IdeThemeContext = createContext<IdeTheme | null>(null);

export function useIdeTheme(): IdeTheme | null {
  return useContext(IdeThemeContext);
}
