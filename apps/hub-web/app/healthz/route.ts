/** This process is up. hub-api keeps its own answer at /health. */
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({ ok: true, service: "hub-web" });
}
