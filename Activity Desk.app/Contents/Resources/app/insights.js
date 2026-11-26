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

// The value a share q of the finite values fall at or below, interpolating between ranks.
function quantile(values, q) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const pos = (v.length - 1) * q;
  const lo = Math.floor(pos);
  return v[lo] + (v[Math.min(lo + 1, v.length - 1)] - v[lo]) * (pos - lo);
}

// ---------- Chance checks ----------
// A fixed seed, so a check gives the same answer on every refresh of the same data.
const CHANCE_SHUFFLES = 999;
const CHANCE_P = 0.05;
function seededRandom() {
  let seed = 1;
  return () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
}
function shuffleInPlace(list, random) {
  for (let i = list.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

// How often the same values, dealt into two groups of the same sizes at random, show a gap in the
// statistic at least as large as the real grouping does. Near 0: the grouping matters. Large: it may not.
function permutationP(a, b, stat) {
  const observed = Math.abs(stat(a, b));
  if (!Number.isFinite(observed)) return null;
  const pool = [...a, ...b];
  const random = seededRandom();
  let asLarge = 0;
  for (let round = 0; round < CHANCE_SHUFFLES; round += 1) {
    shuffleInPlace(pool, random);
    if (Math.abs(stat(pool.slice(0, a.length), pool.slice(a.length))) >= observed - RATIO_EPSILON) asLarge += 1;
  }
  return (asLarge + 1) / (CHANCE_SHUFFLES + 1);
}

// Ranks from 1, with tied values sharing the average of their ranks.
function ranks(values) {
  const order = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const out = Array(values.length);
  for (let i = 0; i < order.length;) {
    let j = i;
    while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j += 1;
    for (let k = i; k <= j; k += 1) out[order[k][1]] = (i + j) / 2 + 1;
    i = j + 1;
  }
  return out;
}
function pearson(x, y) {
  const mx = sum(x) / x.length;
  const my = sum(y) / y.length;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < x.length; i += 1) {
    sxy += (x[i] - mx) * (y[i] - my);
    sxx += (x[i] - mx) ** 2;
    syy += (y[i] - my) ** 2;
  }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
}

// Spearman's rank correlation, with how often shuffling y against x matches or beats it.
// Ranks make it robust to the long tail that merge times and change sizes both have.
function rankCorrelation(x, y) {
  const rx = ranks(x);
  const ry = ranks(y);
  const rho = pearson(rx, ry);
  if (rho == null) return null;
  const random = seededRandom();
  const shuffled = ry.slice();
  let asLarge = 0;
  for (let round = 0; round < CHANCE_SHUFFLES; round += 1) {
    if (Math.abs(pearson(rx, shuffleInPlace(shuffled, random))) >= Math.abs(rho) - RATIO_EPSILON) asLarge += 1;
  }
  return { rho, n: x.length, p: (asLarge + 1) / (CHANCE_SHUFFLES + 1) };
}

// Wording for a permutation p value: lead names the shuffle, thing the result it matched. `clear` is
// the verdict of the page's shared chance budget when there is one; without it, p is held to 5%.
function chanceNote(p, lead, thing, clear = p != null && p < CHANCE_P) {
  if (p == null) return "";
  const often = share(p) === "0%" ? "under 1%" : share(p);
  if (clear) return ` ${lead} match ${thing} ${often === "under 1%" ? often : `only ${often}`} of the time.`;
  return p < CHANCE_P
    ? ` ${lead} match ${thing} only ${often} of the time, which does not clear the bar shared by every chance check on this page.`
    : ` ${lead} match ${thing} ${often} of the time, so it may be chance.`;
}
const GROUP_CHANCE = ["Random regroupings of the same merges", "a gap this large"];

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
// Whether a record knows its size and its reviews. Records from the public search know neither.
const sized = (pr) => Number.isFinite(pr.additions) && Number.isFinite(pr.deletions);
const reviewsKnown = (pr) => Number.isInteger(pr.reviews);
function summarizePullRequests(prInfo, login) {
  const rows = Object.values(prInfo || {}).filter((pr) => pr?.title);
  const merged = rows.filter((pr) => pr.merged);
  // Public search records carry no reviews or sizes; those are unknown, not zero, and are left out.
  const unreviewed = merged.filter((pr) => pr.reviews === 0);
  const selfMerged = merged.filter((pr) => pr.author && pr.mergedBy && pr.author === pr.mergedBy);
  const hoursToMerge = merged
    .map((pr) => (Date.parse(pr.mergedAt) - Date.parse(pr.createdAt)) / 36e5)
    .filter((h) => Number.isFinite(h) && h >= 0);
  const sizes = rows.filter(sized).map((pr) => pr.additions + pr.deletions);
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
    largest: rows.filter(sized).sort((a, b) => (b.additions + b.deletions) - (a.additions + a.deletions)).slice(0, 3),
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
// Differences of two ratios carry float error (0.7 - 0.4 is 0.29999...), so thresholds on them allow for it.
const RATIO_EPSILON = 1e-9;
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
  let lateNight = 0; // midnight to 4am local time, the late-night window in Eyolfson et al.

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
const CORRELATION_MIN_MERGES = 8;
function summarizePrPatterns(prInfo, now) {
  const rows = Object.values(prInfo || {}).filter((pr) => pr?.title);
  const size = (pr) => (pr.additions || 0) + (pr.deletions || 0);
  const toMerge = (pr) => (Date.parse(pr.mergedAt) - Date.parse(pr.createdAt)) / 36e5;
  const timedHours = (list) => list.map(toMerge).filter((h) => Number.isFinite(h) && h >= 0);
  const group = (list) => ({
    count: list.length,
    medianHours: median(timedHours(list)),
    p75Hours: list.length >= 4 ? quantile(timedHours(list), 0.75) : null,
    unreviewed: list.filter((pr) => pr.reviews === 0).length,
    medianSize: median(list.filter(sized).map(size)),
    agent: list.filter((pr) => agentFromBranch(pr.headRef)).length,
  });
  const merged = rows.filter((pr) => pr.merged);
  // Size and review comparisons use only the merges that know them.
  const mergedSized = merged.filter(sized);
  const agentMerged = merged.filter((pr) => agentFromBranch(pr.headRef));
  const otherMerged = merged.filter((pr) => !agentFromBranch(pr.headRef));
  const agentHours = timedHours(agentMerged);
  const otherHours = timedHours(otherMerged);
  const timed = merged.filter((pr) => Number.isFinite(toMerge(pr)) && toMerge(pr) >= 0);
  const ref = (pr) => ({ repo: pr.repo, number: pr.number, lines: size(pr), agent: Boolean(agentFromBranch(pr.headRef)) });
  const bySizeDesc = (list) => list.slice().sort((a, b) => size(b) - size(a) || String(a.repo).localeCompare(String(b.repo)) || a.number - b.number);
  const bySize = mergedSized.slice().sort((a, b) => size(a) - size(b));
  const half = Math.floor(bySize.length / 2);
  const mergedLines = sum(mergedSized.map(size));
  const nowTime = now == null ? Date.now() : new Date(now).getTime();
  const open = rows.filter((pr) => pr.state === "OPEN")
    .map((pr) => ({ repo: pr.repo, number: pr.number, days: (nowTime - Date.parse(pr.createdAt)) / DAY_MS }))
    .filter((pr) => Number.isFinite(pr.days) && pr.days >= 0)
    .sort((a, b) => b.days - a.days);
  return {
    merged: merged.length,
    all: group(merged),
    agent: group(agentMerged),
    other: group(otherMerged),
    // Whether agent-branch merges rank faster or slower than the rest beyond random regrouping: a
    // Mann-Whitney comparison by permutation. Medians are a poor statistic here, since with three tied
    // values per group almost every regrouping moves them as far as the real one.
    agentGapP: agentHours.length >= 3 && otherHours.length >= 3 ? (() => {
      const r = ranks([...agentHours, ...otherHours]);
      const mean = (x) => sum(x) / x.length;
      return permutationP(r.slice(0, agentHours.length), r.slice(agentHours.length), (x, y) => mean(x) - mean(y));
    })() : null,
    // The same check for the share of merges with zero recorded reviews.
    agentReviewP: agentMerged.filter(reviewsKnown).length >= 3 && otherMerged.filter(reviewsKnown).length >= 3 ? permutationP(
      agentMerged.filter(reviewsKnown).map((pr) => (pr.reviews ? 0 : 1)), otherMerged.filter(reviewsKnown).map((pr) => (pr.reviews ? 0 : 1)),
      (x, y) => sum(x) / x.length - sum(y) / y.length) : null,
    // Size against time to merge across every timed merge, by rank.
    sizeVsTime: timed.filter(sized).length >= CORRELATION_MIN_MERGES ? rankCorrelation(timed.filter(sized).map(size), timed.filter(sized).map(toMerge)) : null,
    largest: bySizeDesc(mergedSized).slice(0, 3).map(ref),
    largestUnreviewed: bySizeDesc(mergedSized.filter((pr) => pr.reviews === 0)).slice(0, 3).map(ref),
    largestUnreviewedAgent: bySizeDesc(agentMerged.filter((pr) => sized(pr) && pr.reviews === 0)).slice(0, 3).map(ref),
    // An odd middle PR is left out so both halves hold the same number.
    smaller: half >= 3 ? group(bySize.slice(0, half)) : null,
    larger: half >= 3 ? group(bySize.slice(-half)) : null,
    mergedLines,
    unreviewedLines: sum(mergedSized.filter((pr) => pr.reviews === 0).map(size)),
    // How many merges know their size and their reviews. Public search records know neither.
    sizedMerged: mergedSized.length,
    reviewedKnown: merged.filter(reviewsKnown).length,
    open: open.length,
    oldestOpen: open[0] || null,
    stale: open.filter((pr) => pr.days >= STALE_PR_DAYS).length,
  };
}

const TRAJECTORY_MIN_WEEKS = 6;
const TRAJECTORY_SHUFFLES = 999;
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
      // How often a shuffled year splits at least as cleanly, counted like the other chance checks.
      p: (TRAJECTORY_SHUFFLES - beaten + 1) / (TRAJECTORY_SHUFFLES + 1),
      big: diff !== 0 && Math.abs(diff) / Math.max(best.before, best.after) >= TRAJECTORY_MIN_CHANGE,
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
  // Outcomes need no reviews, so they count every pull request you opened, public search records too.
  const opened = Object.values(prInfo || {}).filter((pr) => pr?.title && me && String(pr.author || "").toLowerCase() === me);
  const firstHuman = (pr) => pr.reviewList
    .filter((r) => !r.bot && r.login && r.login.toLowerCase() !== String(pr.author || "").toLowerCase() && Number.isFinite(Date.parse(r.at)))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))[0];

  // Review verdicts arrive as states such as approved or changes_requested. Older loads lack them,
  // and then the approval counts below are null rather than zero.
  const states = authored.length > 0 && authored.every((pr) => pr.reviewList.every((r) => typeof r.state === "string"));
  const humanBy = (pr, state) => pr.reviewList.filter((r) => !r.bot && r.login && r.login.toLowerCase() !== String(pr.author || "").toLowerCase() &&
    r.state === state && Number.isFinite(Date.parse(r.at)));

  const waits = [];
  const approvalWaits = [];
  const clocks = clockCounts();
  let reviewedBeforeMerge = 0;
  let approvedBeforeMerge = 0;
  let changesRequested = 0;
  const repos = new Map();
  for (const pr of authored) {
    if (!repos.has(pr.repo)) repos.set(pr.repo, { repo: pr.repo, authored: 0, merged: 0, noHuman: 0, approved: 0, waits: [] });
    const row = repos.get(pr.repo);
    row.authored += 1;
    if (pr.merged) row.merged += 1;
    if (states) {
      const approvals = humanBy(pr, "approved").sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
      if (approvals.length) {
        const h = (Date.parse(approvals[0].at) - Date.parse(reviewClock(pr, approvals[0].at).start)) / 36e5;
        if (Number.isFinite(h) && h >= 0) approvalWaits.push(h);
      }
      if (pr.merged && approvals.some((r) => Date.parse(r.at) <= Date.parse(pr.mergedAt))) {
        approvedBeforeMerge += 1;
        row.approved += 1;
      }
      if (humanBy(pr, "changes_requested").length) changesRequested += 1;
    }
    const first = firstHuman(pr);
    if (!first) {
      if (pr.merged) row.noHuman += 1;
      continue;
    }
    // The wait runs from when the pull request was ready for review, so time as a draft is left out.
    const clock = reviewClock(pr, first.at);
    const hours = (Date.parse(first.at) - Date.parse(clock.start)) / 36e5;
    if (Number.isFinite(hours) && hours >= 0) {
      waits.push(hours);
      row.waits.push(hours);
      clocks[clock.from] += 1;
    }
    if (pr.merged && Date.parse(first.at) <= Date.parse(pr.mergedAt)) reviewedBeforeMerge += 1;
  }

  const merged = authored.filter((pr) => pr.merged);
  const botOnly = merged.filter((pr) => pr.reviewList.length && pr.reviewList.every((r) => r.bot));
  const noHuman = merged.filter((pr) => !firstHuman(pr));
  const selfMerged = merged.filter((pr) => pr.mergedBy && pr.mergedBy.toLowerCase() === me);
  // Current state of every pull request you opened that loaded. The authored search covers the whole
  // window, so this is a fuller sample than pull requests opened inside the Events feed.
  const closedUnmerged = opened.filter((pr) => !pr.merged && pr.state === "CLOSED");
  const byRepo = [...repos.values()].map(({ waits: w, ...r }) => ({ ...r, timed: w.length, medianFirstReviewHours: median(w) }))
    .sort((a, b) => b.merged - a.merged || b.authored - a.authored || a.repo.localeCompare(b.repo));

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
    // The slowest quarter of waits starts here. Shown from four waits up.
    p75FirstReviewHours: waits.length >= 4 ? quantile(waits, 0.75) : null,
    // How many waits started when a draft was marked ready, and how many when the pull request opened.
    clocks,
    // Pull requests whose timeline could not be read, so a draft's time counts toward their wait.
    noTimeline: authored.filter((pr) => pr.requests === null).length,
    states,
    approved: states ? approvalWaits.length : null,
    medianFirstApprovalHours: states ? median(approvalWaits) : null,
    approvedBeforeMerge: states ? approvedBeforeMerge : null,
    changesRequested: states ? changesRequested : null,
    outcomes: { merged: opened.filter((pr) => pr.merged).length, closed: closedUnmerged.length, open: opened.filter((pr) => pr.state === "OPEN").length },
    closed: closedUnmerged.map((pr) => ({ repo: pr.repo, number: pr.number, agent: Boolean(agentFromBranch(pr.headRef)) })),
    byRepo,
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

// ---------- Outcomes ----------
// What happened to the user's pull requests, as opposed to how they were handled: whether a merge
// needed a follow-up fix, whether open work piled up, and whether slow pull requests merged at all.
const REWORK_HOURS = 72;        // a follow-up must open this soon after a merge to count against it
const REWORK_MIN_SETTLED = 5;   // merges old enough to have had a follow-up, before a finding
const REWORK_MIN_GROUP = 4;     // merges on each side before two groups are compared
const REWORK_RATE = 0.2;
const BASELINE_MIN_MERGES = 6;  // merges before the user's own merge times set a baseline
const OVERDUE_FLOOR_HOURS = 24; // an open pull request younger than this is never called overdue
const FLOW_PEAK = 5;            // open at once before the peak is worth a finding
const SPLIT_MIN_MERGES = 6;     // merges with a last-commit time before work and waiting are split
// A title that reads as a fix or a revert, allowing one leading [tag] and conventional "fix(scope):".
const FIX_TITLE = /^\s*(?:\[[^\]]{1,40}\]\s*)?(?:fix(?:es|ed)?|hotfix|bugfix|revert(?:s|ed)?|roll\s?back)\b/i;

