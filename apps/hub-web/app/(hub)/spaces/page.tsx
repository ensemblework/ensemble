import { redirect } from "next/navigation";

export default function SpacesIndex() {
  redirect("/settings?tab=spaces");
}
