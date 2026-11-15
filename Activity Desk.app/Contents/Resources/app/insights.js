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
  if (event.type === "PushEvent" && typeof p.ref === "string" && p.ref.startsWith("refs/heads/")) return p.ref.slice(11);
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
  const slug = String(app?.slug || app?.name || "").toLowerCase();
  return Object.hasOwn(APP_NAMES, slug) ? APP_NAMES[slug] : "";
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
    const p = e.payload || {};
    let number;
    if (e.type === "PullRequestEvent") number = p.number || p.pull_request?.number;
    if (e.type === "PullRequestReviewEvent" || e.type === "PullRequestReviewCommentEvent") number = p.pull_request?.number;
    if (e.type === "IssueCommentEvent" && p.issue?.pull_request) number = p.issue.number;
    if (!Number.isInteger(number) || number < 1) continue;
    const key = prKey(repoName(e), number);
    if (!seen.has(key)) seen.set(key, { repo: repoName(e), number });
  }
  return [...seen.values()];
}

function describeEvent(event, prInfo) {
  const payload = (event && event.payload) || {};
  const repo = repoName(event);
  if (event.type === "PushEvent") {
    const ref = branchOf(event) || payload.ref;
    const count = Array.isArray(payload.commits) && payload.commits.length ? payload.commits.length : payload.size || 0;
    const what = count ? `${count} commit${count === 1 ? "" : "s"} ` : "";
    const head = payload.head ? ` (head ${String(payload.head).slice(0, 7)})` : "";
    return `Pushed ${what}to ${ref || "an unspecified ref"}${head}`;
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
  const byType = Object.create(null);
  const byRepo = Object.create(null);
  const hourGrid = Array.from({ length: 7 }, () => Array(24).fill(0));
  const agents = {};
  const tags = Object.create(null);
  let agentEvents = 0;
  let mainPushes = 0;
  let branchPushes = 0;
  let tagPushes = 0;
  let otherPushes = 0;
  let branchesCreated = 0;
  let branchesDeleted = 0;
  let privateEvents = 0;

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
    }
    const agent = agentOf(e);
    if (agent) {
      agentEvents += 1;
      agents[agent] = (agents[agent] || 0) + 1;
    }
    const p = e.payload || {};
    if (type === "PushEvent") {
      const b = branchOf(e);
      if (b === "main" || b === "master") mainPushes += 1;
      else if (b) branchPushes += 1;
      else if (String(p.ref).startsWith("refs/tags/")) tagPushes += 1;
      else otherPushes += 1;
    }
    if (type === "CreateEvent" && p.ref_type === "branch") branchesCreated += 1;
    if (type === "DeleteEvent" && p.ref_type === "branch") branchesDeleted += 1;
    const title = (p.issue && p.issue.title) || (p.pull_request && p.pull_request.title) || "";
    const tag = titleTag(title);
    if (tag && (type === "IssuesEvent" && p.action === "opened")) tags[tag] = (tags[tag] || 0) + 1;
  }

  const times = list.map((e) => new Date(e.created_at).getTime()).filter(Number.isFinite);
  const newest = times.length ? Math.max(...times) : null;
  const oldest = times.length ? Math.min(...times) : null;
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
  return {
    total: list.length,
    byType: Object.entries(byType).sort((a, b) => b[1] - a[1]),
    byRepo: Object.entries(byRepo).sort((a, b) => b[1] - a[1]),
    hourGrid,
    peakHour,
    newest,
    oldest,
    agentEvents,
    agentShare: list.length ? agentEvents / list.length : 0,
    agents: Object.entries(agents).sort((a, b) => b[1] - a[1]),
    mainPushes,
    branchPushes,
    tagPushes,
    otherPushes,
    branchesCreated,
    branchesDeleted,
    tags: Object.entries(tags).sort((a, b) => b[1] - a[1]),
    privateEvents,
    fresh,
  };
}

