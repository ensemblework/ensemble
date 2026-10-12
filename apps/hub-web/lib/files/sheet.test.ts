import assert from "node:assert/strict";
import test from "node:test";
import * as XLSX from "xlsx";
import { buildSheetPatch, columnName, looksLikeHeader, parseCellInput, parseDelimited, readDelimited, readWorkbook, toDelimited, type CellValue } from "./sheet.js";

const ORIGINAL: CellValue[][] = [
  ["Name", "Hours", "Paid"],
  ["Mira Chen", 12, true],
  ["Sam Ortiz", 8, false],
  ["Ana Ruiz", 5, false],
];

test("edits, deletions and added rows become one patch in the original file's coordinates", () => {
  const rows = [
    { origin: 1, values: ["Name", "Hours", "Paid"] },
    { origin: 2, values: ["Mira Chen", 14, true] },
    { origin: 4, values: ["Ana Ruiz", 5, null] },
    { origin: null, values: ["Lee Park", 3, null] },
    { origin: null, values: [null, null, null] },
  ];
  assert.deepEqual(buildSheetPatch([{ name: "Timesheet", original: ORIGINAL, rows }]), {
    sheets: [
      {
        name: "Timesheet",
        set: [
          { row: 2, col: 2, value: 14 },
          { row: 4, col: 3, value: null },
          { row: 5, col: 1, value: "Lee Park" },
          { row: 5, col: 2, value: 3 },
        ],
        deleteRows: [3],
      },
    ],
  });
});

test("an untouched sheet adds nothing, and empty text equals an empty cell", () => {
  const rows = ORIGINAL.map((values, index) => ({ origin: index + 1, values: [...values] }));
  rows[0]!.values.push("");
  assert.deepEqual(buildSheetPatch([{ name: "Timesheet", original: ORIGINAL, rows }]), { sheets: [] });
});

test("typed values become numbers, yes/no and text the way a spreadsheet reads them", () => {
  assert.equal(parseCellInput("42"), 42);
  assert.equal(parseCellInput("-3.5"), -3.5);
  assert.equal(parseCellInput("1,250.75"), 1250.75);
  assert.equal(parseCellInput("007"), "007", "leading zeros stay text (ids, postcodes)");
  assert.equal(parseCellInput("TRUE"), true);
  assert.equal(parseCellInput("  "), null);
  assert.equal(parseCellInput("12 Main St"), "12 Main St");
  assert.equal(columnName(0), "A");
  assert.equal(columnName(25), "Z");
  assert.equal(columnName(26), "AA");
  assert.equal(columnName(701), "ZZ");
});

test("CSV round-trips quotes, separators and line breaks, keeping the BOM and line endings", () => {
  const text = 'name,note\r\n"Chen, Mira","said ""hi""\r\nthen left"\r\nSam,\r\n';
  const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(text)]);
  const { sheet, bom, newline } = readDelimited(bytes, ",");
  assert.equal(bom, true);
  assert.equal(newline, "\r\n");
  assert.deepEqual(
    sheet.rows.map((row) => row.map((cell) => cell?.text ?? "")),
    [["name", "note"], ["Chen, Mira", 'said "hi"\r\nthen left'], ["Sam", ""]],
  );
  const values = sheet.rows.map((row) => row.map((cell) => cell?.value ?? null));
  assert.equal(toDelimited(values, ",", newline), text);
  assert.deepEqual(parseDelimited("a\tb\n1\t2", "\t"), [["a", "b"], ["1", "2"]]);
  assert.equal(toDelimited([["a b", " lead"], ["x\ty", 3]], "\t"), 'a b\t" lead"\n"x\ty"\t3\n');
});

test("workbooks read every sheet with values, formulas and the displayed text", () => {
  const book = XLSX.utils.book_new();
  const first = XLSX.utils.aoa_to_sheet([["Item", "Cost"], ["Seeds", 12.5], ["Soil", 30]]);
  first["C3"] = { t: "n", v: 42.5, f: "B2+B3" };
  first["!ref"] = "A1:C3";
  XLSX.utils.book_append_sheet(book, first, "Budget");
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([]), "Empty");
  const bytes = new Uint8Array(XLSX.write(book, { type: "array", bookType: "xlsx" }) as ArrayBuffer);
  const sheets = readWorkbook(XLSX, bytes);
  assert.deepEqual(sheets.map((sheet) => sheet.name), ["Budget", "Empty"]);
  const budget = sheets[0]!;
  assert.equal(budget.columns, 3);
  assert.equal(budget.rows[1]![1]!.value, 12.5);
  assert.equal(budget.rows[2]![2]!.formula, "B2+B3");
  assert.equal(budget.rows[2]![2]!.value, 42.5);
  assert.equal(looksLikeHeader(budget.rows), true);
  assert.equal(sheets[1]!.rows.length, 0);
});
