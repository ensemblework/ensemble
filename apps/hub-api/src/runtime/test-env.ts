/**
 * Imported before hub-api config. These checks do not need a repo .env or a database.
 * ESM evaluates this module first when it is the first local import.
 */
process.env.DATABASE_URL ??= "postgresql://ensemble:unused@127.0.0.1:1/ensemble";
process.env.REDIS_URL ??= "memory://runtime-tests";
process.env.ENSEMBLE_INPROCESS_RUNTIME ??= "1";
