import { z } from "zod";

export const BoardColor = z.enum(["gray", "blue", "violet", "amber", "green", "rose"]);
export const PageBoardColumn = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(80),
  color: BoardColor,
});
export type PageBoardColumn = z.infer<typeof PageBoardColumn>;
export const PageBoardColumns = z.array(PageBoardColumn).min(1).max(20).refine(
  (columns) => new Set(columns.map((column) => column.id)).size === columns.length,
  "Each column must have a unique id.",
);
export const PageBoardTiles = z.array(z.enum(["count", "distribution", "flow", "recent"])).max(4).refine(
  (tiles) => new Set(tiles).size === tiles.length,
  "Each tile can appear once.",
);
export type PageBoardTile = z.infer<typeof PageBoardTiles>[number];
export const CreatePageBoard = z.object({
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).default(""),
  columns: PageBoardColumns,
});
export type CreatePageBoard = z.infer<typeof CreatePageBoard>;
export const PatchPageBoard = CreatePageBoard.partial().extend({
  revision: z.number().int().positive(),
  tiles: PageBoardTiles.optional(),
});
export type PatchPageBoard = z.infer<typeof PatchPageBoard>;
export type PageBoardRecord = z.infer<typeof CreatePageBoard> & {
  id: string;
  revision: number;
  tiles: PageBoardTile[];
  pageCount: number;
  createdAt: string;
  updatedAt: string;
};
export type BoardPage = {
  id: string;
  kind: "page" | "task";
  title: string;
  columnId: string | null;
  boardOrder: number;
  createdAt: string;
  updatedAt: string;
};
export type DirectoryPage = BoardPage & {
  parentId: string | null;
  board: { id: string; title: string } | null;
  snippet?: string;
};
