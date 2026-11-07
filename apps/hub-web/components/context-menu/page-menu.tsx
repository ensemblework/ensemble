"use client";

import { createContext, useContext } from "react";
import type { MenuSection } from "./menu-store";

/**
 * The open page's or task's own menu, given by its view (note-page.tsx, task-page.tsx): its editor's
 * right-click menu offers it as "Page ▸" or "Task ▸", and quotes its title for the assistant.
 */
export type PageMenuValue = { label: string; title: () => string; sections: () => MenuSection[] };

export const PageMenuContext = createContext<PageMenuValue | null>(null);

export const usePageMenu = () => useContext(PageMenuContext);
