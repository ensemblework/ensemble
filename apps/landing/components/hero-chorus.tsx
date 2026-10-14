"use client";
import { useEffect, useId, useRef } from "react";
import { staticSVG } from "@ensemble/brand";
import { mount, type MorphController } from "@ensemble/brand/motion";

/** A finite welcome; another performance starts only on a visitor's gesture. */
export function HeroChorus() {
  const ref = useRef<HTMLSpanElement>(null);
  const controller = useRef<MorphController | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const id = useId();
  useEffect(() => {
    if (!ref.current) return;
    controller.current = mount(ref.current, { size: 88 });
    return () => { if (timer.current) clearTimeout(timer.current); controller.current?.destroy(); };
  }, []);
  function play() {
    if (timer.current) clearTimeout(timer.current);
    controller.current?.loop();
    timer.current = setTimeout(() => { void controller.current?.settle(); }, 4060);
  }
  return <div className="chorus-overture">
    <button className="chorus-replay" type="button" onClick={play} aria-label="Animate the Ensemble logo" title="Stronger together">
      <span ref={ref} className="u-morph" style={{ width: 88, height: 88 }} dangerouslySetInnerHTML={{ __html: staticSVG(88, { id }) }} />
    </button>
    <span className="chorus-caption">Your ideas. Your agents.<br /><em>One shared context.</em></span>
  </div>;
}
