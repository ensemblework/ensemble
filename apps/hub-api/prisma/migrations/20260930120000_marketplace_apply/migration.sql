ALTER TABLE "users" ADD COLUMN "active_template_id" TEXT;
ALTER TABLE "users" ADD COLUMN "applied_version" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "users" ADD COLUMN "chrome_labels" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "users" ADD COLUMN "template_expires_at" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN "layout_baseline" JSONB;

ALTER TABLE "tasks" ADD COLUMN "measure" INTEGER;

CREATE TABLE "template_applications" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "template_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "template_applications_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "template_applications_user_id_created_at_idx" ON "template_applications"("user_id", "created_at" DESC);

ALTER TABLE "template_applications" ADD CONSTRAINT "template_applications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