function summarizeOutcomes(prInfo, login, now) {
  const me = String(login || "").toLowerCase();
  const nowTime = now == null ? Date.now() : new Date(now).getTime();
  const rows = Object.values(prInfo || {}).filter((pr) => pr?.title);
  const start = (pr) => Date.parse(pr.createdAt);
  const mergedAt = (pr) => Date.parse(pr.mergedAt);
  const size = (pr) => (pr.additions || 0) + (pr.deletions || 0);
  const mine = rows.filter((pr) => me && String(pr.author || "").toLowerCase() === me && Number.isFinite(start(pr)));
  const merged = mine.filter((pr) => pr.merged && Number.isFinite(mergedAt(pr)) && mergedAt(pr) >= start(pr));
  const hours = (pr) => (mergedAt(pr) - start(pr)) / 36e5;

  // ----- Follow-up fixes -----
  // A follow-up is any loaded pull request in the same repository that opens within the window after
  // a merge and is titled as a fix or revert. One that names a merge by number or quoted title counts
  // against that merge; otherwise it counts against the nearest merge before it, and only that one.
  const byRepo = new Map();
  for (const pr of merged) {
    if (!byRepo.has(pr.repo)) byRepo.set(pr.repo, []);
    byRepo.get(pr.repo).push(pr);
  }
  for (const list of byRepo.values()) list.sort((a, b) => mergedAt(a) - mergedAt(b));
  const hit = new Map();
  for (const f of rows) {
    const opened = start(f);
    if (!FIX_TITLE.test(f.title) || !Number.isFinite(opened)) continue;
    const before = (byRepo.get(f.repo) || []).filter((m) => m !== f && mergedAt(m) < opened && opened - mergedAt(m) <= REWORK_HOURS * 36e5);
    if (!before.length) continue;
    const named = before.find((m) => (Number.isInteger(m.number) && new RegExp(`#${m.number}(?!\\d)`).test(f.title)) || f.title.includes(`"${m.title}"`));
    const target = named || before[before.length - 1];
    const key = prKey(target.repo, target.number);
    const found = { number: f.number, hours: (opened - mergedAt(target)) / 36e5, named: Boolean(named) };
    if (!hit.has(key) || found.hours < hit.get(key).hours) hit.set(key, found);
  }
  // A merge younger than the window has not had its chance to be followed, so it is left out.
  const settled = merged.filter((pr) => nowTime - mergedAt(pr) >= REWORK_HOURS * 36e5);
  const isFollowed = (pr) => hit.has(prKey(pr.repo, pr.number));
  const followed = settled.filter(isFollowed);
  const flag = (pr) => (isFollowed(pr) ? 1 : 0);
  const rateGap = (x, y) => sum(x) / x.length - sum(y) / y.length;
  // `known` limits a comparison to the merges that carry what it splits on, such as size or reviews.
  const compare = (key, aLabel, bLabel, inA, known = () => true) => {
    const a = settled.filter((pr) => known(pr) && inA(pr));
    const b = settled.filter((pr) => known(pr) && !inA(pr));
    return {
      key,
      a: { label: aLabel, n: a.length, followed: a.filter(isFollowed).length },
      b: { label: bLabel, n: b.length, followed: b.filter(isFollowed).length },
      p: a.length >= REWORK_MIN_GROUP && b.length >= REWORK_MIN_GROUP && followed.length >= 2
        ? permutationP(a.map(flag), b.map(flag), rateGap) : null,
    };
  };
  const midSize = median(settled.filter(sized).map(size));
  const midHours = median(settled.map(hours));
  const groups = [
    compare("agent", "Agent branches", "Other branches", (pr) => Boolean(agentFromBranch(pr.headRef)), (pr) => typeof pr.headRef === "string"),
    compare("size", "Larger half by lines", "Smaller half", (pr) => size(pr) > midSize, sized),
    compare("review", "No recorded review", "Reviewed", (pr) => !pr.reviews, reviewsKnown),
    compare("speed", "Faster than your median merge", "Slower or at the median", (pr) => hours(pr) < midHours),
    compare("late", "Merged midnight to 4am", "Merged at other hours", (pr) => new Date(mergedAt(pr)).getHours() < 4),
  ].filter((g) => g.a.n && g.b.n);
  // Several comparisons run on the same merges, so the bar each must clear is divided among them.
  const tested = groups.filter((g) => g.p != null).length;
  const bar = CHANCE_P / Math.max(1, tested);
  for (const g of groups) g.clear = g.p != null && g.p < bar;
  const rate = (side) => side.followed / side.n;
  const standouts = groups.filter((g) => g.clear).sort((x, y) => x.p - y.p || Math.abs(rate(y.a) - rate(y.b)) - Math.abs(rate(x.a) - rate(x.b)));
  const rework = {
    merged: merged.length,
    settled: settled.length,
    followed: followed.length,
    rate: settled.length ? followed.length / settled.length : null,
    named: followed.filter((pr) => hit.get(prKey(pr.repo, pr.number)).named).length,
    medianHours: median(followed.map((pr) => hit.get(prKey(pr.repo, pr.number)).hours)),
    examples: followed.slice().sort((a, b) => mergedAt(b) - mergedAt(a)).map((pr) => {
      const by = hit.get(prKey(pr.repo, pr.number));
      return { repo: pr.repo, number: pr.number, lines: sized(pr) ? size(pr) : null, agent: Boolean(agentFromBranch(pr.headRef)), by: by.number, hours: by.hours, named: by.named };
    }),
    groups, tested, bar, standouts,
  };

  // ----- Open work -----
  // Each pull request is open from creation until it merged, closed, or now. A closed one with no
  // close time (data saved before that field was read) has no known end and is left out.
  const end = (pr) => (pr.merged ? mergedAt(pr) : pr.state === "CLOSED" ? Date.parse(pr.closedAt) : nowTime);
  const spans = mine.map((pr) => ({ pr, start: start(pr), end: end(pr) })).filter((s) => Number.isFinite(s.end) && s.end >= s.start);
  for (const s of spans) s.others = spans.filter((o) => o !== s && o.start < s.start && o.end > s.start).length;
  const timedSpans = spans.filter((s) => merged.includes(s.pr));
  const busiest = spans.reduce((best, s) => (!best || s.others > best.others ? s : best), null);
  const cut = median(timedSpans.map((s) => s.others));
  const side = (list) => ({ n: list.length, medianHours: median(list.map((s) => hours(s.pr))) });
  const quiet = timedSpans.filter((s) => s.others <= cut);
  const busy = timedSpans.filter((s) => s.others > cut);
  const first = spans.reduce((t, s) => Math.min(t, s.start), Infinity);
  const openNow = mine.filter((pr) => pr.state === "OPEN")
    .map((pr) => ({ repo: pr.repo, number: pr.number, days: (nowTime - start(pr)) / DAY_MS, draft: Boolean(pr.isDraft) }))
    .filter((pr) => pr.days >= 0).sort((a, b) => b.days - a.days);
  const flow = {
    counted: spans.length,
    unknownEnd: mine.length - spans.length,
    typicalOthers: median(spans.map((s) => s.others)),
    peak: busiest ? { count: busiest.others + 1, at: new Date(busiest.start).toISOString().slice(0, 10) } : null,
    // Time-weighted: pull-request days open, over the days since the first one opened.
    averageOpen: Number.isFinite(first) && nowTime > first ? sum(spans.map((s) => s.end - s.start)) / (nowTime - first) : null,
    load: timedSpans.length >= CORRELATION_MIN_MERGES ? rankCorrelation(timedSpans.map((s) => s.others), timedSpans.map((s) => hours(s.pr))) : null,
    split: quiet.length && busy.length ? { cut, quiet: side(quiet), busy: side(busy) } : null,
    openNow,
  };

  // ----- The user's own baseline -----
  const mergeHours = merged.map(hours);
  const baseline = mergeHours.length >= BASELINE_MIN_MERGES ? {
    n: mergeHours.length, medianHours: median(mergeHours), p75Hours: quantile(mergeHours, 0.75), p90Hours: quantile(mergeHours, 0.9),
  } : null;
  const overdueAfterHours = baseline ? Math.max(baseline.p90Hours, OVERDUE_FLOOR_HOURS) : null;
  const overdue = baseline ? openNow.filter((pr) => pr.days * 24 > overdueAfterHours) : [];
  // Among finished pull requests, did the ones that outlasted the slowest quarter of merges still merge?
  let late = null;
  if (baseline) {
    const finished = spans.filter((s) => s.pr.state !== "OPEN" || s.pr.merged);
    const lasted = (s) => (s.end - s.start) / 36e5 > baseline.p75Hours;
    const slow = finished.filter(lasted);
    const quick = finished.filter((s) => !lasted(s));
    const won = (list) => list.map((s) => (s.pr.merged ? 1 : 0));
    late = {
      afterHours: baseline.p75Hours,
      slow: { n: slow.length, merged: sum(won(slow)) },
      quick: { n: quick.length, merged: sum(won(quick)) },
      p: slow.length >= REWORK_MIN_GROUP && quick.length >= REWORK_MIN_GROUP ? permutationP(won(slow), won(quick), rateGap) : null,
    };
  }

  // ----- Working and waiting -----
  // Time to merge, split at the last commit: open to last commit is work still landing, last commit to
  // merge is finished work waiting. A last commit made before the pull request opened counts as no
  // work time, since the work was done first. Only merges with a read commit time are counted.
  const lastCommit = (pr) => Date.parse(pr.lastCommitAt);
  const timedSplit = timedSpans.filter((s) => Number.isFinite(lastCommit(s.pr)));
  const parts = timedSplit.map((s) => {
    const done = Math.min(Math.max(lastCommit(s.pr), s.start), mergedAt(s.pr));
    return { s, working: (done - s.start) / 36e5, waiting: (mergedAt(s.pr) - done) / 36e5 };
  });
  const totalHours = sum(parts.map((x) => x.working + x.waiting));
  const split = parts.length >= SPLIT_MIN_MERGES ? {
    n: parts.length,
    missing: merged.length - parts.length,
    workingHours: median(parts.map((x) => x.working)),
    waitingHours: median(parts.map((x) => x.waiting)),
    // Time-weighted: of all the hours these pull requests were open, the share after the last commit.
    // Long pull requests weigh most, which is the point: it says where the time went.
    waitingShare: totalHours > 0 ? sum(parts.map((x) => x.waiting)) / totalHours : null,
    totalWaiting: sum(parts.map((x) => x.waiting)),
    totalHours,
    // The merges that sat longest after their last commit.
    idle: parts.slice().sort((a, b) => b.waiting - a.waiting).slice(0, 3)
      .map((x) => ({ repo: x.s.pr.repo, number: x.s.pr.number, waiting: x.waiting, working: x.working })),
    // Whether open work tracks the waiting part, which is what the open-work finding predicts.
    waitingLoad: parts.length >= CORRELATION_MIN_MERGES ? rankCorrelation(parts.map((x) => x.s.others), parts.map((x) => x.waiting)) : null,
  } : null;
  const commits = { asked: merged.length, read: parts.length };

  return { authored: mine.length, merged: merged.length, rework, flow, baseline, overdueAfterHours, overdue, late, split, commits };
}

// ---------- Weekly snapshots ----------
// A handful of outcome numbers, saved once a week in saved history, so a change in how you work can be
// read against what came before. Each number covers the same rolling window as the summaries, so
// neighbouring weeks share most of their pull requests and a real change shows up over several weeks.
const SNAPSHOT_METRICS = [
  { key: "medianMergeHours", label: "Median time to merge", format: (v) => durationLabel(v), better: "lower" },
  { key: "reworkRate", label: "Merges followed by a fix", format: (v) => share(v), better: "lower" },
  { key: "averageOpen", label: "Open at once, on average", format: (v) => formatCount(Math.round(v * 10) / 10), better: "lower" },
  { key: "waitingShare", label: "Open hours after the last commit", format: (v) => share(v), better: "lower" },
  { key: "merged", label: "Merges in the window", format: (v) => String(v), better: "" },
];
const SNAPSHOT_GAP_WEEKS = 4;

// The numbers to save this week, each only once it has the minimum sample its finding uses.
function snapshotOf(outcomes) {
  if (!outcomes) return null;
  const r = outcomes.rework;
  return {
    merged: outcomes.merged,
    medianMergeHours: outcomes.baseline ? outcomes.baseline.medianHours : null,
    reworkRate: r.settled >= REWORK_MIN_SETTLED ? r.rate : null,
    averageOpen: outcomes.flow.averageOpen,
    waitingShare: outcomes.split ? outcomes.split.waitingShare : null,
  };
}

// Saved weeks, oldest first, with each number's first value, its value about four weeks back, and now.
function summarizeSnapshots(saved, current, week) {
  const weeks = Object.entries(saved || {}).filter(([w, v]) => DAY_KEY.test(w) && v && typeof v === "object")
    .map(([w, v]) => ({ week: w, values: v }));
  if (current && DAY_KEY.test(week || "")) {
    const i = weeks.findIndex((w) => w.week === week);
    if (i >= 0) weeks.splice(i, 1);
    weeks.push({ week, values: current });
  }
  weeks.sort((a, b) => a.week.localeCompare(b.week));
  const rows = SNAPSHOT_METRICS.map((m) => {
    const points = weeks.filter((w) => Number.isFinite(w.values[m.key])).map((w) => ({ week: w.week, value: w.values[m.key] }));
    if (points.length < 2) return { ...m, points, first: null, back: null, latest: points[0] || null };
    const latest = points[points.length - 1];
    const cutoff = new Date(Date.parse(latest.week) - SNAPSHOT_GAP_WEEKS * 7 * DAY_MS).toISOString().slice(0, 10);
    const back = points.filter((p) => p.week <= cutoff).pop() || null;
    return { ...m, points, first: points[0], back, latest };
  });
  return { weeks: weeks.length, first: weeks[0]?.week || null, latest: weeks[weeks.length - 1]?.week || null, rows };
}
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

// Review partners: who reviews the user's pull requests and whose pull requests the user reviews.
// Both directions use the same window. Each person's first review is timed from the request to them when
// one came before it, else from when the pull request was ready for review, else from creation
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
  const inClocks = clockCounts();
  const outClocks = clockCounts();
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
      const clock = reviewClock(pr, r.at, r.login);
      const h = hoursFrom(clock.start, r.at);
      if (h != null) {
        p.inHours.push(h);
        inClocks[clock.from] += 1;
      }
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
    // Timed from when you were asked, where a request to you came before your review.
    const clock = pr.myFirstReviewAt ? reviewClock(pr, pr.myFirstReviewAt, login) : null;
    const h = clock ? hoursFrom(clock.start, pr.myFirstReviewAt) : null;
    if (h != null) {
      p.outHours.push(h);
      outClocks[clock.from] += 1;
    } else unmatched += 1;
  }

  // Your own speed on other people's pull requests, across everyone.
  const outAll = [...people.values()].flatMap((p) => p.outHours);
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
    received, given, botAuthored, unmatched, truncated, complete, inClocks, outClocks,
    outTimed: outAll.length, outMedianHours: median(outAll), outP75Hours: outAll.length >= 4 ? quantile(outAll, 0.75) : null,
    people: rows, mutual: rows.filter((r) => r.kind === "mutual").length, findings,
  };
}

const CORRELATION_MIN_RHO = 0.3;
// One sentence on a rank correlation between size and time to merge.
function correlationText(c, clear) {
  if (!c) return "";
  const strength = Math.abs(c.rho) < 0.1 ? "no" : Math.abs(c.rho) < CORRELATION_MIN_RHO ? "a weak" : Math.abs(c.rho) < 0.6 ? "a moderate" : "a strong";
  const direction = Math.abs(c.rho) < 0.1 ? "" : c.rho > 0 ? " positive" : " negative";
  return ` Across all ${plural(c.n, "timed merge")}, size and time to merge show ${strength}${direction} rank correlation (ρ ${c.rho.toFixed(2)}).${chanceNote(c.p, "Random pairings of the same sizes and times", "a correlation this strong", clear)}`;
}

