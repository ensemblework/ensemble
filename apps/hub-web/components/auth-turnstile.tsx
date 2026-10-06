"use client";

import Script from "next/script";
import { useEffect, useRef, useState } from "react";

declare global {
  interface Window {
    turnstile?: {
      render(element: HTMLElement, options: { sitekey: string; action: string; callback: (token: string) => void; "expired-callback": () => void; "error-callback": () => void }): string;
      remove(id: string): void;
    };
  }
}

export function AuthTurnstile({ siteKey, onToken, resetKey }: { siteKey: string; onToken: (token: string) => void; resetKey: number }) {
  const target = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!ready || !target.current || !window.turnstile) return;
    onToken("");
    setError("");
    const service = window.turnstile;
    const id = service.render(target.current, {
      sitekey: siteKey, action: "signup",
      callback: onToken,
      "expired-callback": () => onToken(""),
      "error-callback": () => { onToken(""); setError("Signup verification failed to load. Refresh and try again."); },
    });
    return () => service.remove(id);
  }, [ready, siteKey, onToken, resetKey]);
  return (
    <div className="mt-4">
      <Script src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit" onReady={() => setReady(true)} onError={() => setError("Signup verification is unavailable. Refresh and try again.")} />
      <div ref={target} />
      {error ? <p role="alert" className="text-[13px] text-muted">{error}</p> : null}
    </div>
  );
}
