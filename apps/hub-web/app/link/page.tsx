import { CliLink } from "@/components/cli-link";

export default async function Page({ searchParams }: { searchParams: Promise<{ code?: string | string[] }> }) {
  const params = await searchParams;
  const code = Array.isArray(params.code) ? params.code[0] : params.code;
  return <CliLink initialCode={code ?? ""} />;
}
