import Link from "next/link";
import { site } from "@/lib/site";

export const metadata = { title: "Privacy policy | Ensemble" };

export default function PrivacyPage() {
  return (
    <main className="section">
      <Link href="/">Ensemble home</Link>
      <h1>Privacy policy</h1>
      <p>Effective 6 October 2026. This policy covers the hosted Ensemble service at ensemblework.com.</p>
      <h2>Data we store</h2>
      <p>We store your account email, name, password hash if you use a password, linked login provider identifiers, session records, and the notes, tasks, context and files you choose to save. Login with Google, GitHub or Microsoft requests only identity information; mail and repository connectors require separate authorization.</p>
      <h2>How data is used</h2>
      <p>Your data is used to operate your workspace. Verification and reset emails are delivered through Resend. Cloudflare Turnstile processes browser signals to prevent signup abuse. If you use model features, relevant inputs are sent to the model provider you select. Provider usage may incur charges to your own account. We do not sell your personal data or use it for advertising.</p>
      <h2>Security and control</h2>
      <p>Hosted data is separated by account. Passwords are hashed; saved provider credentials are encrypted at rest. The server decrypts credentials when making authorized provider calls. The service operator has administrative access to hosted infrastructure. Do not store secrets or sensitive regulated data in this early testing service.</p>
      <p>You can export your data or delete your account in Settings → Account. Exports exclude credential secrets. Deletion removes active hosted records and revokes devices; it does not remove local files or data already sent to another provider. Infrastructure backups and provider logs may retain records until their normal retention expires.</p>
      <h2>Cookies</h2>
      <p>We use essential session and login-flow cookies, plus local UI preferences. These cookies keep you signed in and protect login flows.</p>
      <h2>Contact and changes</h2>
      <p>For privacy requests, contact the operator through the <a href={`${site.repoUrl}/issues`}>Ensemble repository</a>. Do not include private account data in a public issue. Material policy changes will be reflected on this page.</p>
    </main>
  );
}
