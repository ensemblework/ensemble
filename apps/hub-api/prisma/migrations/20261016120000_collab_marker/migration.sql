-- Which live-editing authority wrote a page's content last (src/pages/collab.ts): its epoch and
-- version, valid while the page's revision is still collab_revision. Editors that started over
-- after the API restarted use it to tell exactly which of their typing was stored.
ALTER TABLE "task_pages" ADD COLUMN "collab_epoch" TEXT;
ALTER TABLE "task_pages" ADD COLUMN "collab_version" INTEGER;
ALTER TABLE "task_pages" ADD COLUMN "collab_revision" INTEGER;
