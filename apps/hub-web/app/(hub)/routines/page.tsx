import { Suspense } from "react";
import { RoutinesPage } from "@/components/routines/routines-page";

export default function Page() {
  return (
    <Suspense>
      <RoutinesPage />
    </Suspense>
  );
}
