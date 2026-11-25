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
    // Review findings are notes unless the user's own outcomes back them, so only the open one warns.
    ["warn", "1 loaded open PR older than two weeks"],
    ["info", "Agent-branch PRs merged 10× faster than other PRs"],
    ["info", "Agent-branch merges skip review more often"],
    ["info", "98% of merged lines landed without a recorded review"],
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

test("withholds text if hidden comment markup still needs cleanup", () => {
  let body = "<!-- example -->";
  for (let i = 0; i < 12; i += 1) body = `<!${body}-- note -->`;
  assert.equal(insights.textInfo("Comment", `Before ${body} after`), null);
  assert.equal(insights.textInfo("Comment", "Before <!-- example --> after").text, "Before  after");
});

test("joins what a fine-grained and a classic token each returned for one account", () => {
  const events = insights.mergeTokenEvents([
    { slot: "fine-grained", events: [{ id: "1" }, { id: "2" }] },
    { slot: "classic", events: [{ id: "2" }, { id: "3" }, { id: "4" }, null] },
  ]);
  assert.deepEqual([events.events.map((e) => e.id), events.only], [["1", "2", "3", "4"], { "fine-grained": 1, classic: 2 }]);

  const load = (info, extra = {}) => ({ info, loaded: Object.keys(info).length, total: Object.keys(info).length, capped: false, partial: false, issue: "", days: 90, ...extra });
  const prs = insights.mergePullRequestLoads([
    { slot: "fine-grained", load: load({ "a/b#1": { title: "one" } }, { partial: true }) },
    { slot: "classic", load: load({ "a/b#1": { title: "one" }, "org/c#2": { title: "two" } }, { total: 5, capped: true, issue: "Page 2 did not load." }) },
  ]);
  assert.deepEqual(Object.keys(prs.info), ["a/b#1", "org/c#2"]);
  assert.deepEqual([prs.loaded, prs.total, prs.capped, prs.partial, prs.partialSlots, prs.only, prs.days],
    [2, 5, true, true, ["fine-grained"], { "fine-grained": 0, classic: 1 }, 90]);
  assert.equal(prs.issue, "With the classic token: Page 2 did not load.");

  const thread = (repo, number, comments) => ({ repository: { nameWithOwner: repo }, number, comments: { nodes: Array(comments).fill({}) } });
  const talk = insights.mergeConversationData([
    { slot: "fine-grained", data: { issues: { issueCount: 1, nodes: [thread("a/b", 1, 1)] }, pullRequests: null } },
    { slot: "classic", data: { issues: { issueCount: 2, nodes: [thread("a/b", 1, 3), thread("org/c", 2, 1)] }, pullRequests: { issueCount: 1, nodes: [thread("org/c", 9, 0)] } } },
  ]);
  assert.deepEqual(talk.only, { "fine-grained": 0, classic: 2 });
  assert.deepEqual(talk.data.issues.nodes.map((n) => [n.number, n.comments.nodes.length]), [[1, 3], [2, 1]], "the fuller copy of a shared thread is kept");
  assert.deepEqual([talk.data.issues.issueCount, talk.data.pullRequests.nodes.length], [2, 1]);

  const year = (restricted, errors) => ({ errors, data: { viewer: { contributionsCollection: { restrictedContributionsCount: restricted, contributionCalendar: { weeks: [] } } } } });
  const pick = (reads) => insights.pickContributionYear(reads)?.slot;
  assert.equal(pick([{ slot: "fine-grained", data: year(40) }, { slot: "classic", data: year(0) }]), "classic", "fewer hidden contributions wins");
  assert.equal(pick([{ slot: "fine-grained", data: year(0) }, { slot: "classic", data: year(0) }]), "fine-grained", "a tie keeps the fine-grained token");
  assert.equal(pick([{ slot: "fine-grained", data: year(0, [{ message: "partial" }]) }, { slot: "classic", data: year(9) }]), "classic", "a complete read beats a partial one");
  assert.equal(pick([{ slot: "fine-grained", data: { data: null } }]), undefined);

  const paired = insights.deriveSuggestions({ token: { kind: "classic", write: ["repo"], paired: true } }).items.find((s) => s.id === "fine-grained-token");
  assert.match(paired.title, /Narrow the classic token/);
  assert.equal(insights.deriveSuggestions({ token: { kind: "classic", write: [], paired: true } }).items.some((s) => s.id === "fine-grained-token"), false);
});

