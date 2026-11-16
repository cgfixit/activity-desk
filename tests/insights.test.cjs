const assert = require("node:assert/strict");
const { test } = require("node:test");
const insights = require("../Activity Desk.app/Contents/Resources/app/insights.js");

test("compares complete calendar windows and breaks streaks at missing dates", () => {
  const today = "2026-01-15";
  const dates = Array.from({ length: 60 }, (_, index) => ({
    date: new Date(Date.parse(today) - index * 864e5).toISOString().slice(0, 10),
    contributionCount: index === 0 ? 0 : index < 30 ? 2 : 1,
  }));
  const summarize = (contributionDays) => insights.summarizeContributions({
    contributionCalendar: { weeks: [{ contributionDays }] },
  }, today);
  const full = summarize(dates);
  assert.equal(full.last30, 58);
  assert.equal(full.prev30, 30);
  assert.equal(full.currentStreak, 59);
  assert.equal(full.trend, 28 / 30);
  const gap = summarize(dates.filter((_, index) => index !== 2));
  assert.equal(gap.currentStreak, 1);
  assert.equal(gap.longestStreak, 57);
  assert.equal(gap.last30, null);
  assert.equal(gap.prev30, 30);
  assert.equal(gap.trend, null);
  assert.equal(summarize(dates.slice(3)).currentStreak, 0);
});

test("ranks returned repository totals and uses the calendar commit total", () => {
  const result = insights.summarizeContributions({
    totalCommitContributions: 100,
    commitContributionsByRepository: [
      { repository: { nameWithOwner: "fixture/one" }, contributions: { totalCount: 10 } },
      { repository: { nameWithOwner: "fixture/two", isPrivate: true }, contributions: { totalCount: 30 } },
    ],
  });
  assert.deepEqual(result.commits[0], { repo: "fixture/two", isPrivate: true, count: 30 });
  assert.equal(result.focusShare, 0.3);
});

test("counts push refs and known agent signals from loaded events", () => {
  const push = (ref) => ({ type: "PushEvent", payload: { ref } });
  const comment = (slug) => ({
    type: "IssueCommentEvent", payload: { comment: { performed_via_github_app: { slug } } },
  });
  const result = insights.summarizeEvents([
    push("refs/heads/main"), push("refs/heads/trunk"), push("refs/heads/codex/upgrade"),
    push("refs/tags/main"), push(), comment("dependency-monitor"), comment("cursor"),
  ]);
  assert.equal(result.mainPushes, 1);
  assert.equal(result.branchPushes, 2);
  assert.equal(result.tagPushes, 1);
  assert.equal(result.otherPushes, 1);
  assert.deepEqual(result.agents, [["Codex", 1], ["Cursor", 1]]);
});

test("includes review and PR comment references without double counting", () => {
  const repo = { name: "fixture/project" };
  const pullRequest = (type, number) => ({ type, repo, payload: { pull_request: { number } } });
  const comment = (number, pull_request) => ({ type: "IssueCommentEvent", repo, payload: { issue: { number, pull_request } } });
  const events = [
    pullRequest("PullRequestReviewEvent", 7),
    pullRequest("PullRequestEvent", 7),
    comment(8, {}),
    comment(9),
  ];
  assert.deepEqual(insights.prRefsFromEvents(events), [7, 8].map((number) => ({ repo: repo.name, number })));
  const matched = insights.filterEvents(events, "all", repo.name, "docs revision", false, {
    "fixture/project#7": { title: "Docs revision" },
  });
  assert.deepEqual(matched, [events[1]]);
});

test("derives calendar rhythm from concentration, breaks, and rolling windows", () => {
  const day = (index, contributionCount) => ({
    date: new Date(Date.parse("2026-01-01") + index * 864e5).toISOString().slice(0, 10), contributionCount,
  });
  const tiny = insights.summarizeRhythm({
    days: [5, 0, 0, 1, 1, 0, 3].map((count, index) => day(index, count)),
    commits: [{ count: 3 }, { count: 1 }],
  });
  assert.equal(tiny.halfDays, 1);
  assert.equal(tiny.medianRun, 1);
  assert.deepEqual(tiny.longestGap, { days: 2, from: "2026-01-02", to: "2026-01-03" });
  assert.equal(tiny.momentum, null);
  assert.equal(tiny.bands, null);
  assert.equal(tiny.repoSpread.effective, 1.6);

  const quietThenBusy = insights.summarizeRhythm({
    days: Array.from({ length: 84 }, (_, index) => day(index, index < 56 ? 1 : 3)),
  });
  assert.deepEqual(quietThenBusy.momentum, { last28: 84, percentile: 1, windows: 56 });
  assert.equal(quietThenBusy.activeWeeks, 12);
  assert.deepEqual(insights.deriveObservations({ rhythm: tiny }), []);
});

