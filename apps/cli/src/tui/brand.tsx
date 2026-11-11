import { Text, useStdout } from "ink";
import { useEffect, useState } from "react";
import { terminalBrand } from "@ensemble/brand/cli";

/** Only this four-cell marker ticks; idle and plain terminals allocate no timer. */
export function WorkingMark() {
  const { stdout } = useStdout();
  const brand = terminalBrand(process.env, Boolean(stdout.isTTY));
  const [frame, setFrame] = useState(-1);
  useEffect(() => {
    if (!brand.animated) return;
    let index = -1;
    let timer: ReturnType<typeof setTimeout>;
    const step = () => {
      index = index + 1 < brand.frames.length ? index + 1 : -1;
      setFrame(index);
      timer = setTimeout(step, index === -1 ? brand.rest : brand.interval);
    };
    timer = setTimeout(step, 350);
    return () => clearTimeout(timer);
  }, [brand.animated, brand.frames.length, brand.interval, brand.rest]);
  return <Text color={brand.color}>{brand.animated && frame >= 0 ? brand.frames[frame] : brand.still}</Text>;
}
