"use client";

import { useEffect } from "react";

/** Full navigation. A Next `redirect()` becomes an RSC error page in a static export, and the desktop shell has no server to complete it. */
export function DesktopHome() {
  useEffect(() => {
    window.location.replace("/today/");
  }, []);
  return null;
}