test("groups events into sessions and compares sampled merges with sample guards", () => {
  const at = (minutes) => new Date(Date.parse("2026-03-04T12:00:00Z") + minutes * 6e4).toISOString();
  const event = (minutes, name, type, payload) => ({ type, created_at: at(minutes), repo: { name }, payload });
  const sessions = insights.summarizeSessions([
    event(0, "Fixture/one", "CreateEvent", { ref_type: "branch", ref: "codex/a" }),
    event(30, "fixture/two", "IssueCommentEvent", {}),
    event(50, "Fixture/one", "DeleteEvent", { ref_type: "branch", ref: "codex/a" }),
    event(200, "other/three", "PullRequestReviewEvent", {}),
    { type: "PushEvent", created_at: "not a date" },
  ], "fixture");
  assert.equal(sessions.timed, 4);
  assert.equal(sessions.sessions, 2);
  assert.equal(sessions.multi, 1);
  assert.equal(sessions.multiRepo, 1);
  assert.equal(sessions.ownRepo, 3);
  assert.deepEqual(sessions.mix, [["Building", 2], ["Reviewing", 1], ["Discussing", 1]]);
  assert.equal(sessions.branchLifetimes.count, 1);
  assert.ok(Math.abs(sessions.branchLifetimes.medianHours - 50 / 60) < 1e-9);

  const merged = (index, headRef, hours, reviews, lines) => [`fixture/one#${index}`, {
    title: "Change", repo: "fixture/one", number: index, merged: true, state: "MERGED", headRef, reviews,
    createdAt: "2026-03-01T00:00:00Z", mergedAt: new Date(Date.parse("2026-03-01T00:00:00Z") + hours * 36e5).toISOString(),
    additions: lines, deletions: 0,
  }];
  const sample = Object.fromEntries([
    merged(1, "claude/a", 1, 0, 900), merged(2, "codex/b", 1, 0, 800), merged(3, "cursor/c", 1, 0, 700),
    merged(4, "fix/d", 10, 1, 30), merged(5, "fix/e", 10, 1, 20), merged(6, "fix/f", 10, 1, 10),
    ["fixture/one#7", { title: "Open", repo: "fixture/one", number: 7, state: "OPEN", createdAt: "2026-03-01T00:00:00Z" }],
  ]);
  const prs = insights.summarizePrPatterns(sample, "2026-03-21T00:00:00Z");
  assert.equal(prs.agent.medianHours, 1);
  assert.equal(prs.other.unreviewed, 0);
  assert.equal(prs.unreviewedLines / prs.mergedLines, 2400 / 2460);
  assert.equal(prs.larger.agent, 3);
  assert.deepEqual(prs.oldestOpen, { repo: "fixture/one", number: 7, days: 20 });
  assert.deepEqual(insights.deriveObservations({ prs }).map((finding) => [finding.tone, finding.title]), [
    ["warn", "Agent-branch merges skip review more often"],
    ["warn", "98% of merged lines landed without a recorded review"],
    ["warn", "1 loaded open PR older than two weeks"],
    ["info", "Agent-branch PRs merged 10× faster than other PRs"],
    ["info", "Larger PRs merged at least as fast as smaller ones"],
  ]);
  const few = insights.summarizePrPatterns(Object.fromEntries(Object.entries(sample).slice(1, 5)), "2026-03-02T00:00:00Z");
  assert.equal(few.smaller, null);
  assert.deepEqual(insights.deriveObservations({ prs: few }).map((finding) => finding.title), [
    "97% of merged lines landed without a recorded review",
  ]);
});

test("reports a weekly level shift only when it beats shuffled weeks", () => {
  const days = (count) => Array.from({ length: 112 }, (_, i) => ({
    date: new Date(Date.UTC(2026, 0, 1) + i * 864e5).toISOString().slice(0, 10),
    contributionCount: count(i),
  }));
  const step = insights.summarizeTrajectory({ days: days((i) => (i < 56 ? 2 : 10)) });
  assert.equal(step.weeks, 16);
  assert.deepEqual([step.shift.weeksBefore, step.shift.before, step.shift.after, step.shift.clear], [8, 14, 70, true]);
  // Alternating weeks have no level change, so no split should pass.
  const alternating = insights.summarizeTrajectory({ days: days((i) => (Math.floor(i / 7) % 2 ? 6 : 1)) });
  assert.equal(alternating.shift.clear, false);
  // Every other day active: an active day is never followed by another, an idle day always is.
  const odd = insights.summarizeTrajectory({ days: days((i) => i % 2) });
  assert.equal(odd.afterActive.rate, 0);
  assert.equal(odd.afterIdle.rate, 1);
  assert.equal(insights.summarizeTrajectory({ days: days(() => 1).slice(0, 70) }).shift, null);
});