test("checks group gaps and size correlations against random regrouping", () => {
  // Three tied values per group: a median gap would match every regrouping, so ranks are used.
  const at = (h) => new Date(Date.parse("2026-03-01T00:00:00Z") + h * 36e5).toISOString();
  const merged = (n, ref, hours, lines) => [`me/app#${n}`, { title: "t", repo: "me/app", number: n, merged: true, state: "MERGED", headRef: ref,
    reviews: ref.startsWith("claude/") ? 0 : 1, createdAt: at(0), mergedAt: at(hours), additions: lines, deletions: 0 }];
  const small = insights.summarizePrPatterns(Object.fromEntries([1, 2, 3].map((n) => merged(n, "claude/a", 1, 10)).concat([4, 5, 6].map((n) => merged(n, "fix/b", 10, 10)))));
  assert.ok(small.agentGapP > 0.05 && small.agentGapP < 0.2, `3 v 3 separates in 2 of 20 splits, got ${small.agentGapP}`);
  assert.match(insights.deriveObservations({ prs: small }).find((o) => o.title.startsWith("Agent-branch PRs merged")).detail, /may be chance/);
  const wide = insights.summarizePrPatterns(Object.fromEntries(Array.from({ length: 16 }, (_, i) => merged(i + 1, i < 8 ? "codex/a" : "fix/b", i < 8 ? 1 + i / 10 : 20 + i, 10))));
  assert.ok(wide.agentGapP < 0.01);

  const steps = insights.summarizePrPatterns(Object.fromEntries(Array.from({ length: 10 }, (_, i) => merged(i + 1, "fix/x", 2 + i * 10, 20 + i * 100))));
  assert.deepEqual([steps.sizeVsTime.rho, steps.sizeVsTime.n], [1, 10]);
  assert.ok(steps.sizeVsTime.p < 0.01);
  assert.equal(steps.largest[0].lines, 920);
  assert.equal(insights.summarizePrPatterns(Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((n) => merged(n, "fix/x", n, n)))).sizeVsTime, null, "needs 8 merges");
  assert.equal(insights.rankCorrelation([1, 1, 1, 1], [1, 2, 3, 4]), null, "no variation, no correlation");
  assert.deepEqual([insights.quantile([1, 2, 3, 4], 0.75), insights.quantile([], 0.5)], [3.25, null]);
});

test("separates approvals from comment-only reviews and prefers searched outcomes", () => {
  const at = (h) => new Date(Date.parse("2026-03-01T00:00:00Z") + h * 36e5).toISOString();
  const rv = (login, h, state) => ({ login, at: at(h), state, bot: false });
  const pr = (number, state, mergedH, reviewList, repo = "me/app") => [`${repo}#${number}`, { title: "t", repo, number, author: "me", createdAt: at(0),
    state, merged: state === "MERGED", mergedAt: mergedH == null ? null : at(mergedH), mergedBy: "me", headRef: "fix/x", reviews: reviewList.length, reviewList }];
  const prInfo = Object.fromEntries([
    pr(1, "MERGED", 10, [rv("ana", 2, "approved")]),
    pr(2, "MERGED", 10, [rv("ana", 3, "commented")]),
    pr(3, "MERGED", 10, [rv("bo", 20, "approved")], "me/lib"), // approved only after the merge
    pr(4, "MERGED", 10, [rv("bo", 4, "changes_requested"), rv("bo", 6, "approved")], "me/lib"),
    pr(5, "MERGED", 10, []),
    pr(6, "CLOSED", null, []), pr(7, "CLOSED", null, []), pr(8, "OPEN", null, []), pr(9, "CLOSED", null, []),
  ]);
  const flow = insights.summarizeReviewFlow(prInfo, "me");
  assert.deepEqual([flow.states, flow.approvedBeforeMerge, flow.approved, flow.changesRequested, flow.noHuman], [true, 2, 3, 1, 1]);
  assert.deepEqual(flow.outcomes, { merged: 5, closed: 3, open: 1 });
  assert.deepEqual(flow.byRepo.map((r) => [r.repo, r.merged, r.noHuman, r.approved]), [["me/app", 3, 1, 1], ["me/lib", 2, 0, 1]]);
  const titles = insights.deriveObservations({ review: flow }).map((o) => o.title);
  assert.ok(titles.includes("2 of your 5 merges had a human review but no approval before merging"));
  assert.ok(titles.includes("3 of 8 finished pull requests you opened were closed without merging"));
  // Without review states, approval counts are unknown rather than zero.
  const old = insights.summarizeReviewFlow({ "me/app#1": { ...prInfo["me/app#1"], reviewList: [{ login: "ana", at: at(2), bot: false, state: null }] } }, "me");
  assert.deepEqual([old.states, old.approvedBeforeMerge], [false, null]);

  // The searched outcomes (3 of 8 closed) outrank the feed's (0 of 4), and the card says which source it used.
  const feed = { outcomes: { merged: 4, closed: 0, open: 0 }, closed: [], settled: 0, withoutPr: [] };
  const agree = insights.deriveSuggestions({ login: "me", review: flow, follow: feed }).checked.find((c) => c.id === "agree-before-building");
  assert.deepEqual([agree.status, agree.source], ["shown", "Pull requests you opened"]);
  const onlyFeed = insights.deriveSuggestions({ login: "me", follow: { outcomes: { merged: 2, closed: 2, open: 0 }, closed: [{ repo: "me/app", number: 9, agent: true }], settled: 0, withoutPr: [] } });
  const item = onlyFeed.items.find((s) => s.id === "agree-before-building");
  assert.deepEqual([item.source, item.targets], ["Recent events", ["me/app #9 (agent branch)"]]);
});

