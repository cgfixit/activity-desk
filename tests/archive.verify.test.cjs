"use strict";
// Bounded verification of saved events (archive.js). It runs the real module against every sequence of
// up to DEPTH steps over a small model of GitHub's Events feed, plus seeded random longer sequences,
// and checks after every step:
//   COVERAGE  Inside every saved span, every event the feed could have served is saved. A span is a claim
//             that a period was read in full, so a missing event there would show a busy stretch as quiet.
//   SHAPE     Spans are sorted, disjoint, and each starts no later than it ends.
//   LIMITS    After a prune, the account holds at most the level's event count, bytes, and age.
// The feed model: events at whole-second times, newest first with ties broken by id, at most CAP events
// from the last WINDOW, split into pages of PAGE. A read can stop early (a failed page), new events can
// arrive between pages (shifting later pages), two tokens read in turn and only the fine-grained one sees
// private events, the other token can answer page 2 after a denial, and a page 2 can come alone.
// GitHub's delivery delay is not modeled: an event is in the feed from its creation time.
// Run: node --test tests/archive.verify.test.cjs   (about 10 seconds)
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const SOURCE = path.resolve(__dirname, "../Activity Desk.app/Contents/Resources/app/archive.js");
const S = 1000; // one model time unit, in milliseconds
const FEED = { cap: 3, windowMs: 6 * S };
const PAGE = 2;
const DEPTH = 4; // every sequence of up to 4 of the 21 steps: 21^4 + 21^3 + 21^2 + 21 = 204,204
const RANDOM_RUNS = 4000;
const RANDOM_DEPTH = 12;

// Steps, named in the code's terms so a counterexample reads as a story.
const STEPS = [];
for (const n of [1, 2]) for (const gap of [1, 3, 8]) STEPS.push({ kind: "arrive", n, gap, text: `${n} event(s) at the same second, then ${gap}s pass` });
// A private event only the fine-grained token sees, so the two tokens' pages no longer line up.
for (const gap of [1, 3]) STEPS.push({ kind: "arrive", n: 1, gap, priv: true, text: `1 private event, then ${gap}s pass` });
for (const key of ["fine-grained", "classic"]) {
  for (const pages of [1, 2]) for (const shift of [false, true]) {
    STEPS.push({ kind: "read", key, pages, shift, text: `the ${key} token reads ${pages === 1 ? "page 1 only (page 2 fails)" : "pages 1 and 2"}${shift ? ", with a new event between them" : ""}` });
  }
}
// After a denial, the main process can answer page 2 with the other token, which has no page 1 in this run.
for (const key of ["fine-grained", "classic"]) {
  STEPS.push({ kind: "read", key, pages: 2, shift: true, switched: true, text: `the ${key} token reads page 1, a new event arrives, and the other token answers page 2` });
}
// A page 2 with no page 1 before it in this refresh, which the window does not send today.
for (const key of ["fine-grained", "classic"]) STEPS.push({ kind: "read", key, pages: 2, alone: true, text: `the window asks the ${key} token for page 2 alone` });
STEPS.push({ kind: "prune", limits: { events: 2, days: (5 * S) / 864e5, bytes: 1e9 }, text: "a save prunes to 2 events and 5s of age" });

function makeWorld() {
  return { now: 10 * S, nextId: 100, events: [] };
}
const newest = (a, b) => b.t - a.t || b.id - a.id;
const sees = (key, e) => key === "fine-grained" || !e.priv;
function feedAt(world, offset, key) {
  const all = world.events.filter((e) => sees(key, e) && e.t <= world.now && e.t > world.now - FEED.windowMs).sort(newest).slice(0, FEED.cap);
  const page = all.slice(offset, offset + PAGE);
  return { events: page.map(asEvent), more: offset + PAGE < all.length };
}
const asEvent = (e) => ({ id: String(e.id), type: "PushEvent", created_at: new Date(e.t).toISOString().replace(".000Z", "Z"), repo: { name: "me/app" }, actor: { login: "me" }, payload: {} });
const arrive = (world, n, priv = false) => { for (let i = 0; i < n; i += 1) world.events.push({ id: (world.nextId += 1), t: world.now, priv }); };

function apply(A, world, account, runs, step) {
  if (step.kind === "arrive") { arrive(world, step.n, step.priv); world.now += step.gap * S; return; }
  if (step.kind === "prune") { A.prune(account, step.limits, world.now); return; }
  const readAt = world.now;
  // Runs are keyed by the token the window asked for; `via` is the token that answered.
  if (!step.alone) A.recordPage(account, runs, step.key, { page: 1, readAt, via: step.key, ...feedAt(world, 0, step.key) }, FEED);
  if (step.pages === 2) {
    if (step.shift) { arrive(world, 1); world.now += S; }
    const via = step.switched ? (step.key === "classic" ? "fine-grained" : "classic") : step.key;
    A.recordPage(account, runs, step.key, { page: 2, readAt: world.now, via, ...feedAt(world, PAGE, via) }, FEED);
  }
  world.now += S;
}

