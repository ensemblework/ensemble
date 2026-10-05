-- A job the app was running when it quit or crashed. Never re-run on its own; the person picks Run again.
ALTER TYPE "WorkspaceJobStatus" ADD VALUE IF NOT EXISTS 'interrupted';
