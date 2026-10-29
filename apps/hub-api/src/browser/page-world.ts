/**
 * The few browser-side shapes the runtime's own page functions use. hub-api compiles without the
 * DOM library, so a function passed to `evaluate` casts `globalThis` to `PageWindow` itself (it is
 * serialised into the page and cannot call helpers from here).
 */
export type PageElement = {
  value?: string;
  matches(selector: string): boolean;
  closest(selector: string): PageElement | null;
  getAttribute(name: string): string | null;
  getClientRects(): { length: number };
};

export type PageAnimation = {
  currentTime: number | null;
  playbackRate: number;
  playState: string;
  pause(): void;
  play(): void;
};

export type PageWindow = {
  document: {
    title: string;
    body: { innerText: string } | null;
    querySelectorAll(selector: string): ArrayLike<PageElement>;
    getAnimations(): PageAnimation[];
  };
  getComputedStyle(element: PageElement): { visibility: string };
  __ensembleSeek?: (ms: number) => unknown;
};
