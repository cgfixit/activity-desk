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
const plural = (n, word, many = `${word}s`) => `${n.toLocaleString()} ${n === 1 ? word : many}`;
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
  let lateNight = 0; // midnight to 4am local time, the window Eyolfson et al. compared

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
    if (when.getHours() < 4) lateNight += 1;
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
    lateNight,
    mix: Object.entries(mix).filter(([, n]) => n > 0),
    ownRepo: owner ? ownRepo : null,
    branchLifetimes: { count: lifetimes.length, medianHours: median(lifetimes) },
  };
}

// Comparisons inside the loaded pull requests: agent branches against the rest, larger against smaller.
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
    all: group(merged),
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

// Review turnaround in the loaded pull requests, after CHAOSS "time to first response":
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

// Review partners: who reviews the user's pull requests and whose pull requests the user reviews.
// Both directions use the same window and the same clock as review turnaround: hours from creation
// to that person's first review, not from the review request, which needs the timeline API.
const COLLAB_MIN_SIDE = 8;      // reviews on the busier side before a balance finding
const COLLAB_RATIO = 3;         // how lopsided the balance must be
const COLLAB_PAIR_MIN = 3;      // pull requests in each direction before a pair finding
const COLLAB_PAIR_HOURS = 24;   // and the median gap between directions
const COLLAB = "Review partners";
// `complete` says both searches loaded without a cap. Without it, a balance comparison
// would read a missing or truncated side as the user giving or getting fewer reviews.
function summarizeCollaboration(prInfo, reviewed, login, { complete = false } = {}) {
  const me = String(login || "").toLowerCase();
  const people = new Map();
  const person = (name) => {
    const key = name.toLowerCase();
    if (!people.has(key)) people.set(key, { login: name, inHours: [], outHours: [], in: 0, out: 0 });
    return people.get(key);
  };
  const hoursFrom = (start, at) => {
    const h = (Date.parse(at) - Date.parse(start)) / 36e5;
    return Number.isFinite(h) && h >= 0 ? h : null;
  };

  // Inbound: each human reviewer once per pull request the user authored, timed by their first review.
  let received = 0;
  let truncated = 0;
  const authored = Object.values(prInfo || {}).filter((pr) => pr?.title && Array.isArray(pr.reviewList) &&
    me && String(pr.author || "").toLowerCase() === me);
  for (const pr of authored) {
    if (pr.reviews > pr.reviewList.length) truncated += 1;
    const first = new Map();
    for (const r of pr.reviewList) {
      const name = r.login && r.login.toLowerCase();
      if (!name || r.bot || name === me) continue;
      const t = Date.parse(r.at);
      if (!first.has(name) || (Number.isFinite(t) && t < Date.parse(first.get(name).at))) first.set(name, r);
    }
    for (const r of first.values()) {
      const p = person(r.login);
      p.in += 1;
      received += 1;
      const h = hoursFrom(pr.createdAt, r.at);
      if (h != null) p.inHours.push(h);
    }
  }

  // Outbound: pull requests by other humans that the user reviewed, timed by the user's first review.
  let given = 0;
  let botAuthored = 0;
  let unmatched = 0;
  for (const pr of Object.values(reviewed || {})) {
    const author = String(pr?.author || "");
    if (!pr?.title || !author || author.toLowerCase() === me) continue;
    if (pr.authorBot) { botAuthored += 1; continue; }
    const p = person(author);
    p.out += 1;
    given += 1;
    const h = pr.myFirstReviewAt ? hoursFrom(pr.createdAt, pr.myFirstReviewAt) : null;
    if (h != null) p.outHours.push(h); else unmatched += 1;
  }

  const rows = [...people.values()].map((p) => ({
    login: p.login, in: p.in, out: p.out,
    inMedianHours: median(p.inHours), outMedianHours: median(p.outHours),
    inTimed: p.inHours.length, outTimed: p.outHours.length,
    kind: p.in && p.out ? "mutual" : p.in ? "reviews-you" : "you-review",
  })).sort((a, b) => (b.in + b.out) - (a.in + a.out) || a.login.localeCompare(b.login));

  const findings = [];
  const add = (tone, title, detail) => findings.push({ tone, source: COLLAB, title, detail });
  const busier = Math.max(given, received);
  if (complete && busier >= COLLAB_MIN_SIDE && busier >= COLLAB_RATIO * Math.max(1, Math.min(given, received))) {
    if (given > received) add("info", "You review much more than you are reviewed",
      `You reviewed ${plural(given, "pull request")} by others and received ${plural(received, "human review")} on your own in the same window.`);
    else add("info", "Others review you much more than you review them",
      `Your pull requests received ${plural(received, "human review")} and you reviewed ${plural(given, "pull request")} by others in the same window.`);
  }
  for (const r of rows) {
    if (r.kind !== "mutual" || r.inTimed < COLLAB_PAIR_MIN || r.outTimed < COLLAB_PAIR_MIN) continue;
    const gap = r.outMedianHours - r.inMedianHours;
    if (Math.abs(gap) < COLLAB_PAIR_HOURS) continue;
    const faster = gap < 0;
    add("info", faster ? `You answer ${r.login} faster than they answer you` : `${r.login} answers you faster than you answer them`,
      `Median first review: yours on their pull requests ${durationLabel(r.outMedianHours)}, theirs on yours ${durationLabel(r.inMedianHours)}, across ${r.outTimed} and ${r.inTimed} pull requests.`);
    if (findings.length >= 3) break;
  }

  return {
    authored: authored.length, reviewedCount: Object.keys(reviewed || {}).length,
    received, given, botAuthored, unmatched, truncated, complete,
    people: rows, mutual: rows.filter((r) => r.kind === "mutual").length, findings,
  };
}

// Plain-language findings. Each names its source, and each needs a minimum sample before it appears.
function deriveObservations({ rhythm, sessions, prs, trajectory, follow, review }) {
  const out = [];
  const add = (tone, source, title, detail) => out.push({ tone, source, title, detail });
  const YEAR = "Contribution year";
  const FEED = "Recent events";
  const PRS = "Pull requests";

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
        `${prs.unreviewedLines.toLocaleString()} of ${prs.mergedLines.toLocaleString()} changed lines across ${plural(prs.merged, "loaded merge")}.`);
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
      add("warn", PRS, `${plural(prs.stale, "loaded open PR")} older than two weeks`,
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
      add("info", FEED, `${missing} of ${plural(follow.settled, "branch", "branches")} created in the feed never got a pull request`,
        `Counting branches at least ${FOLLOW_GRACE_DAYS} days old. Oldest is ${follow.withoutPr[0].ref} in ${follow.withoutPr[0].repo}.${agents}`);
    }
  }
  if (follow) {
    const { merged, closed } = follow.outcomes;
    const decided = merged + closed;
    if (decided >= 4 && closed / decided >= 0.3) {
      add("warn", FEED, `${closed} of ${plural(decided, "pull request")} you opened and that are now finished were closed without merging`,
        `Pull requests opened in the loaded events, with current state from the loaded details. ${follow.outcomes.open} are still open.`);
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
      add("info", PRS, `You merged ${review.selfMerged} of your ${plural(review.merged, "loaded merge")} yourself`,
        `${review.noHuman} of those merges had no human review from anyone else.`);
    }
  }
  if (review && review.reviewers.length && review.withHumanReview >= 4 && review.topReviewerShare >= 0.6) {
    const [name, count] = review.reviewers[0];
    add("info", PRS, `One person handles most reviews of your work`,
      `${name} reviewed ${count} of your loaded pull requests, ${share(review.topReviewerShare)} of all reviewer visits. Review depends on their availability.`);
  }

  const rank = { warn: 0, good: 1, info: 1 };
  return out.sort((a, b) => rank[a.tone] - rank[b.tone]);
}

