"use client";

import { useState } from "react";

export function CopyCode({ code, label = "Copy" }: { code: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="code-card">
      <div className="code-head">
        <span>{label}</span>
        <button
          type="button"
          className="copy-btn"
          onClick={() => {
            void navigator.clipboard.writeText(code).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1400);
            });
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}
