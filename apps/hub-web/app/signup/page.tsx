import type { Metadata } from "next";
import { AuthForm } from "@/components/auth-form";

export const metadata: Metadata = {
  title: "Sign up",
  description:
    "Create a free Ensemble account: an AI notes app, a Today page to plan your day, and a board you share with AI agents.",
};

export default function SignupPage() {
  return <AuthForm mode="signup" />;
}
