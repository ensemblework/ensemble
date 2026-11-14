import type { Metadata } from "next";
import { McpConsent } from "@/components/mcp-consent";

export const metadata: Metadata = { title: "Connect an app", robots: { index: false, follow: false } };

export default function Page() {
  return <McpConsent />;
}
