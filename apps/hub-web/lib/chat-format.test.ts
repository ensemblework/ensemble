import assert from "node:assert/strict";
import test from "node:test";
import { afterInput, backspaceInList, breakInItem, enterInList, indentList, inList, toMarkdown, wrapInline, type Edit } from "./chat-format";

/** "a|b" is the text "ab" with the caret after "a"; "a‹b›c" has "b" picked. */
function box(text: string): Edit {
  if (text.includes("‹")) {
    const start = text.indexOf("‹");
    const end = text.indexOf("›") - 1;
    return { value: text.replace("‹", "").replace("›", ""), start, end };
  }
  const at = text.indexOf("|");
  return { value: text.replace("|", ""), start: at, end: at };
}
const show = (edit: Edit | null) => (edit ? (edit.start === edit.end ? edit.value.slice(0, edit.start) + "|" + edit.value.slice(edit.start) : edit.value.slice(0, edit.start) + "‹" + edit.value.slice(edit.start, edit.end) + "›" + edit.value.slice(edit.end)) : null);
const typed = (before: string, after: string) => show(afterInput(box(before).value, box(after)));

test("typing - or * and a space at the start of a line starts a bulleted list; 1. is already a list", () => {
  assert.equal(typed("-|", "- |"), "• |");
  assert.equal(typed("Groceries\n*|", "Groceries\n* |"), "Groceries\n• |");
  assert.equal(typed("a -|", "a - |"), null, "only at the start of a line");
  assert.equal(typed("```\n-|", "```\n- |"), null, "never in code");
  assert.equal(typed("*bold|", "*bold |"), null);
  assert.equal(typed("- |text", "- |text"), null, "nothing new was typed");
});

test("Enter continues the list, numbers follow, and Enter on an empty item leaves it", () => {
  assert.equal(show(enterInList(box("1. Milk|"))), "1. Milk\n2. |");
  assert.equal(show(enterInList(box("• Milk|"))), "• Milk\n• |");
  assert.equal(show(enterInList(box("1) Milk|"))), "1) Milk\n2) |");
  assert.equal(show(enterInList(box("1. Milk|\n2. Eggs\n3. Tea"))), "1. Milk\n2. |\n3. Eggs\n4. Tea", "items after it are renumbered");
  assert.equal(show(enterInList(box("1. Mi|lk"))), "1. Mi\n2. |lk", "splits the item at the caret");
  assert.equal(show(enterInList(box("1. Milk\n2. |"))), "1. Milk\n|", "an empty item ends the list");
  assert.equal(show(enterInList(box("- [x] done|"))), "- [x] done\n- [ ] |", "a task item continues unticked");
  assert.equal(show(enterInList(box("9. Nine|"))), "9. Nine\n10. |");
  assert.equal(enterInList(box("Just text|")), null, "not a list: Enter sends");
});

test("an empty nested item steps out a level; the marker at the caret makes room above", () => {
  assert.equal(show(enterInList(box("• Fruit\n  ◦ |"))), "• Fruit\n• |");
  assert.equal(show(enterInList(box("1. a\n   1. |"))), "1. a\n2. |");
  assert.equal(show(enterInList(box("1. |Milk"))), "1. \n2. |Milk");
});

test("Shift+Enter breaks the line inside an item, and Enter there adds the next item", () => {
  assert.equal(show(breakInItem(box("1. Milk|"))), "1. Milk\n   |");
  assert.equal(show(enterInList(box("1. Milk\n   whole|"))), "1. Milk\n   whole\n2. |");
  assert.equal(breakInItem(box("plain|")), null);
});

test("Tab nests an item under the one above, Shift+Tab brings it back, bullets change by depth", () => {
  assert.equal(show(indentList(box("• Fruit\n• App|le"), false)), "• Fruit\n  ◦ App|le");
  assert.equal(show(indentList(box("• Fruit\n  ◦ App|le"), true)), "• Fruit\n• App|le");
  assert.equal(show(indentList(box("1. a\n2. b|\n3. c"), false)), "1. a\n   1. b|\n2. c", "a nested list starts at 1, the rest renumber");
  assert.equal(show(indentList(box("1. a\n   1. b|\n2. c"), true)), "1. a\n2. b|\n3. c");
  assert.deepEqual(indentList(box("• fir|st"), false), box("• fir|st"), "the first item cannot nest, but Tab stays in the box");
  assert.equal(indentList(box("text|"), false), null, "outside a list Tab moves on");
  assert.equal(show(indentList(box("• a\n• ‹b\n• c›"), false)), "• a\n  ◦ ‹b\n  ◦ c›", "every picked item moves");
});

test("Backspace right after a marker steps out, then takes the marker away (the rest keep their numbers, as in Docs)", () => {
  assert.equal(show(backspaceInList(box("• a\n  ◦ |b"))), "• a\n• |b");
  assert.equal(show(backspaceInList(box("1. a\n2. |b\n3. c"))), "1. a\n|b\n3. c");
  assert.equal(backspaceInList(box("1. a|b")), null);
});

test("pasting or deleting lines renumbers numbered lists from their first number", () => {
  assert.equal(show(afterInput("1. a\n2. b\n3. c", box("1. a\n3. c|"))), "1. a\n2. c|");
  assert.equal(show(afterInput("x", box("1. a\n1. b\n1. c|"))), "1. a\n2. b\n3. c|");
  assert.equal(afterInput("5. a\n6. b", box("5. a\n6. b|")), null);
});

test("sending turns bullets back into Markdown; code keeps its own", () => {
  assert.equal(toMarkdown("• a\n  ◦ b\n    ▪ c\n1. d"), "- a\n  - b\n    - c\n1. d");
  assert.equal(toMarkdown("```\n• keep\n```"), "```\n• keep\n```");
  assert.equal(inList("• a", 3), true);
  assert.equal(inList("plain", 2), false);
});

test("Ctrl/Cmd+B, I, E and Shift+X wrap and unwrap the selection", () => {
  assert.equal(show(wrapInline(box("make ‹this› bold"), "**")), "make **‹this›** bold");
  assert.equal(show(wrapInline(box("make **‹this›** bold"), "**")), "make ‹this› bold");
  assert.equal(show(wrapInline(box("make ‹**this**› bold"), "**")), "make ‹this› bold");
  assert.equal(show(wrapInline(box("a ‹word ›b"), "`")), "a `‹word›` b", "the space after a double-clicked word stays outside");
  assert.equal(show(wrapInline(box("x|y"), "*")), "x*|*y");
  assert.equal(show(wrapInline(box("**‹bold›**"), "*")), "***‹bold›***", "italic does not unwrap half of a bold");
  assert.equal(show(wrapInline(box("‹• one\n• two›"), "~~")), "‹• ~~one~~\n• ~~two~~›");
});

test("a sent message shows lists as lists: nested by indentation, numbered as typed, continued lines kept", async () => {
  const { chatRows } = await import("../components/chat-text");
  assert.deepEqual(chatRows("Shopping:\n- milk\n  - oat\n3. eggs\n   free range\nThanks"), [
    { kind: "text", text: "Shopping:" },
    { kind: "item", depth: 0, marker: "•", task: null, text: "milk" },
    { kind: "item", depth: 1, marker: "◦", task: null, text: "oat" },
    { kind: "item", depth: 0, marker: "3.", task: null, text: "eggs\nfree range" },
    { kind: "text", text: "Thanks" },
  ]);
  assert.deepEqual(chatRows("```\n- not a list\n```"), [{ kind: "text", text: "```\n- not a list\n```" }]);
});