test("suggests answering other people's pull requests within a day", () => {
  const at = (h) => new Date(Date.parse("2026-03-01T00:00:00Z") + h * 36e5).toISOString();
  const reviewed = (hours) => Object.fromEntries(hours.map((h, i) => [`org/x#${i}`, { title: "t", author: i % 2 ? "zed" : "yan", createdAt: at(0), myFirstReviewAt: at(h) }]));
  const rule = (collab) => insights.deriveSuggestions({ login: "me", collab });
  const status = (collab) => rule(collab).checked.find((c) => c.id === "answer-review-requests").status;
  assert.equal(status(null), "unavailable");
  assert.equal(status(insights.summarizeCollaboration({}, reviewed([30, 40, 50, 60]), "me")), "short", "needs 5 timed reviews");
  assert.equal(status(insights.summarizeCollaboration({}, reviewed([2, 3, 4, 5, 30]), "me")), "clear");
  const slow = rule(insights.summarizeCollaboration({}, reviewed([30, 40, 50, 60, 70, 80]), "me")).items.find((s) => s.id === "answer-review-requests");
  assert.equal(slow.basis, "6 pull requests by other people that you reviewed");
  assert.deepEqual(slow.targets, ["zed: median 3 days across 3", "yan: median 2 days across 3"]);
  assert.deepEqual(slow.reading, ["google-speed"]);
});

// Outcome fixtures: hours from a fixed start, one repository, authored by "me".
function outcomeRow(number, openedH, life, lines, extra = {}) {
  const at = (h) => new Date(Date.parse("2026-03-01T12:00:00Z") + h * 36e5).toISOString();
  return [`me/app#${number}`, { title: `Change ${number}`, repo: "me/app", number, author: "me", headRef: "work",
    createdAt: at(openedH), state: life == null ? "OPEN" : extra.closed ? "CLOSED" : "MERGED", merged: life != null && !extra.closed,
    mergedAt: life != null && !extra.closed ? at(openedH + life) : null, closedAt: life == null ? null : at(openedH + life),
    additions: lines, deletions: 0, reviews: 0, reviewList: [], ...extra.fields }];
}
const outcomeNow = new Date(Date.parse("2026-03-01T12:00:00Z") + 1000 * 36e5).toISOString();

