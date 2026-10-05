"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";

export default function UnavailablePage() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const useDefault = async () => {
    setBusy(true);
    setError("");
    try {
      await api.applyTemplate("default");
      router.push("/today");
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <div className="mx-auto flex min-h-[70vh] max-w-md flex-col justify-center px-6">
      <p className="text-[12px] font-medium uppercase tracking-[0.14em] text-faint">Template</p>
      <h1 className="display mt-2 text-[36px] leading-none">This isn't part of your template.</h1>
      <p className="mt-3 text-[14px] text-muted">
        The page is still in your account. It opens again when you use Default, or when you apply a template that includes it. The address is{" "}
        <span className="text-ink">/marketplace</span>.
      </p>
      {error ? <p className="mt-3 text-[13px] text-[#ffb4ae]">{error}</p> : null}
      <div className="mt-6">
        <button type="button" className="btn-primary" disabled={busy} onClick={() => void useDefault()}>
          {busy ? "Switching…" : "Use Default"}
        </button>
      </div>
    </div>
  );
}
