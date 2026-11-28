"use strict";

// ---------- Saved events ----------
// GitHub's Events feed returns at most 300 events from the past 30 days. The main process keeps what each
// refresh read, so the dashboard can show more than one feed's worth. Alongside the events it keeps
// spans: periods the feed was read in full. Inside a span, every event GitHub's feed served is saved, so
// a quiet stretch reads as quiet. Between spans nothing is known, and the dashboard says so.
// Times in spans are milliseconds. Pure functions only, so Node can check them without Electron.

const DAY_MS = 864e5;
// The feed's own limits. Coverage claims use a day less than GitHub's 30, since GitHub does not say
// exactly where the window starts.
const FEED = Object.freeze({ cap: 300, windowMs: 29 * DAY_MS });
const LEVELS = Object.freeze({
  standard: Object.freeze({ events: 3000, days: 180, bytes: 4e6 }),
  extended: Object.freeze({ events: 15000, days: 1095, bytes: 20e6 }),
});
const MAX_SPANS = 50;
const TEXT_CHARS = 20000; // the window shows at most this much of a comment, as elsewhere
const NESTING = 6;
const ITEMS = 100;

const EVENT_ID = /^\d{1,20}$/;
const EVENT_TYPE = /^[A-Za-z]{1,40}$/;
const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const LOGIN = /^[A-Za-z0-9-]{1,39}(\[bot\])?$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

const timeOf = (event) => Date.parse(event.created_at);
const sizeOf = (event) => Buffer.byteLength(JSON.stringify(event));

