import { redirect } from "next/navigation";

export default function ProjectsIndex() {
  redirect("/context?tab=projects");
}
