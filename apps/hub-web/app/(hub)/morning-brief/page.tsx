import { redirect } from "next/navigation";

export default function Page() {
  redirect("/routines?routine=morning-brief");
}
