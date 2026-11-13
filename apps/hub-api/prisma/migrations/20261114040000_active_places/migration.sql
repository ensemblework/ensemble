CREATE TABLE "active_places" (
  "user_id" TEXT NOT NULL,
  "window_id" TEXT NOT NULL,
  "session_id" TEXT NOT NULL,
  "surface" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "last_seen" TIMESTAMP(3) NOT NULL,
  "seq" INTEGER NOT NULL,
  "released" BOOLEAN NOT NULL DEFAULT false,
  "revoked" BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT "active_places_pkey" PRIMARY KEY ("user_id", "window_id"),
  CONSTRAINT "active_places_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "active_places_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "active_places_user_id_last_seen_idx" ON "active_places"("user_id", "last_seen");
CREATE INDEX "active_places_session_id_idx" ON "active_places"("session_id");
