import Link from "next/link";

export const metadata = { title: "Terms of use | Ensemble" };

export default function TermsPage() {
  return (
    <main className="section">
      <Link href="/">Ensemble home</Link>
      <h1>Terms of use</h1>
      <p>Effective 6 October 2026. By creating an account, you agree to these terms and the <Link href="/privacy">Privacy policy</Link>.</p>
      <h2>Early testing service</h2>
      <p>Ensemble is experimental software, provided as-is without availability or fitness guarantees. Features may change or be unavailable. Keep independent copies of important data. These terms do not limit rights that cannot legally be excluded.</p>
      <h2>Your account and data</h2>
      <p>Use an email you control and keep your login and tokens secure. You retain ownership of your content and grant permission to process it only to provide the service. Only upload data you have permission to use.</p>
      <h2>Acceptable use</h2>
      <p>Do not abuse the service, bypass limits, access another person's data, distribute malware, or submit unlawful content. Accounts may be suspended to protect users and infrastructure.</p>
      <h2>Agents and costs</h2>
      <p>Review generated work before relying on it. Agent actions on a connected computer run with the permissions you grant. You are responsible for your provider accounts and their charges; public accounts do not receive the operator's model keys.</p>
      <h2>Leaving</h2>
      <p>You can export your data and delete your hosted account from Settings → Account. Connected computers must stop active runs before deletion. Local files are not deleted.</p>
    </main>
  );
}