// ---------- Suggestions ----------
// Further reading for suggestions. The renderer shows these titles, and the main process opens a link
// only by its id here, after checking the URL against its own host allowlist.
const READING = Object.freeze({
  "google-small-cls": { title: "Small CLs", by: "Google Engineering Practices", kind: "Guide", url: "https://google.github.io/eng-practices/review/developer/small-cls.html" },
  "google-speed": { title: "Speed of code reviews", by: "Google Engineering Practices", kind: "Guide", url: "https://google.github.io/eng-practices/review/reviewer/speed.html#fast" },
  "gh-rulesets": { title: "Available rules for rulesets", by: "GitHub Docs", kind: "Docs", url: "https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets" },
  "gh-approve": { title: "Approving a pull request with required reviews", by: "GitHub Docs", kind: "Docs", url: "https://docs.github.com/en/pull-requests/how-tos/review-pull-requests/approving-a-pull-request-with-required-reviews" },
  "gh-codeowners": { title: "About code owners", by: "GitHub Docs", kind: "Docs", url: "https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners" },
  "gh-team-review": { title: "Managing code review settings for your team", by: "GitHub Docs", kind: "Docs", url: "https://docs.github.com/en/organizations/organizing-members-into-teams/managing-code-review-settings-for-your-team#routing-algorithms" },
  "gh-draft": { title: "Pull requests: draft pull requests", by: "GitHub Docs", kind: "Docs", url: "https://docs.github.com/en/pull-requests/reference/pull-requests#draft-pull-requests" },
  "gh-auto-delete": { title: "Managing the automatic deletion of branches", by: "GitHub Docs", kind: "Docs", url: "https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-the-automatic-deletion-of-branches" },
  "actions-stale": { title: "actions/stale", by: "GitHub Actions", kind: "Tool", url: "https://github.com/actions/stale" },
  "gh-notifications": { title: "Managing GitHub Actions notifications", by: "GitHub Docs", kind: "Docs", url: "https://docs.github.com/en/subscriptions-and-notifications/how-tos/managing-github-actions-notifications" },
  "gh-labels": { title: "Filtering and searching issues and pull requests", by: "GitHub Docs", kind: "Docs", url: "https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/filtering-and-searching-issues-and-pull-requests" },
  "gh-issue-forms": { title: "Syntax for issue forms", by: "GitHub Docs", kind: "Docs", url: "https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests/syntax-for-issue-forms#top-level-syntax" },
  "gh-pat": { title: "Managing your personal access tokens", by: "GitHub Docs", kind: "Docs", url: "https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#types-of-personal-access-tokens" },
  "gh-copilot-risks": { title: "Risks and mitigations for Copilot cloud agent", by: "GitHub Docs", kind: "Docs", url: "https://docs.github.com/en/copilot/concepts/security-governance-and-network-settings/risks-and-mitigations#copilot-cloud-agent-can-push-code-changes-to-your-repository" },
  "gh-readme": { title: "About the repository README file", by: "GitHub Docs", kind: "Docs", url: "https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-readmes#about-readmes" },
  "gh-topics": { title: "Classifying your repository with topics", by: "GitHub Docs", kind: "Docs", url: "https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/classifying-your-repository-with-topics#about-topics" },
  "gh-social-preview": { title: "Customizing your repository's social media preview", by: "GitHub Docs", kind: "Docs", url: "https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/customizing-your-repositorys-social-media-preview" },
  "chaoss-first-response": { title: "Time to First Response", by: "CHAOSS", kind: "Metric", url: "https://chaoss.community/kb/metric-time-to-first-response/" },
  "bacchelli-2013": { title: "Expectations, Outcomes, and Challenges of Modern Code Review", by: "Bacchelli and Bird, ICSE 2013", kind: "Study", url: "https://doi.org/10.1109/ICSE.2013.6606617" },
  "sadowski-2018": { title: "Modern Code Review: A Case Study at Google", by: "Sadowski et al., ICSE-SEIP 2018", kind: "Study", url: "https://doi.org/10.1145/3183519.3183525" },
  "kudrjavets-2022": { title: "Do Small Code Changes Merge Faster? A Multi-Language Empirical Investigation", by: "Kudrjavets, Nagappan, and Rastogi, MSR 2022", kind: "Study", url: "https://doi.org/10.1145/3524842.3528448" },
  "perry-2023": { title: "Do Users Write More Insecure Code with AI Assistants?", by: "Perry, Srivastava, Kumar, and Boneh, ACM CCS 2023", kind: "Study", url: "https://doi.org/10.1145/3576915.3623157" },
  "meyer-2014": { title: "Software Developers' Perceptions of Productivity", by: "Meyer, Fritz, Murphy, and Zimmermann, FSE 2014", kind: "Study", url: "https://doi.org/10.1145/2635868.2635892" },
  "mark-2008": { title: "The Cost of Interrupted Work: More Speed and Stress", by: "Mark, Gudith, and Klocke, CHI 2008", kind: "Study", url: "https://doi.org/10.1145/1357054.1357072" },
  "parnin-2011": { title: "Resumption strategies for interrupted programming tasks", by: "Parnin and Rugaber, Software Quality Journal 2011", kind: "Study", url: "https://doi.org/10.1007/s11219-010-9104-9" },
  "eyolfson-2011": { title: "Do Time of Day and Developer Experience Affect Commit Bugginess?", by: "Eyolfson, Tan, and Lam, MSR 2011", kind: "Study", url: "https://doi.org/10.1145/1985441.1985464" },
  "mirsaeedi-2020": { title: "Mitigating Turnover with Code Review Recommendation", by: "Mirsaeedi and Rigby, ICSE 2020", kind: "Study", url: "https://doi.org/10.1145/3377811.3380335" },
});

const SUGGEST_MIN_MERGES = 3;
const SUGGEST_REVIEW_WAIT_HOURS = 24;   // Google's one-business-day guideline, rounded to a day
const SUGGEST_LARGE_LINES = 400;        // median merged lines that count as large
const SUGGEST_STALE_DAYS = 14;
const SUGGEST_WAITING_DAYS = 2;
const SUGGEST_LATE_SHARE = 0.15;
const SUGGEST_CI_SHARE = 0.4;

const lines = (n) => Math.round(n).toLocaleString();
const ageDays = (nowTime, at) => (nowTime - Date.parse(at)) / DAY_MS;