// ---------- One chance budget for the page ----------
// Every chance check on the page runs at once, so with no real effect anywhere, ten checks at 5% each
// would still call one "beyond chance" about two times in five. Holm's step-down method keeps that
// risk at 5% for the page as a whole: sort the p values, hold the smallest to 5% divided by the number
// of checks, the next to 5% divided by one fewer, and stop at the first that fails.
function chanceBudget({ prs, outcomes, trajectory } = {}) {
  const tests = [];
  const add = (key, label, p) => { if (Number.isFinite(p)) tests.push({ key, label, p }); };
  add("agent-gap", "Agent-branch merge times against other merges", prs?.agentGapP);
  add("agent-review", "Agent-branch merges without review against other merges", prs?.agentReviewP);
  add("size-time", "Size against time to merge", prs?.sizeVsTime?.p);
  add("shift", "The clearest shift in weekly output", trajectory?.shift?.big ? trajectory.shift.p : null);
  add("open-work", "Open work against time to merge", outcomes?.flow?.load?.p);
  add("late", "Whether slow pull requests still merged", outcomes?.late?.p);
  add("waiting", "Open work against time waiting after the last commit", outcomes?.split?.waitingLoad?.p);
  for (const g of outcomes?.rework?.groups || []) {
    add(`rework:${g.key}`, `Follow-up fixes: ${g.a.label.toLowerCase()} against ${g.b.label.toLowerCase()}`, g.p);
  }
  tests.sort((a, b) => a.p - b.p || a.key.localeCompare(b.key));
  const cleared = {};
  let open = true;
  for (const [i, t] of tests.entries()) {
    t.bar = CHANCE_P / (tests.length - i);
    t.clear = open && t.p < t.bar;
    if (!t.clear) open = false;
    if (t.clear) cleared[t.key] = true;
  }
  return { tested: tests.length, method: "Holm", entries: tests, cleared };
}

// Whether a chance check passed: against the page budget when there is one, else against 5% alone.
const passes = (chance, key, p) => (chance ? Boolean(chance.cleared[key]) : p != null && p < CHANCE_P);

// The follow-up comparisons judged by the page budget instead of their own shared bar.
function withBudget(outcomes, chance) {
  if (!outcomes || !chance) return outcomes;
  const groups = outcomes.rework.groups.map((g) => ({ ...g, clear: passes(chance, `rework:${g.key}`, g.p) }));
  const rate = (side) => side.followed / side.n;
  const standouts = groups.filter((g) => g.clear).sort((x, y) => x.p - y.p || Math.abs(rate(y.a) - rate(y.b)) - Math.abs(rate(x.a) - rate(x.b)));
  return { ...outcomes, rework: { ...outcomes.rework, groups, standouts, page: chance.tested } };
}

// Plain-language findings. Each names its source, and each needs a minimum sample before it appears.
// A finding that a suggestion acts on carries an id, which the suggestion rule names in `patterns`.
// Warnings are kept for outcomes. A finding about how work was reviewed is a note unless the user's
// own merges show the unreviewed ones needing fixes more often.
// `confirmed` marks a finding that rests on a chance check that passed, which ranks it above the rest.
function deriveObservations({ rhythm, sessions, prs, trajectory, follow, review, outcomes: raw, chance }) {
  const outcomes = withBudget(raw, chance);
  const out = [];
  const add = (tone, source, title, detail, id = "", confirmed = false) => out.push({ tone, source, title, detail, id, confirmed });
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
      "A session is a run of events with gaps under an hour. Frequent crossings can mean context switching.", "sessions-cross-repos");
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
            `Median ${durationLabel(agent.medianHours)} across ${agent.count} agent-branch merges, ${durationLabel(other.medianHours)} across ${other.count} others.${chanceNote(prs.agentGapP, ...GROUP_CHANCE, passes(chance, "agent-gap", prs.agentGapP))}`,
            "", passes(chance, "agent-gap", prs.agentGapP));
        }
      }
      if (agent.unreviewed / agent.count - other.unreviewed / other.count >= 0.3 - RATIO_EPSILON) {
        add(backedByOutcomes(outcomes, "agent") ? "warn" : "info", PRS, "Agent-branch merges skip review more often",
          `${agent.unreviewed} of ${agent.count} had zero recorded reviews, against ${other.unreviewed} of ${other.count} other merges.${chanceNote(prs.agentReviewP, ...GROUP_CHANCE, passes(chance, "agent-review", prs.agentReviewP))}`,
          "agent-skip-review", passes(chance, "agent-review", prs.agentReviewP));
      }
    }
    if (prs.merged >= 3 && prs.mergedLines > 0 && prs.unreviewedLines / prs.mergedLines >= 0.5) {
      add(backedByOutcomes(outcomes, "review") ? "warn" : "info", PRS, `${share(prs.unreviewedLines / prs.mergedLines)} of merged lines landed without a recorded review`,
        `${prs.unreviewedLines.toLocaleString()} of ${prs.mergedLines.toLocaleString()} changed lines across ${plural(prs.merged, "loaded merge")}.`, "unreviewed-lines");
    }
    if (smaller && larger && smaller.medianHours > 0 && larger.medianHours != null) {
      const ratio = larger.medianHours / smaller.medianHours;
      const basis = `Median ${durationLabel(larger.medianHours)} for the larger half (${Math.round(larger.medianSize).toLocaleString()} lines), ${durationLabel(smaller.medianHours)} for the smaller half (${Math.round(smaller.medianSize).toLocaleString()} lines).`;
      // Size and branch type overlap, so say so instead of crediting size alone.
      const skew = Math.abs(larger.agent - smaller.agent) / larger.count >= 0.3
        ? ` Agent branches make up ${larger.agent} of the larger ${larger.count} and ${smaller.agent} of the smaller ${smaller.count}, so branch type may explain the gap.` : "";
      const sized = passes(chance, "size-time", prs.sizeVsTime?.p);
      const rank = correlationText(prs.sizeVsTime, sized);
      if (ratio >= 2) add("info", PRS, "Larger PRs took noticeably longer to merge", basis + skew + rank, "larger-slower", sized && prs.sizeVsTime.rho >= CORRELATION_MIN_RHO);
      else if (ratio <= 1) add("info", PRS, "Larger PRs merged at least as fast as smaller ones", `${basis}${skew || " Time to merge is not scaling with size."}${rank}`);
    }
    // Without a halves finding, a clear rank correlation across every merge still says something.
    const c = prs.sizeVsTime;
    if (!out.some((o) => o.title.startsWith("Larger PRs")) && c && passes(chance, "size-time", c.p) && Math.abs(c.rho) >= CORRELATION_MIN_RHO) {
      add("info", PRS, c.rho > 0 ? "Bigger pull requests took longer to merge" : "Bigger pull requests merged faster",
        `Across ${plural(c.n, "timed merge")}, ranked by lines changed and by time to merge.${correlationText(c, true)}`, c.rho > 0 ? "larger-slower" : "", true);
    }
    // With enough merges of the user's own, open pull requests are judged against those instead.
    if (prs.stale && !outcomes?.baseline) {
      const o = prs.oldestOpen;
      add("warn", PRS, `${plural(prs.stale, "loaded open PR")} older than two weeks`,
        `Oldest is ${o.repo} #${o.number}, opened ${plural(Math.floor(o.days), "day")} ago.`, "open-too-long");
    }
  }
  const perWeek = (x) => `${x >= 10 ? Math.round(x) : x.toFixed(1)} a week`;
  const shifted = trajectory?.shift && (chance ? trajectory.shift.big && passes(chance, "shift") : trajectory.shift.clear);
  if (shifted) {
    const s = trajectory.shift;
    const up = s.after > s.before;
    add(up ? "good" : "info", YEAR, `Weekly output ${up ? "stepped up" : "dropped"} around the week of ${s.at}`,
      `${perWeek(s.before)} across the ${s.weeksBefore} weeks before, ${perWeek(s.after)} across the ${s.weeksAfter} weeks since. This is the clearest single shift in the year's weekly totals.`, "", true);
  }
  if (trajectory?.afterActive && trajectory?.afterIdle) {
    const a = trajectory.afterActive.rate;
    const i = trajectory.afterIdle.rate;
    if (a - i >= 0.3 - RATIO_EPSILON) {
      add("info", YEAR, "Activity carries over from one day to the next",
        `An active day was followed by another ${share(a)} of the time; an idle day was followed by an active one ${share(i)} of the time. Restarting after a break is the harder step.`, "restart-after-break");
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
        `Counting branches at least ${FOLLOW_GRACE_DAYS} days old. Oldest is ${follow.withoutPr[0].ref} in ${follow.withoutPr[0].repo}.${agents}`, "branches-without-pr");
    }
  }
  // Outcomes come from the pull requests you opened that loaded, which the authored search fills for
  // the whole window. The Events feed is the fallback when that sample is too small.
  const searched = review && review.outcomes.merged + review.outcomes.closed >= 4;
  if (searched) {
    const { merged, closed, open } = review.outcomes;
    if (closed / (merged + closed) >= 0.3) {
      add("warn", PRS, `${closed} of ${plural(merged + closed, "finished pull request")} you opened were closed without merging`,
        `From the loaded pull requests you opened, by current state. ${open} are still open.`, "closed-unmerged");
    }
  } else if (follow) {
    const { merged, closed } = follow.outcomes;
    const decided = merged + closed;
    if (decided >= 4 && closed / decided >= 0.3) {
      add("warn", FEED, `${closed} of ${plural(decided, "pull request")} you opened and that are now finished were closed without merging`,
        `Pull requests opened in the loaded events, with current state from the loaded details. ${follow.outcomes.open} are still open.`, "closed-unmerged");
    }
  }

  if (review && review.withHumanReview >= 3) {
    add("info", PRS, `Your pull requests waited a median of ${durationLabel(review.medianFirstReviewHours)} for a first human review`,
      `Across ${plural(review.withHumanReview, "pull request")} that you authored and someone else reviewed. Bots and your own reviews are left out.${review.p75FirstReviewHours != null ? ` One in four waited longer than ${durationLabel(review.p75FirstReviewHours)}.` : ""}`, "first-review-wait");
  }
  if (review && review.states && review.merged >= 3) {
    const unapproved = review.merged - review.noHuman - review.approvedBeforeMerge;
    if (unapproved >= 2 && unapproved / review.merged >= 0.25) {
      add("info", PRS, `${unapproved} of your ${plural(review.merged, "merge")} had a human review but no approval before merging`,
        `${review.approvedBeforeMerge} had an approval from another person before merging, and ${review.noHuman} had no review from another person. A comment-only review is feedback, not sign-off.`);
    }
  }
  if (review && review.merged >= 3) {
    if (review.botOnly && review.botOnly / review.merged >= 0.25) {
      add(backedByOutcomes(outcomes, "review") ? "warn" : "info", PRS, `${review.botOnly} of ${plural(review.merged, "merge")} were reviewed only by bots`,
        "These count as reviewed in the Pull requests view, but no person reviewed them.", "no-human-review");
    }
    if (review.selfMerged / review.merged >= 0.8 && review.noHuman / review.merged >= 0.5) {
      add("info", PRS, `You merged ${review.selfMerged} of your ${plural(review.merged, "loaded merge")} yourself`,
        `${review.noHuman} of those merges had no human review from anyone else.`, "no-human-review");
    }
  }
  if (review && review.reviewers.length && review.withHumanReview >= 4 && review.topReviewerShare >= 0.6) {
    const [name, count] = review.reviewers[0];
    add("info", PRS, `One person handles most reviews of your work`,
      `${name} reviewed ${count} of your loaded pull requests, ${share(review.topReviewerShare)} of all reviewer visits. Review depends on their availability.`, "one-reviewer");
  }

  if (outcomes) {
    const MINE = "Pull requests you opened";
    const { rework, flow, baseline, late } = outcomes;
    if (rework.settled >= REWORK_MIN_SETTLED && rework.followed >= 2 && rework.rate >= REWORK_RATE - RATIO_EPSILON) {
      add("warn", MINE, `${rework.followed} of your ${plural(rework.settled, "settled merge")} were followed by a fix within ${REWORK_HOURS / 24} days`,
        `${reworkStandout(rework)} A follow-up is a pull request in the same repository whose title starts with fix or revert.`, "fixes-follow-merges", rework.standouts.length > 0);
    } else if (rework.settled >= 8 && rework.followed === 0) {
      add("good", MINE, `None of your ${plural(rework.settled, "settled merge")} was followed by a fix`,
        `No pull request titled as a fix or revert opened in the same repository within ${REWORK_HOURS / 24} days of any of them.`);
    }
    const load = flow.load;
    if (load && passes(chance, "open-work", load.p) && load.rho >= CORRELATION_MIN_RHO && flow.split) {
      add("info", MINE, "Pull requests opened beside other open work took longer to merge", flowText(flow, true), "open-work-slows-merges", true);
    } else if (flow.peak && flow.peak.count >= FLOW_PEAK) {
      add("info", MINE, `You had ${flow.peak.count} pull requests open at once`,
        `The most at one time, reached on ${flow.peak.at}. When you open one, a median of ${formatCount(flow.typicalOthers)} of your others ${flow.typicalOthers === 1 ? "is" : "are"} already open.`);
    }
    if (baseline && outcomes.overdue.length) {
      const o = outcomes.overdue[0];
      add("warn", MINE, `${plural(outcomes.overdue.length, "open pull request")} ${outcomes.overdue.length === 1 ? "has" : "have"} outlived your usual merge time`,
        `Open longer than ${durationLabel(outcomes.overdueAfterHours)}. 90% of your ${plural(baseline.n, "merge")} finished within ${durationLabel(baseline.p90Hours)}. Oldest is ${o.repo} #${o.number}, open ${plural(Math.floor(o.days), "day")}.`, "open-too-long");
    }
    const split = outcomes.split;
    if (split && split.waitingShare != null) {
      const w = split.waitingLoad;
      const tracks = w && passes(chance, "waiting", w.p) && w.rho >= CORRELATION_MIN_RHO;
      const load = w ? ` With more of your others open, the waiting part ${tracks ? "grew" : "did not clearly grow"} (ρ ${w.rho.toFixed(2)}).${chanceNote(w.p, "Random pairings of the same counts and times", "a correlation this strong", passes(chance, "waiting", w.p))}` : "";
      const basis = `Median ${durationLabel(split.workingHours)} from opening to the last commit, then ${durationLabel(split.waitingHours)} from the last commit to the merge, across ${plural(split.n, "merge")}.`;
      if (split.waitingShare >= 0.5) {
        const o = split.idle[0];
        add("info", MINE, "Most of the time your pull requests spend open comes after the last commit",
          `${share(split.waitingShare)} of all the hours your merged pull requests spent open came after their last commit. ${basis} Longest wait: ${o.repo} #${o.number}, ${durationLabel(o.waiting)} after its last commit.${load}`, "merges-wait-after-work", Boolean(tracks));
      } else if (split.waitingShare <= 0.2) {
        add("info", MINE, "Your pull requests merge soon after the last commit",
          `Only ${share(split.waitingShare)} of the hours your merged pull requests spent open came after their last commit. ${basis}${load}`, "", Boolean(tracks));
      }
    }
    if (late && late.slow.n >= REWORK_MIN_GROUP && late.quick.n >= REWORK_MIN_GROUP &&
      late.slow.merged / late.slow.n <= 0.5 && late.quick.merged / late.quick.n - late.slow.merged / late.slow.n >= 0.3 - RATIO_EPSILON) {
      const lateClear = passes(chance, "late", late.p);
      add("info", MINE, `Pull requests still open after ${durationLabel(late.afterHours)} merged ${late.slow.merged} of ${late.slow.n} times`, lateText(late, lateClear), "slow-rarely-merge", lateClear);
    }
  }

  // Warnings first, then findings that passed a chance check, then the rest in the order added.
  const rank = { warn: 0, good: 1, info: 1 };
  return out.sort((a, b) => rank[a.tone] - rank[b.tone] || Number(b.confirmed) - Number(a.confirmed));
}