test("counts follow-up fixes, the user's own merge baseline, and what slow pull requests did", () => {
  const rows = [];
  // Eight large agent merges, each followed six hours later by a small fix, then eight small reviewed ones.
  for (let i = 0; i < 8; i += 1) {
    rows.push(outcomeRow(1 + i * 2, i * 48, 2, 800 + i, { fields: { headRef: "claude/big" } }));
    rows.push(outcomeRow(2 + i * 2, i * 48 + 8, 1, 10 + i, { fields: { title: i === 0 ? 'Revert "Change 1"' : i === 1 ? "Fix #3 crash" : "fix: follow-up" } }));
  }
  for (let i = 0; i < 8; i += 1) rows.push(outcomeRow(17 + i, 400 + i * 24, 1, 40 + i, { fields: { reviews: 1 } }));
  rows.push(outcomeRow(25, 700, 100, 300), outcomeRow(26, 701, 110, 310), outcomeRow(27, 702, 120, 320));
  rows.push(outcomeRow(28, 600, 90, 50, { closed: true }), outcomeRow(29, 610, 95, 50, { closed: true }));
  // Two still open, and one merged nine hours ago, too recent for a follow-up to have had its chance.
  rows.push(outcomeRow(30, 500, null, 60), outcomeRow(31, 950, null, 60), outcomeRow(32, 990, 1, 5));
  const prInfo = Object.fromEntries(rows);
  const o = insights.summarizeOutcomes(prInfo, "me", outcomeNow);
  const group = (key) => o.rework.groups.find((g) => g.key === key);

  assert.deepEqual([o.authored, o.merged, o.rework.settled, o.rework.followed, o.rework.named], [32, 28, 27, 8, 2]);
  assert.deepEqual(o.rework.examples[0], { repo: "me/app", number: 15, lines: 807, agent: true, by: 16, hours: 6, named: false });
  assert.deepEqual([group("agent").a, group("agent").b], [{ label: "Agent branches", n: 8, followed: 8 }, { label: "Other branches", n: 19, followed: 0 }]);
  assert.deepEqual([group("size").a.followed, group("size").a.n, group("size").b.followed], [8, 13, 0]);
  // Several comparisons share the 5% bar. The hour-of-day group depends on the local time zone, so its presence is not pinned.
  assert.ok(o.rework.tested >= 3 && Math.abs(o.rework.bar - 0.05 / o.rework.tested) < 1e-12);
  assert.ok(group("agent").clear && group("size").clear && !group("review").clear, "8 of 19 unreviewed against 0 of 8 reviewed does not clear the shared bar");
  assert.equal(group("speed"), undefined, "no merge was faster than the median, so there is nothing to compare");

  assert.deepEqual([o.baseline.n, o.baseline.medianHours, o.baseline.p75Hours], [28, 1, 2]);
  assert.ok(Math.abs(o.overdueAfterHours - 31.4) < 1e-6);
  assert.deepEqual(o.overdue.map((p) => p.number), [30, 31]);
  assert.deepEqual([o.late.slow, o.late.quick], [{ n: 5, merged: 3 }, { n: 25, merged: 25 }]);
  assert.deepEqual([o.flow.peak, o.flow.openNow.length, o.flow.unknownEnd], [{ count: 5, at: "2026-03-30" }, 2, 0]);

  // A closed pull request saved before close times were read has no known end, and is left out of open work.
  const legacy = insights.summarizeOutcomes({ ...prInfo, "me/app#28": { ...prInfo["me/app#28"], closedAt: undefined } }, "me", outcomeNow);
  assert.deepEqual([legacy.flow.unknownEnd, legacy.flow.counted], [1, 31]);
  // Fewer than six merges set no baseline, and other people's pull requests are not the user's outcomes.
  const few = insights.summarizeOutcomes(Object.fromEntries(rows.slice(0, 4)), "me", outcomeNow);
  assert.deepEqual([few.baseline, few.overdue, few.late], [null, [], null]);
  assert.equal(insights.summarizeOutcomes(prInfo, "someone-else", outcomeNow).authored, 0);

  const prs = insights.summarizePrPatterns(prInfo, outcomeNow);
  const review = insights.summarizeReviewFlow(prInfo, "me");
  const observations = insights.deriveObservations({ prs, review, outcomes: o });
  const tone = (id) => observations.find((f) => f.id === id)?.tone;
  // The agent finding warns because agent merges needed fixes more often; the review finding stays a note.
  assert.deepEqual([tone("fixes-follow-merges"), tone("open-too-long"), tone("agent-skip-review"), tone("unreviewed-lines")], ["warn", "warn", "warn", "info"]);
  assert.ok(!observations.some((f) => f.title.includes("older than two weeks")), "the user's own baseline replaces the fixed two weeks");

  const s = insights.deriveSuggestions({ login: "me", now: outcomeNow, prPatterns: prs, review, prInfo, outcomes: o, observations });
  assert.deepEqual(s.items.map((i) => [i.tone, i.confirmed, i.id]), [
    ["warn", true, "trace-follow-up-fixes"], ["warn", true, "settle-stale-prs"], ["warn", false, "review-before-merge"], ["info", true, "smaller-prs"],
  ]);
  const trace = s.items[0];
  assert.deepEqual(trace.patterns, [{ id: "fixes-follow-merges", title: "8 of your 27 settled merges were followed by a fix within 3 days" }]);
  assert.deepEqual(trace.reading, ["dora-metrics"]);
  assert.equal(trace.targets[0], "me/app #15 (807 lines, agent branch): #16 followed after 6.0 h");
  assert.match(trace.act[1][0], /^Start with agent branches/);
  assert.match(s.items[1].seen, /^2 pull requests you opened have been open longer than 31 h\. 90% of your 28 merges finished within 31 h/);
  // The agent rule ends in the same advice as the review rule, so it is shown inside it.
  const second = s.items[2];
  assert.deepEqual(second.folded, ["Review agent branches like a colleague's work"]);
  assert.equal(second.also.length, 1);
  assert.ok(second.reading.includes("perry-2023") && second.reading.includes("bacchelli-2013"));
  assert.equal(s.checked.find((c) => c.id === "review-agent-branches").status, "folded");
  assert.deepEqual(s.links["agent-skip-review"], { id: "review-before-merge", title: "Get a second look before merging" });
  assert.equal(s.links["open-too-long"].id, "settle-stale-prs");
});

