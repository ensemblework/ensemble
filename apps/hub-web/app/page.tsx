import { redirect } from "next/navigation";
import { desktopExport } from "@/lib/desktop-export";
import { DesktopHome } from "./desktop-home";

export default function Home() {
  if (desktopExport()) return <DesktopHome />;
  redirect("/today");
}