test("follows branches to pull requests and measures first human review", () => {
  const now = Date.parse("2026-03-20T12:00:00Z");
  const at = (h) => new Date(Date.parse("2026-03-01T00:00:00Z") + h * 36e5).toISOString();
  const ev = (type, payload, h, repo = "me/app") => ({ type, payload, created_at: at(h), repo: { name: repo } });
  const events = [
    ev("CreateEvent", { ref_type: "branch", ref: "fix/a" }, 0),
    ev("PullRequestEvent", { action: "opened", number: 1, pull_request: { head: { ref: "fix/a" } } }, 1),
    ev("CreateEvent", { ref_type: "branch", ref: "claude/b" }, 2),
    ev("PullRequestEvent", { action: "opened", number: 2 }, 3),
    ev("CreateEvent", { ref_type: "branch", ref: "codex/orphan" }, 4),
    ev("CreateEvent", { ref_type: "branch", ref: "fix/new" }, 24 * 18.9),
    ev("PullRequestEvent", { action: "opened", number: 3 }, 5),
  ];
  const review = (login, h, bot = false) => ({ login, at: at(h), bot });
  const pr = (number, extra) => ({ title: `PR ${number}`, repo: "me/app", number, author: "me", createdAt: at(1), reviews: extra.reviewList.length, ...extra });
  const prInfo = {
    "me/app#1": pr(1, { headRef: "fix/a", merged: true, state: "MERGED", mergedAt: at(30), mergedBy: "me", reviewList: [review("me", 2), review("ana", 7), review("bo", 9)] }),
    "me/app#2": pr(2, { headRef: "claude/b", merged: true, state: "MERGED", mergedAt: at(2), mergedBy: "me", reviewList: [review("codex-connector", 1.5, true)] }),
    "me/app#3": pr(3, { headRef: "x", merged: false, state: "CLOSED", reviewList: [review("ana", 4)] }),
  };
  const follow = insights.summarizeFollowThrough(events, prInfo, now);
  assert.equal(follow.branches, 4);
  assert.equal(follow.settled, 3, "a branch under two days old is not judged yet");
  assert.deepEqual(follow.withoutPr.map((b) => b.ref), ["codex/orphan"]);
  assert.equal(follow.agentWithoutPr, 1);
  assert.deepEqual(follow.outcomes, { merged: 2, closed: 1, open: 0, unknown: 0 });

  const flow = insights.summarizeReviewFlow(prInfo, "ME");
  assert.equal(flow.authored, 3);
  assert.equal(flow.withHumanReview, 2);
  assert.equal(flow.medianFirstReviewHours, 4.5, "own review at 1 h is skipped; waits are 6 h and 3 h");
  assert.deepEqual([flow.botOnly, flow.noHuman, flow.selfMerged, flow.reviewedBeforeMerge], [1, 1, 2, 1]);
  assert.deepEqual(flow.reviewers, [["ana", 2], ["bo", 1]]);
  assert.equal(insights.isBotLogin("dependabot[bot]"), true);
  assert.equal(insights.isBotLogin("robot"), false);
  assert.deepEqual(insights.deriveObservations({ trajectory: insights.summarizeTrajectory(null), follow: insights.summarizeFollowThrough([], {}), review: insights.summarizeReviewFlow({}, "") }), []);
});