function violation(A, world, account, step) {
  const spans = account.spans;
  for (const [i, [a, b]] of spans.entries()) {
    if (!(a <= b)) return `SHAPE: span ${i} starts after it ends`;
    if (i && !(spans[i - 1][1] < a)) return `SHAPE: spans ${i - 1} and ${i} overlap or are out of order`;
  }
  for (const [a, b] of spans) {
    // Every token sees public events, so every span must hold them. A private event is covered only by
    // what the fine-grained token read, as GitHub's feed itself shows each token only what it may see.
    const missing = world.events.find((e) => !e.priv && e.t >= a && e.t <= b && !account.events[String(e.id)]);
    if (missing) return `COVERAGE: event ${missing.id} at ${missing.t / S}s lies in saved span ${a / S}s–${b / S}s but is not saved`;
  }
  if (step.kind === "prune") {
    const kept = Object.values(account.events);
    if (kept.length > step.limits.events) return `LIMITS: ${kept.length} events kept, limit ${step.limits.events}`;
    const old = kept.find((e) => A.timeOf(e) < world.now - step.limits.days * 864e5);
    if (old) return `LIMITS: event ${old.id} is older than the age limit`;
  }
  return "";
}

function run(A, steps) {
  const world = makeWorld();
  const account = A.emptyAccount("me");
  const runs = {};
  for (const [i, step] of steps.entries()) {
    apply(A, world, account, runs, step);
    const v = violation(A, world, account, step);
    if (v) return { at: i, problem: v, story: steps.slice(0, i + 1).map((s, j) => `${j + 1}. ${s.text}`) };
  }
  return null;
}

// Every sequence up to DEPTH, then seeded random sequences up to RANDOM_DEPTH. Returns the first
// counterexample, or null, and how many sequences ran.
function check(A) {
  let count = 0;
  const walk = (prefix) => {
    if (prefix.length) {
      count += 1;
      const bad = run(A, prefix);
      if (bad) return bad;
    }
    if (prefix.length === DEPTH) return null;
    for (const step of STEPS) {
      const bad = walk([...prefix, step]);
      if (bad) return bad;
    }
    return null;
  };
  const exhaustive = walk([]);
  if (exhaustive) return { ...exhaustive, count };
  let seed = 20261128;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  for (let r = 0; r < RANDOM_RUNS; r += 1) {
    const steps = Array.from({ length: 1 + Math.floor(rand() * RANDOM_DEPTH) }, () => STEPS[Math.floor(rand() * STEPS.length)]);
    count += 1;
    const bad = run(A, steps);
    if (bad) return { ...bad, count };
  }
  return { count };
}

// Loads archive.js, optionally with one edit, from a scratch copy so the real file is never touched.
function load(edit) {
  let text = fs.readFileSync(SOURCE, "utf8");
  if (edit) {
    assert.ok(text.includes(edit[0]), `mutation anchor missing: ${edit[0]}`);
    text = text.replace(edit[0], edit[1]);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "archive-verify-"));
  const file = path.join(dir, "archive.js");
  fs.writeFileSync(file, text);
  try {
    return require(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("saved events: every saved span is complete, spans stay disjoint, and pruning keeps its limits", () => {
  const result = check(load());
  assert.equal(result.problem, undefined, result.story ? `${result.problem}\n${result.story.join("\n")}` : "");
  assert.ok(result.count > 10000, `only ${result.count} sequences ran`);
});

// Each property must fail on a broken variant of the code it guards, or the check proves nothing.
const MUTATIONS = {
  "the window measured from page 1 instead of the last page": ["Math.min(after, readAt - feed.windowMs + 1)", "Math.min(after, run.readAt - feed.windowMs + 1)"],
  "a request's own second counted as read": ["return Number.isFinite(from) ? { from, to: secondOf(run.readAt) - 1 } : null;", "return Number.isFinite(from) ? { from, to: run.readAt } : null;"],
  "a capped feed read as having run out": ["const exhausted = !more && run.count < feed.cap;", "const exhausted = !more;"],
  "page 1 claiming the instant of its oldest event": ["const after = secondOf(run.oldest) + SECOND;", "const after = run.oldest;"],
  "a page that does not follow the last one treated as continuing": ["const continues = page === 1 || (runs[key]?.page === page - 1 && runs[key].via === via);", "const continues = page === 1 || Boolean(runs[key]);"],
  "a page from another token treated as continuing": ["const continues = page === 1 || (runs[key]?.page === page - 1 && runs[key].via === via);", "const continues = page === 1 || runs[key]?.page === page - 1;"],
  "pruning that leaves spans over deleted events": ["const after = Math.max(oldest, dropped.length ? timeOf(dropped[0]) + 1 : -Infinity);", "const after = oldest;"],
  "pruning that keeps more than the limit": ["kept >= limits.events ||", "kept > limits.events ||"],
  "spans joined without merging overlaps": ["if (b < lo || a > hi) out.push([a, b]);", "if (true) out.push([a, b]);"],
};
for (const [name, edit] of Object.entries(MUTATIONS)) {
  test(`the check catches ${name}`, () => {
    const result = check(load(edit));
    assert.ok(result.problem, `no counterexample in ${result.count} sequences`);
  });
}

module.exports = { check, load, run, STEPS, apply, makeWorld, feedAt };
