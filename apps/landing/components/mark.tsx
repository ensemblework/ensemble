"use client";
import { useId } from "react";
import { svgBody } from "@ensemble/brand";

export function Mark({ size = 32 }: { size?: number }) {
  const id = useId();
  return <svg width={size} height={size} viewBox="0 0 320 320" aria-hidden="true" focusable="false" dangerouslySetInnerHTML={{ __html: svgBody({ id, micro: size <= 20 }) }} />;
}

export function Wordmark() { return <span className="wordmark"><Mark /><span>Ensemble</span></span>; }