test("flattens issue and pull request conversations and filters them", () => {
  const who = (login, type = "User") => ({ __typename: type, login });
  const data = { pullRequests: { issueCount: 4, nodes: [
    { __typename: "PullRequest", number: 4, title: "Add cache", prState: "MERGED", merged: true, repository: { nameWithOwner: "me/app" },
      comments: { totalCount: 3, nodes: [
        { author: who("ana"), createdAt: "2026-03-02T10:00:00Z", bodyText: "Looks keyed by login" },
        { author: who("Me"), createdAt: "2026-03-02T11:00:00Z", bodyText: "Fixed" },
      ] },
      reviews: { totalCount: 2, nodes: [
        { author: who("ana"), createdAt: "2026-03-02T09:00:00Z", bodyText: "", state: "APPROVED", comments: { totalCount: 0, nodes: [] } },
        { author: who("me"), createdAt: "2026-03-02T08:00:00Z", bodyText: "", state: "COMMENTED",
          comments: { totalCount: 6, nodes: [{ author: who("me"), createdAt: "2026-03-02T08:00:00Z", bodyText: "note", path: "a.js" }] } },
      ] } },
  ] }, issues: { issueCount: 1, nodes: [
    { __typename: "Issue", number: 9, title: "Crash", issueState: "CLOSED", repository: { nameWithOwner: "org/lib" },
      comments: { totalCount: 1, nodes: [{ author: who("helper", "Bot"), createdAt: "2026-03-01T00:00:00Z", bodyText: "Triaged" }, { author: null, createdAt: "bad", bodyText: "x" }] } },
    null,
  ] } };
  const conv = insights.flattenConversations(data, "me");
  assert.equal(conv.threads, 2);
  assert.equal(conv.matched, 5);
  assert.deepEqual(conv.searches, { issues: { loaded: 1, matched: 1 }, pullRequests: { loaded: 1, matched: 4 } });
  assert.deepEqual(conv.truncated, { comments: 1, reviews: 0, reviewComments: 1, threads: 1 }, "one thread, cut short two ways");
  // The empty COMMENTED review only wraps its inline comment; the unparseable date is dropped.
  assert.deepEqual(conv.items.map((c) => `${c.kind}:${c.author}`), ["comment:Me", "comment:ana", "review:ana", "inline:me", "comment:helper"]);
  assert.equal(conv.items[0].mine, true);
  assert.equal(conv.items[2].verdict, "approved");
  assert.equal(conv.items[0].thread.state, "merged");
  assert.equal(conv.items[4].thread.state, "closed");
  const count = (f, repo, q) => insights.filterConversations(conv.items, f, repo, q).length;
  assert.deepEqual([count("all"), count("others"), count("mine"), count("reviews"), count("bots")], [5, 3, 2, 2, 1]);
  assert.equal(count("all", "org/lib"), 1);
  assert.equal(count("all", "", "KEYED"), 1);
  assert.equal(count("all", "", "a.js"), 1);
  assert.deepEqual(insights.flattenConversations(null, "me").items, []);
  assert.equal(insights.flattenConversations(null, "me").usable, false);
  // One search missing still leaves the other usable, and it is reported as missing.
  const half = insights.flattenConversations({ issues: data.issues, pullRequests: null }, "me");
  assert.deepEqual([half.usable, half.threads, half.searches.pullRequests], [true, 1, null]);
  // A thread returned by both searches is listed once.
  const twice = insights.flattenConversations({ issues: data.issues, pullRequests: data.issues }, "me");
  assert.equal(twice.threads, 1);
});

test("finds the text behind comment events in the payload or the loaded conversations", () => {
  const event = (type, payload, at = "2026-03-02T10:00:00Z") => ({ id: "1", type, repo: { name: "me/app" }, created_at: at, payload });
  const thread = { repo: "me/app", number: 9 };
  const index = insights.conversationIndex([
    { kind: "comment", thread, author: "Me", at: "2026-03-02T10:00:40Z", body: "From the thread" },
    { kind: "comment", thread, author: "ana", at: "2026-03-02T10:00:00Z", body: "Someone else" },
  ], "me");
  const text = (e) => insights.eventText(e, index);
  assert.deepEqual(text(event("IssueCommentEvent", { issue: { number: 9 }, comment: { body: "Line one\r\n<!-- bot marker -->\r\n\r\n\r\nLine two" } })),
    { label: "Comment", text: "Line one\n\nLine two", clipped: 0, source: "event" });
  assert.equal(text(event("IssueCommentEvent", { issue: { number: 9 }, comment: { id: 5 } })).source, "conversation");
  assert.equal(text(event("IssueCommentEvent", { issue: { number: 9 }, comment: { id: 5 } })).text, "From the thread");
  assert.deepEqual(text(event("IssueCommentEvent", { issue: { number: 9 } }, "2026-03-02T10:05:00Z")), { label: "Comment", missing: true });
  assert.equal(text(event("IssueCommentEvent", { issue: { number: 9 }, comment: { body: null } })), null);
  assert.equal(text(event("PullRequestReviewEvent", { pull_request: { number: 9 } })), null, "reviews without text are common");
  assert.equal(text(event("PullRequestReviewEvent", { review: { state: "approved", body: "Ship it" } })).label, "Review");
  assert.equal(text(event("IssuesEvent", { action: "opened", issue: { body: "Description" } })).label, "Issue description");
  assert.equal(text(event("IssuesEvent", { action: "closed", issue: { body: "Description" } })), null);
  assert.equal(text(event("PushEvent", {})), null);
  // Removing one comment can rejoin "<!--" from what surrounds it; nothing hidden may survive.
  assert.equal(insights.cleanText("visible <!<!-- x -->-- hidden marker -->text"), "visible text");
  assert.equal(insights.cleanText("keep this <!-- unterminated"), "keep this");
  assert.equal(insights.cleanText("step one --> step two"), "step one --> step two");
  const long = text(event("CommitCommentEvent", { comment: { body: "x".repeat(20010) } }));
  assert.deepEqual([long.text.length, long.clipped], [20000, 10]);
  const events = [event("IssueCommentEvent", { issue: { number: 9 }, comment: { body: "Mentions the retry loop" } })];
  assert.equal(insights.filterEvents(events, "comment", "", "RETRY LOOP", false, {}, index).length, 1);
  assert.equal(insights.filterEvents(events, "comment", "", "absent", false, {}, index).length, 0);
});
