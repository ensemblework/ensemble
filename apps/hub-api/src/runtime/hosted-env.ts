/**
 * Imported before hub-api config. Leaves the runtime on the Python HTTP path.
 */
process.env.DATABASE_URL ??= "postgresql://ensemble:unused@127.0.0.1:1/ensemble";
process.env.REDIS_URL ??= "memory://runtime-tests";
delete process.env.ENSEMBLE_INPROCESS_RUNTIME;
delete process.env.ENSEMBLE_DESKTOP;
