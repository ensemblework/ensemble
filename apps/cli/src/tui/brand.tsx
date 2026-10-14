import { Text, useStdout } from "ink";
import { useEffect, useState } from "react";
import { terminalBrand } from "@ensemble/brand/cli";

/** Only this four-cell marker ticks; idle and plain terminals allocate no timer. */
export function WorkingMark() {
  const { stdout } = useStdout();
  const brand = terminalBrand(process.env, Boolean(stdout.isTTY));
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!brand.animated) return;
    const timer = setInterval(() => setFrame(value => (value + 1) % brand.frames.length), brand.interval);
    return () => clearInterval(timer);
  }, [brand.animated, brand.frames.length, brand.interval]);
  return <Text color={brand.color}>{brand.animated ? brand.frames[frame] : brand.still}</Text>;
}
