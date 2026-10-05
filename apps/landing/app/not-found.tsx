import { Mark } from "@/components/mark";

export default function NotFound() {
  return (
    <main className="lost">
      <div>
        <Mark size={44} />
        <h1>
          This page is <em>out of key.</em>
        </h1>
        <a className="btn" href="/">
          Back to Ensemble
        </a>
      </div>
    </main>
  );
}