test("suggests a limit on open work only when it tracks time to merge beyond chance", () => {
  const rule = (o) => insights.deriveSuggestions({ login: "me", outcomes: o });
  const status = (o) => rule(o).checked.find((c) => c.id === "limit-open-work").status;
  // Eight opened one at a time merge in an hour; six opened on top of each other take days.
  const alone = Array.from({ length: 8 }, (_, i) => outcomeRow(1 + i, i * 24, 1, 50));
  const piled = Array.from({ length: 6 }, (_, i) => outcomeRow(20 + i, 300 + i, 100 + i * 10, 50));
  const o = insights.summarizeOutcomes(Object.fromEntries([...alone, ...piled, outcomeRow(40, 900, null, 50)]), "me", outcomeNow);
  assert.deepEqual(o.flow.split, { cut: 0, quiet: { n: 9, medianHours: 1 }, busy: { n: 5, medianHours: 130 } });
  assert.ok(o.flow.load.rho > 0.8 && o.flow.load.p < 0.01);
  assert.equal(o.flow.peak.count, 6);
  const item = rule(o).items.find((i) => i.id === "limit-open-work");
  assert.deepEqual([item.tone, item.confirmed, item.reading, item.targets], ["info", true, ["dora-wip"], ["me/app #40: open 4 days"]]);
  assert.match(item.act[0][0], /^Try a limit of 1 open pull request for two weeks/);

  assert.equal(status(null), "unavailable");
  assert.equal(status(insights.summarizeOutcomes(Object.fromEntries(alone.slice(0, 5)), "me", outcomeNow)), "short", "needs 8 merges");
  // Open work that never varies has no correlation, and nothing to suggest.
  assert.equal(status(insights.summarizeOutcomes(Object.fromEntries(alone), "me", outcomeNow)), "clear");
});

test("holds every chance check on the page to one Holm bar", () => {
  const prs = { agentGapP: 0.004, agentReviewP: 0.03, sizeVsTime: { p: 0.001, rho: 0.5, n: 20 } };
  const outcomes = { flow: { load: { p: 0.2 } }, late: null, split: null, rework: { groups: [] } };
  const chance = insights.chanceBudget({ prs, outcomes });
  assert.equal(chance.tested, 4);
  assert.deepEqual(chance.entries.map((t) => [t.key, t.clear]), [["size-time", true], ["agent-gap", true], ["agent-review", false], ["open-work", false]]);
  // 0.03 passes alone at 5% but not at 5% / 2 after two smaller results.
  assert.equal(chance.entries[2].bar, 0.025);
  assert.match(insights.deriveObservations({ prs: { ...prs, agent: { count: 3, unreviewed: 3, medianHours: 1 }, other: { count: 3, unreviewed: 0, medianHours: 1 }, merged: 0 }, chance })
    .find((o) => o.id === "agent-skip-review").detail, /does not clear the bar shared by every chance check/);
});

test("splits time to merge at the last commit and summarizes saved weeks", () => {
  const info = {};
  for (let i = 0; i < 6; i += 1) {
    const created = Date.parse("2026-03-01T00:00:00Z") + i * 864e5;
    info[`me/r#${i}`] = { title: `Change ${i}`, repo: "me/r", number: i + 1, author: "me", merged: true, state: "MERGED",
      createdAt: new Date(created).toISOString(), mergedAt: new Date(created + 10 * 36e5).toISOString(),
      // Work for 2 hours, then 8 hours waiting; the first one's last commit predates the pull request.
      lastCommitAt: new Date(created + (i ? 2 : -5) * 36e5).toISOString(), additions: 1, deletions: 0, reviews: 0 };
  }
  const o = insights.summarizeOutcomes(info, "me", "2026-04-01T00:00:00Z");
  assert.equal(o.split.n, 6);
  assert.equal(o.split.workingHours, 2);
  assert.equal(o.split.waitingHours, 8);
  assert.equal(o.split.waitingShare, (8 * 5 + 10) / 60);
  assert.ok(insights.deriveObservations({ outcomes: o }).some((f) => f.id === "merges-wait-after-work"));
  const snap = insights.summarizeSnapshots({ "2026-02-02": { medianMergeHours: 30 }, "2026-03-02": { medianMergeHours: 20 }, junk: { merged: 1 } },
    insights.snapshotOf(o), "2026-03-30");
  const row = snap.rows.find((r) => r.key === "medianMergeHours");
  assert.deepEqual([snap.weeks, row.first.value, row.back.value, row.latest.value], [3, 30, 20, 10]);
});