// ---------- Pull requests looked up from the feed ----------
function summarizePullRequests(prInfo, login) {
  const rows = Object.values(prInfo || {}).filter((pr) => pr?.title);
  const merged = rows.filter((pr) => pr.merged);
  const unreviewed = merged.filter((pr) => !pr.reviews);
  const selfMerged = merged.filter((pr) => pr.author && pr.mergedBy && pr.author === pr.mergedBy);
  const hoursToMerge = merged
    .map((pr) => (Date.parse(pr.mergedAt) - Date.parse(pr.createdAt)) / 36e5)
    .filter((h) => Number.isFinite(h) && h >= 0);
  const sizes = rows.map((pr) => (pr.additions || 0) + (pr.deletions || 0));
  const open = rows.filter((pr) => pr.state === "OPEN");
  const agentBranches = rows.filter((pr) => agentFromBranch(pr.headRef));
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
    agentBranches: agentBranches.length,
    drafts: open.filter((pr) => pr.isDraft).length,
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

  const todayTime = Date.parse(todayKey);
  let current = 0;
  let longest = 0;
  let run = 0;
  let previousTime = null;
  let recentCount = 0;
  let priorCount = 0;
  let recentDays = 0;
  let priorDays = 0;
  const weekday = Array(7).fill(0);
  const monthly = {};
  for (const d of upToToday) {
    const date = new Date(d.date);
    const time = date.getTime();
    const age = (todayTime - time) / 864e5;
    if (age < 30) {
      recentDays += 1;
      recentCount += d.contributionCount;
    } else if (age < 60) {
      priorDays += 1;
      priorCount += d.contributionCount;
    }
    if (time - previousTime !== 864e5) run = 0;
    run = d.contributionCount > 0 ? run + 1 : 0;
    longest = Math.max(longest, run);
    if (age <= 1 && run > 0) current = run; // today can still be empty
    previousTime = time;
    weekday[date.getUTCDay()] += d.contributionCount;
    const m = d.date.slice(0, 7);
    monthly[m] = (monthly[m] || 0) + d.contributionCount;
  }
  const totalFromDays = weekday.reduce((a, b) => a + b, 0);
  const active = upToToday.filter((d) => d.contributionCount > 0);
  const last30 = recentDays === 30 ? recentCount : null;
  const prev30 = priorDays === 30 ? priorCount : null;
  const commits = (collection?.commitContributionsByRepository || []).map((row) => ({
    repo: row.repository?.nameWithOwner,
    isPrivate: row.repository?.isPrivate,
    count: row.contributions?.totalCount,
  })).filter((row) => row.repo && row.count > 0).sort((a, b) => b.count - a.count);
  const commitTotal = collection?.totalCommitContributions || 0;

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
    trend: last30 != null && prev30 ? (last30 - prev30) / prev30 : null,
    commits,
    focusShare: commitTotal && commits[0] && commits[0].count <= commitTotal ? commits[0].count / commitTotal : null,
    totals: {
      commits: commitTotal,
      prs: collection ? collection.totalPullRequestContributions || 0 : 0,
      issues: collection ? collection.totalIssueContributions || 0 : 0,
      reviews: collection ? collection.totalPullRequestReviewContributions || 0 : 0,
      restricted: collection ? collection.restrictedContributionsCount || 0 : 0,
      repos: collection ? collection.totalRepositoriesWithContributedCommits || 0 : 0,
    },
  };
}

// ---------- Derived patterns ----------
// Everything below is computed from data the other summaries already hold. Nothing here asks GitHub for more.
const DAY_MS = 864e5;
const SESSION_GAP_MINUTES = 60;
const STALE_PR_DAYS = 14;
const WORK_MIX = {
  PushEvent: "Building", CreateEvent: "Building", DeleteEvent: "Building", ReleaseEvent: "Building", PullRequestEvent: "Building",
  PullRequestReviewEvent: "Reviewing", PullRequestReviewCommentEvent: "Reviewing",
  IssuesEvent: "Discussing", IssueCommentEvent: "Discussing", CommitCommentEvent: "Discussing",
};

const sum = (values) => values.reduce((a, b) => a + b, 0);
const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;
const share = (x) => `${Math.round(x * 100)}%`;

