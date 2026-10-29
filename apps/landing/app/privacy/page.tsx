import Link from "next/link";
import { pageMetadata } from "@/lib/metadata";
import { site } from "@/lib/site";

export const metadata = pageMetadata({
  path: "/privacy",
  title: "Privacy policy | Ensemble",
  description: "How Ensemble stores, uses and protects your notes, tasks, context and model keys, and how to export or delete your data.",
});

export default function PrivacyPage() {
  return (
    <main className="section">
      <Link href="/">Ensemble home</Link>
      <h1>Privacy policy</h1>
      <p>Effective 21 October 2026. This policy covers the hosted Ensemble service at ensemblework.com.</p>
      <h2>Data we store</h2>
      <p>We store your account email, name, password hash if you use a password, linked login provider identifiers, session records, and the notes, tasks, context and files you choose to save. Login with Google, GitHub or Microsoft requests only identity information; mail and repository connectors require separate authorization.</p>
      <h2>How data is used</h2>
      <p>Your data is used to operate your workspace. Verification and reset emails are delivered through Resend. Cloudflare Turnstile processes browser signals to prevent signup abuse. If you use model features, relevant inputs are sent to the model provider you select. Provider usage may incur charges to your own account. We do not sell your personal data or use it for advertising.</p>
      <h2>Usage analytics</h2>
      <p>To understand how Ensemble is used and what to improve, we log how signed-in people use the hosted Hub: which screens you open and how long you actively use them (only while the tab is visible and you have used it in the last minute), named actions such as opening the assistant or the command palette, the size of your browser window, and whether you use the web or the desktop app. The server also records actions you take, such as creating a task or uploading a file, and the model calls the Hub makes with their token counts. This log never contains your content: no titles, text, file names or prompts, and identifiers are removed from addresses before they are stored. It is tied to your account, kept on the operator&apos;s own server for up to two years, used by the operator to improve the service and shown back to you as your own active time in the Weekly recap, and not sold, shared or used for advertising. It is included in your data export, removed when you delete everything or your account, and is not used by Vercel or any third-party analytics service.</p>
      <h2>Security and control</h2>
      <p>Hosted data is separated by account. Passwords are hashed; saved provider credentials are encrypted at rest. The server decrypts credentials when making authorized provider calls. The service operator has administrative access to hosted infrastructure. Do not store secrets or sensitive regulated data in this early testing service.</p>
      <p>You can export your data or delete your account in Settings → Account. Exports exclude credential secrets. Deletion removes active hosted records and revokes devices; it does not remove local files or data already sent to another provider. Infrastructure backups and provider logs may retain records until their normal retention expires.</p>
      <h2>Deletion logs</h2>
      <p>After account deletion, we keep a minimal operational log for up to 90 days: a keyed identifier derived from the email, the deletion date and an expiry date. This log contains no readable email, name, profile, workspace content or feedback. It does not prevent signing up again; a repeat deletion replaces the previous log. The identifier is pseudonymous, not anonymous. The log is restricted to the service operator and is not shared externally or sent to a model. To request erasure of the log, contact the operator through a private channel as described below.</p>
      <h2>Monthly AI credits</h2>
      <p>Deleting data does not restore credits already used. To enforce the monthly allowance, we retain a separate keyed identifier derived from the account email, the UTC month and the charged amount, including pending reservations. It contains no readable email, prompts, replies or workspace content. This pseudonymous record survives account deletion so signing up again with the same email does not renew the allowance. Ended months are removed after a two-day settlement grace period. Usage details are erased when you delete everything; the monthly amount remains until that expiry. Your usage in other apps and external AI plan balances are not fetched.</p>
      <h2>Cookies</h2>
      <p>We use essential session and login-flow cookies, plus local UI preferences. These cookies keep you signed in and protect login flows.</p>
      <h2>Contact and changes</h2>
      <p>For privacy requests, contact the operator through the <a href={`${site.repoUrl}/issues`}>Ensemble repository</a>. Do not include private account data in a public issue. Material policy changes will be reflected on this page.</p>
    </main>
  );
}