test("sorts suggestions by card state and brings a dismissed card back when its number gets worse", () => {
  const item = (id, metric) => ({ id, title: id, metric, targets: [], refs: [], also: [], why: [], act: [] });
  const suggestions = {
    items: [item("a", { unit: "share", value: 0.2, label: "A" }), item("b", { unit: "share", value: 0.7, label: "B" }),
      item("c", null), item("d", { unit: "count", value: 3, label: "D" }), item("fine-grained-token", null)],
    checked: ["a", "b", "c", "d", "fine-grained-token", "e"].map((id) => ({ id, title: id, status: id === "e" ? "clear" : "shown",
      metric: id === "e" ? { unit: "hours", value: 5, label: "E" } : undefined })),
    links: { fa: { id: "c" }, fb: { id: "a" } },
  };
  const now = "2026-11-21T00:00:00Z";
  const r = insights.applyCardStates(suggestions, {
    a: { state: "trying", at: "2026-11-01T00:00:00Z", metric: { unit: "share", value: 0.4, label: "A" } },
    b: { state: "dismissed", at: "2026-11-10T00:00:00Z", metric: { unit: "share", value: 0.3, label: "B" } }, // 30% → 70%: back
    c: { state: "snoozed", at: "2026-11-20T00:00:00Z", until: "2026-11-27T00:00:00Z" },
    d: { state: "dismissed", at: "2026-11-10T00:00:00Z", metric: { unit: "count", value: 2, label: "D" } }, // 2 → 3: not enough
    e: { state: "trying", at: "2026-11-01T00:00:00Z", metric: { unit: "hours", value: 30, label: "E" } }, // no longer shown
    "fine-grained-token": { state: "dismissed", at: "2026-11-10T00:00:00Z" },
  }, now);
  assert.deepEqual(r.items.map((i) => i.id), ["a", "b", "fine-grained-token"]);
  assert.deepEqual([r.items[0].trying.then, r.items[0].trying.now], ["40%", "20%"]);
  assert.deepEqual([r.items[1].returned.then, r.items[1].returned.now], ["30%", "70%"]);
  assert.deepEqual([r.snoozed.map((x) => x.id), r.dismissed.map((x) => x.id)], [["c"], ["d"]]);
  assert.deepEqual(r.trying.map((t) => [t.id, t.showing, t.then, t.now, t.better]), [["a", true, "40%", "20%", true], ["e", false, "30 h", "5.0 h", true]]);
  assert.deepEqual(Object.keys(r.links), ["fb"]);
});

test("scopes suggestions to one repository and keys card states per view", () => {
  const pr = (repo, number, merged) => [`${repo}#${number}`, { title: "T", repo, number, author: "me", merged, state: merged ? "MERGED" : "OPEN" }];
  const info = Object.fromEntries([pr("me/a", 1, true), pr("me/a", 2, true), pr("me/a", 3, true), pr("me/a", 4, false),
    pr("me/b", 1, true), pr("me/b", 2, true), pr("me/c", 1, true), pr("me/c", 2, true), pr("me/c", 3, true), pr("me/c", 4, true)]);
  assert.deepEqual(insights.scopeRepos(info, "me").map((r) => [r.repo, r.merged, r.opened]), [["me/c", 4, 4], ["me/a", 3, 4]]);
  assert.deepEqual(Object.keys(insights.scopePullRequests(info, "me/b")), ["me/b#1", "me/b#2"]);
  assert.equal(insights.cardKey("smaller-prs", "me/a"), "smaller-prs@me/a");
  assert.equal(insights.cardKey("late-night-review", "me/a"), "late-night-review");
  const item = (id) => ({ id, title: id, metric: null, targets: [], refs: [], also: [], why: [], act: [] });
  const suggestions = { items: [item("smaller-prs"), item("late-night-review")], checked: [], links: {} };
  const states = { "smaller-prs@me/a": { state: "dismissed", at: "2026-11-20T00:00:00Z" }, "late-night-review": { state: "dismissed", at: "2026-11-20T00:00:00Z" } };
  // In me/a both are set aside; in the account view only the account-wide one is; in me/c the same.
  assert.deepEqual(insights.applyCardStates(suggestions, states, "2026-11-21T00:00:00Z", "me/a").items.map((i) => i.key), []);
  assert.deepEqual(insights.applyCardStates(suggestions, states, "2026-11-21T00:00:00Z").items.map((i) => i.key), ["smaller-prs"]);
  assert.deepEqual(insights.applyCardStates(suggestions, states, "2026-11-21T00:00:00Z", "me/c").items.map((i) => i.key), ["smaller-prs@me/c"]);
});

test("reads a trial's weekly snapshots from the week it started", () => {
  const snaps = insights.summarizeSnapshots({
    "2026-10-26": { medianMergeHours: 30, waitingShare: 0.5 },
    "2026-11-02": { medianMergeHours: 28 },
    "2026-11-09": { medianMergeHours: 18 },
  }, { medianMergeHours: 9 }, "2026-11-16");
  const s = insights.trialSeries("limit-open-work", "2026-11-05T12:00:00Z", snaps);
  assert.deepEqual([s.start, s.values.map((v) => v.text), s.better], ["2026-11-02", ["28 h", "18 h", "9.0 h"], true]);
  // One saved week is not a series, an unmapped rule has none, and a repository view ignores account weeks.
  assert.equal(insights.trialSeries("merge-finished-work", "2026-11-05T12:00:00Z", snaps), null);
  assert.equal(insights.trialSeries("smaller-prs", "2026-11-05T12:00:00Z", snaps), null);
  const sug = { items: [], checked: [{ id: "limit-open-work", title: "L", status: "clear", metric: { unit: "hours", value: 9, label: "M" } }], links: {} };
  const st = { at: "2026-11-05T12:00:00Z", state: "trying", metric: { unit: "hours", value: 28, label: "M" } };
  assert.equal(insights.applyCardStates(sug, { "limit-open-work": st }, null, null, snaps).trying[0].series.weeks, 3);
  assert.equal(insights.applyCardStates(sug, { "limit-open-work@me/a": st }, null, "me/a", snaps).trying[0].series, null);
});