// Each rule returns null when it checked the data and found nothing to suggest, { unavailable } when
// its source did not load, { short } when the sample is below its minimum, or the suggestion.
// `seen` describes the loaded data. Each `why` claim names its source; `act` is what to try.
// Segments are [text, ...reading ids].
const SUGGESTION_RULES = [
  {
    id: "review-before-merge", area: "Review", source: "Pull requests you opened",
    title: "Get a second look before merging",
    check: ({ review }) => {
      if (!review) return { unavailable: "Pull request details did not load." };
      if (review.merged < SUGGEST_MIN_MERGES) return { short: `Needs ${SUGGEST_MIN_MERGES} merged pull requests you opened; ${review.merged} loaded.` };
      if (review.noHuman / review.merged < 0.5) return null;
      const bots = review.botOnly ? ` ${review.botOnly} had only bot reviews.` : "";
      const seen = `${review.noHuman} of your ${plural(review.merged, "merged pull request")} had no review from another person.${bots}`;
      if (!review.reviewers.length) {
        return {
          tone: "warn",
          seen: `${seen} Nobody else reviewed your pull requests in this window.`,
          why: [
            ["GitHub does not let authors approve their own pull requests, so a required approval has to come from someone else.", "gh-approve"],
            ["A required status check works alone: merging waits until the checks you name pass. On GitHub Free, rulesets cover public repositories only.", "gh-rulesets"],
          ],
          act: [["Add a ruleset on your default branch with Require status checks to pass before merging, naming your tests and code scanning, and read the whole diff under Files changed before you merge."]],
        };
      }
      return {
        tone: "warn",
        seen: `${seen}${review.selfMerged ? ` You merged ${review.selfMerged} yourself.` : ""}`,
        why: [["Developers expect review to find defects, but in a study of reviews at Microsoft much of its value came from knowledge transfer, team awareness, and alternative solutions.", "bacchelli-2013"]],
        act: [["Add a ruleset on your default branch with Require a pull request before merging and one required approval.", "gh-rulesets"]],
      };
    },
  },
  {
    id: "review-agent-branches", area: "Review", source: "Pull requests",
    title: "Review agent branches like a colleague's work",
    check: ({ prPatterns: p }) => {
      if (!p) return { unavailable: "Pull request details did not load." };
      const a = p.agent;
      if (a.count < SUGGEST_MIN_MERGES) return { short: `Needs ${SUGGEST_MIN_MERGES} merged agent-branch pull requests; ${a.count} loaded.` };
      const o = p.other;
      const gap = o.count >= SUGGEST_MIN_MERGES && a.unreviewed / a.count - o.unreviewed / o.count >= 0.3;
      if (a.unreviewed / a.count < 0.5 && !gap) return null;
      return {
        tone: "warn",
        seen: `${a.unreviewed} of ${plural(a.count, "agent-branch merge")} had no recorded review${o.count ? `, against ${o.unreviewed} of ${o.count} other merges` : ""}. Agent branches are matched by prefix, such as claude/ or codex/.`,
        why: [
          ["In a controlled study, participants with an AI code assistant wrote less secure code than those without one, and were more likely to believe their code was secure.", "perry-2023"],
          ["GitHub's own coding agent is set up so the person who asked for its pull request cannot approve it.", "gh-copilot-risks"],
        ],
        act: [["Read an agent's diff before merging it, and require tests and code scanning to pass on the default branch.", "gh-rulesets"]],
      };
    },
  },
  {
    id: "faster-first-review", area: "Review", source: "Pull requests you opened",
    title: "Ask for a reviewer when you open the pull request",
    check: ({ review }) => {
      if (!review) return { unavailable: "Pull request details did not load." };
      if (review.withHumanReview < 3) return { short: `Needs 3 of your pull requests with a review from another person; ${review.withHumanReview} loaded.` };
      if (!(review.medianFirstReviewHours >= SUGGEST_REVIEW_WAIT_HOURS)) return null;
      return {
        tone: "info",
        seen: `Your pull requests waited a median of ${durationLabel(review.medianFirstReviewHours)} for a first review from another person, across ${plural(review.withHumanReview, "pull request")}. Time as a draft counts toward the wait.`,
        why: [["Google's review guide sets one business day as the maximum time to respond to a review request.", "google-speed"]],
        act: [["Request a reviewer as you open it, or add a CODEOWNERS file so GitHub requests one automatically. Code owners are not requested on drafts until they are marked ready.", "gh-codeowners"]],
        more: ["chaoss-first-response"],
      };
    },
  },
  {
    id: "spread-reviews", area: "Review", source: "Pull requests you opened",
    title: "Spread reviews beyond one person",
    check: ({ review }) => {
      if (!review) return { unavailable: "Pull request details did not load." };
      if (review.withHumanReview < 4 || !review.reviewers.length) return { short: `Needs 4 of your pull requests with a review from another person; ${review.withHumanReview} loaded.` };
      if (review.topReviewerShare < 0.6) return null;
      const [name, count] = review.reviewers[0];
      return {
        tone: "info",
        seen: `${name} reviewed ${plural(count, "pull request")} of yours, ${share(review.topReviewerShare)} of all reviewer visits.`,
        why: [["Choosing reviewers to spread knowledge, not only by expertise, reduced the files at risk when a developer leaves.", "mirsaeedi-2020"]],
        act: [["Name a second owner for your busiest paths in CODEOWNERS, or, in an organization, have a team assign reviewers by round robin or load balance.", "gh-team-review"]],
      };
    },
  },
  {
    id: "smaller-prs", area: "Pull requests", source: "Pull requests",
    title: "Split large pull requests",
    check: ({ prPatterns: p }) => {
      if (!p) return { unavailable: "Pull request details did not load." };
      if (!p.smaller || !p.larger) return { short: `Needs 6 merged pull requests; ${p.merged} loaded.` };
      const { smaller: s, larger: l } = p;
      const slow = s.medianHours > 0 && l.medianHours != null && l.medianHours / s.medianHours >= 2;
      const big = p.all.medianSize >= SUGGEST_LARGE_LINES;
      if (!slow && !big) return null;
      const skew = Math.abs(l.agent - s.agent) / l.count >= 0.3
        ? ` Agent branches make up ${l.agent} of the larger half and ${s.agent} of the smaller, so branch type may explain part of the gap.` : "";
      const seen = slow
        ? `The larger half of loaded merges (median ${lines(l.medianSize)} lines) took ${durationLabel(l.medianHours)} to merge, the smaller half (${lines(s.medianSize)} lines) ${durationLabel(s.medianHours)}.${skew}`
        : `Loaded merges changed a median of ${lines(p.all.medianSize)} lines.`;
      return {
        tone: "info",
        seen,
        why: [
          ["Google's review guide says small changes are reviewed more quickly and more thoroughly, and are less likely to introduce bugs.", "google-small-cls"],
          ["Across open-source projects the link between size and time to merge is weaker than that advice suggests, so your own numbers are the better guide.", "kudrjavets-2022"],
        ],
        act: [["Split by concern: refactors, renames, and generated files in their own pull requests, and dependent changes stacked one on another."]],
      };
    },
  },
  {
    id: "settle-stale-prs", area: "Pull requests", source: "Pull requests you opened",
    title: "Settle pull requests that have been open for weeks",
    check: ({ prInfo }, { me, nowTime }) => {
      if (!prInfo) return { unavailable: "Pull request details did not load." };
      const stale = Object.values(prInfo).filter((pr) => pr?.title && pr.state === "OPEN" && me && String(pr.author || "").toLowerCase() === me)
        .map((pr) => ({ pr, days: ageDays(nowTime, pr.createdAt) }))
        .filter((r) => r.days >= SUGGEST_STALE_DAYS)
        .sort((a, b) => b.days - a.days);
      if (!stale.length || (stale.length < 2 && stale[0].days < 30)) return null;
      const o = stale[0];
      return {
        tone: "warn",
        seen: `${plural(stale.length, "pull request")} you opened ${stale.length === 1 ? "has" : "have"} been open more than two weeks. Oldest: ${o.pr.repo} #${o.pr.number}${o.pr.isDraft ? " (draft)" : ""}, ${plural(Math.floor(o.days), "day")}.`,
        act: [
          ["Decide each one: merge it, close it with a one-line reason, or convert it to a draft so it stops reading as ready.", "gh-draft"],
          ["Where outside contributors open pull requests, actions/stale can label inactive ones and close them later.", "actions-stale"],
        ],
      };
    },
  },
  {
    id: "agree-before-building", area: "Pull requests", source: "Recent events",
    title: "Agree on the approach before building",
    check: ({ follow }) => {
      if (!follow) return { unavailable: "No events loaded." };
      const { merged, closed } = follow.outcomes;
      const decided = merged + closed;
      if (decided < 4) return { short: `Needs 4 finished pull requests opened in the loaded events; ${decided} found.` };
      if (closed / decided < 0.3) return null;
      const agents = follow.closed.filter((c) => c.agent).length;
      return {
        tone: "info",
        seen: `${closed} of ${plural(decided, "finished pull request")} you opened in the loaded events closed without merging${agents ? `, ${agents} of them from agent branches` : ""}.`,
        act: [["For larger changes, open an issue or a draft pull request first and settle the approach before polishing it.", "gh-draft"]],
      };
    },
  },
  {
    id: "branches-without-prs", area: "Branches", source: "Recent events",
    title: "Open a draft pull request early, or delete the branch",
    check: ({ follow }) => {
      if (!follow) return { unavailable: "No events loaded." };
      if (follow.settled < 4) return { short: `Needs 4 branches created in the loaded events and at least 2 days old; ${follow.settled} found.` };
      const n = follow.withoutPr.length;
      if (n / follow.settled < 0.5) return null;
      const o = follow.withoutPr[0];
      return {
        tone: "info",
        seen: `${n} of ${plural(follow.settled, "branch", "branches")} created in the loaded events have no pull request${follow.agentWithoutPr ? `, ${follow.agentWithoutPr} of them agent branches` : ""}. Oldest: ${o.ref} in ${o.repo}.`,
        act: [
          ["Open a draft pull request once a branch has a direction, so the work is visible.", "gh-draft"],
          ["Delete branches you have abandoned, and turn on Automatically delete head branches so merged ones go too.", "gh-auto-delete"],
        ],
      };
    },
  },
  {
    id: "answer-waiting-threads", area: "Conversations", source: "Conversations",
    title: "Answer replies waiting on your threads",
    check: ({ conversations }, { me, nowTime }) => {
      if (!conversations) return { unavailable: "Conversations did not load." };
      // Items are newest first, so the first item per thread is its latest loaded comment.
      const latest = new Map();
      for (const c of conversations.items) {
        const key = `${c.thread.repo}#${c.thread.number}`;
        if (!latest.has(key)) latest.set(key, c);
      }
      const waiting = [...latest.values()]
        .filter((c) => c.thread.state === "open" && me && String(c.thread.author).toLowerCase() === me && !c.mine && !c.bot)
        .map((c) => ({ c, days: ageDays(nowTime, c.at) }))
        .filter((r) => r.days >= SUGGEST_WAITING_DAYS)
        .sort((a, b) => b.days - a.days);
      if (waiting.length < 2) return null;
      const o = waiting[0];
      return {
        tone: "info",
        seen: `${waiting.length} open issues or pull requests you opened end with a reply from someone else, ${SUGGEST_WAITING_DAYS} or more days old. Oldest: ${o.c.thread.repo} #${o.c.thread.number}, from ${o.c.author}, ${plural(Math.floor(o.days), "day")} ago.`,
        act: [["Reply, resolve, or close each thread. If one no longer needs you, close it with a note so nobody keeps waiting."]],
      };
    },
  },
  {
    id: "batch-by-repo", area: "Focus", source: "Recent events",
    title: "Give each repository its own block of time",
    check: ({ sessions }) => {
      if (!sessions) return { unavailable: "No events loaded." };
      if (sessions.multi < 4) return { short: `Needs 4 work sessions with several events; ${sessions.multi} found.` };
      if (sessions.multiRepo / sessions.multi < 0.5) return null;
      return {
        tone: "info",
        seen: `${sessions.multiRepo} of ${plural(sessions.multi, "work session")} crossed repositories. A session is a run of events with gaps under an hour.`,
        why: [
          ["Developers rated days with few context switches and interruptions as their most productive.", "meyer-2014"],
          ["In a lab study, interrupted people finished as fast but reported more stress, frustration, and time pressure.", "mark-2008"],
        ],
        act: [["Work one repository per block, and batch cross-repository chores such as dependency bumps into one session."]],
      };
    },
  },
  {
    id: "re-entry-notes", area: "Focus", source: "Contribution year",
    title: "Leave yourself a next step before a break",
    check: ({ trajectory: t }) => {
      if (!t) return { unavailable: "The contribution calendar did not load." };
      if (!t.afterActive || !t.afterIdle) return { short: "Needs at least 10 days after active days and 10 after idle days." };
      if (t.afterActive.rate - t.afterIdle.rate < 0.3) return null;
      return {
        tone: "info",
        seen: `After an active day you were active again ${share(t.afterActive.rate)} of the time; after an idle day, ${share(t.afterIdle.rate)}. Restarting is the harder step.`,
        why: [["Programmers resuming interrupted work rarely started editing right away, and relied on notes and other cues to rebuild context.", "parnin-2011"]],
        act: [["Before you stop, write the next concrete step in the issue or pull request, or leave a failing test, so the first move back is obvious."]],
      };
    },
  },
  {
    id: "late-night-review", area: "Focus", source: "Recent events",
    title: "Review late-night changes the next day",
    check: ({ sessions }) => {
      if (!sessions) return { unavailable: "No events loaded." };
      if (sessions.timed < 20) return { short: `Needs 20 timed events; ${sessions.timed} loaded.` };
      if (sessions.lateNight < 5 || sessions.lateNight / sessions.timed < SUGGEST_LATE_SHARE) return null;
      return {
        tone: "info",
        seen: `${share(sessions.lateNight / sessions.timed)} of loaded events (${sessions.lateNight.toLocaleString()}) happened between midnight and 4am, local time.`,
        why: [["In the Linux kernel and PostgreSQL histories, commits made between midnight and 4am were more likely to introduce bugs.", "eyolfson-2011"]],
        act: [["Open late-night work as a draft and read the diff the next day before merging."]],
      };
    },
  },
  {
    id: "ci-notifications", area: "Notifications", source: "Unread notifications",
    title: "Get Actions notifications only for failures",
    check: ({ notes }) => {
      if (!notes) return { unavailable: "Unread notifications need a classic token with the notifications scope." };
      if (notes.unread < 10) return { short: `Needs 10 unread notifications; ${notes.unread} loaded.` };
      if (notes.ciNoise / notes.unread < SUGGEST_CI_SHARE) return null;
      return {
        tone: "info",
        seen: `${notes.ciNoise} of ${plural(notes.unread, "unread notification")} are routine CI updates.`,
        act: [["In GitHub's notification settings, under GitHub Actions, choose Only notify for failed workflows.", "gh-notifications"]],
      };
    },
  },
  {
    id: "labels-not-prefixes", area: "Issues", source: "Recent events",
    title: "Use labels instead of title prefixes",
    check: ({ ev }) => {
      if (!ev) return { unavailable: "No events loaded." };
      const n = sum(ev.tags.map(([, k]) => k));
      if (n < 3) return null;
      return {
        tone: "info",
        seen: `${plural(n, "issue")} you opened in the loaded events start with a bracketed tag: ${ev.tags.slice(0, 3).map(([t]) => `[${t}]`).join(", ")}.`,
        why: [["Labels let you find issues and pull requests by label, for example label:\"bug\".", "gh-labels"]],
        act: [["Create matching labels and apply them instead. An issue form can add existing labels automatically.", "gh-issue-forms"]],
      };
    },
  },
  {
    id: "readme-first-screen", area: "Visibility", source: "Repository traffic",
    title: "Make the README's first screen do the work",
    check: ({ footprint }) => {
      if (!footprint) return { unavailable: "Repository traffic did not load." };
      const quiet = footprint.rows.filter((r) => r.uniques >= FOOTPRINT_MIN_VISITORS && r.stars14 === 0)
        .sort((a, b) => b.uniques - a.uniques);
      if (!quiet.length) return null;
      const o = quiet[0];
      return {
        tone: "info",
        seen: `${o.repo} had ${o.uniques.toLocaleString()} unique visitors in 14 days and no new stars${quiet.length > 1 ? `, and so did ${plural(quiet.length - 1, "other repository", "other repositories")}` : ""}.`,
        why: [["A README is often the first item a visitor will see.", "gh-readme"], ["Topics help other people find and contribute to a project.", "gh-topics"]],
        act: [["Open the README with what the project does, a screenshot or example of it working, and how to start. Then add topics and, for a public repository, a social preview image.", "gh-social-preview"]],
      };
    },
  },
  {
    id: "fine-grained-token", area: "Access", source: "Token check",
    title: "Switch to a read-only fine-grained token",
    check: ({ token }) => {
      if (!token || !token.kind) return { unavailable: "GitHub has not reported the token type." };
      if (token.kind !== "classic") return null;
      if (!token.write) return { unavailable: "GitHub has not reported this token's scopes." };
      if (!token.write.length) return null;
      return {
        tone: "warn",
        seen: `This classic token has ${token.write.length === 1 ? "a scope that allows" : "scopes that allow"} writes: ${token.write.join(", ")}. Activity Desk only reads.`,
        why: [["GitHub recommends fine-grained tokens over classic ones whenever possible.", "gh-pat"]],
        act: [["Create a fine-grained token with only the read permissions in Quick start, sign in with it, and revoke the classic token."]],
      };
    },
  },
];

