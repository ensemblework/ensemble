import { Board } from "@/components/board/board";
import { loadLayout } from "@/lib/server-layout";

export default async function BoardPage() {
  const initialBoardLayout = await loadLayout("board");
  return <Board initialBoardLayout={initialBoardLayout} />;
}
