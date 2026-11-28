---
name: verify-event-archive
description: Check a change to Activity Desk's saved events (archive.js, or how main.js records Events feed pages) against the promise that a saved span never hides an event. Use before committing any edit to archive.js, to recordEvents or the event-archive handlers in main.js, or to how renderer.js pages the Events feed.
---

# Verify saved events

## The promise

**Property.** Inside every span that saved events report as read in full, every event GitHub's feed served to the reading token is saved.

**Harm if broken.** The dashboard joins saved events to the feed only inside the span that reaches today, and calls the rest a gap. A span that is missing an event shows a busy stretch as quiet: fewer pushes, no late-night work, a branch with no pull request. No error appears.

The check also holds two smaller properties:

- **SHAPE.** Spans are sorted and disjoint.
- **LIMITS.** After a prune, the account is within the level's count and age.

## What the check is

`tests/archive.verify.test.cjs` loads the real `Activity Desk.app/Contents/Resources/app/archive.js`, not a copy of its logic, and runs it against a model of GitHub's Events feed. The model is the part a reviewer must trust. Read its header before changing it. It models:

- whole-second event times, newest first, with ties broken by id;
- at most `cap` events from the last `window`, in pages;
- a read that stops after page 1;
- new events arriving between pages;
- two tokens, where only the fine-grained one sees private events;
- page 2 answered by the other token after a denial;
- page 2 requested alone;
- pruning.

It runs every sequence of up to 4 of 21 steps (204,204), then 4,000 seeded random sequences of up to 12 steps. It does this once on the real file, then once per mutation in `MUTATIONS`, each a broken variant that must produce a counterexample.

Why this tool: JavaScript has no verifier that runs on this code. A bounded enumeration of the real module, rather than a TLA+ model of it, cannot drift from the code it checks, and it runs on Node 22 with nothing to install.

## Coverage record

| Covered code | What the model assumes about it |
| --- | --- |
| `archive.js`: `pageCoverage`, `recordPage`, `addSpan`, `prune`, `cleanEvent` | Called as the model calls them. |
| `main.js`: `recordEvents` | Keys runs by the token the window asked for (`slot`, or `"any"`), passes the token that answered as `via`, and sends the request time as `readAt`. The model mirrors this. If that wiring changes, update `apply()` in the check to match. |
| `renderer.js`: `loadEvents` | Asks for pages 1, 2, 3 in order and stops at the first failure. |

**Not covered:**
- `mergeAccount`, which joins a recovered copy. It only adds events and spans, so it cannot remove an event from a span.
- `view`.
- Encryption and the IPC handlers. `tests/main.test.cjs` exercises these with synthetic responses.
- GitHub's delivery delay of up to several hours. A late event can land in a span already read, and the next refresh adds it. The user guide says so.
- Feeds with more than two pages or a cap above 3. The rules don't depend on page count, but the bound is a bound.

**Sync commit:** `069a0f745eb8e5a7eb05a4012dad462f13e7a6b7`. The check was last confirmed to describe the covered code at this commit.

## When to run it

Run it when a diff touches any of these:
- `archive.js`;
- `recordEvents`, `eventRuns`, `sentAt`, or the `event-archive` handlers in `main.js`;
- `loadEvents` or `loadAllEvents` in `renderer.js`.

To see what changed in covered code since the sync commit:

```bash
git diff 069a0f745eb8e5a7eb05a4012dad462f13e7a6b7 -- "Activity Desk.app/Contents/Resources/app/archive.js" "Activity Desk.app/Contents/Resources/app/main.js" "Activity Desk.app/Contents/Resources/app/renderer.js"
```

## How to run it

```bash
node --test tests/archive.verify.test.cjs
```

It takes about two seconds. CI runs it with the other `tests/*.test.cjs` files.

## Reading a result

- **All tests ok:** the property holds in the bounds above. Every mutation was caught, so the check can still fail.
- **The first test fails:** it prints the broken property, then the shortest numbered story of steps that led there, in the code's words. For example: "the fine-grained token reads page 1 only (page 2 fails)", "1 event(s) at the same second, then 1s pass". Replay the steps against your change and decide which case applies:
  - **A real bug.** The story is something GitHub's feed can do, and the code claims a span it did not read. Fix the code, not the check.
  - **A modeling error.** The story is something GitHub cannot do, or something the renderer never sends. Fix the model in `apply()`, `feedAt()` or `STEPS`, and say why in its comments. Never loosen `violation()` to make a run pass.
- **A "the check catches …" test fails with "no counterexample":** either a mutation's anchor text no longer matches, which fails with "mutation anchor missing", or the model can no longer reach the case that mutation guards. Update the anchor to the code's new text, or add the step that reaches it. Never delete the mutation.

## After an intended change

1. Change the code.
2. If the wiring in the coverage record changed, change `apply()` to match.
3. Add a mutation for any new rule the change relies on.
4. Run the check and see it pass, then break the new rule on purpose and see it fail.
5. Only then move the sync commit above forward to the commit that holds the change.

If the check passes but has not been run against a deliberate break of the new rule, do not move the sync commit.