test("starts review clocks when a draft is ready or a reviewer is asked", () => {
  const H = 36e5;
  const c = Date.parse("2026-10-01T00:00:00Z");
  const iso = (h) => new Date(c + h * H).toISOString();
  const pr = (number, author, reviews, timeline) => insights.normalizePullRequest({
    title: `T${number}`, state: "MERGED", merged: true, createdAt: iso(0), mergedAt: iso(100), closedAt: iso(100), additions: 1, deletions: 1,
    headRefName: "x", author: { login: author }, mergedBy: { login: author },
    reviews: { totalCount: reviews.length, nodes: reviews.map(([who, h]) => ({ submittedAt: iso(h), state: "APPROVED", author: { __typename: "User", login: who } })) },
    timelineItems: timeline && { totalCount: timeline.length, nodes: timeline.map(([type, h, who]) => (type === "ready"
      ? { __typename: "ReadyForReviewEvent", createdAt: iso(h) }
      : { __typename: "ReviewRequestedEvent", createdAt: iso(h), requestedReviewer: who ? { __typename: "User", login: who } : { __typename: "Team" } })) },
  }, "o/r", number, "search");
  const info = {
    a: pr(1, "me", [["mira", 60]], [["ready", 48]]), // a draft marked ready at 48 h: waits 12 h
    b: pr(2, "me", [["mira", 10]], [["ready", 48]]), // reviewed while still a draft: from opening
    c: pr(3, "me", [["tomas", 30]], [["request", 20, "tomas"]]), // the pull request's wait ignores the request
    d: pr(4, "me", [["tomas", 5]], null), // no timeline read
  };
  assert.equal(info.a.readyAt, iso(48));
  assert.equal("timelineItems" in info.a, false);
  const flow = insights.summarizeReviewFlow(info, "me");
  assert.equal(flow.medianFirstReviewHours, 11);
  assert.deepEqual([flow.clocks, flow.noTimeline], [{ request: 0, ready: 1, opened: 3 }, 1]);
  // Per reviewer, the request to that person starts the clock: tomas answered in 10 h and 5 h.
  const theirs = pr(9, "mira", [["me", 46]], [["request", 40, "me"]]);
  theirs.myFirstReviewAt = iso(46);
  const collab = insights.summarizeCollaboration(info, { t: theirs }, "me", { complete: true });
  assert.equal(collab.people.find((p) => p.login === "tomas").inMedianHours, 7.5);
  assert.deepEqual([collab.outMedianHours, collab.outClocks], [6, { request: 1, ready: 0, opened: 0 }]);
  assert.match(insights.clockText(collab.outClocks, "your"), /^Timed from your review request on 1 pull request\.$/);
});