function durationLabel(hours) {
  if (hours == null || !Number.isFinite(hours)) return "—";
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} min`;
  if (hours < 48) return `${hours < 10 ? hours.toFixed(1) : Math.round(hours)} h`;
  return `${Math.round(hours / 24)} days`;
}

// Shape of the contribution year: how concentrated, how interrupted, and where the latest weeks sit.
function summarizeRhythm(year) {
  const days = (year && year.days) || [];
  const counts = days.map((d) => d.contributionCount || 0);
  const total = sum(counts);
  const ranked = counts.filter((n) => n > 0).sort((a, b) => b - a);

  let halfDays = 0;
  for (let acc = 0; halfDays < ranked.length && acc * 2 < total; halfDays += 1) acc += ranked[halfDays];
  let bands = null;
  if (ranked.length >= 10) {
    const top = Math.round(ranked.length * 0.1);
    const mid = Math.round(ranked.length * 0.5);
    bands = [
      ["Busiest 10% of active days", sum(ranked.slice(0, top)) / total],
      ["Next 40%", sum(ranked.slice(top, mid)) / total],
      ["Quietest 50%", sum(ranked.slice(mid)) / total],
    ];
  }

  const runs = [];
  const gaps = [];
  let previous = null;
  for (const d of days) {
    if (!d.contributionCount) continue;
    const time = Date.parse(d.date);
    const idle = previous == null ? 0 : Math.round((time - previous) / DAY_MS) - 1;
    if (previous == null || idle > 0) runs.push(0);
    if (idle > 0) {
      gaps.push({
        days: idle,
        from: new Date(previous + DAY_MS).toISOString().slice(0, 10),
        to: new Date(time - DAY_MS).toISOString().slice(0, 10),
      });
    }
    runs[runs.length - 1] += 1;
    previous = time;
  }
  const longestGap = gaps.reduce((best, gap) => (!best || gap.days > best.days ? gap : best), null);

  // Where the latest 28 days rank among every rolling 28-day window in the calendar.
  let momentum = null;
  if (counts.length >= 56) {
    const windows = [];
    let rolling = sum(counts.slice(0, 28));
    windows.push(rolling);
    for (let i = 28; i < counts.length; i += 1) {
      rolling += counts[i] - counts[i - 28];
      windows.push(rolling);
    }
    const last = windows.pop();
    momentum = { last28: last, percentile: windows.filter((w) => w < last).length / windows.length, windows: windows.length };
  }

  const weeks = [];
  for (let end = counts.length; end >= 7; end -= 7) weeks.push(sum(counts.slice(end - 7, end)));

  const repoCounts = ((year && year.commits) || []).map((row) => row.count);
  const repoTotal = sum(repoCounts);
  return {
    total,
    activeDays: ranked.length,
    halfDays,
    halfShare: ranked.length ? halfDays / ranked.length : null,
    bands,
    medianRun: median(runs),
    longestGap,
    weekBreaks: gaps.filter((gap) => gap.days >= 7).length,
    momentum,
    weeks: weeks.length,
    activeWeeks: weeks.filter(Boolean).length,
    repoSpread: repoTotal ? {
      effective: repoTotal ** 2 / sum(repoCounts.map((n) => n * n)),
      listed: repoCounts.length,
    } : null,
  };
}

// Work sessions in the Events feed: runs of events separated by less than an hour.
function summarizeSessions(events, login) {
  const timed = (events || [])
    .map((e) => ({ e, time: new Date(e.created_at).getTime() }))
    .filter((row) => Number.isFinite(row.time))
    .sort((a, b) => a.time - b.time);
  const sessions = [];
  const dayParts = { core: 0, edge: 0, weekend: 0 };
  const mix = { Building: 0, Reviewing: 0, Discussing: 0, Other: 0 };
  const created = new Map();
  const lifetimes = [];
  const owner = login ? `${String(login).toLowerCase()}/` : "";
  let ownRepo = 0;

  for (const { e, time } of timed) {
    const repo = repoName(e);
    const current = sessions[sessions.length - 1];
    if (current && time - current.end < SESSION_GAP_MINUTES * 6e4) {
      current.end = time;
      current.events += 1;
      current.repos.add(repo);
    } else {
      sessions.push({ start: time, end: time, events: 1, repos: new Set([repo]) });
    }
    const when = new Date(time);
    const weekend = when.getDay() === 0 || when.getDay() === 6;
    dayParts[weekend ? "weekend" : when.getHours() >= 9 && when.getHours() < 18 ? "core" : "edge"] += 1;
    mix[WORK_MIX[e.type] || "Other"] += 1;
    if (owner && repo.toLowerCase().startsWith(owner)) ownRepo += 1;
    const p = e.payload || {};
    if (p.ref_type === "branch" && p.ref) {
      const key = `${repo} ${p.ref}`;
      if (e.type === "CreateEvent") created.set(key, time);
      if (e.type === "DeleteEvent" && created.has(key)) {
        lifetimes.push((time - created.get(key)) / 36e5);
        created.delete(key);
      }
    }
  }

  const multi = sessions.filter((s) => s.events > 1);
  const longest = multi.reduce((best, s) => (!best || s.end - s.start > best.end - best.start ? s : best), null);
  return {
    timed: timed.length,
    sessions: sessions.length,
    multi: multi.length,
    medianHours: median(multi.map((s) => (s.end - s.start) / 36e5)),
    longest: longest && { start: longest.start, hours: (longest.end - longest.start) / 36e5, events: longest.events, repos: longest.repos.size },
    multiRepo: multi.filter((s) => s.repos.size > 1).length,
    dayParts,
    mix: Object.entries(mix).filter(([, n]) => n > 0),
    ownRepo: owner ? ownRepo : null,
    branchLifetimes: { count: lifetimes.length, medianHours: median(lifetimes) },
  };
}

// Comparisons inside the sampled pull requests: agent branches against the rest, larger against smaller.
function summarizePrPatterns(prInfo, now) {
  const rows = Object.values(prInfo || {}).filter((pr) => pr?.title);
  const size = (pr) => (pr.additions || 0) + (pr.deletions || 0);
  const group = (list) => ({
    count: list.length,
    medianHours: median(list
      .map((pr) => (Date.parse(pr.mergedAt) - Date.parse(pr.createdAt)) / 36e5)
      .filter((h) => Number.isFinite(h) && h >= 0)),
    unreviewed: list.filter((pr) => !pr.reviews).length,
    medianSize: median(list.map(size)),
    agent: list.filter((pr) => agentFromBranch(pr.headRef)).length,
  });
  const merged = rows.filter((pr) => pr.merged);
  const bySize = merged.slice().sort((a, b) => size(a) - size(b));
  const half = Math.floor(bySize.length / 2);
  const mergedLines = sum(merged.map(size));
  const nowTime = now == null ? Date.now() : new Date(now).getTime();
  const open = rows.filter((pr) => pr.state === "OPEN")
    .map((pr) => ({ repo: pr.repo, number: pr.number, days: (nowTime - Date.parse(pr.createdAt)) / DAY_MS }))
    .filter((pr) => Number.isFinite(pr.days) && pr.days >= 0)
    .sort((a, b) => b.days - a.days);
  return {
    merged: merged.length,
    agent: group(merged.filter((pr) => agentFromBranch(pr.headRef))),
    other: group(merged.filter((pr) => !agentFromBranch(pr.headRef))),
    // An odd middle PR is left out so both halves hold the same number.
    smaller: half >= 3 ? group(bySize.slice(0, half)) : null,
    larger: half >= 3 ? group(bySize.slice(-half)) : null,
    mergedLines,
    unreviewedLines: sum(merged.filter((pr) => !pr.reviews).map(size)),
    open: open.length,
    oldestOpen: open[0] || null,
    stale: open.filter((pr) => pr.days >= STALE_PR_DAYS).length,
  };
}

const TRAJECTORY_MIN_WEEKS = 6;
const TRAJECTORY_SHUFFLES = 200;
const TRAJECTORY_MIN_CHANGE = 0.25;
const FOLLOW_GRACE_DAYS = 2;

// The split of a series into before and after that removes the most squared error around the overall mean.
function bestSplit(values) {
  const n = values.length;
  const total = sum(values);
  let best = null;
  let left = 0;
  for (let k = 1; k < n; k += 1) {
    left += values[k - 1];
    if (k < TRAJECTORY_MIN_WEEKS || n - k < TRAJECTORY_MIN_WEEKS) continue;
    const before = left / k;
    const after = (total - left) / (n - k);
    const gain = (k * (n - k) / n) * (after - before) ** 2;
    if (!best || gain > best.gain) best = { k, gain, before, after };
  }
  return best;
}

// Weekly level shifts and day-to-day persistence in the contribution year.
function summarizeTrajectory(year) {
  const days = (year && year.days) || [];
  const weeks = [];
  for (let end = days.length; end >= 7; end -= 7) {
    const slice = days.slice(end - 7, end);
    weeks.unshift({ start: slice[0].date, count: sum(slice.map((d) => d.contributionCount || 0)) });
  }

  let shift = null;
  const n = weeks.length;
  if (n >= TRAJECTORY_MIN_WEEKS * 2) {
    const values = weeks.map((w) => w.count);
    const best = bestSplit(values);
    // The best split is chosen to look as different as possible, so compare it with the best split of
    // the same weeks in random order. A shift is clear when it beats 95% of the shuffles.
    let seed = 1;
    const random = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
    const shuffled = values.slice();
    let beaten = 0;
    for (let round = 0; round < TRAJECTORY_SHUFFLES; round += 1) {
      for (let i = shuffled.length - 1; i > 0; i -= 1) {
        const j = Math.floor(random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      if (bestSplit(shuffled).gain < best.gain) beaten += 1;
    }
    const diff = best.after - best.before;
    shift = {
      at: weeks[best.k].start,
      weeksBefore: best.k,
      weeksAfter: n - best.k,
      before: best.before,
      after: best.after,
      beaten: beaten / TRAJECTORY_SHUFFLES,
      clear: diff !== 0 && beaten / TRAJECTORY_SHUFFLES >= 0.95 &&
        Math.abs(diff) / Math.max(best.before, best.after) >= TRAJECTORY_MIN_CHANGE,
    };
  }

  // Today can still be empty, so it is never counted as the day after.
  const counts = days.slice(0, -1).map((d) => (d.contributionCount || 0) > 0);
  const after = { active: [0, 0], idle: [0, 0] };
  for (let i = 1; i < counts.length; i += 1) {
    const bucket = counts[i - 1] ? after.active : after.idle;
    bucket[1] += 1;
    if (counts[i]) bucket[0] += 1;
  }
  const odds = (pair) => (pair[1] >= 10 ? { rate: pair[0] / pair[1], days: pair[1] } : null);
  return { weeks: n, series: weeks, shift, afterActive: odds(after.active), afterIdle: odds(after.idle) };
}

// Whether work that starts in the Events feed reaches a pull request and a merge.
function summarizeFollowThrough(events, prInfo, now) {
  const nowTime = now == null ? Date.now() : new Date(now).getTime();
  const prs = Object.values(prInfo || {}).filter((pr) => pr?.title);
  const headRefs = new Set(prs.map((pr) => `${pr.repo} ${pr.headRef}`));
  const prBranches = new Set();
  const opened = new Map();
  const branches = new Map();
  for (const e of events || []) {
    const repo = repoName(e);
    const p = e.payload || {};
    if (e.type === "PullRequestEvent") {
      const ref = branchOf(e);
      if (ref) prBranches.add(`${repo} ${ref}`);
      const number = p.number || p.pull_request?.number;
      if (p.action === "opened" && Number.isInteger(number)) opened.set(prKey(repo, number), { repo, number });
    }
    if (e.type === "CreateEvent" && p.ref_type === "branch" && p.ref) {
      const time = Date.parse(e.created_at);
      const key = `${repo} ${p.ref}`;
      if (Number.isFinite(time) && (!branches.has(key) || branches.get(key).time > time)) branches.set(key, { repo, ref: String(p.ref), time });
    }
  }

  // Branches younger than the grace period have not had a fair chance to get a pull request.
  const settled = [...branches.entries()].filter(([, b]) => (nowTime - b.time) / DAY_MS >= FOLLOW_GRACE_DAYS);
  const withoutPr = settled.filter(([key]) => !headRefs.has(key) && !prBranches.has(key))
    .map(([, b]) => ({ repo: b.repo, ref: b.ref, days: (nowTime - b.time) / DAY_MS, agent: agentFromBranch(b.ref) }))
    .sort((a, b) => b.days - a.days);

  const outcomes = { merged: 0, closed: 0, open: 0, unknown: 0 };
  const closed = [];
  for (const [key, ref] of opened) {
    const pr = prInfo?.[key];
    if (!pr?.title) outcomes.unknown += 1;
    else if (pr.merged) outcomes.merged += 1;
    else if (pr.state === "CLOSED") {
      outcomes.closed += 1;
      closed.push({ repo: ref.repo, number: ref.number, agent: agentFromBranch(pr.headRef) });
    } else outcomes.open += 1;
  }
  return {
    branches: branches.size,
    settled: settled.length,
    withoutPr,
    agentWithoutPr: withoutPr.filter((b) => b.agent).length,
    opened: opened.size,
    outcomes,
    closed,
  };
}

const isBotLogin = (login) => /\[bot\]$|-bot$|^copilot/i.test(String(login || ""));

// Review turnaround in the sampled pull requests, after CHAOSS "time to first response":
// the first review by a human who is not the author, measured from when the pull request was created.
function summarizeReviewFlow(prInfo, login) {
  const me = String(login || "").toLowerCase();
  const rows = Object.values(prInfo || {}).filter((pr) => pr?.title && Array.isArray(pr.reviewList));
  const authored = rows.filter((pr) => me && String(pr.author || "").toLowerCase() === me);
  const firstHuman = (pr) => pr.reviewList
    .filter((r) => !r.bot && r.login && r.login.toLowerCase() !== String(pr.author || "").toLowerCase() && Number.isFinite(Date.parse(r.at)))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))[0];

  const waits = [];
  let reviewedBeforeMerge = 0;
  for (const pr of authored) {
    const first = firstHuman(pr);
    if (!first) continue;
    const hours = (Date.parse(first.at) - Date.parse(pr.createdAt)) / 36e5;
    if (Number.isFinite(hours) && hours >= 0) waits.push(hours);
    if (pr.merged && Date.parse(first.at) <= Date.parse(pr.mergedAt)) reviewedBeforeMerge += 1;
  }

  const merged = authored.filter((pr) => pr.merged);
  const botOnly = merged.filter((pr) => pr.reviewList.length && pr.reviewList.every((r) => r.bot));
  const noHuman = merged.filter((pr) => !firstHuman(pr));
  const selfMerged = merged.filter((pr) => pr.mergedBy && pr.mergedBy.toLowerCase() === me);

  // Who reviews this user's work, counting each reviewer once per pull request.
  const reviewers = new Map();
  for (const pr of authored) {
    const seen = new Set();
    for (const r of pr.reviewList) {
      const name = r.login && r.login.toLowerCase();
      if (!name || r.bot || name === me || seen.has(name)) continue;
      seen.add(name);
      reviewers.set(r.login, (reviewers.get(r.login) || 0) + 1);
    }
  }
  const ranked = [...reviewers.entries()].sort((a, b) => b[1] - a[1]);
  const reviewerTotal = sum(ranked.map(([, n]) => n));
  return {
    authored: authored.length,
    withHumanReview: waits.length,
    medianFirstReviewHours: median(waits),
    merged: merged.length,
    reviewedBeforeMerge,
    botOnly: botOnly.length,
    noHuman: noHuman.length,
    selfMerged: selfMerged.length,
    reviewers: ranked,
    topReviewerShare: reviewerTotal ? ranked[0][1] / reviewerTotal : null,
    truncated: authored.filter((pr) => pr.reviews > pr.reviewList.length).length,
  };
}

// Plain-language findings. Each names its source, and each needs a minimum sample before it appears.
function deriveObservations({ rhythm, sessions, prs, trajectory, follow, review }) {
  const out = [];
  const add = (tone, source, title, detail) => out.push({ tone, source, title, detail });
  const YEAR = "Contribution year";
  const FEED = "Recent events";
  const PRS = "Sampled pull requests";

  if (rhythm && rhythm.activeDays >= 10) {
    const shape = rhythm.halfShare <= 0.2 ? " Output arrives in bursts rather than evenly."
      : rhythm.halfShare >= 0.35 ? " Output is spread fairly evenly across active days." : "";
    add("info", YEAR, `Half of the year's contributions came from ${plural(rhythm.halfDays, "day")}`,
      `That is ${share(rhythm.halfShare)} of ${plural(rhythm.activeDays, "active day")}.${shape}`);
  }
  if (rhythm?.momentum && rhythm.momentum.last28 > 0 && rhythm.momentum.percentile >= 0.85) {
    add("good", YEAR, "The last 28 days are among the busiest stretches of the year",
      rhythm.momentum.percentile === 1 ? `Busier than every one of the ${plural(rhythm.momentum.windows, "earlier rolling 28-day window")}.`
        : `Busier than ${Math.floor(rhythm.momentum.percentile * 100)}% of the ${plural(rhythm.momentum.windows, "earlier rolling 28-day window")}.`);
  } else if (rhythm?.momentum && rhythm.total > 0 && rhythm.momentum.percentile <= 0.15) {
    add("info", YEAR, "The last 28 days are among the quietest stretches of the year",
      `Busier than only ${Math.ceil(rhythm.momentum.percentile * 100)}% of the ${plural(rhythm.momentum.windows, "earlier rolling 28-day window")}.`);
  }
  if (rhythm?.longestGap && rhythm.longestGap.days >= 7) {
    add("info", YEAR, `The longest break lasted ${plural(rhythm.longestGap.days, "day")}`,
      `${rhythm.longestGap.from} to ${rhythm.longestGap.to}. ${plural(rhythm.weekBreaks, "break")} of a week or longer between active days.`);
  }
  if (rhythm?.repoSpread && rhythm.repoSpread.listed >= 2) {
    const { effective, listed } = rhythm.repoSpread;
    const title = effective < 1.5 ? "Commits concentrate in a single repository"
      : effective >= 4 ? `Commits spread across about ${Math.round(effective)} repositories` : "";
    if (title) add("info", YEAR, title,
      `The ${listed} returned repository totals are distributed like ${effective.toFixed(1)} equally used repositories.`);
  }

  if (sessions && sessions.multi >= 4) {
    const crossing = sessions.multiRepo / sessions.multi;
    if (crossing >= 0.5) add("info", FEED, `${sessions.multiRepo} of ${plural(sessions.multi, "work session")} crossed repositories`,
      "A session is a run of events with gaps under an hour. Frequent crossings can mean context switching.");
    else if (crossing <= 0.15) add("good", FEED, "Work sessions tend to stay in one repository",
      `${sessions.multiRepo} of ${plural(sessions.multi, "session")} with several events touched more than one repository.`);
  }
  if (sessions && sessions.timed >= 20) {
    const { core, edge, weekend } = sessions.dayParts;
    if (core / sessions.timed < 0.5) add("info", FEED, `${share(1 - core / sessions.timed)} of loaded events fall outside weekdays 9am–6pm`,
      `${plural(weekend, "event")} on weekends and ${edge.toLocaleString()} on weekday early mornings or evenings, local time.`);
  }
  if (sessions && sessions.branchLifetimes.count >= 3) {
    add("info", FEED, `Short-lived branches lasted a median of ${durationLabel(sessions.branchLifetimes.medianHours)}`,
      `${sessions.branchLifetimes.count} branches were created and deleted within the loaded events.`);
  }

  if (prs) {
    const { agent, other, smaller, larger } = prs;
    if (agent.count >= 3 && other.count >= 3) {
      if (agent.medianHours > 0 && other.medianHours > 0) {
        const ratio = other.medianHours / agent.medianHours;
        const times = (x) => `${x >= 10 ? Math.round(x) : x.toFixed(1)}×`;
        if (ratio >= 2 || ratio <= 0.5) {
          add("info", PRS, `Agent-branch PRs merged ${ratio >= 2 ? `${times(ratio)} faster` : `${times(1 / ratio)} slower`} than other PRs`,
            `Median ${durationLabel(agent.medianHours)} across ${agent.count} agent-branch merges, ${durationLabel(other.medianHours)} across ${other.count} others.`);
        }
      }
      if (agent.unreviewed / agent.count - other.unreviewed / other.count >= 0.3) {
        add("warn", PRS, "Agent-branch merges skip review more often",
          `${agent.unreviewed} of ${agent.count} had zero recorded reviews, against ${other.unreviewed} of ${other.count} other merges.`);
      }
    }
    if (prs.merged >= 3 && prs.mergedLines > 0 && prs.unreviewedLines / prs.mergedLines >= 0.5) {
      add("warn", PRS, `${share(prs.unreviewedLines / prs.mergedLines)} of merged lines landed without a recorded review`,
        `${prs.unreviewedLines.toLocaleString()} of ${prs.mergedLines.toLocaleString()} changed lines across ${plural(prs.merged, "sampled merge")}.`);
    }
    if (smaller && larger && smaller.medianHours > 0 && larger.medianHours != null) {
      const ratio = larger.medianHours / smaller.medianHours;
      const basis = `Median ${durationLabel(larger.medianHours)} for the larger half (${Math.round(larger.medianSize).toLocaleString()} lines), ${durationLabel(smaller.medianHours)} for the smaller half (${Math.round(smaller.medianSize).toLocaleString()} lines).`;
      // Size and branch type overlap, so say so instead of crediting size alone.
      const skew = Math.abs(larger.agent - smaller.agent) / larger.count >= 0.3
        ? ` Agent branches make up ${larger.agent} of the larger ${larger.count} and ${smaller.agent} of the smaller ${smaller.count}, so branch type may explain the gap.` : "";
      if (ratio >= 2) add("info", PRS, "Larger PRs took noticeably longer to merge", basis + skew);
      else if (ratio <= 1) add("info", PRS, "Larger PRs merged at least as fast as smaller ones", `${basis}${skew || " Time to merge is not scaling with size."}`);
    }
    if (prs.stale) {
      const o = prs.oldestOpen;
      add("warn", PRS, `${plural(prs.stale, "sampled open PR")} older than two weeks`,
        `Oldest is ${o.repo} #${o.number}, opened ${plural(Math.floor(o.days), "day")} ago.`);
    }
  }
  const perWeek = (x) => `${x >= 10 ? Math.round(x) : x.toFixed(1)} a week`;
  if (trajectory?.shift?.clear) {
    const s = trajectory.shift;
    const up = s.after > s.before;
    add(up ? "good" : "info", YEAR, `Weekly output ${up ? "stepped up" : "dropped"} around the week of ${s.at}`,
      `${perWeek(s.before)} across the ${s.weeksBefore} weeks before, ${perWeek(s.after)} across the ${s.weeksAfter} weeks since. This is the clearest single shift in the year's weekly totals.`);
  }
  if (trajectory?.afterActive && trajectory?.afterIdle) {
    const a = trajectory.afterActive.rate;
    const i = trajectory.afterIdle.rate;
    if (a - i >= 0.3) {
      add("info", YEAR, "Activity carries over from one day to the next",
        `An active day was followed by another ${share(a)} of the time; an idle day was followed by an active one ${share(i)} of the time. Restarting after a break is the harder step.`);
    } else if (Math.abs(a - i) < 0.1 && i >= 0.3) {
      add("good", YEAR, "Breaks do not stall the next day",
        `The chance of an active day is about the same after an active day (${share(a)}) as after an idle one (${share(i)}).`);
    }
  }

  if (follow && follow.settled >= 4) {
    const missing = follow.withoutPr.length;
    if (missing / follow.settled >= 0.5) {
      const agents = follow.agentWithoutPr ? ` ${follow.agentWithoutPr} of them are agent branches.` : "";
      add("info", FEED, `${missing} of ${plural(follow.settled, "branch")} created in the feed never got a pull request`,
        `Counting branches at least ${FOLLOW_GRACE_DAYS} days old. Oldest is ${follow.withoutPr[0].ref} in ${follow.withoutPr[0].repo}.${agents}`);
    }
  }
  if (follow) {
    const { merged, closed } = follow.outcomes;
    const decided = merged + closed;
    if (decided >= 4 && closed / decided >= 0.3) {
      add("warn", FEED, `${closed} of ${plural(decided, "pull request")} you opened and that are now finished were closed without merging`,
        `Pull requests opened in the loaded events, with current state from the sampled details. ${follow.outcomes.open} are still open.`);
    }
  }

  if (review && review.withHumanReview >= 3) {
    add("info", PRS, `Your pull requests waited a median of ${durationLabel(review.medianFirstReviewHours)} for a first human review`,
      `Across ${plural(review.withHumanReview, "pull request")} that you authored and someone else reviewed. Bots and your own reviews are left out.`);
  }
  if (review && review.merged >= 3) {
    if (review.botOnly && review.botOnly / review.merged >= 0.25) {
      add("warn", PRS, `${review.botOnly} of ${plural(review.merged, "merge")} were reviewed only by bots`,
        "These count as reviewed in the Pull requests view, but no person reviewed them.");
    }
    if (review.selfMerged / review.merged >= 0.8 && review.noHuman / review.merged >= 0.5) {
      add("info", PRS, `You merged ${review.selfMerged} of your ${plural(review.merged, "sampled merge")} yourself`,
        `${review.noHuman} of those merges had no human review from anyone else.`);
    }
  }
  if (review && review.reviewers.length && review.withHumanReview >= 4 && review.topReviewerShare >= 0.6) {
    const [name, count] = review.reviewers[0];
    add("info", PRS, `One person handles most reviews of your work`,
      `${name} reviewed ${count} of your sampled pull requests, ${share(review.topReviewerShare)} of all reviewer visits. Review depends on their availability.`);
  }

  const rank = { warn: 0, good: 1, info: 1 };
  return out.sort((a, b) => rank[a.tone] - rank[b.tone]);
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

function filterEvents(events, filter, repo, query, hideMinor, prInfo) {
  const f = FILTERS[filter] || FILTERS.all;
  const q = String(query || "").trim().toLowerCase();
  return (events || []).filter((e) => f(e) && (!hideMinor || !isMinor(e)) && (!repo || repoName(e) === repo) &&
    (!q || `${repoName(e)} ${describeEvent(e, prInfo)} ${branchOf(e)}`.toLowerCase().includes(q)));
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
  summarizeRhythm,
  summarizeSessions,
  summarizePrPatterns,
  summarizeTrajectory,
  summarizeFollowThrough,
  summarizeReviewFlow,
  isBotLogin,
  deriveObservations,
  durationLabel,
  filterEvents,
  isMinor,
};

if (typeof module !== "undefined" && module.exports) module.exports = api;
if (typeof window !== "undefined") window.DeskInsights = api;
})();
