import type { Metadata } from "next";
import { AuthForm } from "@/components/auth-form";

export const metadata: Metadata = {
  title: "Log in",
  description: "Log in to Ensemble, the AI notes app and workspace where you plan your day and work with AI agents.",
};

export default function LoginPage() {
  return <AuthForm mode="login" />;
}
