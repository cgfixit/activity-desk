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

// Plain-language findings. Each names its source, and each needs a minimum sample before it appears.
function deriveObservations({ rhythm, sessions, prs }) {
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
  deriveObservations,
  durationLabel,
  filterEvents,
  isMinor,
};

if (typeof module !== "undefined" && module.exports) module.exports = api;
if (typeof window !== "undefined") window.DeskInsights = api;
})();