// A copy of a payload value with strings, lists, keys, and nesting bounded. API links are left out:
// the window builds its own github.com links from repository names and numbers.
function bounded(value, depth) {
  if (typeof value === "string") return value.slice(0, TEXT_CHARS);
  if (value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return value;
  if (depth >= NESTING || typeof value !== "object") return undefined;
  if (Array.isArray(value)) return value.slice(0, ITEMS).map((v) => bounded(v, depth + 1)).filter((v) => v !== undefined);
  const out = {};
  for (const key of Object.keys(value).slice(0, ITEMS)) {
    if (key === "_links" || (key.endsWith("url") && key !== "html_url")) continue;
    const v = bounded(value[key], depth + 1);
    if (v !== undefined) out[key] = v;
  }
  return out;
}

// The fields the dashboard reads from an event, or null when it lacks what every summary depends on.
function cleanEvent(e) {
  if (!e || typeof e !== "object" || typeof e.id !== "string" || !EVENT_ID.test(e.id) ||
      typeof e.type !== "string" || !EVENT_TYPE.test(e.type) ||
      typeof e.created_at !== "string" || !ISO_TIME.test(e.created_at) || !Number.isFinite(timeOf(e)) ||
      typeof e.repo?.name !== "string" || !REPO.test(e.repo.name) ||
      typeof e.actor?.login !== "string" || !LOGIN.test(e.actor.login)) return null;
  return {
    id: e.id, type: e.type, created_at: e.created_at, public: e.public !== false,
    repo: { name: e.repo.name }, actor: { login: e.actor.login },
    payload: e.payload && typeof e.payload === "object" ? bounded(e.payload, 1) : {},
  };
}

const emptyAccount = (login) => ({ login, events: {}, spans: [] });

// Adds a span and joins every span it overlaps. Spans stay sorted and disjoint.
function addSpan(spans, from, to) {
  if (!(from <= to)) return spans;
  let lo = from;
  let hi = to;
  const out = [];
  for (const [a, b] of spans) {
    if (b < lo || a > hi) out.push([a, b]);
    else { lo = Math.min(lo, a); hi = Math.max(hi, b); }
  }
  out.push([lo, hi]);
  return out.sort((x, y) => x[0] - y[0]);
}

// What one page of the feed proves was read in full. A refresh reads pages 1, 2, 3 in order, and each
// page continues the one before it. `runs` remembers, per account and per token the window asked for,
// the page-1 time, the token that answered, and the oldest event so far. A page answered by a different
// token than page 1 is not a continuation: each token's feed holds the events it may see, so their pages
// do not line up. GitHub stamps events to the second, and events that share a second can fall on
// either side of a page break or of the request itself, so a span never includes the second at its
// edges. A run covers from after its oldest event's second up to before the second page 1 was sent in.
// When the feed ran out before GitHub's cap, the run reaches back to the start of the window as it stood
// when the last page was read: the window moves between pages, and older events leave it. A page
// that does not continue a run covers only the seconds strictly between its own oldest and newest events.
const SECOND = 1000;
const secondOf = (ms) => Math.floor(ms / SECOND) * SECOND;
function pageCoverage(runs, key, { page, events, more, readAt, via }, feed = FEED) {
  const times = events.map(timeOf).filter(Number.isFinite);
  const continues = page === 1 || (runs[key]?.page === page - 1 && runs[key].via === via);
  if (page === 1) runs[key] = { page: 0, readAt, via, count: 0, oldest: Infinity };
  if (!continues) {
    delete runs[key];
    return times.length > 1 ? { from: secondOf(Math.min(...times)) + SECOND, to: secondOf(Math.max(...times)) - 1 } : null;
  }
  const run = runs[key];
  run.page = page;
  run.count += events.length;
  run.oldest = Math.min(run.oldest, ...times);
  const exhausted = !more && run.count < feed.cap;
  // The feed holds events newer than readAt - window, so the window's own first instant is left out.
  const after = secondOf(run.oldest) + SECOND;
  const from = exhausted ? Math.min(after, readAt - feed.windowMs + 1) : after;
  return Number.isFinite(from) ? { from, to: secondOf(run.readAt) - 1 } : null;
}

// Saves one page's events and the span it proves. Returns true when anything changed.
function recordPage(account, runs, key, page, feed = FEED) {
  const cover = pageCoverage(runs, key, page, feed);
  let changed = false;
  for (const raw of page.events) {
    const e = cleanEvent(raw);
    if (!e) continue;
    const before = account.events[e.id];
    if (!before || JSON.stringify(before) !== JSON.stringify(e)) { account.events[e.id] = e; changed = true; }
  }
  if (cover) {
    const spans = addSpan(account.spans, cover.from, cover.to);
    if (JSON.stringify(spans) !== JSON.stringify(account.spans)) { account.spans = spans; changed = true; }
  }
  return changed;
}

// Keeps the newest events within the level's count, size, and age, and moves every span to start after
// the newest event it dropped, so no span claims a period whose events are gone. Returns the count dropped.
function prune(account, limits, now, maxSpans = MAX_SPANS) {
  const oldest = now - limits.days * DAY_MS;
  const sorted = Object.values(account.events).sort((a, b) => timeOf(b) - timeOf(a) || b.id.localeCompare(a.id));
  let bytes = 0;
  let kept = 0;
  for (const e of sorted) {
    const size = sizeOf(e);
    if (timeOf(e) < oldest || kept >= limits.events || bytes + size > limits.bytes) break;
    bytes += size;
    kept += 1;
  }
  const dropped = sorted.slice(kept);
  for (const e of dropped) delete account.events[e.id];
  const after = Math.max(oldest, dropped.length ? timeOf(dropped[0]) + 1 : -Infinity);
  account.spans = account.spans.map(([a, b]) => [Math.max(a, after), b]).filter(([a, b]) => a <= b).slice(-maxSpans);
  return dropped.length;
}

// Joins a store recovered from a copy that had been set aside into the current one. Events are
// matched by id and spans joined, so joining the same copy twice changes nothing.
function mergeAccount(into, from) {
  for (const [id, e] of Object.entries(from.events || {})) {
    const clean = cleanEvent(e);
    if (clean && clean.id === id && !into.events[id]) into.events[id] = clean;
  }
  for (const s of Array.isArray(from.spans) ? from.spans : []) {
    if (Array.isArray(s) && s.length === 2 && s.every(Number.isFinite)) into.spans = addSpan(into.spans, s[0], s[1]);
  }
  return into;
}

// What the window receives: the span that reaches the latest read and its events, plus a count for each
// earlier span. Events outside every span are kept but not shown, since nothing says what is missing
// around them.
function view(account) {
  const spans = account?.spans || [];
  const events = Object.values(account?.events || {});
  const inSpan = ([a, b]) => events.filter((e) => timeOf(e) >= a && timeOf(e) <= b);
  const last = spans.at(-1);
  return {
    current: last ? { from: last[0], to: last[1], events: inSpan(last).sort((x, y) => timeOf(y) - timeOf(x)) } : null,
    earlier: spans.slice(0, -1).map((s) => ({ from: s[0], to: s[1], count: inSpan(s).length })).reverse(),
    count: events.length,
  };
}

module.exports = { FEED, LEVELS, MAX_SPANS, DAY_MS, cleanEvent, emptyAccount, addSpan, pageCoverage, recordPage, prune, mergeAccount, view, timeOf };
