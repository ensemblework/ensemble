"use client";

import { useSearchParams } from "next/navigation";
import type { LayoutPayload } from "@/lib/server-layout";
import { ENSEMBLE_LABEL_BOARD } from "@ensemble/shared-types";
import { BoardLabelColors } from "../task/labels";
import { Board } from "./board";
import { CustomBoard } from "./custom-board";

export function Boards({ initialBoardLayout }: { initialBoardLayout: LayoutPayload | null }) {
  const id = useSearchParams().get("board");
  // Cards show labels in their board's colours.
  return (
    <BoardLabelColors board={id ?? ENSEMBLE_LABEL_BOARD}>
      {id ? <CustomBoard key={id} id={id} /> : <Board initialBoardLayout={initialBoardLayout} />}
    </BoardLabelColors>
  );
}