const formatCount = (x) => (Number.isInteger(x) ? String(x) : x.toFixed(1));
const oftenText = (p) => (share(p) === "0%" ? "under 1%" : share(p));
// The follow-up comparisons that stand apart, higher side first, or a plain statement that none does.
function reworkStandout(rework) {
  const pair = (g) => {
    const [hi, lo] = g.a.followed / g.a.n >= g.b.followed / g.b.n ? [g.a, g.b] : [g.b, g.a];
    return `${hi.label}: ${hi.followed} of ${hi.n}. ${lo.label}: ${lo.followed} of ${lo.n}.`;
  };
  const [first, ...rest] = rework.standouts;
  if (first) {
    const bar = `${Number((rework.bar * 100).toFixed(2))}%`;
    const clears = rework.page
      ? `which clears the bar shared by ${plural(rework.page, "chance check")} on this page`
      : `under the ${bar} bar that ${plural(rework.tested, "comparison")} on the same merges must clear`;
    return `${pair(first)} Random regroupings match that gap ${oftenText(first.p)} of the time, ${clears}.${rest.map((g) => ` Also beyond chance: ${pair(g)}`).join("")}`;
  }
  return rework.tested
    ? `No group stood apart beyond chance across ${plural(rework.tested, "comparison")} (branch type, size, review, merge speed, hour).`
    : `Groups are compared once each side has ${REWORK_MIN_GROUP} merges.`;
}
const reworkGroup = (outcomes, key) => outcomes?.rework.groups.find((x) => x.key === key && x.p != null) || null;
// One follow-up comparison as a sentence, for a suggestion whose advice it tests. Empty when untested.
function reworkNote(outcomes, key) {
  const g = reworkGroup(outcomes, key);
  if (!g) return "";
  const gap = Math.abs(g.a.followed / g.a.n - g.b.followed / g.b.n);
  const verdict = g.clear ? "a gap beyond chance" : gap < 0.05 || g.p >= 0.5 ? "about the same rate once chance is allowed for" : `a gap random regrouping matches ${oftenText(g.p)} of the time`;
  return ` In your own merges, a fix followed ${g.a.followed} of ${g.a.n} (${g.a.label.toLowerCase()}) against ${g.b.followed} of ${g.b.n} (${g.b.label.toLowerCase()}), ${verdict}.`;
}
// Advice about process (get a review, read the diff) is a warning only when the user's own merges back
// it: the group it targets was followed by fixes more often, beyond chance. Otherwise it is a note.
function backedByOutcomes(outcomes, key) {
  const g = reworkGroup(outcomes, key);
  return Boolean(g && g.clear && g.a.followed / g.a.n > g.b.followed / g.b.n);
}
function flowText(flow, clear) {
  const { split, load } = flow;
  const more = split.cut === 0 ? "at least one of your others already open" : `more than ${formatCount(split.cut)} of your others already open`;
  return `Median ${durationLabel(split.busy.medianHours)} to merge across ${split.busy.n} opened with ${more}, ${durationLabel(split.quiet.medianHours)} across the other ${split.quiet.n}. Rank correlation ρ ${load.rho.toFixed(2)} across ${plural(load.n, "merge")}.${chanceNote(load.p, "Random pairings of the same counts and times", "a correlation this strong", clear)}`;
}
function lateText(late, clear) {
  return `Counting finished pull requests you opened that outlasted the slowest quarter of your merges. Of those that finished sooner, ${late.quick.merged} of ${late.quick.n} merged.${chanceNote(late.p, "Random regroupings of the same pull requests", "a gap this large", clear)}`;
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
  "dora-wip": { title: "Work in process limits", by: "DORA", kind: "Guide", url: "https://dora.dev/capabilities/wip-limits/" },
  "dora-metrics": { title: "DORA's software delivery performance metrics", by: "DORA", kind: "Guide", url: "https://dora.dev/guides/dora-metrics/" },
  "bacchelli-2013": { title: "Expectations, Outcomes, and Challenges of Modern Code Review", by: "Bacchelli and Bird, ICSE 2013", kind: "Study", url: "https://doi.org/10.1109/ICSE.2013.6606617" },
  "kudrjavets-2022": { title: "Do Small Code Changes Merge Faster? A Multi-Language Empirical Investigation", by: "Kudrjavets, Nagappan, and Rastogi, MSR 2022", kind: "Study", url: "https://doi.org/10.1145/3524842.3528448" },
  "perry-2023": { title: "Do Users Write More Insecure Code with AI Assistants?", by: "Perry, Srivastava, Kumar, and Boneh, ACM CCS 2023", kind: "Study", url: "https://doi.org/10.1145/3576915.3623157" },
  "meyer-2014": { title: "Software Developers' Perceptions of Productivity", by: "Meyer, Fritz, Murphy, and Zimmermann, FSE 2014", kind: "Study", url: "https://doi.org/10.1145/2635868.2635892" },
  "mark-2008": { title: "The Cost of Interrupted Work: More Speed and Stress", by: "Mark, Gudith, and Klocke, CHI 2008", kind: "Study", url: "https://doi.org/10.1145/1357054.1357072" },
  "parnin-2011": { title: "Resumption strategies for interrupted programming tasks", by: "Parnin and Rugaber, Software Quality Journal 2011", kind: "Study", url: "https://doi.org/10.1007/s11219-010-9104-9" },
  "eyolfson-2014": { title: "Correlations between bugginess and time-based commit characteristics", by: "Eyolfson, Tan, and Lam, Empirical Software Engineering 2014", kind: "Study", url: "https://doi.org/10.1007/s10664-013-9245-0" },
  "mirsaeedi-2020": { title: "Mitigating Turnover with Code Review Recommendation", by: "Mirsaeedi and Rigby, ICSE 2020", kind: "Study", url: "https://doi.org/10.1145/3377811.3380335" },
});

const SUGGEST_MIN_MERGES = 3;
const SUGGEST_REVIEW_WAIT_HOURS = 24;   // Google's one-business-day guideline, rounded to a day
const SUGGEST_LARGE_LINES = 400;        // median merged lines that count as large
const SUGGEST_STALE_DAYS = 14;
const SUGGEST_WAITING_DAYS = 2;
const SUGGEST_LATE_SHARE = 0.15;
const SUGGEST_CI_SHARE = 0.4;
const SUGGEST_OUT_MIN = 5;
const SUGGEST_PENDING_MIN = 2;          // review requests to you by name, each waiting a day, before a card

const lines = (n) => Math.round(n).toLocaleString();
const ageDays = (nowTime, at) => (nowTime - Date.parse(at)) / DAY_MS;
const SUGGEST_TARGETS = 3;
const prLabel = (r) => `${r.repo} #${r.number}`;
// A Where line that names a repository, or a pull request or issue in it, so the card can open it on
// github.com. The main process builds the URL itself from the repository name and number.
const ref = (text, repo, number) => ({ text, repo, number: Number.isInteger(number) ? number : null });

