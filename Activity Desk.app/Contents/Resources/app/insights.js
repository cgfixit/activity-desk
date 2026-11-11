(() => {
"use strict";

const EVENT_LABELS = {
  PushEvent: "Push",
  PullRequestEvent: "Pull request",
  PullRequestReviewEvent: "Review",
  PullRequestReviewCommentEvent: "Review comment",
  IssuesEvent: "Issue",
  IssueCommentEvent: "Comment",
  CommitCommentEvent: "Commit comment",
  CreateEvent: "Create",
  DeleteEvent: "Delete",
  WatchEvent: "Star",
  ForkEvent: "Fork",
  ReleaseEvent: "Release",
  PublicEvent: "Made public",
  MemberEvent: "Member",
  GollumEvent: "Wiki",
};

const FILTERS = {
  all: () => true,
  push: (e) => e.type === "PushEvent",
  pr: (e) => e.type === "PullRequestEvent" || e.type === "PullRequestReviewEvent" || e.type === "PullRequestReviewCommentEvent",
  issue: (e) => e.type === "IssuesEvent",
  comment: (e) => e.type === "IssueCommentEvent" || e.type === "CommitCommentEvent" || e.type === "PullRequestReviewCommentEvent",
  branch: (e) => e.type === "CreateEvent" || e.type === "DeleteEvent",
  agent: (e) => Boolean(agentOf(e)),
};

const AGENT_PREFIXES = [
  ["claude/", "Claude"],
  ["codex/", "Codex"],
  ["cursor/", "Cursor"],
  ["copilot/", "Copilot"],
  ["devin/", "Devin"],
  ["jules/", "Jules"],
];
const APP_NAMES = {
  "chatgpt-codex-connector": "Codex",
  "openai-codex": "Codex",
  cursor: "Cursor",
  claude: "Claude",
  "copilot-swe-agent": "Copilot",
  "github-copilot": "Copilot",
  devin: "Devin",
  "google-labs-jules": "Jules",
};

function eventLabel(type) {
  return EVENT_LABELS[type] || String(type || "Event").replace(/Event$/, "");
}

function repoName(event) {
  return (event && event.repo && event.repo.name) || "unknown";
}

function branchOf(event) {
  const p = (event && event.payload) || {};
  if (event.type === "PushEvent") return String(p.ref || "").replace("refs/heads/", "");
  if ((event.type === "CreateEvent" || event.type === "DeleteEvent") && p.ref_type === "branch") return String(p.ref || "");
  if (event.type === "PullRequestEvent") return String((p.pull_request && p.pull_request.head && p.pull_request.head.ref) || "");
  return "";
}

function agentFromBranch(branch) {
  const b = String(branch || "").toLowerCase();
  for (const [prefix, name] of AGENT_PREFIXES) if (b.startsWith(prefix)) return name;
  return "";
}

function appName(app) {
  if (!app) return "";
  const slug = String(app.slug || app.name || "").toLowerCase();
  return APP_NAMES[slug] || app.name || slug;
}

// Which agent, if any, this event is attributable to.
// Comments: the app that posted the comment. Issues opened: the app that created the issue.
// Pushes, branches, PRs: an agent branch prefix such as claude/ or codex/.
function agentOf(event) {
  const p = (event && event.payload) || {};
  if (event.type === "IssueCommentEvent" || event.type === "PullRequestReviewCommentEvent") {
    return appName(p.comment && p.comment.performed_via_github_app);
  }
  if (event.type === "IssuesEvent" && p.action === "opened") {
    return appName(p.issue && p.issue.performed_via_github_app);
  }
  return agentFromBranch(branchOf(event));
}

function titleTag(title) {
  const m = String(title || "").match(/^\s*\[([a-z0-9 _-]{2,20})\]/i);
  return m ? m[1].toLowerCase().trim() : "";
}

function median(values) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

function prKey(repo, number) {
  return `${repo}#${number}`;
}

function prRefsFromEvents(events) {
  const seen = new Map();
  for (const e of events || []) {
    if (e.type !== "PullRequestEvent") continue;
    const p = e.payload || {};
    const number = p.number || (p.pull_request && p.pull_request.number);
    if (!number) continue;
    const key = prKey(repoName(e), number);
    if (!seen.has(key)) seen.set(key, { repo: repoName(e), number });
  }
  return [...seen.values()];
}

function describeEvent(event, prInfo) {
  const payload = (event && event.payload) || {};
  const repo = repoName(event);
  if (event.type === "PushEvent") {
    const ref = branchOf(event);
    const count = Array.isArray(payload.commits) && payload.commits.length ? payload.commits.length : payload.size || 0;
    const what = count ? `${count} commit${count === 1 ? "" : "s"} ` : "";
    const head = payload.head ? ` (head ${String(payload.head).slice(0, 7)})` : "";
    return `Pushed ${what}to ${ref || "a branch"}${head}`;
  }
  if (event.type === "PullRequestEvent") {
    const pr = payload.pull_request || {};
    const number = payload.number || pr.number;
    const info = prInfo && prInfo[prKey(repo, number)];
    const title = pr.title || (info && info.title) || "";
    const action = payload.action === "closed" && (pr.merged || (info && info.merged)) ? "merged" : payload.action || "updated";
    return `${action[0].toUpperCase()}${action.slice(1)} PR #${number || "?"}${title ? ` · ${title}` : ""}`;
  }
  if (event.type === "PullRequestReviewEvent") {
    const pr = payload.pull_request || {};
    const state = payload.review && payload.review.state;
    return `Reviewed PR #${pr.number || "?"}${state ? ` (${String(state).toLowerCase().replace("_", " ")})` : ""}`;
  }
  if (event.type === "IssueCommentEvent") {
    const issue = payload.issue || {};
    const kind = issue.pull_request ? "PR" : "issue";
    return `Commented on ${kind} #${issue.number || "?"}${issue.title ? ` · ${issue.title}` : ""}`;
  }
  if (event.type === "IssuesEvent") {
    const issue = payload.issue || {};
    const action = payload.action || "updated";
    return `${action[0].toUpperCase()}${action.slice(1)} issue #${issue.number || "?"}${issue.title ? ` · ${issue.title}` : ""}`;
  }
  if (event.type === "CreateEvent" || event.type === "DeleteEvent") {
    const verb = event.type === "CreateEvent" ? "Created" : "Deleted";
    if (payload.ref_type === "repository") return `${verb} repository`;
    return `${verb} ${payload.ref_type || "ref"} ${payload.ref || ""}`.trim();
  }
  if (event.type === "ReleaseEvent") {
    const rel = payload.release || {};
    return `${payload.action || "Published"} release ${rel.tag_name || ""}`.trim();
  }
  if (event.type === "WatchEvent") return "Starred repository";
  if (event.type === "ForkEvent") return "Forked repository";
  return eventLabel(event.type);
}

// ---------- Activity feed (events API) ----------
function summarizeEvents(events, options) {
  const list = Array.isArray(events) ? events : [];
  const opts = options || {};
  const byType = {};
  const byRepo = {};
  const hourGrid = Array.from({ length: 7 }, () => Array(24).fill(0));
  const reposByDay = {};
  const agents = {};
  const tags = {};
  let agentEvents = 0;
  let defaultPushes = 0;
  let branchPushes = 0;
  let branchesCreated = 0;
  let branchesDeleted = 0;
  let privateEvents = 0;
  const prActions = {};

  for (const e of list) {
    const type = e.type || "Unknown";
    const repo = repoName(e);
    byType[type] = (byType[type] || 0) + 1;
    if (!byRepo[repo]) byRepo[repo] = 0;
    byRepo[repo] += 1;
    if (e.public === false) privateEvents += 1;
    const when = new Date(e.created_at);
    if (!Number.isNaN(when.getTime())) {
      hourGrid[when.getDay()][when.getHours()] += 1;
      const day = `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, "0")}-${String(when.getDate()).padStart(2, "0")}`;
      (reposByDay[day] = reposByDay[day] || new Set()).add(repo);
    }
    const agent = agentOf(e);
    if (agent) {
      agentEvents += 1;
      agents[agent] = (agents[agent] || 0) + 1;
    }
    const p = e.payload || {};
    if (type === "PushEvent") {
      const b = branchOf(e);
      if (b === "main" || b === "master") defaultPushes += 1;
      else branchPushes += 1;
    }
    if (type === "CreateEvent" && p.ref_type === "branch") branchesCreated += 1;
    if (type === "DeleteEvent" && p.ref_type === "branch") branchesDeleted += 1;
    if (type === "PullRequestEvent") prActions[p.action || "other"] = (prActions[p.action || "other"] || 0) + 1;
    const title = (p.issue && p.issue.title) || (p.pull_request && p.pull_request.title) || "";
    const tag = titleTag(title);
    if (tag && (type === "IssuesEvent" && p.action === "opened")) tags[tag] = (tags[tag] || 0) + 1;
  }

  const times = list.map((e) => new Date(e.created_at).getTime()).filter(Number.isFinite);
  const newest = times.length ? Math.max(...times) : null;
  const oldest = times.length ? Math.min(...times) : null;
  const spanHours = newest && oldest ? (newest - oldest) / 36e5 : 0;
  const dayRepoCounts = Object.values(reposByDay).map((s) => s.size);
  const lastSeen = opts.lastSeen ? new Date(opts.lastSeen).getTime() : null;
  const fresh = lastSeen ? list.filter((e) => new Date(e.created_at).getTime() > lastSeen).length : 0;

  let peakHour = null;
  let peakCount = 0;
  for (let d = 0; d < 7; d += 1) for (let h = 0; h < 24; h += 1) {
    if (hourGrid[d][h] > peakCount) {
      peakCount = hourGrid[d][h];
      peakHour = { day: d, hour: h, count: peakCount };
    }
  }
  const pushes = defaultPushes + branchPushes;

  return {
    total: list.length,
    byType,
    byRepo: Object.entries(byRepo).sort((a, b) => b[1] - a[1]),
    hourGrid,
    peakHour,
    newest,
    oldest,
    spanHours,
    reposPerDay: median(dayRepoCounts),
    agentEvents,
    agentShare: list.length ? agentEvents / list.length : 0,
    agents: Object.entries(agents).sort((a, b) => b[1] - a[1]),
    defaultPushes,
    branchPushes,
    defaultPushShare: pushes ? defaultPushes / pushes : 0,
    branchesCreated,
    branchesDeleted,
    prActions,
    tags: Object.entries(tags).sort((a, b) => b[1] - a[1]),
    privateEvents,
    fresh,
  };
}

// ---------- Pull requests looked up from the feed ----------
function summarizePullRequests(prInfo, login) {
  const rows = Object.entries(prInfo || {}).map(([key, pr]) => ({ key, ...pr })).filter((pr) => pr && pr.title);
  const merged = rows.filter((pr) => pr.merged);
  const unreviewed = merged.filter((pr) => !pr.reviews);
  const selfMerged = merged.filter((pr) => pr.author && pr.mergedBy && pr.author === pr.mergedBy);
  const hoursToMerge = merged
    .map((pr) => (new Date(pr.mergedAt) - new Date(pr.createdAt)) / 36e5)
    .filter((h) => Number.isFinite(h) && h >= 0);
  const sizes = rows.map((pr) => (pr.additions || 0) + (pr.deletions || 0));
  const open = rows.filter((pr) => pr.state === "OPEN");
  const agentAuthored = rows.filter((pr) => agentFromBranch(pr.headRef));
  const agentUnreviewed = merged.filter((pr) => agentFromBranch(pr.headRef) && !pr.reviews);
  const mine = login ? open.filter((pr) => pr.author === login) : open;
  return {
    total: rows.length,
    merged: merged.length,
    unreviewed,
    selfMerged: selfMerged.length,
    medianHoursToMerge: median(hoursToMerge),
    medianSize: median(sizes),
    largest: rows.slice().sort((a, b) => (b.additions + b.deletions) - (a.additions + a.deletions)).slice(0, 3),
    open,
    openMine: mine,
    agentAuthored: agentAuthored.length,
    agentUnreviewed,
    drafts: rows.filter((pr) => pr.isDraft).length,
  };
}

// ---------- Contribution year (GraphQL) ----------
function summarizeContributions(collection, today) {
  const calendar = collection && collection.contributionCalendar;
  const days = [];
  for (const week of (calendar && calendar.weeks) || []) {
    for (const day of week.contributionDays || []) days.push(day);
  }
  days.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const todayKey = today || (days.length ? days[days.length - 1].date : "");
  const upToToday = days.filter((d) => d.date <= todayKey);

  let longest = 0;
  let run = 0;
  for (const d of upToToday) {
    run = d.contributionCount > 0 ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  let current = 0;
  for (let i = upToToday.length - 1; i >= 0; i -= 1) {
    const d = upToToday[i];
    if (d.contributionCount > 0) current += 1;
    else if (i === upToToday.length - 1) continue; // today can still be empty
    else break;
  }

  const weekday = Array(7).fill(0);
  const monthly = {};
  for (const d of upToToday) {
    const dow = new Date(`${d.date}T00:00:00Z`).getUTCDay();
    weekday[dow] += d.contributionCount;
    const m = d.date.slice(0, 7);
    monthly[m] = (monthly[m] || 0) + d.contributionCount;
  }
  const totalFromDays = weekday.reduce((a, b) => a + b, 0);
  const active = upToToday.filter((d) => d.contributionCount > 0);
  const sumLast = (n, skip) => upToToday.slice(Math.max(0, upToToday.length - n - (skip || 0)), upToToday.length - (skip || 0))
    .reduce((a, d) => a + d.contributionCount, 0);
  const last30 = sumLast(30, 0);
  const prev30 = sumLast(30, 30);

  function repoTotals(rows) {
    return (rows || [])
      .map((row) => ({
        repo: row.repository && row.repository.nameWithOwner,
        isPrivate: Boolean(row.repository && row.repository.isPrivate),
        count: row.contributions && row.contributions.totalCount,
      }))
      .filter((row) => row.repo && row.count);
  }
  const commits = repoTotals(collection && collection.commitContributionsByRepository);
  const commitTotal = commits.reduce((a, r) => a + r.count, 0);

  return {
    total: calendar ? calendar.totalContributions : 0,
    days: upToToday,
    busiest: active.slice().sort((a, b) => b.contributionCount - a.contributionCount).slice(0, 5),
    longestStreak: longest,
    currentStreak: current,
    activeDays: active.length,
    dayCount: upToToday.length,
    medianActiveDay: median(active.map((d) => d.contributionCount)),
    weekday,
    weekendShare: totalFromDays ? (weekday[0] + weekday[6]) / totalFromDays : 0,
    monthly: Object.entries(monthly),
    last30,
    prev30,
    trend: prev30 ? (last30 - prev30) / prev30 : null,
    commits,
    focusShare: commitTotal && commits[0] ? commits[0].count / commitTotal : 0,
    pullRequests: repoTotals(collection && collection.pullRequestContributionsByRepository),
    issues: repoTotals(collection && collection.issueContributionsByRepository),
    reviews: repoTotals(collection && collection.pullRequestReviewContributionsByRepository),
    totals: {
      commits: collection ? collection.totalCommitContributions || 0 : 0,
      prs: collection ? collection.totalPullRequestContributions || 0 : 0,
      issues: collection ? collection.totalIssueContributions || 0 : 0,
      reviews: collection ? collection.totalPullRequestReviewContributions || 0 : 0,
      restricted: collection ? collection.restrictedContributionsCount || 0 : 0,
      repos: collection ? collection.totalRepositoriesWithContributedCommits || 0 : 0,
    },
  };
}

function summarizeNotifications(items) {
  const list = Array.isArray(items) ? items : [];
  const unread = list.filter((item) => item && item.unread);
  const byReason = {};
  for (const item of unread) {
    const reason = item.reason || "other";
    byReason[reason] = (byReason[reason] || 0) + 1;
  }
  const important = new Set(["review_requested", "mention", "team_mention", "assign", "author", "comment", "approval_requested", "security_alert"]);
  const ciFailures = unread.filter((item) => item.reason === "ci_activity" && /fail|cancel/i.test((item.subject && item.subject.title) || ""));
  const missed = unread.filter((item) => important.has(item.reason || "")).concat(ciFailures);
  return {
    total: list.length,
    unread: unread.length,
    byReason: Object.entries(byReason).sort((a, b) => b[1] - a[1]),
    missed,
    ciNoise: unread.filter((item) => item.reason === "ci_activity").length - ciFailures.length,
  };
}

const MINOR_PR_ACTIONS = new Set(["labeled", "unlabeled", "synchronize", "assigned", "unassigned", "review_requested", "review_request_removed", "edited"]);
function isMinor(event) {
  const p = (event && event.payload) || {};
  return (event.type === "PullRequestEvent" || event.type === "IssuesEvent") && MINOR_PR_ACTIONS.has(p.action);
}

function filterEvents(events, filter, repo, query, hideMinor) {
  const f = FILTERS[filter] || FILTERS.all;
  const q = String(query || "").trim().toLowerCase();
  return (events || []).filter((e) => f(e) && (!hideMinor || !isMinor(e)) && (!repo || repoName(e) === repo) &&
    (!q || `${repoName(e)} ${describeEvent(e)} ${branchOf(e)}`.toLowerCase().includes(q)));
}

const api = {
  eventLabel,
  repoName,
  branchOf,
  agentOf,
  agentFromBranch,
  titleTag,
  median,
  prKey,
  prRefsFromEvents,
  describeEvent,
  summarizeEvents,
  summarizePullRequests,
  summarizeContributions,
  summarizeNotifications,
  filterEvents,
  isMinor,
};

if (typeof module !== "undefined" && module.exports) module.exports = api;
if (typeof window !== "undefined") window.DeskInsights = api;
})();
