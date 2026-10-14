"use client";
import { useEffect, useId, useRef } from "react";
import { staticSVG } from "@ensemble/brand";
import { mount } from "@ensemble/brand/motion";

export function WorkingMark() {
  const ref = useRef<HTMLSpanElement>(null);
  const id = useId();
  useEffect(() => {
    if (!ref.current) return;
    const motion = mount(ref.current, { size: 18, kind: "relay" });
    motion.loop({ kind: "relay" });
    return () => motion.destroy();
  }, []);
  return <span ref={ref} className="u-morph" style={{ width: 18, height: 18 }} dangerouslySetInnerHTML={{ __html: staticSVG(18, { id }) }} />;
}
