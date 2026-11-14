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