// Each rule returns null when it checked the data and found nothing to suggest, { unavailable } when
// its source did not load, { short } when the sample is below its minimum, or the suggestion.
// `seen` describes the loaded data. Each `why` claim names its source; `act` is what to try.
// Segments are [text, ...reading ids]. `basis` names the sample, and `targets` lists up to three
// specific repositories, pull requests, branches, threads, or people to start with.
// `patterns` names the Patterns findings a rule acts on, so each can point at the other.
// `confirmed` marks a suggestion that rests on a gap or correlation that passed its chance check.
// `fold` names a rule that gives the same advice: when both apply, this one is shown inside it.
const SUGGESTION_RULES = [
  {
    id: "trace-follow-up-fixes", area: "Quality", source: "Pull requests you opened", patterns: ["fixes-follow-merges"],
    title: "Find what your follow-up fixes have in common",
    check: ({ outcomes }) => {
      if (!outcomes) return { unavailable: "The search for pull requests you opened did not load." };
      const r = outcomes.rework;
      if (r.settled < REWORK_MIN_SETTLED) return { short: `Needs ${REWORK_MIN_SETTLED} merged pull requests you opened that are at least ${REWORK_HOURS / 24} days old; ${r.settled} loaded.` };
      if (r.followed < 2 || r.rate < REWORK_RATE - RATIO_EPSILON) return null;
      const START = {
        agent: "Start with agent branches: ask for a test that fails without the change in the same pull request, and run it before you merge.",
        size: "Start with the larger ones: split the next large change so each part can be checked on its own.",
        review: "Start with the merges nobody reviewed: put a required status check in front of them and read the whole diff before merging.",
        speed: "Start with the quick merges: let the checks finish and reopen the diff once before merging.",
        late: "Start with the late-night merges: open them as drafts and merge the next day.",
      };
      // Each line of advice is aimed at side a of its comparison, so it only fits when a is the higher side.
      const g = r.standouts.find((x) => x.a.followed / x.a.n > x.b.followed / x.b.n);
      const aimed = g ? [[START[g.key]]] : [];
      return {
        tone: "warn", confirmed: r.standouts.length > 0,
        basis: `${plural(r.settled, "merged pull request")} you opened, each at least ${REWORK_HOURS / 24} days old`,
        targets: r.examples.map((e) => ref(`${prLabel(e)}${e.lines != null || e.agent ? ` (${[e.lines != null ? `${lines(e.lines)} lines` : "", e.agent ? "agent branch" : ""].filter(Boolean).join(", ")})` : ""}: #${e.by} followed after ${durationLabel(e.hours)}`, e.repo, e.number)),
        why: [["DORA measures the instability of software delivery partly by change fail rate: the share of deployments that need immediate intervention afterwards, likely a rollback or a hotfix.", "dora-metrics"]],
        seen: `${r.followed} of your ${plural(r.settled, "settled merge")} were followed within ${REWORK_HOURS / 24} days by a pull request in the same repository titled as a fix or revert${r.named ? `, ${r.named} of them naming the merge` : ""}. ${reworkStandout(r)} A title is a proxy: a fix that opens after a merge is not always a fix for it, and a merge is not a deployment.`,
        act: [
          ["Open each pair below and write one line in the fix saying what the first pull request missed: a test, a case, a platform. Then add the check that would have caught the most common miss."],
          ...aimed,
        ],
      };
    },
  },
  {
    id: "limit-open-work", area: "Flow", source: "Pull requests you opened", patterns: ["open-work-slows-merges"],
    title: "Finish open pull requests before opening the next",
    check: ({ outcomes, chance }) => {
      if (!outcomes) return { unavailable: "The search for pull requests you opened did not load." };
      const f = outcomes.flow;
      if (outcomes.merged < CORRELATION_MIN_MERGES) return { short: `Needs ${CORRELATION_MIN_MERGES} merged pull requests you opened; ${outcomes.merged} loaded.` };
      // No correlation exists when open work never varied, which is itself nothing to act on.
      if (!f.load || !(passes(chance, "open-work", f.load.p) && f.load.rho >= CORRELATION_MIN_RHO) || !f.split) return null;
      const limit = Math.floor(f.split.cut) + 1;
      return {
        tone: "info", confirmed: true,
        basis: `${plural(f.load.n, "merged pull request")} you opened`,
        targets: f.openNow.slice(0, SUGGEST_TARGETS).map((o) => ref(`${prLabel(o)}${o.draft ? " (draft)" : ""}: open ${plural(Math.floor(o.days), "day")}`, o.repo, o.number)),
        seen: `${flowText(f, true)}${f.peak ? ` You had up to ${f.peak.count} open at once, on ${f.peak.at}.` : ""} Busy stretches can cause both, so this is a pattern to test, not a proven cause.`,
        why: [["DORA's guidance for teams says that spreading people across several tasks makes tasks take longer to finish, and that its research shows limits on work in process help improve software delivery performance.", "dora-wip"]],
        act: [[`Try a limit of ${plural(limit, "open pull request")} for two weeks. At the limit, merge or close the oldest before you open another, then compare your time to merge here.`]],
      };
    },
  },
  {
    id: "merge-finished-work", area: "Flow", source: "Pull requests you opened", patterns: ["merges-wait-after-work"], fold: "limit-open-work",
    title: "Merge finished pull requests before they sit",
    check: ({ outcomes, chance }) => {
      if (!outcomes) return { unavailable: "The search for pull requests you opened did not load." };
      const s = outcomes.split;
      if (!s) {
        return outcomes.merged >= SPLIT_MIN_MERGES && outcomes.commits.read === 0
          ? { unavailable: "Last-commit times did not load, so time to merge cannot be split into work and waiting." }
          : { short: `Needs ${SPLIT_MIN_MERGES} merged pull requests you opened with a last-commit time; ${outcomes.commits.read} loaded.` };
      }
      if (!(s.waitingShare >= 0.5)) return null;
      const w = s.waitingLoad;
      const tracks = Boolean(w && passes(chance, "waiting", w.p) && w.rho >= CORRELATION_MIN_RHO);
      return {
        tone: "info", confirmed: tracks,
        basis: `${plural(s.n, "merged pull request")} you opened with a last-commit time`,
        targets: s.idle.map((o) => ref(`${prLabel(o)}: merged ${durationLabel(o.waiting)} after its last commit`, o.repo, o.number)),
        seen: `${share(s.waitingShare)} of the hours your merged pull requests spent open came after their last commit. Per pull request, the median was ${durationLabel(s.workingHours)} from opening to the last commit and ${durationLabel(s.waitingHours)} from the last commit to the merge.${tracks ? ` The wait grew with the number of your other pull requests open (ρ ${w.rho.toFixed(2)}).` : ""} A last commit is not always the end of the work: a review can still ask for changes.`,
        why: [["DORA's guidance for teams says that spreading people across several tasks makes tasks take longer to finish, and that its research shows limits on work in process help improve software delivery performance.", "dora-wip"]],
        act: [["When the last commit of a pull request is in and its checks pass, merge it or ask for the review that day, before you start something new. The pull requests below waited longest."]],
      };
    },
  },
  {
    id: "review-before-merge", area: "Review", source: "Pull requests you opened", patterns: ["unreviewed-lines", "no-human-review"],
    title: "Get a second look before merging",
    check: ({ review, outcomes }) => {
      if (!review) return { unavailable: "The search for pull requests you opened did not load." };
      if (review.merged < SUGGEST_MIN_MERGES) return { short: `Needs ${SUGGEST_MIN_MERGES} merged pull requests you opened; ${review.merged} loaded.` };
      if (review.noHuman / review.merged < 0.5) return null;
      const bots = review.botOnly ? ` ${review.botOnly} had only bot reviews.` : "";
      const cut = review.truncated ? ` ${plural(review.truncated, "pull request")} had more than 10 reviews, and only the first 10 were read.` : "";
      const approved = review.states ? ` ${review.approvedBeforeMerge} had an approval from another person before merging.` : "";
      const seen = `${review.noHuman} of your ${plural(review.merged, "merged pull request")} had no review from another person.${approved}${bots}${cut}${reworkNote(outcomes, "review")}`;
      const basis = `${plural(review.merged, "merged pull request")} you opened`;
      const tone = backedByOutcomes(outcomes, "review") ? "warn" : "info";
      // Rulesets are set per repository, so name the repositories where unreviewed merges collect.
      const targets = review.byRepo.filter((r) => r.noHuman).sort((a, b) => b.noHuman - a.noHuman || a.repo.localeCompare(b.repo))
        .slice(0, SUGGEST_TARGETS).map((r) => ref(`${r.repo}: ${r.noHuman} of ${plural(r.merged, "merge")} with no review from another person`, r.repo));
      if (!review.reviewers.length && !review.truncated) {
        return {
          tone, basis, targets,
          seen: `${seen} Nobody else reviewed your pull requests in this window.`,
          why: [
            ["GitHub does not let authors approve their own pull requests, so a required approval has to come from someone else.", "gh-approve"],
            ["A required status check works alone: merging waits until the checks you name pass. On GitHub Free, rulesets cover public repositories only.", "gh-rulesets"],
          ],
          act: [["Add a ruleset on your default branch with Require status checks to pass before merging, naming your tests and code scanning, and read the whole diff under Files changed before you merge."]],
        };
      }
      return {
        tone, basis, targets,
        seen: `${seen}${review.selfMerged ? ` You merged ${review.selfMerged} yourself.` : ""}`,
        why: [["At Microsoft, finding defects was the main reason developers gave for review, but reviews turned out less about defects than expected and also spread knowledge, team awareness, and alternative solutions.", "bacchelli-2013"]],
        act: [["Add a ruleset on your default branch with Require a pull request before merging and one required approval.", "gh-rulesets"]],
      };
    },
  },
  {
    id: "review-agent-branches", area: "Review", source: "Pull requests", patterns: ["agent-skip-review"], fold: "review-before-merge",
    title: "Review agent branches like a colleague's work",
    check: ({ prPatterns: p, outcomes, chance }) => {
      if (!p) return { unavailable: "No pull request details loaded." };
      const a = p.agent;
      if (a.count < SUGGEST_MIN_MERGES) return { short: `Needs ${SUGGEST_MIN_MERGES} merged agent-branch pull requests; ${a.count} loaded.` };
      const o = p.other;
      const gap = o.count >= SUGGEST_MIN_MERGES && a.unreviewed / a.count - o.unreviewed / o.count >= 0.3 - RATIO_EPSILON;
      if (a.unreviewed / a.count < 0.5 && !gap) return null;
      return {
        tone: backedByOutcomes(outcomes, "agent") ? "warn" : "info", confirmed: gap && passes(chance, "agent-review", p.agentReviewP),
        basis: `${plural(a.count, "agent-branch merge")}${o.count ? ` and ${plural(o.count, "other merge")}` : ""}`,
        targets: p.largestUnreviewedAgent.map((r) => ref(`${prLabel(r)}: ${lines(r.lines)} lines, no recorded review`, r.repo, r.number)),
        seen: `${a.unreviewed} of ${plural(a.count, "agent-branch merge")} had no recorded review${o.count ? `, against ${o.unreviewed} of ${o.count} other merges` : ""}. Agent branches are matched by prefix, such as claude/ or codex/.${reworkNote(outcomes, "agent")}`,
        why: [
          ["In a 47-person study, participants with an AI code assistant wrote less secure code on four of five tasks, and were more likely to believe it was secure.", "perry-2023"],
          ["GitHub's own coding agent is set up so the person who asked for its pull request cannot approve it.", "gh-copilot-risks"],
        ],
        act: [["Read an agent's diff before merging it, and require tests and code scanning to pass on the default branch.", "gh-rulesets"]],
      };
    },
  },
  {
    id: "faster-first-review", area: "Review", source: "Pull requests you opened", patterns: ["first-review-wait"],
    title: "Ask for a reviewer when you open the pull request",
    check: ({ review }) => {
      if (!review) return { unavailable: "The search for pull requests you opened did not load." };
      if (review.withHumanReview < 3) return { short: `Needs 3 of your pull requests with a review from another person; ${review.withHumanReview} loaded.` };
      if (!(review.medianFirstReviewHours >= SUGGEST_REVIEW_WAIT_HOURS)) return null;
      return {
        tone: "info",
        basis: `${plural(review.withHumanReview, "pull request")} you opened that another person reviewed`,
        targets: review.byRepo.filter((r) => r.timed >= 2 && r.medianFirstReviewHours >= SUGGEST_REVIEW_WAIT_HOURS)
          .sort((a, b) => b.medianFirstReviewHours - a.medianFirstReviewHours).slice(0, SUGGEST_TARGETS)
          .map((r) => ref(`${r.repo}: median ${durationLabel(r.medianFirstReviewHours)} across ${r.timed}`, r.repo)),
        seen: `Your pull requests waited a median of ${durationLabel(review.medianFirstReviewHours)} for a first review from another person, across ${plural(review.withHumanReview, "pull request")}.${review.p75FirstReviewHours != null ? ` One in four waited longer than ${durationLabel(review.p75FirstReviewHours)}.` : ""} Each wait runs from when the pull request was ready for review, so time as a draft is left out${review.noTimeline ? `, except on ${plural(review.noTimeline, "pull request")} whose timeline did not load` : ""}.`,
        why: [["Google's review guide sets one business day as the maximum time to respond to a review request.", "google-speed"]],
        act: [["Request a reviewer as you open it, or add a CODEOWNERS file so GitHub requests one automatically. Code owners are not requested on drafts until they are marked ready.", "gh-codeowners"]],
        more: ["chaoss-first-response"],
      };
    },
  },
  {
    id: "answer-review-requests", area: "Review", source: "Pull requests you reviewed",
    title: "Answer other people's pull requests within a day",
    // Fires on your past speed, or on review requests to you by name that have already waited a day.
    check: ({ collab, requests }) => {
      if (!collab && !requests) return { unavailable: "The searches for pull requests you reviewed and for review requests did not load." };
      const history = collab && collab.outTimed >= SUGGEST_OUT_MIN ? collab : null;
      const slow = history && history.outMedianHours >= SUGGEST_REVIEW_WAIT_HOURS;
      const pending = requests ? requests.items.filter((r) => r.direct && r.hours >= REQUEST_LATE_HOURS) : [];
      const asked = pending.length >= SUGGEST_PENDING_MIN;
      if (!slow && !asked) {
        if (!history) return { short: `Needs ${SUGGEST_OUT_MIN} pull requests by others with a readable time for your first review (${collab ? `${collab.outTimed} loaded` : "that search did not load"}), or ${SUGGEST_PENDING_MIN} review requests to you by name that have waited a day (${pending.length} ${pending.length === 1 ? "has" : "have"}).` };
        return null;
      }
      const seen = [];
      if (slow) seen.push(`Your first review on other people's pull requests came a median of ${durationLabel(history.outMedianHours)} ${history.outClocks.request || history.outClocks.ready ? "after you were asked or they were ready for review" : "after they were opened"}, across ${plural(history.outTimed, "pull request")}.${history.outP75Hours != null ? ` One in four took longer than ${durationLabel(history.outP75Hours)}.` : ""} ${clockText(history.outClocks, "your")}`);
      if (asked) seen.push(`${plural(pending.length, "open review request")} to you by name ${pending.length === 1 ? "has" : "have"} waited a day or more since the ask. The oldest request, on ${prLabel(pending[0])}, came ${durationLabel(pending[0].hours)} ago.`);
      const basis = [slow ? `${plural(history.outTimed, "pull request")} by other people that you reviewed` : "", asked ? `${plural(requests.items.filter((r) => r.direct).length, "open review request")} to you by name` : ""].filter(Boolean);
      const people = slow ? history.people.filter((p) => p.outTimed >= 2 && p.outMedianHours >= SUGGEST_REVIEW_WAIT_HOURS)
        .sort((a, b) => b.outMedianHours - a.outMedianHours).map((p) => `${p.login}: median ${durationLabel(p.outMedianHours)} across ${p.outTimed}`) : [];
      return {
        tone: "info",
        source: asked ? (slow ? "Pull requests you reviewed, and review requests" : "Review requests") : undefined,
        basis: basis.join(", and "),
        targets: [...pending.map((r) => ref(`${prLabel(r)}: asked ${durationLabel(r.hours)} ago, by ${r.author}`, r.repo, r.number)), ...people].slice(0, SUGGEST_TARGETS),
        seen: seen.join(" "),
        why: [["Google's review guide sets one business day as the maximum time to respond to a review request.", "google-speed"]],
        act: [["Set one or two fixed times a day to clear your review requests. When a full review has to wait, reply with when you will get to it."]],
      };
    },
  },
  {
    id: "spread-reviews", area: "Review", source: "Pull requests you opened", patterns: ["one-reviewer"],
    title: "Spread reviews beyond one person",
    check: ({ review }) => {
      if (!review) return { unavailable: "The search for pull requests you opened did not load." };
      if (review.withHumanReview < 4 || !review.reviewers.length) return { short: `Needs 4 of your pull requests with a review from another person; ${review.withHumanReview} loaded.` };
      if (review.topReviewerShare < 0.6) return null;
      const [name, count] = review.reviewers[0];
      return {
        tone: "info",
        basis: `${plural(review.withHumanReview, "pull request")} you opened that another person reviewed`,
        seen: `${name} reviewed ${plural(count, "pull request")} of yours, ${share(review.topReviewerShare)} of all reviewer visits.`,
        why: [["In a reviewer-recommendation study, picking reviewers by ownership alone concentrated knowledge in a few people; balancing expertise with spreading knowledge cut the files at risk from turnover by 28%.", "mirsaeedi-2020"]],
        act: [["Name a second owner for your busiest paths in CODEOWNERS, or, in an organization, have a team assign reviewers by round robin or load balance.", "gh-team-review"]],
      };
    },
  },
  {
    id: "smaller-prs", area: "Pull requests", source: "Pull requests", patterns: ["larger-slower"],
    title: "Split large pull requests",
    check: ({ prPatterns: p, outcomes, chance }) => {
      if (!p) return { unavailable: "No pull request details loaded." };
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
      const c = p.sizeVsTime;
      return {
        tone: "info", confirmed: Boolean(c && passes(chance, "size-time", c.p) && c.rho >= CORRELATION_MIN_RHO),
        basis: `${plural(p.merged, "merged pull request")}`,
        targets: p.largest.map((r) => ref(`${prLabel(r)}: ${lines(r.lines)} lines`, r.repo, r.number)),
        seen: seen + correlationText(c, Boolean(c) && passes(chance, "size-time", c.p)) + reworkNote(outcomes, "size"),
        why: [
          ["Google's review guide says small changes are reviewed more quickly and more thoroughly, and are less likely to introduce bugs.", "google-small-cls"],
          ["Across 100 open-source projects, though, pull request size was only weakly related to time to merge, so your own numbers are the better guide.", "kudrjavets-2022"],
        ],
        act: [["Split by concern: refactors, renames, and generated files in their own pull requests, and dependent changes stacked one on another."]],
      };
    },
  },
  {
    id: "settle-stale-prs", area: "Pull requests", source: "Pull requests you opened", patterns: ["open-too-long", "slow-rarely-merge"],
    title: "Settle pull requests that have been open for weeks",
    check: ({ prInfo, outcomes, chance }, { me, nowTime }) => {
      if (!prInfo) return { unavailable: "The search for pull requests you opened did not load." };
      const act = [
        ["Decide each one: merge it, close it with a one-line reason, or convert it to a draft so it stops reading as ready.", "gh-draft"],
        ["Where outside contributors open pull requests, actions/stale can label inactive ones and close them later.", "actions-stale"],
      ];
      const target = (r) => ref(`${prLabel(r)}${r.draft ? " (draft)" : ""}: open ${plural(Math.floor(r.days), "day")}`, r.repo, r.number);
      // With enough merges of your own, "too long" is measured against them, not against a fixed two weeks.
      const b = outcomes?.baseline;
      if (b) {
        const over = outcomes.overdue;
        if (!over.length || (over.length < 2 && over[0].days < 7)) return null;
        const l = outcomes.late;
        const odds = l && l.slow.n >= REWORK_MIN_GROUP
          ? ` Of ${plural(l.slow.n, "finished pull request")} that were still open after ${durationLabel(l.afterHours)}, ${l.slow.merged} merged, against ${l.quick.merged} of ${l.quick.n} that finished sooner.${chanceNote(l.p, "Random regroupings of the same pull requests", "a gap this large", passes(chance, "late", l.p))}` : "";
        return {
          tone: "warn", confirmed: Boolean(l && passes(chance, "late", l.p)),
          title: "Settle pull requests that have outlived your usual merge time",
          basis: `${plural(b.n, "merged pull request")} you opened and ${plural(outcomes.flow.openNow.length, "open one")}`,
          targets: over.slice(0, SUGGEST_TARGETS).map(target),
          seen: `${plural(over.length, "pull request")} you opened ${over.length === 1 ? "has" : "have"} been open longer than ${durationLabel(outcomes.overdueAfterHours)}. 90% of your ${plural(b.n, "merge")} finished within ${durationLabel(b.p90Hours)}, and half within ${durationLabel(b.medianHours)}.${odds}`,
          act,
        };
      }
      const stale = Object.values(prInfo).filter((pr) => pr?.title && pr.state === "OPEN" && me && String(pr.author || "").toLowerCase() === me)
        .map((pr) => ({ repo: pr.repo, number: pr.number, draft: Boolean(pr.isDraft), days: ageDays(nowTime, pr.createdAt) }))
        .filter((r) => r.days >= SUGGEST_STALE_DAYS)
        .sort((a, b) => b.days - a.days);
      if (!stale.length || (stale.length < 2 && stale[0].days < 30)) return null;
      const o = stale[0];
      return {
        tone: "warn",
        targets: stale.slice(0, SUGGEST_TARGETS).map(target),
        seen: `${plural(stale.length, "pull request")} you opened ${stale.length === 1 ? "has" : "have"} been open more than two weeks. Oldest: ${o.repo} #${o.number}${o.draft ? " (draft)" : ""}, ${plural(Math.floor(o.days), "day")}.`,
        act,
      };
    },
  },
  {
    id: "agree-before-building", area: "Pull requests", source: "Recent events", patterns: ["closed-unmerged"],
    title: "Agree on the approach before building",
    check: ({ follow, review, scope }) => {
      // The authored search covers every pull request you opened in its window, so it is preferred.
      // The Events feed is used when that search did not load or found too few finished ones. In a
      // repository view the search is already narrowed to that repository, and the feed, which covers
      // the whole account, is not used.
      const fromSearch = review && review.outcomes.merged + review.outcomes.closed >= 4;
      const source = fromSearch || scope ? review : follow;
      if (!source) return { unavailable: "Recent events or pull request details did not load." };
      const { merged, closed } = source.outcomes;
      const decided = merged + closed;
      if (decided < 4) return { short: `Needs 4 finished pull requests you opened; ${decided} found.` };
      if (closed / decided < 0.3) return null;
      const agents = source.closed.filter((c) => c.agent).length;
      return {
        tone: "info",
        source: fromSearch ? "Pull requests you opened" : "Recent events",
        basis: `${plural(decided, "finished pull request")} you opened${fromSearch ? "" : " in the loaded events"}`,
        targets: source.closed.slice(0, SUGGEST_TARGETS).map((c) => ref(`${prLabel(c)}${c.agent ? " (agent branch)" : ""}`, c.repo, c.number)),
        seen: `${closed} of ${plural(decided, "finished pull request")} you opened${fromSearch ? "" : " in the loaded events"} closed without merging${agents ? `, ${agents} of them from agent branches` : ""}.`,
        act: [["For larger changes, open an issue or a draft pull request first and settle the approach before polishing it.", "gh-draft"]],
      };
    },
  },
  {
    id: "branches-without-prs", area: "Branches", source: "Recent events", patterns: ["branches-without-pr"],
    title: "Open a draft pull request early, or delete the branch",
    check: ({ follow }) => {
      if (!follow) return { unavailable: "Recent events or pull request details did not load." };
      if (follow.settled < 4) return { short: `Needs 4 branches created in the loaded events and at least 2 days old; ${follow.settled} found.` };
      const n = follow.withoutPr.length;
      if (n / follow.settled < 0.5) return null;
      const o = follow.withoutPr[0];
      return {
        tone: "info",
        basis: `${plural(follow.settled, "branch", "branches")} created in the loaded events`,
        targets: follow.withoutPr.slice(0, SUGGEST_TARGETS).map((b) => ref(`${b.ref} in ${b.repo}: ${plural(Math.floor(b.days), "day")} old`, b.repo)),
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
      // Bot comments are skipped, so a bot posting after a person's reply does not hide it.
      for (const c of conversations.items) {
        const key = `${c.thread.repo}#${c.thread.number}`;
        if (!c.bot && !latest.has(key)) latest.set(key, c);
      }
      const waiting = [...latest.values()]
        .filter((c) => c.thread.state === "open" && me && String(c.thread.author).toLowerCase() === me && !c.mine)
        .map((c) => ({ c, days: ageDays(nowTime, c.at) }))
        .filter((r) => r.days >= SUGGEST_WAITING_DAYS)
        .sort((a, b) => b.days - a.days);
      if (waiting.length < 2) return null;
      const o = waiting[0];
      return {
        tone: "info",
        targets: waiting.slice(0, SUGGEST_TARGETS).map((r) => ref(`${r.c.thread.repo} #${r.c.thread.number}: ${r.c.author}, ${plural(Math.floor(r.days), "day")} ago`, r.c.thread.repo, r.c.thread.number)),
        seen: `${waiting.length} open issues or pull requests you opened end with a reply from someone else, ${SUGGEST_WAITING_DAYS} or more days old. Oldest: ${o.c.thread.repo} #${o.c.thread.number}, from ${o.c.author}, ${plural(Math.floor(o.days), "day")} ago.`,
        act: [["Reply, resolve, or close each thread. If one no longer needs you, close it with a note so nobody keeps waiting."]],
      };
    },
  },
  {
    id: "batch-by-repo", area: "Focus", source: "Recent events", patterns: ["sessions-cross-repos"],
    title: "Give each repository its own block of time",
    check: ({ sessions }) => {
      if (!sessions) return { unavailable: "Recent events did not load." };
      if (sessions.multi < 4) return { short: `Needs 4 work sessions with several events; ${sessions.multi} found.` };
      if (sessions.multiRepo / sessions.multi < 0.5) return null;
      return {
        tone: "info",
        basis: `${plural(sessions.multi, "work session")} with several events`,
        seen: `${sessions.multiRepo} of ${plural(sessions.multi, "work session")} crossed repositories. A session is a run of events with gaps under an hour.`,
        why: [
          ["Developers describe productive days as finishing tasks without many interruptions or context switches, although when observed they switched often and still felt productive.", "meyer-2014"],
          ["In a lab study, interrupted people finished faster with no loss of quality, but reported more stress, frustration, time pressure, and effort.", "mark-2008"],
        ],
        act: [["Work one repository per block, and batch cross-repository chores such as dependency bumps into one session."]],
      };
    },
  },
  {
    id: "re-entry-notes", area: "Focus", source: "Contribution year", patterns: ["restart-after-break"],
    title: "Leave yourself a next step before a break",
    check: ({ trajectory: t }) => {
      if (!t) return { unavailable: "The contribution calendar did not load." };
      if (!t.afterActive || !t.afterIdle) return { short: "Needs at least 10 days after active days and 10 after idle days." };
      if (t.afterActive.rate - t.afterIdle.rate < 0.3 - RATIO_EPSILON) return null;
      return {
        tone: "info",
        basis: `${plural(t.afterActive.days + t.afterIdle.days, "day")} in the contribution year`,
        seen: `After an active day you were active again ${share(t.afterActive.rate)} of the time; after an idle day, ${share(t.afterIdle.rate)}. Restarting is the harder step.`,
        why: [["Across 10,000 recorded sessions, programmers resumed editing within a minute of an interruption only 10% of the time, and used several strategies to rebuild context.", "parnin-2011"]],
        act: [["Before you stop, write the next concrete step in the issue or pull request, or leave a failing test, so the first move back is obvious."]],
      };
    },
  },
  {
    id: "late-night-review", area: "Focus", source: "Recent events",
    title: "Review late-night changes the next day",
    check: ({ sessions, outcomes }) => {
      if (!sessions) return { unavailable: "Recent events did not load." };
      if (sessions.timed < 20) return { short: `Needs 20 timed events; ${sessions.timed} loaded.` };
      if (sessions.lateNight < 5 || sessions.lateNight / sessions.timed < SUGGEST_LATE_SHARE) return null;
      return {
        tone: "info",
        basis: `${plural(sessions.timed, "timed event")}`,
        seen: `${share(sessions.lateNight / sessions.timed)} of loaded events (${sessions.lateNight.toLocaleString()}) happened between midnight and 4am, local time.${reworkNote(outcomes, "late")}`,
        why: [["In the Linux kernel, PostgreSQL, and X.org server histories, commits made between midnight and 4am were significantly buggier.", "eyolfson-2014"]],
        act: [["Open late-night work as a draft and read the diff the next day before merging."]],
      };
    },
  },
  {
    id: "ci-notifications", area: "Notifications", source: "Unread notifications",
    title: "Get Actions notifications only for failures",
    check: ({ notes, notesNote }) => {
      if (!notes) return { unavailable: notesNote || "Unread notifications did not load." };
      if (notes.unread < 10) return { short: `Needs 10 unread notifications; ${notes.unread} loaded.` };
      if (notes.ciNoise / notes.unread < SUGGEST_CI_SHARE) return null;
      return {
        tone: "info",
        basis: `${plural(notes.unread, "unread notification")}`,
        seen: `${notes.ciNoise} of ${plural(notes.unread, "unread notification")}${notesNote ? " on the first page" : ""} are routine CI updates.`,
        act: [["In GitHub's notification settings, under GitHub Actions, choose Only notify for failed workflows.", "gh-notifications"]],
      };
    },
  },
  {
    id: "labels-not-prefixes", area: "Issues", source: "Recent events",
    title: "Use labels instead of title prefixes",
    check: ({ ev }) => {
      if (!ev) return { unavailable: "Recent events did not load." };
      const n = sum(ev.tags.map(([, k]) => k));
      if (n < 3) return null;
      return {
        tone: "info",
        basis: `${plural(n, "issue")} you opened in the loaded events`,
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
      const known = footprint.rows.filter((r) => r.uniques != null && r.stars14 != null);
      if (!known.length) return { unavailable: "Traffic or star dates did not load for your repositories." };
      const quiet = known.filter((r) => r.uniques >= FOOTPRINT_MIN_VISITORS && r.stars14 === 0)
        .sort((a, b) => b.uniques - a.uniques);
      if (!quiet.length) return null;
      const o = quiet[0];
      return {
        tone: "info",
        basis: `14-day traffic for ${plural(known.length, "repository", "repositories")}`,
        targets: quiet.slice(0, SUGGEST_TARGETS).map((r) => ref(`${r.repo}: ${r.uniques.toLocaleString()} unique visitors, no new stars`, r.repo)),
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
      if (token.kind === "none") return { unavailable: "No token is saved." };
      if (token.kind !== "classic") return null;
      if (!token.write) return { unavailable: "GitHub has not reported this token's scopes." };
      if (!token.write.length) return null;
      const scopes = `${token.write.length === 1 ? "a scope that allows" : "scopes that allow"} writes: ${token.write.join(", ")}`;
      // With a fine-grained token saved beside it, the classic token is only needed for what the
      // fine-grained one cannot read.
      if (token.paired) {
        return {
          tone: "warn",
          title: "Narrow the classic token",
          seen: `The classic token saved beside your fine-grained token has ${scopes}. Activity Desk only reads.`,
          why: [["GitHub recommends fine-grained tokens over classic ones whenever possible.", "gh-pat"]],
          act: [["If you keep the classic token only for the unread inbox, replace it with one that has just the notifications scope, then revoke the old one. Keep a wider scope only for organization or private data the fine-grained token cannot reach."]],
        };
      }
      return {
        tone: "warn",
        seen: `This classic token has ${scopes}. Activity Desk only reads.`,
        why: [["GitHub recommends fine-grained tokens over classic ones whenever possible.", "gh-pat"]],
        act: [["Create a fine-grained token with only the read permissions in Quick start and sign in with it. Keep a classic token with just the notifications scope beside it if you want the unread inbox, and revoke this one."]],
      };
    },
  },
];

// Suggestions built on the loaded summaries. Returns the suggestions that apply and, for every rule,
// whether it was shown, folded into another, found nothing, lacked data, or lacked a source, so the
// view can say what it checked. `links` maps a Patterns finding id to the suggestion that acts on it.
// ---------- Card states ----------
// The number each suggestion's advice should move, read the same way whether or not the card shows,
// so a card marked "trying" can report the number then against now even after it stops appearing.
// Every number here is better lower. Each needs the minimum sample its finding uses.
const SUGGESTION_METRICS = {
  "trace-follow-up-fixes": ({ outcomes: o }) => o && o.rework.settled >= REWORK_MIN_SETTLED && { label: "Merges followed by a fix", value: o.rework.rate, unit: "share" },
  "limit-open-work": ({ outcomes: o }) => o?.baseline && { label: "Median time to merge", value: o.baseline.medianHours, unit: "hours" },
  "merge-finished-work": ({ outcomes: o }) => o?.split && o.split.waitingShare != null && { label: "Open hours after the last commit", value: o.split.waitingShare, unit: "share" },
  "review-before-merge": ({ review: r }) => r && r.merged >= SUGGEST_MIN_MERGES && { label: "Merges with no review from another person", value: r.noHuman / r.merged, unit: "share" },
  "review-agent-branches": ({ prPatterns: p }) => p && p.agent.count >= SUGGEST_MIN_MERGES && { label: "Agent-branch merges with no recorded review", value: p.agent.unreviewed / p.agent.count, unit: "share" },
  "faster-first-review": ({ review: r }) => r && r.withHumanReview >= 3 && r.medianFirstReviewHours != null && { label: "Median wait for a first review", value: r.medianFirstReviewHours, unit: "hours" },
  "answer-review-requests": ({ collab: c }) => c && c.outTimed >= SUGGEST_OUT_MIN && c.outMedianHours != null && { label: "Median time to your first review of others' work", value: c.outMedianHours, unit: "hours" },
  "spread-reviews": ({ review: r }) => r && r.withHumanReview >= 4 && r.topReviewerShare != null && { label: "Reviews by your most frequent reviewer", value: r.topReviewerShare, unit: "share" },
  "smaller-prs": ({ prPatterns: p }) => p && p.merged >= SUGGEST_MIN_MERGES && p.all.medianSize != null && { label: "Median lines per merge", value: p.all.medianSize, unit: "lines" },
  "settle-stale-prs": ({ outcomes: o, prPatterns: p }) => (o?.baseline
    ? { label: "Open pull requests past your usual merge time", value: o.overdue.length, unit: "count" }
    : p && { label: "Open pull requests older than two weeks", value: p.stale, unit: "count" }),
  "branches-without-prs": ({ follow: f }) => f && f.settled >= 4 && { label: "Branches without a pull request", value: f.withoutPr.length, unit: "count" },
};
// Cards that can never be snoozed or dismissed: write access on a token is never noise.
const PINNED_SUGGESTIONS = new Set(["fine-grained-token"]);
const SNOOZE_DAYS = [7, 30];
// A dismissed card comes back when its number is clearly worse than when it was dismissed: a quarter
// higher, and by more than a small floor for its unit, so a count of 1 becoming 2 is not enough alone.
const WORSE_FLOOR = { share: 0.1, hours: 12, lines: 100, count: 2 };
const metricText = (m, value) => (m.unit === "share" ? share(value) : m.unit === "hours" ? durationLabel(value)
  : m.unit === "lines" ? `${Math.round(value).toLocaleString()} lines` : Math.round(value).toLocaleString());
// A saved number is compared with today's only when both measure the same thing. One rule can switch
// measures as data grows, such as settle-stale-prs moving from a two-week cutoff to your own merges.
const sameMeasure = (saved, current) => Boolean(saved && current && saved.unit === current.unit && saved.label === current.label);
function clearlyWorse(unit, then, now) {
  return Number.isFinite(then) && Number.isFinite(now) && now - then > (WORSE_FLOOR[unit] ?? 0) && now >= then * 1.25;
}

// A card being tried reads its weekly snapshots when saved history has them. Each rule maps to the
// snapshot number that measures the same thing, in the same unit as SUGGESTION_METRICS.
const TRIAL_SNAPSHOTS = {
  "trace-follow-up-fixes": { key: "reworkRate", unit: "share" },
  "limit-open-work": { key: "medianMergeHours", unit: "hours" },
  "merge-finished-work": { key: "waitingShare", unit: "share" },
};
const TRIAL_POINTS = 6;
// The UTC Monday of a time, the same week key the main process saves snapshots under.
function weekOf(at) {
  const t = Date.parse(at);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}
// The weekly series for a trial: the last saved week at or before the trial started, then every week
// since. Null unless at least two weeks are known, so a single number never reads as a trend. Long
// series keep the start and the latest weeks.
function trialSeries(id, at, snapshots) {
  const map = TRIAL_SNAPSHOTS[id];
  const start = weekOf(at);
  if (!map || !start || !snapshots?.rows) return null;
  const points = snapshots.rows.find((r) => r.key === map.key)?.points || [];
  const before = points.filter((p) => p.week <= start).pop();
  const after = points.filter((p) => p.week > start);
  const series = before ? [before, ...after] : after;
  if (series.length < 2) return null;
  const shown = series.length > TRIAL_POINTS ? [series[0], null, ...series.slice(-(TRIAL_POINTS - 2))] : series;
  const text = (v) => metricText({ unit: map.unit }, v);
  return {
    key: map.key, start: series[0].week, before: series[0].week < start, weeks: series.length,
    values: shown.map((p) => (p ? { week: p.week, text: text(p.value) } : null)),
    better: series[series.length - 1].value < series[0].value,
    same: series[series.length - 1].value === series[0].value,
  };
}

// ---------- One repository at a time ----------
// Rules that read the Events feed, the contribution calendar, notifications, conversations, traffic, or
// the token describe the whole account, so a repository view shows them unchanged and says so.
const ACCOUNT_RULES = new Set(["branches-without-prs", "answer-waiting-threads", "batch-by-repo",
  "re-entry-notes", "late-night-review", "ci-notifications", "labels-not-prefixes", "readme-first-screen", "fine-grained-token"]);
const SCOPE_MIN_MERGES = SUGGEST_MIN_MERGES;

// Repositories where you merged enough loaded pull requests to scope Suggestions to, busiest first.
function scopeRepos(prInfo, login) {
  const me = String(login || "").toLowerCase();
  const counts = new Map();
  for (const pr of Object.values(prInfo || {})) {
    if (!pr?.repo || String(pr.author || "").toLowerCase() !== me) continue;
    const c = counts.get(pr.repo) || { repo: pr.repo, opened: 0, merged: 0 };
    c.opened += 1;
    if (pr.merged) c.merged += 1;
    counts.set(pr.repo, c);
  }
  return [...counts.values()].filter((c) => c.merged >= SCOPE_MIN_MERGES)
    .sort((a, b) => b.merged - a.merged || a.repo.localeCompare(b.repo));
}

// The loaded pull requests in one repository, keyed as before, for running the same summaries on.
function scopePullRequests(prInfo, repo) {
  return Object.fromEntries(Object.entries(prInfo || {}).filter(([, pr]) => pr?.repo === repo));
}

// A card's state is kept per view: the rule id in the account view, rule@owner/repo in a repository
// view. Account-wide rules keep one state in every view, since they show the same thing in each.
const cardKey = (id, scope) => (scope && !ACCOUNT_RULES.has(id) ? `${id}@${scope}` : id);

// Sorts suggestions by what the user said about each card: trying, snoozed until a date, or
// dismissed. `states` maps a card key to { state, at, until, metric } as the main process saved it.
// `snapshots` is summarizeSnapshots' result. It is account-wide, so a repository view ignores it.
function applyCardStates(suggestions, allStates, now, scope = null, snapshots = null) {
  const nowTime = now == null ? Date.now() : new Date(now).getTime();
  const all = allStates && typeof allStates === "object" ? allStates : {};
  // This view's states, by rule id. A key for another view is left alone.
  const saved = {};
  for (const [key, st] of Object.entries(all)) {
    const id = key.split("@")[0];
    if (cardKey(id, scope) === key) saved[id] = st;
  }
  const byId = new Map(suggestions.items.map((i) => [i.id, i]));
  const items = [];
  const trying = [];
  const snoozed = [];
  const dismissed = [];
  const checked = suggestions.checked.map((c) => ({ ...c }));
  for (const item of suggestions.items) {
    const st = saved[item.id];
    const pinned = PINNED_SUGGESTIONS.has(item.id);
    if (!st || pinned) { items.push(item); continue; }
    if (st.state === "trying") {
      const then = sameMeasure(st.metric, item.metric) ? metricText(st.metric, st.metric.value) : null;
      items.push({ ...item, trying: { ...st, then, now: item.metric ? metricText(item.metric, item.metric.value) : null } });
      continue;
    }
    if (st.state === "snoozed" && Date.parse(st.until) > nowTime) { snoozed.push({ ...item, until: st.until }); continue; }
    if (st.state === "dismissed") {
      const m = item.metric;
      if (sameMeasure(st.metric, m) && clearlyWorse(m.unit, st.metric.value, m.value)) {
        items.push({ ...item, returned: { at: st.at, then: metricText(m, st.metric.value), now: metricText(m, m.value), label: m.label } });
      } else {
        dismissed.push({ ...item, dismissedAt: st.at });
      }
      continue;
    }
    items.push(item);
  }
  // A card being tried is listed even after its rule stops firing, with its number then and now.
  for (const [id, st] of Object.entries(saved)) {
    if (st?.state !== "trying") continue;
    const shown = items.find((i) => i.id === id);
    const check = checked.find((c) => c.id === id);
    if (!check) continue;
    const metric = (shown || byId.get(id))?.metric || check.metric || null;
    const same = sameMeasure(st.metric, metric);
    trying.push({
      id, key: cardKey(id, scope), title: check.title, at: st.at, showing: Boolean(shown), status: check.status,
      then: same ? metricText(metric, st.metric.value) : null,
      now: metric ? metricText(metric, metric.value) : null,
      label: metric?.label || st.metric?.label || null,
      // The measure changed since you started, so the saved number is named but not compared.
      started: st.metric && metric && !same ? { label: st.metric.label, value: metricText(st.metric, st.metric.value) } : null,
      better: same ? metric.value < st.metric.value : null,
      series: scope ? null : trialSeries(id, st.at, snapshots),
      weekly: !scope && Boolean(TRIAL_SNAPSHOTS[id]),
    });
  }
  for (const c of checked) {
    const st = saved[c.id];
    if (!st || PINNED_SUGGESTIONS.has(c.id)) continue;
    if (snoozed.some((x) => x.id === c.id)) Object.assign(c, { status: "snoozed", detail: `Snoozed until ${String(snoozed.find((x) => x.id === c.id).until).slice(0, 10)}.` });
    if (dismissed.some((x) => x.id === c.id)) Object.assign(c, { status: "dismissed", detail: `Dismissed ${String(st.at).slice(0, 10)}. It comes back if its number gets clearly worse.` });
  }
  // Cards being tried lead, then the order deriveSuggestions chose. A finding links only to a card shown.
  items.sort((a, b) => Number(Boolean(b.trying)) - Number(Boolean(a.trying)));
  const showing = new Set(items.map((i) => i.id));
  const links = Object.fromEntries(Object.entries(suggestions.links || {}).filter(([, l]) => showing.has(l.id)));
  const keyed = (x) => ({ ...x, key: cardKey(x.id, scope) });
  return { ...suggestions, items: items.map(keyed), trying, snoozed: snoozed.map(keyed), dismissed: dismissed.map(keyed), checked, links, scope };
}

// Where lines as text, with an aligned list of what each one names on github.com (or null).
const REF_REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
function whereLines(list) {
  const lines = (list || []).slice(0, SUGGEST_TARGETS);
  return {
    targets: lines.map((t) => (typeof t === "string" ? t : t.text)),
    refs: lines.map((t) => (t && typeof t === "object" && REF_REPO.test(t.repo || "") ? { repo: t.repo, number: t.number } : null)),
  };
}

// In the public view, pull requests come from GitHub's public search, which leaves out what these rules
// read, and some sources are never public. These rules say what they need instead of reading as "not
// enough data" or as a source that failed.
const SEARCH_LACKS = (what) => `Needs a token. GitHub's public search lists pull requests without ${what}.`;
const PUBLIC_NEEDS = {
  "review-before-merge": SEARCH_LACKS("reviews"), "review-agent-branches": SEARCH_LACKS("branch names and reviews"),
  "faster-first-review": SEARCH_LACKS("reviews"), "answer-review-requests": SEARCH_LACKS("your reviews of other people's pull requests"),
  "spread-reviews": SEARCH_LACKS("reviews"), "smaller-prs": SEARCH_LACKS("pull request sizes"), "merge-finished-work": SEARCH_LACKS("commit times"),
  "branches-without-prs": `${SEARCH_LACKS("branch names")} A branch cannot be matched to its pull request.`,
  "answer-waiting-threads": "Needs a token. Conversations are read only with one.",
  "re-entry-notes": "Needs a token. GitHub's API returns the contribution calendar only to a signed-in request.",
  "readme-first-screen": "Needs a token. Repository traffic is never public.",
};

function deriveSuggestions(input) {
  // Follow-up comparisons are judged by the page's chance budget when the caller passes one.
  const x = input ? { ...input, outcomes: withBudget(input.outcomes, input.chance) } : {};
  const me = String(x.login || "").toLowerCase();
  const nowTime = x.now == null ? Date.now() : new Date(x.now).getTime();
  const shown = new Map();
  const checked = [];
  for (const rule of SUGGESTION_RULES) {
    const result = x.publicView && PUBLIC_NEEDS[rule.id] ? { unavailable: PUBLIC_NEEDS[rule.id] } : rule.check(x, { me, nowTime });
    const measured = SUGGESTION_METRICS[rule.id]?.(x);
    const metric = measured && Number.isFinite(measured.value) ? measured : null;
    const accountWide = Boolean(x.scope) && ACCOUNT_RULES.has(rule.id);
    const base = { id: rule.id, area: rule.area, source: result?.source || rule.source, title: rule.title, metric, pinned: PINNED_SUGGESTIONS.has(rule.id), accountWide };
    if (!result) checked.push({ ...base, status: "clear" });
    else if (result.unavailable) checked.push({ ...base, status: "unavailable", detail: result.unavailable });
    else if (result.short) checked.push({ ...base, status: "short", detail: x.scope && !accountWide ? `${result.short} Counted in ${x.scope} only.` : result.short });
    else {
      shown.set(rule.id, { ...base, title: result.title || rule.title, tone: result.tone, seen: result.seen, why: result.why || [], act: result.act || [],
        more: result.more || [], basis: result.basis || "", ...whereLines(result.targets),
        confirmed: Boolean(result.confirmed), patterns: rule.patterns || [], also: [], folded: [] });
      checked.push({ ...base, title: result.title || rule.title, status: "shown" });
    }
  }
  // Two rules that end in the same advice read as one suggestion: the folded rule adds what it saw
  // (kept apart in `also`), its reasons, and its first target, and the list of checks says where it went.
  for (const rule of SUGGESTION_RULES) {
    const from = rule.fold && shown.get(rule.id);
    const into = rule.fold && shown.get(rule.fold);
    if (!from || !into) continue;
    shown.delete(rule.id);
    into.also.push(from.seen);
    into.why = [...into.why, ...from.why.filter((w) => !into.why.some((v) => v[0] === w[0]))];
    into.more = [...into.more, ...from.more];
    if (from.targets.length) {
      into.targets = [...into.targets.slice(0, SUGGEST_TARGETS - 1), from.targets[0]];
      into.refs = [...into.refs.slice(0, SUGGEST_TARGETS - 1), from.refs[0]];
    }
    into.patterns = [...new Set([...into.patterns, ...from.patterns])];
    if (from.tone === "warn") into.tone = "warn";
    into.folded.push(from.title);
    Object.assign(checked.find((c) => c.id === rule.id), { status: "folded", detail: `Shown inside "${into.title}", which ends in the same advice.` });
  }
  const findings = (x.observations || []).filter((o) => o && o.id);
  const links = {};
  const items = [...shown.values()].map(({ more, patterns, ...item }) => {
    // Number the sources in the order the text cites them, then any further reading.
    const cited = [...item.why, ...item.act].flatMap((segment) => segment.slice(1));
    const reading = [...new Set([...cited, ...more])].filter((id) => Object.hasOwn(READING, id));
    const from = findings.filter((o) => patterns.includes(o.id)).map((o) => ({ id: o.id, title: o.title }));
    for (const f of from) if (!links[f.id]) links[f.id] = { id: item.id, title: item.title };
    return { ...item, reading, patterns: from };
  });
  // Warnings first. Within a tone, a suggestion whose pattern passed a chance check comes first.
  const rank = { warn: 0, info: 1 };
  items.sort((a, b) => rank[a.tone] - rank[b.tone] || Number(b.confirmed) - Number(a.confirmed));
  return { items, checked, links };
}

// ---------- Review requests waiting on you ----------
// Open pull requests that ask you for a review, from the search GitHub keeps for review-requested:you.
// A re-request restarts the clock. For teams, show the oldest of the current asks as an estimate,
// since the search identifies the PR but does not say which pending team included you.
const REQUEST_LATE_HOURS = 24; // Google's one-business-day guideline, rounded to a day, as elsewhere
const isTeamReviewer = (r) => r?.__typename === "Team" || r?.__typename === "EnterpriseTeam";
function summarizeReviewRequests(search, login, now) {
  if (!search || !Array.isArray(search.nodes)) return null;
  const me = String(login || "").toLowerCase();
  const nowTime = now == null ? Date.now() : new Date(now).getTime();
  const items = [];
  for (const n of search.nodes) {
    const repo = n?.repository?.nameWithOwner;
    if (!n || n.__typename !== "PullRequest" || typeof repo !== "string" || !Number.isInteger(n.number) || !validTime(n.createdAt)) continue;
    const reviewers = (n.reviewRequests?.nodes || []).map((r) => r?.requestedReviewer).filter(Boolean);
    const direct = reviewers.some((r) => r.__typename === "User" && String(r.login || "").toLowerCase() === me);
    const events = (n.timelineItems?.nodes || []).filter((e) => e && validTime(e.createdAt))
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    const pick = direct
      ? events.find((e) => e.requestedReviewer?.__typename === "User" && String(e.requestedReviewer.login || "").toLowerCase() === me)
      : reviewers.filter((r) => isTeamReviewer(r) && r.id)
        .map((r) => events.find((e) => isTeamReviewer(e.requestedReviewer) && e.requestedReviewer.id === r.id))
        .filter(Boolean).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))[0];
    const at = pick ? pick.createdAt : n.createdAt;
    items.push({
      repo, number: n.number, title: String(n.title || ""), author: n.author?.login || "ghost",
      authorBot: n.author?.__typename === "Bot" || isBotLogin(n.author?.login), draft: Boolean(n.isDraft),
      lines: (Number(n.additions) || 0) + (Number(n.deletions) || 0), direct, at, since: pick ? (direct ? "request" : "team-estimate") : "opened",
      hours: Math.max(0, (nowTime - Date.parse(at)) / 36e5),
    });
  }
  items.sort((a, b) => b.hours - a.hours);
  return {
    items,
    loaded: items.length,
    total: Number.isInteger(search.issueCount) ? Math.max(search.issueCount, items.length) : items.length,
    direct: items.filter((r) => r.direct).length,
    late: items.filter((r) => r.hours >= REQUEST_LATE_HOURS).length,
    lateDirect: items.filter((r) => r.direct && r.hours >= REQUEST_LATE_HOURS).length,
  };
}

// Everything in the loaded data that waits on you: review requests, threads whose latest reply is
// someone else's, and your open pull requests whose latest review from another person asked for changes.
function summarizeWaiting({ requests, conversations, prInfo, login, now } = {}) {
  const me = String(login || "").toLowerCase();
  const nowTime = now == null ? Date.now() : new Date(now).getTime();
  const replies = conversations ? conversations.items.filter((c) => c.awaiting)
    .map((c) => ({ repo: c.thread.repo, number: c.thread.number, title: c.thread.title, isPr: c.thread.isPr, author: c.author, at: c.at,
      hours: Math.max(0, (nowTime - Date.parse(c.at)) / 36e5), kind: c.kind, yours: me && c.thread.author.toLowerCase() === me }))
    .sort((a, b) => b.hours - a.hours) : null;
  const changes = [];
  let unsure = 0;
  for (const pr of Object.values(prInfo || {})) {
    if (!pr?.title || pr.state !== "OPEN" || String(pr.author || "").toLowerCase() !== me || !Array.isArray(pr.reviewList)) continue;
    const verdicts = pr.reviewList.filter((r) => !r.bot && r.login && r.login.toLowerCase() !== me && validTime(r.at) &&
      (r.state === "approved" || r.state === "changes_requested")).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    if (verdicts[0]?.state !== "changes_requested") continue;
    // Only the first 10 reviews are read, so a later approval could be missing.
    if (pr.reviews > pr.reviewList.length) { unsure += 1; continue; }
    changes.push({ repo: pr.repo, number: pr.number, title: pr.title, author: verdicts[0].login, at: verdicts[0].at,
      hours: Math.max(0, (nowTime - Date.parse(verdicts[0].at)) / 36e5) });
  }
  changes.sort((a, b) => b.hours - a.hours);
  const reviews = requests ? requests.items : null;
  const count = (reviews?.length || 0) + (replies?.length || 0) + changes.length;
  return { reviews, replies, changes, unsure, count };
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
  awaiting: (c) => Boolean(c.awaiting),
};

// The conversation request runs one search for issues and one for pull requests. Each kind reports
// its own counts, and null when GitHub did not return that search.
const CONVERSATION_SEARCHES = ["issues", "pullRequests"];

function flattenConversations(data, login) {
  const me = String(login || "").toLowerCase();
  const searches = {};
  const seen = new Set();
  const nodes = [];
  for (const key of CONVERSATION_SEARCHES) {
    const search = data && data[key];
    if (!Array.isArray(search?.nodes)) { searches[key] = null; continue; }
    const usable = search.nodes.filter((n) => n && n.repository && Number.isInteger(n.number));
    for (const n of usable) {
      const id = `${n.repository.nameWithOwner}#${n.number}`;
      if (!seen.has(id)) { seen.add(id); nodes.push(n); }
    }
    searches[key] = { loaded: usable.length, matched: Number.isInteger(search.issueCount) ? search.issueCount : usable.length };
  }
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
  // A thread awaits your reply when it is open, you opened it or wrote in it, and its latest comment from
  // a person, not a bot, is someone else's. That latest comment is marked, so each thread counts once.
  const joined = new Set(valid.filter((c) => c.mine).map((c) => `${c.thread.repo}#${c.thread.number}`));
  const latest = new Set();
  for (const c of valid) {
    const key = `${c.thread.repo}#${c.thread.number}`;
    if (c.bot || latest.has(key)) continue;
    latest.add(key);
    const yours = joined.has(key) || (me && c.thread.author.toLowerCase() === me);
    if (!c.mine && c.thread.state === "open" && yours) c.awaiting = true;
  }
  const found = CONVERSATION_SEARCHES.map((key) => searches[key]).filter(Boolean);
  return {
    items: valid,
    threads: nodes.length,
    matched: found.reduce((sum, s) => sum + s.matched, 0),
    searches,
    usable: found.length > 0,
    truncated,
  };
}

function filterConversations(items, filter, repo, query) {
  const f = CONVERSATION_FILTERS[filter] || CONVERSATION_FILTERS.all;
  const q = String(query || "").trim().toLowerCase();
  return (items || []).filter((c) => f(c) && (!repo || c.thread.repo === repo) &&
    (!q || `${c.thread.repo} ${c.thread.title} ${c.author} ${c.body} ${c.path || ""}`.toLowerCase().includes(q)));
}

// ---------- Written text behind an event ----------
// A comment, a review, or the description of an issue or pull request the event opened. It comes from
// the event payload when GitHub includes it. A comment event without one is matched to your comment in
// the loaded conversations: same kind, thread, and author, created within two minutes of the event.
const TEXT_LIMIT = 20000;
const TEXT_MATCH_MS = 120000;
const COMMENT_EVENTS = {
  IssueCommentEvent: { kind: "comment", label: "Comment", always: true },
  PullRequestReviewCommentEvent: { kind: "inline", label: "Review comment", always: true },
  CommitCommentEvent: { kind: null, label: "Commit comment", always: true },
  PullRequestReviewEvent: { kind: "review", label: "Review", always: false },
};

// Removing a comment can join the surrounding text into a new opener. Bound the number of
// rescans and withhold text with unresolved markup so hidden content cannot become visible.
const COMMENT_STRIP_PASSES = 8;
function stripHtmlComments(text) {
  for (let pass = 0; pass < COMMENT_STRIP_PASSES; pass += 1) {
    if (!text.includes("<!--")) return text;
    text = text.replace(/<!--[\s\S]*?(?:-->|$)/g, "");
  }
  return text.includes("<!--") ? "" : text;
}

// Line endings normalized, hidden HTML comments and runs of blank lines removed.
function cleanText(value) {
  return stripHtmlComments(String(value).replace(/\r\n?/g, "\n")).replace(/\n{3,}/g, "\n\n").trim();
}

// Cleaned text, cut at TEXT_LIMIT characters with the remainder counted, or null when nothing is left.
function textInfo(label, raw, source) {
  const text = cleanText(raw ?? "");
  if (!text) return null;
  const clipped = Math.max(0, text.length - TEXT_LIMIT);
  return { label, text: clipped ? text.slice(0, TEXT_LIMIT) : text, clipped, source };
}

// Your own comments in the loaded conversations, keyed by kind and thread.
function conversationIndex(items, login) {
  const me = String(login || "").toLowerCase();
  const index = new Map();
  for (const c of items || []) {
    if (!c || !c.body || String(c.author).toLowerCase() !== me) continue;
    const key = `${c.kind}|${c.thread.repo}#${c.thread.number}`;
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(c);
  }
  return index;
}

// { label, text, clipped, source: "event" | "conversation" } when the text is known,
// { label, missing: true } for a comment whose text GitHub did not send, or null when there is no text.
// Cleaned once per event and conversation index, since Stream renders and searches on every keystroke.
// Loaded events are not changed afterwards, and callers only read the result.
const eventTexts = new WeakMap();
function eventText(event, index) {
  if (!event || typeof event !== "object") return findEventText(event, index);
  const hit = eventTexts.get(event);
  if (hit && hit.index === index) return hit.value;
  const value = findEventText(event, index);
  eventTexts.set(event, { index, value });
  return value;
}

function findEventText(event, index) {
  const p = (event && event.payload) || {};
  const type = event && event.type;
  const comment = COMMENT_EVENTS[type];
  let holder;
  let label;
  if (comment) { holder = type === "PullRequestReviewEvent" ? p.review : p.comment; label = comment.label; }
  else if (type === "IssuesEvent" && p.action === "opened") { holder = p.issue; label = "Issue description"; }
  else if (type === "PullRequestEvent" && p.action === "opened") { holder = p.pull_request; label = "Pull request description"; }
  else return null;
  if (holder && typeof holder.body === "string") return textInfo(label, holder.body, "event");
  // The object arrived with an empty body, or this is a description GitHub left out.
  if ((holder && holder.body === null) || !comment) return null;
  const number = type === "IssueCommentEvent" ? p.issue?.number : p.pull_request?.number;
  const at = Date.parse(event.created_at);
  const candidates = comment.kind && index ? index.get(`${comment.kind}|${repoName(event)}#${number}`) : null;
  let best = null;
  for (const c of candidates || []) {
    const gap = Math.abs(Date.parse(c.at) - at);
    if (gap <= TEXT_MATCH_MS && (!best || gap < best.gap)) best = { c, gap };
  }
  if (best) return textInfo(label, best.c.body, "conversation");
  return comment.always ? { label, missing: true } : null;
}

const MINOR_PR_ACTIONS = new Set(["labeled", "unlabeled", "synchronize", "assigned", "unassigned", "review_requested", "review_request_removed", "edited"]);
function isMinor(event) {
  const p = (event && event.payload) || {};
  return (event.type === "PullRequestEvent" || event.type === "IssuesEvent") && MINOR_PR_ACTIONS.has(p.action);
}

// Search text covers the repository, the description, the branch, and any comment text.
function filterEvents(events, filter, repo, query, hideMinor, prInfo, index) {
  const f = FILTERS[filter] || FILTERS.all;
  const q = String(query || "").trim().toLowerCase();
  return (events || []).filter((e) => f(e) && (!hideMinor || !isMinor(e)) && (!repo || repoName(e) === repo) &&
    (!q || `${repoName(e)} ${describeEvent(e, prInfo)} ${branchOf(e)} ${eventText(e, index)?.text || ""}`.toLowerCase().includes(q)));
}

// ---------- Pull request details, token metadata, and rate limits ----------
// One shape for a pull request from either the authored search or the event-referenced lookup.
// Returns null when GitHub left out the fields the summaries depend on.
function normalizePullRequest(pr, repo, number, source) {
  if (!pr || typeof pr.title !== "string" || !Number.isInteger(pr.reviews?.totalCount)) return null;
  const { timelineItems, ...rest } = pr;
  return {
    ...rest, repo, number, source, ...timelineOf(timelineItems),
    headRef: pr.headRefName, author: pr.author?.login, mergedBy: pr.mergedBy?.login,
    authorBot: pr.author?.__typename === "Bot" || isBotLogin(pr.author?.login),
    reviews: pr.reviews.totalCount,
    reviewList: (Array.isArray(pr.reviews.nodes) ? pr.reviews.nodes : []).map((r) => ({
      login: r?.author?.login || "", at: r?.submittedAt,
      state: typeof r?.state === "string" ? r.state.toLowerCase() : null,
      bot: r?.author?.__typename === "Bot" || isBotLogin(r?.author?.login),
    })),
  };
}

// A pull request from the public search, shaped by the main process. Search has no reviews, sizes,
// branch, merger, or commits, so those stay null and every summary treats them as unknown.
function normalizeSearchPullRequest(item) {
  if (!item || typeof item.repo !== "string" || !Number.isInteger(item.number) || typeof item.title !== "string" || !validTime(item.createdAt)) return null;
  const merged = validTime(item.mergedAt);
  return {
    repo: item.repo, number: item.number, source: "public-search", title: item.title,
    state: item.state === "open" ? "OPEN" : merged ? "MERGED" : "CLOSED", merged, isDraft: Boolean(item.draft),
    createdAt: item.createdAt, mergedAt: merged ? item.mergedAt : null, closedAt: validTime(item.closedAt) ? item.closedAt : null,
    author: item.author, authorBot: item.authorType === "Bot" || isBotLogin(item.author), mergedBy: null,
    additions: null, deletions: null, headRef: null, reviews: null, reviewList: null, readyAt: null, requests: null,
  };
}

// When review could start on a pull request: the first time a draft was marked ready, and each review
// request with its time and the requested login (null for a team). Null when the timeline was not read.
const validTime = (at) => typeof at === "string" && Number.isFinite(Date.parse(at));
function timelineOf(items) {
  const nodes = Array.isArray(items?.nodes) ? items.nodes.filter(Boolean) : null;
  if (!nodes) return { readyAt: null, requests: null };
  const ready = nodes.filter((n) => n.__typename === "ReadyForReviewEvent" && validTime(n.createdAt))
    .map((n) => n.createdAt).sort((a, b) => Date.parse(a) - Date.parse(b));
  const requests = nodes.filter((n) => n.__typename === "ReviewRequestedEvent" && validTime(n.createdAt)).map((n) => ({
    login: n.requestedReviewer?.__typename === "User" && typeof n.requestedReviewer.login === "string" ? n.requestedReviewer.login : null,
    at: n.createdAt,
  }));
  return { readyAt: ready[0] || null, requests, timelineCapped: Number.isInteger(items.totalCount) && items.totalCount > nodes.length };
}

// Where the wait for a review starts. For a pull request as a whole it is when it was ready for review:
// when a draft was first marked ready, if that came before the review, or else when it opened. For one
// reviewer it is the earliest request to that person before their review, when there is one, since the
// clock for answering an ask starts with the ask. `from` says which: "request", "ready", or "opened".
function reviewClock(pr, reviewAt, reviewer) {
  const at = Date.parse(reviewAt);
  if (reviewer && Array.isArray(pr.requests)) {
    const name = reviewer.toLowerCase();
    const asked = pr.requests.filter((r) => r.login && r.login.toLowerCase() === name && Date.parse(r.at) <= at)
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))[0];
    if (asked && Date.parse(asked.at) >= Date.parse(pr.createdAt)) return { start: asked.at, from: "request" };
  }
  if (pr.readyAt && Date.parse(pr.readyAt) <= at && Date.parse(pr.readyAt) > Date.parse(pr.createdAt)) return { start: pr.readyAt, from: "ready" };
  return { start: pr.createdAt, from: "opened" };
}
const clockCounts = () => ({ request: 0, ready: 0, opened: 0 });
// One sentence on where review waits started. `asked` names who was asked, for request-timed waits.
function clockText(c, asked) {
  if (!c) return "";
  const total = c.request + c.ready + c.opened;
  if (!total) return "";
  const parts = [];
  if (c.request) parts.push(`from ${asked} review request on ${plural(c.request, "pull request")}`);
  if (c.ready) parts.push(`from when a draft was marked ready on ${c.ready}`);
  if (c.opened) parts.push(`from opening on ${c.opened}`);
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(", ")}, and ${parts.at(-1)}` : parts[0];
  return `Timed ${list}${c.opened && asked ? ", where no earlier request was recorded" : ""}.`;
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

// ---------- Two tokens, one account ----------
// A fine-grained token and a classic token for the same account can see different parts of it: the
// fine-grained token reaches one resource owner, and the classic one reaches what its scopes allow.
// These helpers merge what each token returned for one source and count what only one of them saw.
const TOKEN_SLOTS = ["fine-grained", "classic"];

// loads: [{ slot, value }]. entries(value) lists [key, item] pairs. A later item replaces an earlier
// one for the same key only when better(later, earlier) says so.
function unionBySlot(loads, entries, better) {
  const merged = new Map();
  const seenBy = new Map();
  for (const { slot, value } of loads) {
    for (const [key, item] of entries(value)) {
      if (!merged.has(key) || (better && better(item, merged.get(key)))) merged.set(key, item);
      if (!seenBy.has(key)) seenBy.set(key, new Set());
      seenBy.get(key).add(slot);
    }
  }
  const only = {};
  for (const { slot } of loads) only[slot] = 0;
  for (const slots of seenBy.values()) if (slots.size === 1) only[[...slots][0]] += 1;
  return { merged, only };
}

// Events from each token's read of the same feed, joined by event id.
function mergeTokenEvents(loads) {
  const { merged, only } = unionBySlot(loads.map((l) => ({ slot: l.slot, value: l.events })),
    (events) => (events || []).filter((e) => e && e.id != null).map((e) => [String(e.id), e]));
  return { events: [...merged.values()], only };
}

// Pull request searches from each token, joined by repository and number. loads: [{ slot, load }]
// with the load shape of one search. The total is the larger match count, since each search counts
// only what its token can read.
function mergePullRequestLoads(loads) {
  const { merged, only } = unionBySlot(loads.map((l) => ({ slot: l.slot, value: l.load.info })), (info) => Object.entries(info || {}));
  const all = loads.map((l) => l.load);
  const loaded = merged.size;
  return {
    info: Object.fromEntries(merged),
    loaded,
    total: Math.max(loaded, ...all.map((l) => l.total || 0)),
    capped: all.some((l) => l.capped),
    partial: all.some((l) => l.partial),
    partialSlots: loads.filter((l) => l.load.partial).map((l) => l.slot),
    issue: loads.filter((l) => l.load.issue).map((l) => `With the ${l.slot} token: ${l.load.issue}`).join(" "),
    days: all[0]?.days,
    only,
  };
}

// Conversation searches from each token, joined per search by thread. The copy of a thread that
// carries more comments and reviews is kept. Returns the shape flattenConversations reads.
function mergeConversationData(loads) {
  const size = (n) => (n.comments?.nodes?.length || 0) + (n.reviews?.nodes?.length || 0);
  const data = {};
  const only = {};
  for (const { slot } of loads) only[slot] = 0;
  for (const key of CONVERSATION_SEARCHES) {
    const found = loads.filter((l) => Array.isArray(l.data?.[key]?.nodes));
    if (!found.length) continue;
    const { merged, only: seen } = unionBySlot(found.map((l) => ({ slot: l.slot, value: l.data[key].nodes })),
      (nodes) => nodes.filter((n) => n && n.repository && Number.isInteger(n.number)).map((n) => [`${n.repository.nameWithOwner}#${n.number}`, n]),
      (a, b) => size(a) > size(b));
    for (const [slot, n] of Object.entries(seen)) only[slot] += n;
    const counts = found.map((l) => l.data[key].issueCount).filter(Number.isInteger);
    data[key] = { nodes: [...merged.values()], issueCount: Math.max(merged.size, ...counts) };
  }
  return { data, only };
}

