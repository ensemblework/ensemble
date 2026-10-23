"use client";

import { useSearchParams } from "next/navigation";
import type { LayoutPayload } from "@/lib/server-layout";
import { Board } from "./board";
import { CustomBoard } from "./custom-board";

export function Boards({ initialBoardLayout }: { initialBoardLayout: LayoutPayload | null }) {
  const id = useSearchParams().get("board");
  return id ? <CustomBoard key={id} id={id} /> : <Board initialBoardLayout={initialBoardLayout} />;
}
