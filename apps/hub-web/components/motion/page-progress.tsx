"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useDelayedFlag } from "@/lib/motion/use-delayed-flag";
import { BrandMorph } from "./brand-morph";

/** Top progress for a real route change. Fast navigations never paint it. */
export function PageProgress() {
  const pathname = usePathname();
  const [pending, setPending] = useState(false);
  const [bareMain, setBareMain] = useState<HTMLElement | null>(null);
  const showed = useRef(false);
  const visible = useDelayedFlag(pending);

  useEffect(() => {
    setPending(false);
  }, [pathname]);

  useEffect(() => {
    if (!pending) {
      setBareMain(null);
      return;
    }
    const look = () => {
      const main = document.querySelector("main");
      if (!(main instanceof HTMLElement)) {
        setBareMain(null);
        return;
      }
      const probe = main.cloneNode(true) as HTMLElement;
      probe.querySelectorAll(".m-route-mark, .u-morph").forEach((node) => node.remove());
      const text = (probe.innerText || "").replace(/\s+/g, "");
      const media = probe.querySelector("img, canvas, video");
      const loading = probe.querySelector("[data-route-loading], [data-motion-slot='content.skeleton']");
      setBareMain(text.length === 0 && !media && !loading ? main : null);
    };
    look();
    const id = window.setInterval(look, 150);
    return () => window.clearInterval(id);
  }, [pending, pathname]);

  useEffect(() => {
    if (visible) showed.current = true;
  }, [visible]);

  useEffect(() => {
    if (pending || !showed.current) return;
    showed.current = false;
    document.documentElement.dataset.motionEnter = "1";
    const raw = getComputedStyle(document.documentElement).getPropertyValue("--m-dur-move");
    const ms = Number.parseFloat(raw);
    const timer = window.setTimeout(() => {
      delete document.documentElement.dataset.motionEnter;
    }, Number.isFinite(ms) ? ms : 0);
    return () => window.clearTimeout(timer);
  }, [pending, pathname]);

  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = (event.target as HTMLElement | null)?.closest?.("a");
      if (!anchor || anchor.target === "_blank" || anchor.hasAttribute("download")) return;
      const href = anchor.getAttribute("href");
      if (!href || href.startsWith("#")) return;
      let url: URL;
      try {
        url = new URL(anchor.href, window.location.href);
      } catch {
        return;
      }
      if (url.origin !== window.location.origin) return;
      if (url.pathname === window.location.pathname && url.search === window.location.search) return;
      setPending(true);
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);

  const bar = visible ? (
    <div className="m-progress" data-motion-slot="page.progress" data-state="loading" data-motion-loading="1" aria-hidden>
      <i className="a m-loop" />
      <i className="b m-loop" />
    </div>
  ) : null;
  const mark =
    pending && bareMain
      ? createPortal(
          <div className="m-route-mark" aria-hidden>
            <BrandMorph size={40} loader state="loop" />
          </div>,
          bareMain,
        )
      : null;
  if (!bar && !mark) return null;
  return (
    <>
      {bar}
      {mark}
    </>
  );
}
