-- Calendar links (ICS subscriptions) on the Today calendar (docs/03 §2.4). Additive only.

CREATE TABLE "calendar_feeds" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "url_key" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "last_sync_at" TIMESTAMP(3),
    "last_error" TEXT,
    "item_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "calendar_feeds_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "calendar_feeds_user_id_url_key_key" ON "calendar_feeds"("user_id", "url_key");

ALTER TABLE "calendar_feeds" ADD CONSTRAINT "calendar_feeds_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