// Suggestions built on the loaded summaries. Returns the suggestions that apply and, for every rule,
// whether it was shown, found nothing, lacked data, or lacked a source, so the view can say what it checked.
function deriveSuggestions(input) {
  const x = input || {};
  const me = String(x.login || "").toLowerCase();
  const nowTime = x.now == null ? Date.now() : new Date(x.now).getTime();
  const items = [];
  const checked = [];
  for (const rule of SUGGESTION_RULES) {
    const result = rule.check(x, { me, nowTime });
    const base = { id: rule.id, area: rule.area, source: rule.source, title: rule.title };
    if (!result) checked.push({ ...base, status: "clear" });
    else if (result.unavailable) checked.push({ ...base, status: "unavailable", detail: result.unavailable });
    else if (result.short) checked.push({ ...base, status: "short", detail: result.short });
    else {
      // Number the sources in the order the text cites them, then any further reading.
      const cited = [...(result.why || []), ...(result.act || [])].flatMap((segment) => segment.slice(1));
      const reading = [...new Set([...cited, ...(result.more || [])])].filter((id) => Object.hasOwn(READING, id));
      items.push({ ...base, tone: result.tone, seen: result.seen, why: result.why || [], act: result.act || [], reading });
      checked.push({ ...base, status: "shown" });
    }
  }
  const rank = { warn: 0, info: 1 };
  items.sort((a, b) => rank[a.tone] - rank[b.tone]);
  return { items, checked };
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

// ---------- Conversations ----------
// Comments, reviews, and review comments on issues and pull requests that involve the user.
const CONVERSATION_FILTERS = {
  all: () => true,
  others: (c) => !c.mine,
  mine: (c) => c.mine,
  reviews: (c) => c.kind !== "comment",
  bots: (c) => c.bot,
};

function flattenConversations(data, login) {
  const me = String(login || "").toLowerCase();
  const search = data && data.search;
  const nodes = Array.isArray(search?.nodes) ? search.nodes.filter((n) => n && n.repository && Number.isInteger(n.number)) : [];
  const items = [];
  const truncated = { comments: 0, reviews: 0, reviewComments: 0, threads: 0 };
  const person = (author) => {
    const name = author?.login || "ghost";
    return { author: name, bot: author?.__typename === "Bot" || isBotLogin(name), mine: name.toLowerCase() === me };
  };
  for (const n of nodes) {
    const isPr = n.__typename === "PullRequest";
    const raw = String((isPr ? n.prState : n.issueState) || "").toLowerCase();
    const thread = {
      repo: n.repository.nameWithOwner,
      number: n.number,
      title: String(n.title || ""),
      isPr,
      state: isPr && n.merged ? "merged" : raw === "open" ? "open" : "closed",
      author: n.author?.login || "",
    };
    const before = truncated.comments + truncated.reviews + truncated.reviewComments;
    const comments = n.comments?.nodes || [];
    if (n.comments?.totalCount > comments.length) truncated.comments += 1;
    for (const c of comments) if (c) items.push({ kind: "comment", thread, ...person(c.author), at: c.createdAt, body: String(c.bodyText || "") });
    const reviews = n.reviews?.nodes || [];
    if (n.reviews?.totalCount > reviews.length) truncated.reviews += 1;
    for (const r of reviews) {
      if (!r) continue;
      const verdict = String(r.state || "").toLowerCase();
      // A plain COMMENTED review with no body only wraps its inline comments, which are listed below.
      if (r.bodyText || (verdict && verdict !== "commented" && verdict !== "pending")) {
        items.push({ kind: "review", thread, ...person(r.author), at: r.createdAt, body: String(r.bodyText || ""), verdict });
      }
      const inline = r.comments?.nodes || [];
      if (r.comments?.totalCount > inline.length) truncated.reviewComments += 1;
      for (const c of inline) if (c) items.push({ kind: "inline", thread, ...person(c.author), at: c.createdAt, body: String(c.bodyText || ""), path: String(c.path || "") });
    }
    if (truncated.comments + truncated.reviews + truncated.reviewComments > before) truncated.threads += 1;
  }
  const valid = items.filter((c) => Number.isFinite(Date.parse(c.at)));
  valid.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return {
    items: valid,
    threads: nodes.length,
    matched: Number.isInteger(search?.issueCount) ? search.issueCount : nodes.length,
    truncated,
  };
}

function filterConversations(items, filter, repo, query) {
  const f = CONVERSATION_FILTERS[filter] || CONVERSATION_FILTERS.all;
  const q = String(query || "").trim().toLowerCase();
  return (items || []).filter((c) => f(c) && (!repo || c.thread.repo === repo) &&
    (!q || `${c.thread.repo} ${c.thread.title} ${c.author} ${c.body} ${c.path || ""}`.toLowerCase().includes(q)));
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

// ---------- Pull request details, token metadata, and rate limits ----------
// One shape for a pull request from either the authored search or the event-referenced lookup.
// Returns null when GitHub left out the fields the summaries depend on.
function normalizePullRequest(pr, repo, number, source) {
  if (!pr || typeof pr.title !== "string" || !Number.isInteger(pr.reviews?.totalCount)) return null;
  return {
    ...pr, repo, number, source,
    headRef: pr.headRefName, author: pr.author?.login, mergedBy: pr.mergedBy?.login,
    authorBot: pr.author?.__typename === "Bot" || isBotLogin(pr.author?.login),
    reviews: pr.reviews.totalCount,
    reviewList: (Array.isArray(pr.reviews.nodes) ? pr.reviews.nodes : []).map((r) => ({
      login: r?.author?.login || "", at: r?.submittedAt,
      bot: r?.author?.__typename === "Bot" || isBotLogin(r?.author?.login),
    })),
  };
}

// The X-Accepted-GitHub-Permissions value lists the permissions an endpoint needs, comma separated.
// When several sets work, the sets are separated by semicolons.
// Header names that differ from the label on GitHub's token settings page.
const PERMISSION_LABELS = { user_events: "Events (account permission)" };
function parseAcceptedPermissions(header) {
  return String(header || "").split(";").map((set) => set.split(",").map((part) => part.trim()).filter(Boolean).map((part) => {
    const [name, access] = part.split("=").map((x) => x.trim());
    const label = Object.hasOwn(PERMISSION_LABELS, name) ? PERMISSION_LABELS[name] : name.replace(/_/g, " ");
    return `${label.charAt(0).toUpperCase()}${label.slice(1)}${access ? `: ${access}` : ""}`;
  })).filter((set) => set.length);
}

// GitHub can send the expiry of a personal access token, for example "2026-12-01 00:00:00 UTC".
function parseTokenExpiry(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)\s*(UTC|Z|[+-]\d{2}:?\d{2})?$/.exec(text);
  let time;
  if (m) {
    const zone = !m[3] || m[3] === "UTC" || m[3] === "Z" ? "Z" : m[3].replace(/^([+-]\d{2})(\d{2})$/, "$1:$2");
    time = Date.parse(`${m[1]}T${m[2].length === 5 ? `${m[2]}:00` : m[2]}${zone}`);
  } else {
    time = Date.parse(text);
  }
  return Number.isFinite(time) ? new Date(time) : null;
}

const TOKEN_EXPIRY_WARN_DAYS = 14;
function tokenExpiryStatus(expires, now) {
  if (!(expires instanceof Date)) return null;
  const nowTime = now == null ? Date.now() : new Date(now).getTime();
  const days = (expires.getTime() - nowTime) / DAY_MS;
  return { at: expires, days, expired: days <= 0, soon: days > 0 && days <= TOKEN_EXPIRY_WARN_DAYS };
}

// Classic scopes that allow writes. Activity Desk only reads, so these grant more than it uses.
const WRITE_SCOPES = new Set(["repo", "public_repo", "write:org", "admin:org", "workflow", "delete_repo", "write:packages", "admin:repo_hook", "admin:public_key", "admin:gpg_key", "gist", "user", "write:discussion", "project", "codespace"]);
function classicScopes(header) {
  if (header == null) return null;
  const scopes = String(header).split(",").map((s) => s.trim()).filter(Boolean);
  return { scopes, write: scopes.filter((s) => WRITE_SCOPES.has(s)) };
}

const RATE_LABELS = { core: "REST", graphql: "GraphQL" };
const RATE_LOW_SHARE = 0.1;
function summarizeRateLimit(data) {
  const resources = data?.resources || {};
  return Object.keys(RATE_LABELS).filter((name) => resources[name]).map((name) => {
    const r = resources[name];
    const share = r.limit > 0 ? r.remaining / r.limit : null;
    return { name, label: RATE_LABELS[name], limit: r.limit, remaining: r.remaining, used: r.used,
      resetAt: new Date(r.reset * 1000), share, low: share != null && share < RATE_LOW_SHARE };
  });
}

// ---------- Footprint: repository traffic, stars, and saved history ----------
const FOOTPRINT_WEEKS = 13;
const FOOTPRINT_MIN_VISITORS = 20;
const NEW_REFERRER_DAYS = 30;

const sumKnown = (values) => {
  const known = values.filter((v) => Number.isFinite(v));
  return known.length ? sum(known) : null;
};

// fp: { repos, traffic: { repo: { views, clones, referrers } }, stars: { repo: [starred_at] } }
// saved: the main process's saved history for this account, { repos: { repo: { views, clones, counts, referrers } } }
function summarizeFootprint(fp, saved, now) {
  const nowTime = now == null ? Date.now() : new Date(now).getTime();
  const dayKey = (offset) => new Date(nowTime - offset * DAY_MS).toISOString().slice(0, 10);
  const savedRepos = saved?.repos || {};
  const traffic = fp?.traffic || {};
  const starLists = fp?.stars || {};

  const rows = (fp?.repos || []).map((r) => {
    const t = traffic[r.full_name] || {};
    const times = starLists[r.full_name];
    let stars14 = null;
    let stars30 = null;
    let starSource = null;
    if (Array.isArray(times)) {
      const ages = times.map((at) => (nowTime - Date.parse(at)) / DAY_MS).filter(Number.isFinite);
      stars14 = ages.filter((a) => a >= 0 && a < 14).length;
      stars30 = ages.filter((a) => a >= 0 && a < 30).length;
      starSource = "timestamps";
    } else {
      // Without timestamps, compare with the saved count from 30 or more days ago.
      const counts = savedRepos[r.full_name]?.counts || {};
      const past = Object.keys(counts).filter((d) => d <= dayKey(30)).sort().pop();
      if (past && Number.isFinite(r.stargazers_count)) {
        stars30 = r.stargazers_count - counts[past][0];
        starSource = "history";
      }
    }
    return {
      repo: r.full_name, private: r.private, stars: r.stargazers_count, forks: r.forks_count,
      views: t.views?.count ?? null, uniques: t.views?.uniques ?? null,
      clones: t.clones?.count ?? null, cloners: t.clones?.uniques ?? null,
      stars14, stars30, starSource,
    };
  });

  const totals = {
    views: sumKnown(rows.map((r) => r.views)),
    uniques: sumKnown(rows.map((r) => r.uniques)),
    clones: sumKnown(rows.map((r) => r.clones)),
    cloners: sumKnown(rows.map((r) => r.cloners)),
    withTraffic: rows.filter((r) => r.views != null).length,
  };

  // Daily views across repositories: saved days first, then today's 14-day response on top.
  const daily = new Map();
  let firstSaved = null;
  for (const r of rows) {
    const merged = { ...(savedRepos[r.repo]?.views || {}) };
    for (const d of traffic[r.repo]?.views?.views || []) {
      const day = String(d?.timestamp || "").slice(0, 10);
      if (day && Number.isFinite(d.count)) merged[day] = [d.count, d.uniques];
    }
    for (const [day, [n]] of Object.entries(merged)) {
      daily.set(day, (daily.get(day) || 0) + n);
      if (!firstSaved || day < firstSaved) firstSaved = day;
    }
  }
  const weeks = [];
  for (let w = FOOTPRINT_WEEKS - 1; w >= 0; w -= 1) {
    let n = 0;
    let known = false;
    for (let d = 0; d < 7; d += 1) {
      const day = dayKey(w * 7 + d);
      if (daily.has(day)) { n += daily.get(day); known = true; }
      else if (firstSaved && day >= firstSaved) known = true; // GitHub omits days with no views
    }
    weeks.push({ start: dayKey(w * 7 + 6), count: n, known });
  }
  const coveredDays = firstSaved ? Math.floor((nowTime - Date.parse(`${firstSaved}T00:00:00Z`)) / DAY_MS) + 1 : 0;
  let trend = null;
  if (coveredDays >= 56) {
    const range = (from, to) => { let n = 0; for (let d = from; d < to; d += 1) n += daily.get(dayKey(d)) || 0; return n; };
    const last = range(0, 28);
    const prev = range(28, 56);
    trend = { last, prev, change: prev ? (last - prev) / prev : null };
  }

  // Where visitors come from in the current 14-day window, summed across repositories.
  const refMap = new Map();
  for (const r of rows) {
    for (const x of traffic[r.repo]?.referrers || []) {
      if (typeof x?.referrer !== "string") continue;
      const cur = refMap.get(x.referrer) || { referrer: x.referrer, count: 0, uniques: 0, repos: 0 };
      cur.count += x.count || 0;
      cur.uniques += x.uniques || 0;
      cur.repos += 1;
      refMap.set(x.referrer, cur);
    }
  }
  const referrers = [...refMap.values()].sort((a, b) => b.count - a.count);

  // Referrers first seen recently. A sighting counts only when saved history began at least
  // 14 days earlier, so the first refresh does not report every referrer as new.
  let historyStart = null;
  for (const entry of Object.values(savedRepos)) {
    for (const series of [entry.views, entry.clones, entry.counts]) {
      for (const day of Object.keys(series || {})) if (!historyStart || day < historyStart) historyStart = day;
    }
    for (const seen of Object.values(entry.referrers || {})) if (!historyStart || seen.first < historyStart) historyStart = seen.first;
  }
  const newReferrers = [];
  for (const [repo, entry] of Object.entries(savedRepos)) {
    for (const [name, seen] of Object.entries(entry.referrers || {})) {
      const lead = historyStart ? (Date.parse(seen.first) - Date.parse(historyStart)) / DAY_MS : 0;
      if (seen.first >= dayKey(NEW_REFERRER_DAYS) && lead >= 14) newReferrers.push({ referrer: name, repo, first: seen.first, peak: seen.peak });
    }
  }
  newReferrers.sort((a, b) => b.first.localeCompare(a.first));

  const findings = [];
  const add = (tone, title, detail) => findings.push({ tone, source: "Repository traffic", title, detail });
  const pctText = (x) => `${Math.round(x * 100)}%`;
  const ranked = rows.filter((r) => r.views).sort((a, b) => b.views - a.views);
  if (totals.views >= FOOTPRINT_MIN_VISITORS && ranked.length > 1 && ranked[0].views / totals.views >= 0.6) {
    add("info", `${ranked[0].repo} drew ${pctText(ranked[0].views / totals.views)} of page views`,
      `${ranked[0].views.toLocaleString()} of ${totals.views.toLocaleString()} views across ${totals.withTraffic} repositories in the last 14 days. One repository carries most of your visible footprint.`);
  }
  const starred = rows.filter((r) => r.starSource === "timestamps" && r.uniques != null);
  const starVisitors = sum(starred.map((r) => r.uniques));
  if (starVisitors >= FOOTPRINT_MIN_VISITORS) {
    const gained = sum(starred.map((r) => r.stars14));
    add("info", `${(gained / starVisitors * 100).toFixed(1)} new stars per 100 unique visitors`,
      `${gained} stars in the last 14 days against ${starVisitors.toLocaleString()} unique visitors, summed per repository, across ${starred.length} ${starred.length === 1 ? "repository" : "repositories"} with star dates. A person who visits two repositories counts twice.`);
  }
  for (const r of rows) {
    if (r.uniques >= FOOTPRINT_MIN_VISITORS && r.stars14 === 0) {
      add("warn", `${r.repo} had ${r.uniques} unique visitors and no new stars`,
        "Visitors arrived in the last 14 days but none starred it. The README and first screen are what they saw.");
    }
    if (r.cloners != null && r.uniques != null && r.cloners >= 10 && r.cloners > r.uniques * 2) {
      add("info", `${r.repo} has more cloners than visitors`,
        `${r.cloners} unique cloners against ${r.uniques} unique visitors in 14 days. Clones that skip the page usually come from automation such as CI, mirrors, or package tools.`);
    }
  }
  if (trend && trend.prev >= FOOTPRINT_MIN_VISITORS && trend.change != null && Math.abs(trend.change) >= 0.25) {
    add(trend.change > 0 ? "good" : "warn", `Page views ${trend.change > 0 ? "rose" : "fell"} ${pctText(Math.abs(trend.change))} over four weeks`,
      `${trend.last.toLocaleString()} views in the last 28 days against ${trend.prev.toLocaleString()} in the 28 before, from saved history.`);
  }
  if (newReferrers.length) {
    add("good", `${newReferrers.length} new ${newReferrers.length === 1 ? "referrer" : "referrers"} in the last ${NEW_REFERRER_DAYS} days`,
      newReferrers.slice(0, 4).map((x) => `${x.referrer} → ${x.repo.split("/")[1]} (${x.first})`).join(", "));
  }

  return { rows, totals, weeks, coveredDays, firstSaved, trend, referrers, newReferrers, historyStart, findings };
}

// ---------- Contribution history across calendar years ----------
const HISTORY_MIN_YEAR_TOTAL = 50;
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// byYear: { [year]: contributionsCollection for that calendar year }. todayKey: local YYYY-MM-DD.
function summarizeContributionHistory(byYear, todayKey, createdAt) {
  const thisYear = Number(String(todayKey).slice(0, 4));
  const createdYear = createdAt ? new Date(createdAt).getUTCFullYear() : null;
  const years = [];
  const allDays = [];
  for (const [key, c] of Object.entries(byYear || {})) {
    const year = Number(key);
    const days = [];
    for (const week of c?.contributionCalendar?.weeks || []) {
      for (const d of week.contributionDays || []) {
        if (typeof d?.date === "string" && d.date.startsWith(`${year}-`) && d.date <= todayKey && Number.isFinite(d.contributionCount)) days.push(d);
      }
    }
    days.sort((a, b) => a.date.localeCompare(b.date));
    let run = 0;
    let longest = 0;
    const monthly = Array(12).fill(0);
    const weekday = Array(7).fill(0);
    for (const d of days) {
      run = d.contributionCount > 0 ? run + 1 : 0;
      longest = Math.max(longest, run);
      monthly[Number(d.date.slice(5, 7)) - 1] += d.contributionCount;
      weekday[new Date(`${d.date}T00:00:00Z`).getUTCDay()] += d.contributionCount;
    }
    const total = days.reduce((a, d) => a + d.contributionCount, 0);
    allDays.push(...days);
    years.push({
      year, total, days: days.length,
      activeDays: days.filter((d) => d.contributionCount > 0).length,
      longestStreak: longest,
      commits: c?.totalCommitContributions || 0,
      prs: c?.totalPullRequestContributions || 0,
      issues: c?.totalIssueContributions || 0,
      reviews: c?.totalPullRequestReviewContributions || 0,
      restricted: c?.restrictedContributionsCount || 0,
      monthly, weekday,
      weekendShare: total ? (weekday[0] + weekday[6]) / total : null,
      // A full year: before this year, and not the year the account was created.
      complete: year < thisYear && (createdYear == null || year > createdYear),
      partial: year === thisYear,
    });
  }
  years.sort((a, b) => a.year - b.year);
  allDays.sort((a, b) => a.date.localeCompare(b.date));

  // Records across years, so a streak that crosses New Year counts once.
  let run = 0;
  let runStart = null;
  let bestRun = { days: 0, start: null, end: null };
  let lastActive = null;
  let bestGap = { days: 0, start: null, end: null };
  let prevTime = null;
  for (const d of allDays) {
    const time = Date.parse(`${d.date}T00:00:00Z`);
    if (prevTime != null && time - prevTime !== DAY_MS) run = 0;
    prevTime = time;
    if (d.contributionCount > 0) {
      if (run === 0) runStart = d.date;
      run += 1;
      if (run > bestRun.days) bestRun = { days: run, start: runStart, end: d.date };
      if (lastActive) {
        const gap = Math.round((time - Date.parse(`${lastActive}T00:00:00Z`)) / DAY_MS) - 1;
        if (gap > bestGap.days) bestGap = { days: gap, start: lastActive, end: d.date };
      }
      lastActive = d.date;
    } else run = 0;
  }
  const busiestDay = allDays.reduce((best, d) => (!best || d.contributionCount > best.contributionCount ? d : best), null);

  // Year to date against the same date last year.
  const current = years.find((y) => y.year === thisYear);
  const last = years.find((y) => y.year === thisYear - 1);
  let pace = null;
  if (current && last && last.days) {
    const cutoff = `${thisYear - 1}${String(todayKey).slice(4)}`;
    const lastYtd = allDays.filter((d) => d.date.startsWith(`${thisYear - 1}-`) && d.date <= cutoff).reduce((a, d) => a + d.contributionCount, 0);
    pace = { ytd: current.total, lastYtd, change: lastYtd ? (current.total - lastYtd) / lastYtd : null };
  }

  // Seasonality across full years: each year's monthly share, averaged, so a big year does not dominate.
  const full = years.filter((y) => y.complete && y.total >= HISTORY_MIN_YEAR_TOTAL);
  let seasons = null;
  if (full.length >= 2) {
    const share = Array.from({ length: 12 }, (_, m) => sum(full.map((y) => y.monthly[m] / y.total)) / full.length);
    const peak = share.indexOf(Math.max(...share));
    const low = share.indexOf(Math.min(...share));
    const peakYears = full.filter((y) => {
      const ranked = y.monthly.map((n, m) => [n, m]).sort((a, b) => b[0] - a[0]).slice(0, 3).map(([, m]) => m);
      return ranked.includes(peak);
    }).length;
    seasons = { share, peak, low, years: full.length, peakYears };
  }

  const findings = [];
  const add = (tone, title, detail) => findings.push({ tone, source: "Contribution history", title, detail });
  const pctText = (x) => `${Math.round(Math.abs(x) * 100)}%`;
  if (pace && pace.change != null && pace.lastYtd >= HISTORY_MIN_YEAR_TOTAL && Math.abs(pace.change) >= 0.1) {
    add(pace.change > 0 ? "good" : "warn", `${pctText(pace.change)} ${pace.change > 0 ? "ahead of" : "behind"} last year's pace`,
      `${pace.ytd.toLocaleString()} contributions so far this year against ${pace.lastYtd.toLocaleString()} by the same date last year.`);
  }
  const ranked = full.slice().sort((a, b) => b.total - a.total);
  if (ranked.length >= 2) {
    add("info", `${ranked[0].year} was your busiest full year`,
      `${ranked[0].total.toLocaleString()} contributions on ${ranked[0].activeDays} active days. The next was ${ranked[1].year} with ${ranked[1].total.toLocaleString()}.`);
  }
  const lastTwo = full.slice(-2);
  if (lastTwo.length === 2) {
    const [a, b] = lastTwo;
    const change = (b.total - a.total) / a.total;
    if (Math.abs(change) >= 0.25) {
      add(change > 0 ? "good" : "info", `${b.year} ${change > 0 ? "grew" : "fell"} ${pctText(change)} on ${a.year}`,
        `${b.total.toLocaleString()} contributions against ${a.total.toLocaleString()}. Active days went from ${a.activeDays} to ${b.activeDays}.`);
    }
  }
  if (seasons && seasons.share[seasons.peak] >= 0.13 && seasons.peakYears * 2 >= seasons.years) {
    add("info", `${MONTH_NAMES[seasons.peak]} is your strongest month`,
      `It averaged ${pctText(seasons.share[seasons.peak])} of each full year's contributions across ${seasons.years} years, and was a top-three month in ${seasons.peakYears} of them. An even spread would be 8%.`);
  }
  const weekendYears = full.filter((y) => y.total >= 100 && y.weekendShare != null);
  if (weekendYears.length >= 2) {
    const first = weekendYears[0];
    const latest = weekendYears.at(-1);
    const shift = latest.weekendShare - first.weekendShare;
    if (Math.abs(shift) >= 0.15) {
      add("info", `Weekend work ${shift > 0 ? "rose" : "fell"} from ${pctText(first.weekendShare)} to ${pctText(latest.weekendShare)}`,
        `Share of contributions on Saturdays and Sundays in ${first.year} against ${latest.year}.`);
    }
  }
  if (bestRun.days >= 7) {
    add("info", `Longest streak: ${bestRun.days} days`, `From ${bestRun.start} to ${bestRun.end}, across every year loaded.`);
  }

  return { years, bestRun, bestGap, busiestDay, pace, seasons, findings,
    restricted: sum(years.map((y) => y.restricted)), total: sum(years.map((y) => y.total)) };
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
  flattenConversations,
  filterConversations,
  CONVERSATION_FILTERS,
  deriveObservations,
  deriveSuggestions,
  READING,
  durationLabel,
  filterEvents,
  isMinor,
  normalizePullRequest,
  parseAcceptedPermissions,
  parseTokenExpiry,
  tokenExpiryStatus,
  classicScopes,
  summarizeRateLimit,
  summarizeFootprint,
  summarizeContributionHistory,
  summarizeCollaboration,
};

if (typeof module !== "undefined" && module.exports) module.exports = api;
if (typeof window !== "undefined") window.DeskInsights = api;
})();
