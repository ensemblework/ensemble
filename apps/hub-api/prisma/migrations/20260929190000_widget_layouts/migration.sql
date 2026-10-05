-- Widget layouts and role onboarding.
-- Sorts after 20260929180000_cowork_surfaces. Does not alter meeting_sessions or nudge_paused_until.
-- Existing accounts are marked complete so they are not sent through the wizard.

ALTER TABLE "users" ADD COLUMN "onboarding_role" TEXT;
ALTER TABLE "users" ADD COLUMN "onboarding_template_id" TEXT;
ALTER TABLE "users" ADD COLUMN "onboarding_completed_at" TIMESTAMP(3);

UPDATE "users" SET "onboarding_completed_at" = CURRENT_TIMESTAMP WHERE "onboarding_completed_at" IS NULL;

CREATE TABLE "widget_layouts" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "surface" TEXT NOT NULL,
    "template_id" TEXT,
    "document" JSONB NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "widget_layouts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "widget_layouts_user_id_surface_key" ON "widget_layouts"("user_id", "surface");

ALTER TABLE "widget_layouts" ADD CONSTRAINT "widget_layouts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
