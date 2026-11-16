const assert = require("node:assert/strict");
const { test } = require("node:test");
const notes = require("../Activity Desk.app/Contents/Resources/app/notes.js");

test("titles and previews come from the note's lines", () => {
  assert.equal(notes.noteTitle("\n  Groceries  \nmilk\n\neggs"), "Groceries");
  assert.equal(notes.notePreview("\n  Groceries  \nmilk\n\neggs"), "milk eggs");
  assert.equal(notes.noteTitle(""), "");
  assert.equal(notes.notePreview("Only a title"), "");
  assert.equal(notes.noteTitle("x".repeat(100)), `${"x".repeat(80)}…`);
  assert.equal(notes.notePreview(`t\n${"y".repeat(200)}`).length, 121);
});

test("pinned notes sort first, then the most recently edited, and search reads the text", () => {
  const list = [
    { id: "a", text: "Old", pinned: false, updated: "2026-01-01T00:00:00.000Z", created: "2026-01-01T00:00:00.000Z" },
    { id: "b", text: "Pinned old", pinned: true, updated: "2025-01-01T00:00:00.000Z", created: "2025-01-01T00:00:00.000Z" },
    { id: "c", text: "New\nwith milk", pinned: false, updated: "2026-02-01T00:00:00.000Z", created: "2026-01-01T00:00:00.000Z" },
  ];
  assert.deepEqual(notes.sortNotes(list).map((n) => n.id), ["b", "c", "a"]);
  assert.deepEqual(list.map((n) => n.id), ["a", "b", "c"], "sorting copies the list");
  assert.deepEqual(notes.filterNotes(list, " MILK ").map((n) => n.id), ["c"]);
  assert.equal(notes.filterNotes(list, "").length, 3);
});

test("edit times read as a time today, then yesterday, a weekday, and a date", () => {
  const now = new Date(2026, 10, 16, 15, 0);
  assert.match(notes.noteDateLabel(new Date(2026, 10, 16, 9, 5).toISOString(), now), /9:05/);
  assert.equal(notes.noteDateLabel(new Date(2026, 10, 15, 23, 0).toISOString(), now), "Yesterday");
  assert.equal(notes.noteDateLabel(new Date(2026, 10, 12, 8, 0).toISOString(), now),
    new Date(2026, 10, 12).toLocaleDateString([], { weekday: "long" }));
  assert.match(notes.noteDateLabel(new Date(2025, 0, 2).toISOString(), now), /25/);
  assert.equal(notes.noteDateLabel("not a date", now), "");
});
