import { execFileSync } from "node:child_process";

/**
 * Run one INSERT or UPDATE and fail when it does not change exactly `expected` rows.
 * psql exits 0 for an UPDATE that matches nothing, so the row count has to be checked here.
 */
export function execSqlChanging(psql, statement, label, expected = 1) {
  const count = Number(expected);
  execFileSync(
    "psql",
    [
      psql,
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      `DO $$
DECLARE updated_count integer;
BEGIN
  ${statement}
  GET DIAGNOSTICS updated_count = ROW_COUNT;
  IF updated_count <> ${count} THEN
    RAISE EXCEPTION '${label} expected ${count} row(s), changed %', updated_count;
  END IF;
END $$;`,
    ],
    { stdio: "pipe" },
  );
}

export function markTester(psql, email) {
  const safe = String(email).replaceAll("'", "");
  execSqlChanging(psql, `UPDATE users SET tester = true WHERE email = '${safe}';`, "mark tester");
}
