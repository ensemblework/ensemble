import assert from "node:assert/strict";
import test from "node:test";
import { assertWithinLimit, hostedLimits } from "./hosted-limits.js";
import { storedTableBytes } from "../plots/store.js";

test("hosted limits default to five connectors, fifty jobs and 100 MiB per storage area", () => {
  assert.deepEqual(hostedLimits({}), { connectors: 5, jobsPerDay: 50, datasetBytes: 104857600, documentBytes: 104857600 });
  assert.deepEqual(hostedLimits({ ENSEMBLE_MAX_CONNECTORS: "2", ENSEMBLE_MAX_JOBS_PER_DAY: "3", ENSEMBLE_MAX_DATASET_BYTES: "100", ENSEMBLE_MAX_DOCUMENT_BYTES: "101" }), { connectors: 2, jobsPerDay: 3, datasetBytes: 100, documentBytes: 101 });
});
test("invalid quota configuration fails loudly instead of disabling the cap", () => {
  for (const value of ["0", "-1", "Infinity", "1.5", "abc", "9007199254740992"]) {
    assert.throws(() => hostedLimits({ ENSEMBLE_MAX_CONNECTORS: value }), /positive safe integer/);
    assert.throws(() => hostedLimits({ ENSEMBLE_MAX_DOCUMENT_BYTES: value }), /ENSEMBLE_MAX_DOCUMENT_BYTES must be a positive safe integer/);
  }
});
test("exact thresholds fit; one connector, job or byte over is refused", () => {
  for (const max of [5, 50, 104857600]) {
    assertWithinLimit(max - 1, 1, max, "resource");
    assertWithinLimit(max, 0, max, "resource");
    assert.throws(() => assertWithinLimit(max, 1, max, "resource"), { statusCode: 429 });
    assert.throws(() => assertWithinLimit(0, max + 1, max, "resource"), { statusCode: 429 });
  }
  assert.throws(() => assertWithinLimit(-1, 1, 5, "resource"), /Invalid/);
});

test("dataset storage counts compressed tables plus every original byte", () => {
  const table = { columns: [{ name: "value", type: "number" as const }], rows: [[1], [2]] };
  const compressed = storedTableBytes(table);
  assert.ok(compressed > 0);
  assert.equal(storedTableBytes(table, new Uint8Array(17)), compressed + 17);
});
