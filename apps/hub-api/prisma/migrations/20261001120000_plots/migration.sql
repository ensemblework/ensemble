-- Plots: datasets and saved charts. Off by default; module_set is unchanged.

CREATE TABLE "plot_datasets" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "columns" JSONB NOT NULL,
    "row_count" INTEGER NOT NULL,
    "byte_size" INTEGER NOT NULL,
    "content_hash" TEXT NOT NULL,
    "sheet" TEXT NOT NULL DEFAULT '',
    "sheets" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),
    CONSTRAINT "plot_datasets_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "plots" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT 'Untitled plot',
    "dataset_id" TEXT,
    "config" JSONB NOT NULL DEFAULT '{}',
    "code" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),
    CONSTRAINT "plots_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "plot_datasets_user_id_updated_at_idx" ON "plot_datasets"("user_id", "updated_at");
CREATE INDEX "plot_datasets_user_id_deleted_at_idx" ON "plot_datasets"("user_id", "deleted_at");
CREATE INDEX "plots_user_id_updated_at_idx" ON "plots"("user_id", "updated_at");
CREATE INDEX "plots_user_id_deleted_at_idx" ON "plots"("user_id", "deleted_at");

ALTER TABLE "plot_datasets" ADD CONSTRAINT "plot_datasets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "plots" ADD CONSTRAINT "plots_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "plots" ADD CONSTRAINT "plots_dataset_id_fkey" FOREIGN KEY ("dataset_id") REFERENCES "plot_datasets"("id") ON DELETE SET NULL ON UPDATE CASCADE;
