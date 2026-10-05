/**
 * Decide what `pnpm db:migrate` should do from `prisma migrate status`.
 *
 * A database created with `pnpm db:push` already has tables and no rows in
 * `_prisma_migrations`. `prisma migrate deploy` then exits P3005 and applies
 * nothing. Replaying those files would also fail: several of them ADD COLUMN
 * or CREATE TABLE without IF NOT EXISTS, and db push already created them.
 * That database needs its history recorded, not a reset.
 */

export function nextMigrateStep(statusText, schemaInSync) {
  if (/database schema is up to date/i.test(statusText)) return "done";
  if (/P3005/.test(statusText) || /database schema is not empty/i.test(statusText)) return "baseline";
  if (/have not yet been applied/i.test(statusText) && schemaInSync) return "baseline";
  return "deploy";
}

export function alreadyRecorded(resolveText) {
  return /P3008/.test(resolveText) || /already recorded as applied/i.test(resolveText);
}
