(() => {
"use strict";

// Display helpers for Stream → Notes. The main process stores the notes; this file only formats them.
// It can be required from Node.

const TITLE_CHARS = 80;
const PREVIEW_CHARS = 120;
const COLOR_NAMES = { yellow: "Yellow", green: "Green", blue: "Blue", pink: "Pink", purple: "Purple" };

const lines = (text) => String(text || "").split("\n").map((line) => line.trim()).filter(Boolean);
const cut = (text, max) => (text.length > max ? `${text.slice(0, max).trimEnd()}…` : text);

// The first non-empty line is the title, as in Apple Notes. Empty notes have no title.
function noteTitle(text) {
  return cut(lines(text)[0] || "", TITLE_CHARS);
}

// The lines after the title, joined into one line.
function notePreview(text) {
  return cut(lines(text).slice(1).join(" "), PREVIEW_CHARS);
}

const later = (a, b) => (a < b) - (a > b);

// Pinned notes first, then the most recently edited.
function sortNotes(notes) {
  return (notes || []).slice().sort((a, b) =>
    (b.pinned === true) - (a.pinned === true) || later(String(a.updated), String(b.updated)) || later(String(a.created), String(b.created)));
}

function filterNotes(notes, query) {
  const q = String(query || "").trim().toLowerCase();
  return q ? (notes || []).filter((n) => String(n.text).toLowerCase().includes(q)) : (notes || []);
}

// A list label for an edit time: the time today, "Yesterday", a weekday within the week, then a date.
function noteDateLabel(iso, now) {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return "";
  const ref = now instanceof Date ? now : new Date();
  const start = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((start(ref) - start(when)) / 864e5);
  if (days <= 0) return when.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (days === 1) return "Yesterday";
  if (days < 7) return when.toLocaleDateString([], { weekday: "long" });
  return when.toLocaleDateString([], { month: "numeric", day: "numeric", year: "2-digit" });
}

const api = { noteTitle, notePreview, sortNotes, filterNotes, noteDateLabel, COLOR_NAMES, TITLE_CHARS, PREVIEW_CHARS };

if (typeof module !== "undefined" && module.exports) module.exports = api;
if (typeof window !== "undefined") window.DeskNotes = api;
})();
