ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "tester" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "starts_at" TIMESTAMP(3);
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "depends_on" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "matter_stage" TEXT;
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "court" TEXT;
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "order_date" TIMESTAMP(3);
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "subject" TEXT;
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "weight" DOUBLE PRECISION;
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "word_count" INTEGER;
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "pipeline_stage" TEXT;

ALTER TABLE "people" ADD COLUMN IF NOT EXISTS "capacity_hours" DOUBLE PRECISION;
ALTER TABLE "people" ADD COLUMN IF NOT EXISTS "one_on_one_days" INTEGER;

CREATE TABLE IF NOT EXISTS "timetable_slots" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "weekday" INTEGER NOT NULL,
  "start_min" INTEGER NOT NULL,
  "end_min" INTEGER NOT NULL,
  "course" TEXT NOT NULL DEFAULT '',
  CONSTRAINT "timetable_slots_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "timetable_slots_user_id_weekday_idx" ON "timetable_slots"("user_id", "weekday");

CREATE TABLE IF NOT EXISTS "court_holidays" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "day" TIMESTAMP(3) NOT NULL,
  "name" TEXT NOT NULL,
  CONSTRAINT "court_holidays_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "court_holidays_user_id_day_idx" ON "court_holidays"("user_id", "day");

CREATE TABLE IF NOT EXISTS "attendance_marks" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "person_id" TEXT NOT NULL,
  "day" TIMESTAMP(3) NOT NULL,
  "present" BOOLEAN NOT NULL DEFAULT true,
  CONSTRAINT "attendance_marks_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "attendance_marks_user_id_day_idx" ON "attendance_marks"("user_id", "day");

CREATE TABLE IF NOT EXISTS "objectives" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "progress" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "objectives_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "objectives_user_id_idx" ON "objectives"("user_id");

CREATE TABLE IF NOT EXISTS "deploy_events" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "env" TEXT NOT NULL DEFAULT 'prod',
  "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "deploy_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "deploy_events_user_id_at_idx" ON "deploy_events"("user_id", "at");

CREATE TABLE IF NOT EXISTS "part_rows" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'out',
  "qty" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "part_rows_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "part_rows_user_id_idx" ON "part_rows"("user_id");

CREATE TABLE IF NOT EXISTS "test_results" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "build" TEXT NOT NULL DEFAULT '',
  "status" TEXT NOT NULL DEFAULT 'unknown',
  CONSTRAINT "test_results_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "test_results_user_id_idx" ON "test_results"("user_id");

CREATE TABLE IF NOT EXISTS "citation_links" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "from_title" TEXT NOT NULL,
  "to_title" TEXT NOT NULL,
  CONSTRAINT "citation_links_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "citation_links_user_id_idx" ON "citation_links"("user_id");

CREATE TABLE IF NOT EXISTS "grading_rows" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "class_name" TEXT NOT NULL,
  "expected" INTEGER NOT NULL DEFAULT 0,
  "marked" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "grading_rows_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "grading_rows_user_id_idx" ON "grading_rows"("user_id");