test("lists review requests and threads that wait on you, oldest first", () => {
  const H = 36e5;
  const now = Date.parse("2026-11-20T12:00:00Z");
  const iso = (t) => new Date(t).toISOString();
  const user = (login) => ({ __typename: "User", login });
  const team = (id) => ({ __typename: "Team", id });
  const node = (number, created, reviewers, events) => ({ __typename: "PullRequest", number, title: `Ask ${number}`, isDraft: false, createdAt: iso(created),
    additions: 3, deletions: 1, repository: { nameWithOwner: "t/o" }, author: { __typename: "User", login: "mira" },
    reviewRequests: { nodes: reviewers.map((requestedReviewer) => ({ requestedReviewer })) },
    timelineItems: { nodes: events.map(([h, requestedReviewer]) => ({ createdAt: iso(created + h * H), requestedReviewer })) } });
  const requests = insights.summarizeReviewRequests({ issueCount: 3, nodes: [
    node(50, now - 80 * H, [user("me")], [[2, user("me")], [60, user("me")]]),
    node(51, now - 50 * H, [team("mine"), team("other")], [[1, team("mine")], [48, team("other")], [49, team("removed")], [0, team("mine")]]),
    node(52, now - 30 * H, [user("me")], []),
    null,
  ] }, "me", now);
  assert.deepEqual(requests.items.map((r) => [r.number, r.direct, r.since, Math.round(r.hours)]),
    [[51, false, "team-estimate", 49], [52, true, "opened", 30], [50, true, "request", 20]]);
  assert.deepEqual([requests.late, requests.lateDirect], [2, 1]);

  const thread = (number, author, state, comments) => ({ __typename: "Issue", number, title: `Thread ${number}`, issueState: state, author: { login: author },
    repository: { nameWithOwner: "o/r" }, comments: { totalCount: comments.length, nodes: comments.map(([who, h]) => ({
      author: { __typename: /\[bot\]$/.test(who) ? "Bot" : "User", login: who }, bodyText: "x", createdAt: iso(now - h * H) })) } });
  const flat = insights.flattenConversations({ issues: { issueCount: 5, nodes: [
    thread(1, "me", "OPEN", [["mira", 50], ["ci[bot]", 10]]), // yours, a person's reply is latest once bots are skipped
    thread(2, "mira", "OPEN", [["me", 60], ["tomas", 40]]), // you wrote in it
    thread(3, "mira", "OPEN", [["tomas", 5]]), // you never joined
    thread(4, "me", "CLOSED", [["mira", 5]]), // closed
    thread(5, "me", "OPEN", [["mira", 9], ["me", 8]]), // you answered
  ] }, pullRequests: { issueCount: 0, nodes: [] } }, "me");
  assert.deepEqual(insights.filterConversations(flat.items, "awaiting", "", "").map((x) => x.thread.number).sort(), [1, 2]);
  const waiting = insights.summarizeWaiting({ requests, conversations: flat, prInfo: {}, login: "me", now });
  assert.deepEqual([waiting.reviews.length, waiting.replies.length, waiting.changes.length, waiting.count], [3, 2, 0, 5]);

  // Two direct requests a day old are enough for the review-speed card, which names them.
  const both = { ...requests, items: requests.items.map((r) => ({ ...r, direct: true })) };
  const card = insights.deriveSuggestions({ login: "me", now, requests: both }).items.find((i) => i.id === "answer-review-requests");
  assert.deepEqual(card.refs.slice(0, 2), [{ repo: "t/o", number: 51 }, { repo: "t/o", number: 52 }]);
  assert.equal(insights.deriveSuggestions({ login: "me", now, requests }).checked.find((c) => c.id === "answer-review-requests").status, "short");
});

test("reads public search records as unknown where search has no reviews, sizes, or branches", () => {
  const H = 36e5;
  const now = Date.parse("2026-11-20T12:00:00Z");
  const iso = (t) => new Date(t).toISOString();
  const item = (number, daysAgo, hours, extra = {}) => ({ repo: "me/r", number, title: `Change ${number}`, state: "closed", draft: false, author: "me", authorType: "User",
    createdAt: iso(now - daysAgo * 24 * H), closedAt: iso(now - daysAgo * 24 * H + hours * H), mergedAt: iso(now - daysAgo * 24 * H + hours * H), ...extra });
  const items = [...Array.from({ length: 8 }, (_, i) => item(i + 1, 60 - i * 5, 5 + i * 4)),
    item(20, 30, 10, { mergedAt: null }), item(21, 3, 0, { state: "open", closedAt: null, mergedAt: null }), { repo: "me/r", number: 22, title: "x", createdAt: "bad" }];
  const info = Object.fromEntries(items.map(insights.normalizeSearchPullRequest).filter(Boolean).map((pr) => [insights.prKey(pr.repo, pr.number), pr]));
  assert.equal(Object.keys(info).length, 10);
  assert.deepEqual(["MERGED", "CLOSED", "OPEN"].map((st) => Object.values(info).filter((p) => p.state === st).length), [8, 1, 1]);
  const pr = insights.summarizePullRequests(info, "me");
  // Unknown is not zero: no merge reads as unreviewed, and no size is reported.
  assert.deepEqual([pr.unreviewed.length, pr.medianSize, pr.largest.length], [0, null, 0]);
  const patterns = insights.summarizePrPatterns(info, now);
  assert.deepEqual([patterns.smaller, patterns.sizeVsTime, patterns.mergedLines, patterns.sizedMerged], [null, null, 0, 0]);
  const outcomes = insights.summarizeOutcomes(info, "me", now);
  assert.ok(outcomes.rework.groups.every((g) => ["speed", "late"].includes(g.key)));
  assert.equal(outcomes.baseline.n, 8);
  assert.deepEqual(insights.summarizeReviewFlow(info, "me").outcomes, { merged: 8, closed: 1, open: 1 });
  const checked = insights.deriveSuggestions({ login: "me", now, prPatterns: patterns, prInfo: info, outcomes, publicView: true }).checked;
  for (const id of ["smaller-prs", "review-before-merge", "merge-finished-work", "branches-without-prs"]) {
    const c = checked.find((x) => x.id === id);
    assert.equal(c.status, "unavailable", id);
    assert.match(c.detail, /^Needs a token\./, id);
  }
});