// Of two reads of the contribution year, the one that hides fewer contributions from its token.
// reads: [{ slot, data }] where data is the GraphQL response body. Returns the chosen read or null.
function pickContributionYear(reads) {
  const rank = (r) => {
    const c = r.data?.data?.viewer?.contributionsCollection;
    if (!Array.isArray(c?.contributionCalendar?.weeks)) return null;
    return [r.data.errors?.length ? 1 : 0, Number.isInteger(c.restrictedContributionsCount) ? c.restrictedContributionsCount : Infinity];
  };
  let best = null;
  for (const r of reads) {
    const score = rank(r);
    if (score && (!best || score[0] < best.score[0] || (score[0] === best.score[0] && score[1] < best.score[1]))) best = { ...r, score };
  }
  return best;
}

const RATE_LABELS = { core: "REST", graphql: "GraphQL", search: "Search" };
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
const TRAFFIC_WINDOW_DAYS = 14; // GitHub's traffic endpoints return the last 14 days
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
  // GitHub omits days with no views, so a missing day reads as zero, but only inside a window some
  // read covered. Each refresh with saved history on stores that day's star count for every owned
  // repository, so those days mark when traffic was read. A read covers its day and the 13 before.
  const daily = new Map();
  const covered = new Set();
  const cover = (day) => {
    const end = Date.parse(`${day}T00:00:00Z`);
    for (let d = 0; d < TRAFFIC_WINDOW_DAYS && Number.isFinite(end); d += 1) covered.add(new Date(end - d * DAY_MS).toISOString().slice(0, 10));
  };
  let firstSaved = null;
  for (const r of rows) {
    for (const day of Object.keys(savedRepos[r.repo]?.counts || {})) cover(day);
    if (Array.isArray(traffic[r.repo]?.views?.views)) cover(dayKey(0));
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
      else if (firstSaved && day >= firstSaved && covered.has(day)) known = true;
    }
    weeks.push({ start: dayKey(w * 7 + 6), count: n, known });
  }
  const coveredDays = firstSaved ? Math.floor((nowTime - Date.parse(`${firstSaved}T00:00:00Z`)) / DAY_MS) + 1 : 0;
  // The trend compares two full four-week windows, so every day in both must have been read.
  let gaps = 0;
  for (let d = 0; d < 56; d += 1) if (!daily.has(dayKey(d)) && !covered.has(dayKey(d))) gaps += 1;
  let trend = null;
  if (coveredDays >= 56 && !gaps) {
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

  // Records across years, so a streak that crosses New Year counts once. Days missing from the loaded
  // years, such as a year GitHub did not return, end a streak and are not counted as a break.
  let run = 0;
  let runStart = null;
  let bestRun = { days: 0, start: null, end: null };
  let lastActive = null;
  let bestGap = { days: 0, start: null, end: null };
  let prevTime = null;
  for (const d of allDays) {
    const time = Date.parse(`${d.date}T00:00:00Z`);
    if (prevTime != null && time - prevTime !== DAY_MS) { run = 0; lastActive = null; }
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
  quantile,
  permutationP,
  rankCorrelation,
  prKey,
  prRefsFromEvents,
  describeEvent,
  summarizeEvents,
  summarizePullRequests,
  summarizeContributions,
  summarizeNotifications,
  summarizeReviewRequests,
  summarizeWaiting,
  REQUEST_LATE_HOURS,
  summarizeRhythm,
  summarizeSessions,
  summarizePrPatterns,
  summarizeTrajectory,
  summarizeFollowThrough,
  summarizeReviewFlow,
  summarizeOutcomes,
  chanceBudget,
  snapshotOf,
  summarizeSnapshots,
  SNAPSHOT_METRICS,
  isBotLogin,
  flattenConversations,
  filterConversations,
  conversationIndex,
  eventText,
  textInfo,
  cleanText,
  CONVERSATION_FILTERS,
  deriveObservations,
  deriveSuggestions,
  applyCardStates,
  trialSeries,
  TRIAL_SNAPSHOTS,
  scopeRepos,
  SUGGEST_MIN_MERGES,
  scopePullRequests,
  cardKey,
  ACCOUNT_RULES,
  SNOOZE_DAYS,
  READING,
  REWORK_HOURS,
  durationLabel,
  clockText,
  filterEvents,
  isMinor,
  normalizePullRequest,
  normalizeSearchPullRequest,
  parseAcceptedPermissions,
  parseTokenExpiry,
  tokenExpiryStatus,
  classicScopes,
  TOKEN_SLOTS,
  mergeTokenEvents,
  mergePullRequestLoads,
  mergeConversationData,
  pickContributionYear,
  summarizeRateLimit,
  summarizeFootprint,
  summarizeContributionHistory,
  summarizeCollaboration,
};

if (typeof module !== "undefined" && module.exports) module.exports = api;
if (typeof window !== "undefined") window.DeskInsights = api;
})();
