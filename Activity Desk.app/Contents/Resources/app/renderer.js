(() => {
"use strict";

const I = window.DeskInsights;
const $ = (id) => document.getElementById(id);
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const LAST_SEEN_KEY = "desk.lastSeen";
const EVENT_PAGES = 3; // GitHub serves at most 300 events
const PR_LOOKUP_LIMIT = 40;
const GLYPHS = { PushEvent: "↑", PullRequestEvent: "⇄", IssuesEvent: "◉", IssueCommentEvent: "✎", CreateEvent: "+", DeleteEvent: "−", PullRequestReviewEvent: "✓", ReleaseEvent: "◆", WatchEvent: "★", ForkEvent: "⑂" };
const CHIPS = [["all", "All"], ["push", "Pushes"], ["pr", "Pull requests"], ["issue", "Issues"], ["comment", "Comments"], ["branch", "Branches"], ["agent", "Agents"]];

const initialState = {
  tokenKind: null,
  user: null,
  viewer: null,
  events: [],
  prInfo: {},
  prLookup: { total: 0, asked: 0, found: 0 },
  contributions: null,
  notifications: null,
  errors: {},
  remaining: null,
  refreshedAt: null,
  lastSeen: null,
  filter: "all",
  repo: "",
  query: "",
  hideMinor: true,
  insight: "year",
  busy: false,
};
let state = { ...initialState };
let signingOut = false;
const seenKey = () => `${LAST_SEEN_KEY}.${state.user.id}`;

// ---------- helpers ----------
function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}
const fmt = (n) => (n == null || Number.isNaN(n) ? "—" : Number(n).toLocaleString());
const pct = (x) => (x == null || !Number.isFinite(x) ? "—" : `${Math.round(x * 100)}%`);
const hoursLabel = I.durationLabel;
function hourName(h) {
  const am = h < 12 ? "am" : "pm";
  return `${h % 12 === 0 ? 12 : h % 12}${am}`;
}
function localDayKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
function dayHeading(key) {
  const today = localDayKey(new Date());
  const y = new Date(); y.setDate(y.getDate() - 1);
  if (key === today) return "Today";
  if (key === localDayKey(y)) return "Yesterday";
  const d = new Date(`${key}T12:00:00`);
  return d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
}
function dateRange(first, last) {
  if (first == null || last == null) return "";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" })
    .formatRange(new Date(first), new Date(last));
}
function level(count, max) {
  if (!count) return 0;
  const r = count / Math.max(1, max);
  return r > 0.6 ? 4 : r > 0.35 ? 3 : r > 0.15 ? 2 : 1;
}
function bars(rows, opts) {
  const o = opts || {};
  const max = Math.max(1, ...rows.map((r) => r[1]));
  return `<ul class="bars">${rows.map(([name, n, repo]) => {
    const label = repo
      ? `<button type="button" class="link name" data-insight-repo="${esc(repo)}" title="View ${esc(repo)} in Stream">${esc(name)}</button>`
      : `<span class="name" title="${esc(name)}">${esc(name)}</span>`;
    return `<li class="bar${o.violet ? " violet" : ""}">${label}<span class="track" aria-hidden="true"><span class="fill" style="width:${(n / max * 100).toFixed(1)}%"></span></span><span class="num">${esc(fmt(n))}${o.suffix || ""}</span></li>`;
  }).join("")}</ul>`;
}
const shortRepo = (repo) => (state.user && repo.startsWith(`${state.user.login}/`) ? repo.slice(state.user.login.length + 1) : repo);

function setBusy(text) {
  state.busy = Boolean(text);
  $("loading").classList.toggle("hidden", !text);
  $("loading-text").textContent = text || "";
  $("refresh").disabled = Boolean(text);
}
function signinMessage(text, isError) {
  $("signin-error").textContent = text || "";
  $("signin-error").className = `msg${isError ? " error" : ""}`;
}

// ---------- GitHub ----------
async function api(account, operation, args) {
  if (account !== state) throw new Error("Session changed.");
  const result = await window.desk.github(operation, args);
  if (account !== state) throw new Error("Session changed.");
  if (result.remaining != null) account.remaining = result.remaining;
  if (!result.ok) {
    const detail = result.error || ({
      401: "GitHub rejected the saved token.",
      403: "GitHub denied the request. Check token permissions and rate limits.",
      429: "GitHub rate limit reached.",
    })[result.status] || `GitHub returned HTTP ${result.status}.`;
    throw Object.assign(new Error(detail), { status: result.status });
  }
  return { data: JSON.parse(result.body || "null"), more: /rel="next"/.test(result.link || "") };
}

async function loadEvents(account, login) {
  const events = [];
  let more = false;
  for (let page = 1; page <= EVENT_PAGES; page += 1) {
    try {
      const result = await api(account, "events", { login, page });
      if (!Array.isArray(result.data)) throw new Error("Unexpected events response.");
      events.push(...result.data);
      more = result.more;
      if (!more) break;
    } catch (error) {
      return { events, issue: `Events page ${page} did not load. ${error.message}` };
    }
  }
  return { events, issue: more || events.length >= 300 ? "The feed reached the 300-event limit." : "" };
}

async function lookupPullRequests(account, refs) {
  const usable = refs.slice(0, PR_LOOKUP_LIMIT);
  if (!usable.length) return { info: {}, total: 0, asked: 0, found: 0 };
  const { data: result } = await api(account, "pullRequests", usable);
  const info = {};
  const errors = result?.errors || [];
  const failed = new Set(errors.map((error) => error.path?.[0]));
  usable.forEach((r, i) => {
    const alias = `p${i}`;
    const pr = result?.data?.[alias]?.pullRequest;
    if (failed.has(undefined) || failed.has(alias) || !pr || !Number.isInteger(pr.reviews?.totalCount)) return;
    info[I.prKey(r.repo, r.number)] = {
      ...pr, repo: r.repo, number: r.number,
      headRef: pr.headRefName, author: pr.author?.login, mergedBy: pr.mergedBy?.login,
      reviews: pr.reviews.totalCount,
      reviewList: (Array.isArray(pr.reviews.nodes) ? pr.reviews.nodes : []).map((r) => ({
        login: r?.author?.login || "", at: r?.submittedAt,
        bot: r?.author?.__typename === "Bot" || I.isBotLogin(r?.author?.login),
      })),
    };
  });
  return {
    info, total: refs.length, asked: usable.length, found: Object.keys(info).length,
  };
}

async function refresh() {
  const account = state;
  setBusy("Loading your profile…");
  try {
    const { data: user } = await api(account, "profile");
    if (typeof user?.login !== "string" || !user.login || !Number.isSafeInteger(user.id)) throw new Error("Unexpected GitHub profile.");
    setBusy("Loading activity…");
    const feed = await loadEvents(account, user.login);
    if (account !== state) return;
    const events = [...new Map(feed.events.map((e) => [e.id, e])).values()]
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));

    setBusy("Loading contribution year and notifications…");
    const refs = I.prRefsFromEvents(events);
    const fineGrained = account.tokenKind === "fine-grained";
    const [notes, year, prs] = await Promise.allSettled([
      fineGrained ? null : api(account, "notifications"),
      api(account, "year"),
      lookupPullRequests(account, refs),
    ]);
    if (account !== state) return;

    const errors = {};
    if (feed.issue) errors.events = feed.issue;
    const notifications = Array.isArray(notes.value?.data) ? notes.value.data : null;
    if (!notifications) errors.notifications = fineGrained
      ? "Unread notifications require a classic token."
      : notes.reason?.message || "Notifications are unavailable.";
    else if (notes.value.more) errors.notifications = "Showing the first page of unread notifications.";
    const yearData = year.value?.data;
    const yearErrors = yearData?.errors || [];
    const contributionError = yearErrors.some(({ path }) => !path || path.length < 2 || path[1] === "contributionsCollection");
    const viewer = yearData?.data?.viewer;
    const collection = viewer?.contributionsCollection;
    const contributions = !contributionError && Array.isArray(collection?.contributionCalendar?.weeks)
      ? I.summarizeContributions(collection, localDayKey(new Date())) : null;
    if (!contributions) errors.year = year.reason?.message || "GitHub did not return a usable contribution calendar.";
    else if (yearErrors.length) errors.account = "Some account details are unavailable.";
    const prLookup = prs.value || { info: {}, total: refs.length, asked: Math.min(refs.length, PR_LOOKUP_LIMIT), found: 0 };
    if (prLookup.found < prLookup.asked) errors.prs = prs.reason?.message || "Some requested pull requests were unavailable.";
    if (prLookup.asked < prLookup.total) errors.prs = `${errors.prs ? `${errors.prs} ` : ""}Details are capped at the first ${PR_LOOKUP_LIMIT} references.`;

    Object.assign(account, { user, viewer, contributions, events, notifications, prLookup, prInfo: prLookup.info, errors, refreshedAt: new Date() });
    if (!events.some((e) => I.repoName(e) === account.repo)) account.repo = "";
    account.lastSeen = localStorage.getItem(seenKey());
    if (!account.lastSeen && account.events[0]) {
      account.lastSeen = account.events[0].created_at;
      localStorage.setItem(seenKey(), account.lastSeen);
    }
    renderIdentity();
    renderAll();
    showApp(true);
  } catch (error) {
    if (account !== state) return;
    if (!account.user) throw error;
    account.errors.refresh = `Refresh failed. ${error.message} Showing the last loaded data.`;
    renderAll();
  } finally {
    if (account === state) setBusy("");
  }
}

// ---------- rendering ----------
function renderIdentity() {
  const u = state.user;
  if (!u) return;
  const name = typeof u.name === "string" ? u.name.trim() : "";
  $("me-name").textContent = name || u.login;
  $("me-login").textContent = `@${u.login}`;
  $("initials").textContent = (name ? name.split(/\s+/).slice(0, 2).map((part) => Array.from(part)[0]).join("") : u.login.slice(0, 2)).toUpperCase();
}

function computed() {
  const ev = I.summarizeEvents(state.events, { lastSeen: state.lastSeen });
  const pr = I.summarizePullRequests(state.prInfo, state.user && state.user.login);
  const notes = state.notifications ? I.summarizeNotifications(state.notifications) : null;
  const rhythm = state.contributions ? I.summarizeRhythm(state.contributions) : null;
  const sessions = I.summarizeSessions(state.events, state.user && state.user.login);
  const prPatterns = I.summarizePrPatterns(state.prInfo, state.refreshedAt);
  const trajectory = state.contributions ? I.summarizeTrajectory(state.contributions) : null;
  const follow = I.summarizeFollowThrough(state.events, state.prInfo, state.refreshedAt);
  const review = I.summarizeReviewFlow(state.prInfo, state.user && state.user.login);
  const observations = I.deriveObservations({ rhythm, sessions, prs: prPatterns, trajectory, follow, review });
  return { ev, pr, notes, year: state.contributions, rhythm, sessions, prPatterns, trajectory, follow, review, observations };
}

function renderOverview(c) {
  const { ev, pr, notes, year } = c;
  const parts = [];
  if (ev.fresh) parts.push(`<strong>${fmt(ev.fresh)} new event${ev.fresh === 1 ? "" : "s"}</strong> since you last marked the stream seen.`);
  if (year?.last30 != null) {
    const trend = year.trend ? ` (${year.trend > 0 ? "up" : "down"} ${pct(Math.abs(year.trend))} from the prior 30 days)` : "";
    parts.push(`${fmt(year.last30)} contributions in the last 30 days${trend}.`);
  }
  if (ev.agentEvents) parts.push(`${pct(ev.agentShare)} of loaded events matched a known agent app or branch prefix.`);
  $("summary").innerHTML = parts.join(" ");

  const kpis = [
    ["Contribution year", year ? fmt(year.total) : "—", year ? `${fmt(year.activeDays)} active days of ${fmt(year.dayCount)}` : esc(state.errors.year || "")],
    ["Current streak", year ? `${fmt(year.currentStreak)} d` : "—", year ? `Longest ${fmt(year.longestStreak)} days` : ""],
    ["Last 30 days", fmt(year?.last30), year?.prev30 != null ? `${fmt(year.prev30)} in the prior 30 days` : ""],
    ["Agent signals", ev.total ? pct(ev.agentShare) : "—", ev.agents.length ? ev.agents.slice(0, 3).map(([n, k]) => `${esc(n)} ${k}`).join(" · ") : "No matches in loaded events"],
  ];
  $("kpis").innerHTML = kpis.map(([label, value, sub]) =>
    `<div class="kpi"><div class="label">${esc(label)}</div><div class="value">${value}</div><div class="sub">${sub}</div></div>`).join("");

  const items = [];
  if (pr.unreviewed.length) items.push(["warn", `${pr.unreviewed.length} of ${pr.merged} sampled merges have zero recorded reviews`, pr.unreviewed.slice(0, 3).map((p) => `${shortRepo(p.repo)} #${p.number}`).join(", ")]);
  if (pr.openMine.length) items.push(["warn", `${pr.openMine.length} of your sampled PRs are still open`, pr.openMine.slice(0, 4).map((p) => `${shortRepo(p.repo)} #${p.number}${p.isDraft ? " (draft)" : ""}`).join(", ")]);
  if (notes && notes.missed.length) items.push(["warn", `${notes.missed.length} unread notification${notes.missed.length === 1 ? "" : "s"} flagged`, "Includes review requests, mentions, and failed checks."]);
  const coverage = Object.values(state.errors);
  if (coverage.length) items.push(["warn", "Some data is missing or limited", coverage.join(" ")]);
  else if (!items.length) items.push(["good", "Nothing flagged in the loaded data", "Open PRs, review counts and notifications are limited to the loaded samples."]);
  $("attention").innerHTML = items.map(([cls, t, d]) =>
    `<li class="${cls}"><span class="dot"></span><div><div class="t">${esc(t)}</div><div class="d">${esc(d)}</div></div></li>`).join("");

  if (!notes) {
    $("notes").innerHTML = `<p class="note">${esc(state.errors.notifications || "Notifications are unavailable.")}</p>`;
  } else {
    $("notes").innerHTML = `<p class="big"><strong>${fmt(notes.unread)}</strong> unread loaded · ${fmt(notes.ciNoise)} are routine CI updates</p>${bars(notes.byReason.slice(0, 6))}` +
      (notes.missed.length ? `<ul class="attention">${notes.missed.slice(0, 5).map((n) => `<li class="warn"><span class="dot"></span><div><div class="t">${esc((n.subject && n.subject.title) || "Notification")}</div><div class="d">${esc(n.reason)} · ${esc(n.repository && n.repository.full_name)}</div></div></li>`).join("")}</ul>` : "");
  }

  renderYear(year);
}

function renderYear(year) {
  if (!year) {
    $("year-heat").innerHTML = `<p class="note year-empty">${esc(state.errors.year || "Contribution year did not load.")}</p>`;
    $("year-caption").textContent = "";
    return;
  }
  const max = Math.max(1, ...year.days.map((d) => d.contributionCount));
  const cells = [];
  const first = year.days[0];
  if (first) {
    const pad = new Date(`${first.date}T00:00:00Z`).getUTCDay();
    for (let i = 0; i < pad; i += 1) cells.push({ pad: true });
  }
  year.days.forEach((d) => cells.push(d));
  const weeks = Math.ceil(cells.length / 7);
  let html = "";
  let lastMonth = "";
  for (let w = 0; w < weeks; w += 1) {
    const week = cells.slice(w * 7, w * 7 + 7);
    const firstReal = week.find((d) => !d.pad);
    const month = firstReal ? firstReal.date.slice(5, 7) : "";
    html += `<span class="m" style="grid-column:${w + 1}">${month && month !== lastMonth ? MONTHS[Number(month) - 1] : ""}</span>`;
    if (month) lastMonth = month;
    week.forEach((d, i) => {
      html += d.pad ? `<span class="c" style="grid-column:${w + 1};grid-row:${i + 2};visibility:hidden"></span>`
        : `<span class="c l${level(d.contributionCount, max)}" style="grid-column:${w + 1};grid-row:${i + 2}" title="${esc(d.date)}: ${esc(d.contributionCount)} contributions"></span>`;
    });
  }
  $("year-heat").innerHTML = html || '<p class="note year-empty">GitHub returned no calendar days.</p>';
  const busiest = year.busiest[0];
  $("year-caption").textContent = `${fmt(year.total)} contributions${busiest ? ` · busiest ${busiest.date} (${busiest.contributionCount})` : ""}`;
}

function renderStream(c) {
  const { ev } = c;
  const range = dateRange(ev.oldest, ev.newest);
  $("stream-caption").textContent = ev.total
    ? `${fmt(ev.total)} events loaded${range ? ` · ${range}` : ""}.`
    : "No recent events loaded.";
  if (state.errors.events) $("stream-caption").textContent += ` ${state.errors.events}`;

  const counts = Object.fromEntries(CHIPS.map(([k]) => [k, I.filterEvents(state.events, k, state.repo, "", state.hideMinor).length]));
  const minor = state.events.filter(I.isMinor).length;
  $("minor-count").textContent = minor ? `(${minor})` : "";
  $("chips").innerHTML = CHIPS.map(([k, label]) =>
    `<button class="chip" role="tab" type="button" data-filter="${k}" aria-selected="${state.filter === k}">${esc(label)}<span class="n">${counts[k]}</span></button>`).join("");

  const repos = ev.byRepo.map(([r]) => r);
  $("repo-filter").innerHTML = `<option value="">All repositories</option>${repos.map((r) => `<option value="${esc(r)}"${r === state.repo ? " selected" : ""}>${esc(shortRepo(r))}</option>`).join("")}`;

  const list = I.filterEvents(state.events, state.filter, state.repo, state.query, state.hideMinor, state.prInfo);
  const lastSeen = state.lastSeen ? new Date(state.lastSeen).getTime() : null;
  const groups = new Map();
  for (const e of list) {
    const key = localDayKey(new Date(e.created_at));
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }
  if (!list.length) {
    $("stream").innerHTML = `<div class="empty">No events match these filters.</div>`;
  } else {
    $("stream").innerHTML = [...groups.entries()].map(([key, rows]) => `
      <div class="day"><div class="day-head">${esc(dayHeading(key))} · ${rows.length}</div><div class="rows">${rows.map((e) => {
        const when = new Date(e.created_at);
        const agent = I.agentOf(e);
        const fresh = lastSeen && when.getTime() > lastSeen;
        const p = e.payload || {};
        const number = e.type === "PullRequestEvent" ? p.number || (p.pull_request && p.pull_request.number) : null;
        const info = number ? state.prInfo[I.prKey(I.repoName(e), number)] : null;
        const tags = [];
        if (fresh) tags.push(`<span class="tag new">New</span>`);
        if (agent) tags.push(`<span class="tag agent">${esc(agent)}</span>`);
        if (info) {
          const st = info.merged ? "merged" : info.state === "OPEN" ? "open" : "closed";
          tags.push(`<span class="tag ${st}">${st}</span>`);
          tags.push(`<span class="tag">+${fmt(info.additions)} −${fmt(info.deletions)}</span>`);
          if (info.merged && !info.reviews) tags.push(`<span class="tag warn">0 reviews</span>`);
        }
        const branch = I.branchOf(e);
        return `<div class="row${fresh ? " fresh" : ""}">
          <span class="time">${esc(when.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }))}</span>
          <span class="glyph" title="${esc(I.eventLabel(e.type))}">${esc(GLYPHS[e.type] || "•")}</span>
          <div class="what"><div class="title">${esc(I.describeEvent(e, state.prInfo))}</div>
            <div class="meta"><span>${esc(shortRepo(I.repoName(e)))}</span>${branch && e.type !== "PushEvent" && e.type !== "CreateEvent" && e.type !== "DeleteEvent" ? `<span>${esc(branch)}</span>` : ""}${e.public === false ? "<span>private</span>" : ""}</div></div>
          <div class="tags">${tags.join("")}</div>
        </div>`;
      }).join("")}</div></div>`).join("");
  }
  const badge = $("fresh-badge");
  badge.textContent = ev.fresh > 99 ? "99+" : String(ev.fresh);
  badge.classList.toggle("hidden", !ev.fresh);
}

function insightSection(id, name, caption, content) {
  return `<section class="insight-section" aria-labelledby="${id}-title">
    <header class="insight-heading">
      <h3 id="${id}-title">${name}</h3>
      <p class="lede">${esc(caption)}</p>
    </header>
    ${content}
  </section>`;
}

const stats = (rows) => `<dl class="stat-row">${rows.map(([label, value]) =>
  `<div class="stat"><dt>${label}</dt><dd>${value}</dd></div>`
).join("")}</dl>`;

function annualInsights(year) {
  if (!year) {
    return insightSection("insight-year", "Contribution year", "Unavailable",
      `<p class="card muted">${esc(state.errors.year || "The contribution calendar did not load.")}</p>`);
  }

  const dates = year.days.length ? dateRange(`${year.days[0].date}T12:00:00`, `${year.days.at(-1).date}T12:00:00`) : "";
  const caption = `${fmt(year.total)} contributions${dates ? ` · ${dates}` : ""}`;
  const { commits, prs, issues, reviews, restricted } = year.totals;
  const peak = year.busiest[0];
  const highestMonth = Math.max(1, ...year.monthly.map(([, n]) => n));
  const trend = year.trend ? `${year.trend > 0 ? "+" : "−"}${pct(Math.abs(year.trend))}` : pct(year.trend);
  const comparisonNote = year.last30 == null || year.prev30 == null
    ? "A 30-day total appears once all 30 dates are available."
    : year.prev30 === 0 ? "Percentage change requires a nonzero prior total." : "The 30-day comparison includes today.";
  const chart = year.monthly.length ? `<div class="monthly-chart"><ol class="month-bars" aria-label="Contributions by month">
    ${year.monthly.map(([key, n], i) => {
      const month = MONTHS[Number(key.slice(5)) - 1];
      const label = i === 0 || key.endsWith("-01") ? `${month} ’${key.slice(2, 4)}` : month;
      return `<li title="${esc(key)} · ${fmt(n)} contributions"><span class="month-count">${fmt(n)}</span>
        <span class="month-track" aria-hidden="true"><i style="height:${(100 * n / highestMonth).toFixed(1)}%"></i></span>
        <span>${label}</span></li>`;
    }).join("")}</ol></div>` : '<p class="note">GitHub returned no calendar days.</p>';
  const leadingRepo = year.commits[0];

  return insightSection("insight-year", "Contribution year", caption, `
    ${restricted ? `<p class="insight-notice">${fmt(restricted)} restricted contributions are counted without repository details.</p>` : ""}
    <div class="grid insights">
      <article class="card insight-wide">
        <h4>Contribution trends</h4>
        ${stats([["Last 30 days", fmt(year.last30)], ["Prior 30 days", fmt(year.prev30)], ["Change", trend]])}
        ${chart}
        <p class="note">${comparisonNote} The first and last months in the chart can be partial.</p>
      </article>
      <article class="card">
        <h4>Consistency</h4>
        ${stats([["Current streak", year.dayCount ? `${fmt(year.currentStreak)} d` : "—"], ["Longest streak", year.dayCount ? `${fmt(year.longestStreak)} d` : "—"], ["Active days", pct(year.dayCount ? year.activeDays / year.dayCount : null)]])}
        ${peak ? `<p class="note">Median of <strong>${fmt(year.medianActiveDay)}</strong> contributions on active days. Busiest day was <strong>${esc(peak.date)}</strong> with ${fmt(peak.contributionCount)}.</p>` : '<p class="note">No active days in the returned calendar.</p>'}
      </article>
      <article class="card">
        <h4>Contribution types</h4>
        ${bars([["Commits", commits], ["Pull requests opened", prs], ["Issues opened", issues], ["PR review contributions", reviews]])}
      </article>
      <article class="card">
        <h4>Commit contributions by repository</h4>
        ${leadingRepo ? `
          <p class="big">${year.focusShare == null ? "" : `<strong>${pct(year.focusShare)}</strong> of calendar commits were in <strong>${esc(shortRepo(leadingRepo.repo))}</strong>, the leading repository returned. `}${fmt(year.totals.repos)} repositories with commits.</p>
          ${bars(year.commits.map((r) => [shortRepo(r.repo) + (r.isPrivate ? " (private)" : ""), r.count]))}
          <p class="note">GitHub returns up to 10 repository totals.</p>` : '<p class="note">No repository totals were returned.</p>'}
      </article>
      <article class="card">
        <h4>Contributions by weekday</h4>
        ${bars([1, 2, 3, 4, 5, 6, 0].map((d) => [DAY_NAMES[d], year.weekday[d]]))}
        ${year.activeDays ? `<p class="note">${pct(year.weekendShare)} fell on weekends.</p>` : ""}
      </article>
    </div>`);
}

function eventInsights(ev) {
  const range = dateRange(ev.oldest, ev.newest);
  const caption = `${fmt(ev.total)} events loaded${range ? ` · ${range}` : ""}`;
  const notice = state.errors.events ? `<p class="insight-notice">${esc(state.errors.events)}</p>` : "";
  if (!ev.total) {
    return insightSection("insight-events", "Recent events", caption,
      notice || '<p class="card muted">GitHub returned no recent events for this token.</p>');
  }

  const peak = ev.peakHour;
  const peakLabel = peak ? `${DAY_NAMES[peak.day]} ${hourName(peak.hour)} · ${fmt(peak.count)} ${peak.count === 1 ? "event" : "events"}` : "";
  const hourLabels = Array.from({ length: 24 }, (_, h) => `<span class="axis">${h % 6 === 0 ? hourName(h) : ""}</span>`).join("");
  let grid = `<span></span>${hourLabels}`;
  for (const day of [1, 2, 3, 4, 5, 6, 0]) {
    grid += `<span class="lab">${DAY_NAMES[day]}</span>${ev.hourGrid[day].map((n, h) =>
      `<span class="h l${level(n, peak?.count)}" title="${DAY_NAMES[day]} ${hourName(h)} · ${fmt(n)} events"></span>`).join("")}`;
  }
  const pushes = ev.mainPushes + ev.branchPushes + ev.tagPushes + ev.otherPushes;

  return insightSection("insight-events", "Recent events", caption, `
    ${notice}
    <div class="grid insights">
      <article class="card">
        <h4>Activity by day and hour</h4>
        ${peak ? `<p class="big">Busiest slot <strong>${peakLabel}</strong>, local time.</p>
          <div class="hours" role="img" aria-label="Events by local day and hour. Busiest slot ${peakLabel}.">${grid}</div>
          <div class="legend small muted" aria-hidden="true"><span>Fewer</span><i class="l0"></i><i class="l1"></i><i class="l2"></i><i class="l3"></i><i class="l4"></i><span>More</span></div>`
          : '<p class="note">No event timestamps are available.</p>'}
      </article>
      <article class="card">
        <h4>Events by repository</h4>
        <p class="big">Select a repository to view its loaded events in Stream.</p>
        ${bars(ev.byRepo.slice(0, 6).map(([repo, n]) => [shortRepo(repo), n, repo]))}
      </article>
      <article class="card">
        <h4>Event types</h4>
        ${bars(ev.byType.map(([type, n]) => [I.eventLabel(type), n]))}
      </article>
      <article class="card">
        <h4>Agent signals</h4>
        <p class="big"><strong>${fmt(ev.agentEvents)} of ${fmt(ev.total)} events</strong> matched known app slugs or branch prefixes.</p>
        ${ev.agents.length ? bars(ev.agents, { violet: true }) : ""}
        <p class="note">Branch matches include prefixes such as <code>codex/</code>, <code>cursor/</code>, and <code>copilot/</code>.</p>
      </article>
      <article class="card">
        <h4>Pushes and branches</h4>
        <p class="big">${pushes ? `${fmt(pushes)} push events by ref.` : "No push events loaded."}</p>
        ${pushes ? bars([["Branches named main or master", ev.mainPushes], ["Other branches", ev.branchPushes], ["Tags", ev.tagPushes], ["Unspecified or other refs", ev.otherPushes]]) : ""}
        <p class="note">${fmt(ev.branchesCreated)} branches created · ${fmt(ev.branchesDeleted)} deleted</p>
      </article>
      ${ev.tags.length ? `<article class="card">
        <h4>Issue title tags</h4>
        <p class="big">From the <code>[tag]</code> at the start of issue titles in opened events.</p>
        ${bars(ev.tags.slice(0, 8))}
      </article>` : ""}
    </div>`);
}

function pullRequestInsights(pr) {
  const { asked, found, total } = state.prLookup;
  const caption = total
    ? `${fmt(found)} of ${fmt(asked)} requested details loaded · ${fmt(total)} ${total === 1 ? "pull request" : "distinct pull requests"} referenced in the feed`
    : "No pull requests referenced in the loaded events.";
  const notice = [state.errors.events, state.errors.prs].filter(Boolean).join(" ");
  return insightSection("insight-prs", "Pull requests", caption, `
    ${notice ? `<p class="insight-notice">${esc(notice)}</p>` : ""}
    ${pr.total ? `<div class="grid insights">
      <article class="card">
        <h4>Merge activity</h4>
        ${stats([["Merged", fmt(pr.merged)], ["Median time to merge", hoursLabel(pr.medianHoursToMerge)], ["Zero recorded reviews", pr.merged ? `${fmt(pr.unreviewed.length)} / ${fmt(pr.merged)}` : "—"]])}
        <p class="note">${fmt(pr.selfMerged)} merged by the PR author. Review counts reflect the loaded PR details.</p>
      </article>
      <article class="card">
        <h4>Current status and size</h4>
        ${stats([["Open", fmt(pr.open.length)], ["Open drafts", fmt(pr.drafts)], ["Median lines changed", fmt(pr.medianSize)]])}
        ${bars(pr.largest.map((p) => [`${shortRepo(p.repo)} #${p.number}`, p.additions + p.deletions]))}
        <p class="note">Largest sampled changes by additions plus deletions. ${fmt(pr.agentBranches)} sampled PRs had a known agent branch prefix.</p>
      </article>
    </div>` : ""}`);
}

const sourceTag = (name) => `<span class="src">${esc(name)}</span>`;

function patternInsights({ ev, pr, rhythm, sessions, prPatterns, trajectory, follow, review, observations }) {
  const sources = [
    rhythm ? "the contribution year" : "",
    ev.total ? `${fmt(ev.total)} loaded events` : "",
    pr.total ? `${fmt(pr.total)} sampled pull requests` : "",
  ].filter(Boolean);
  const caption = sources.length ? `Derived from ${new Intl.ListFormat(undefined, { type: "conjunction" }).format(sources)}` : "No data loaded";
  const notice = [state.errors.year, state.errors.events, state.errors.prs].filter(Boolean).join(" ");

  const findings = observations.length
    ? `<ul class="attention">${observations.map((o) =>
      `<li class="${esc(o.tone)}"><span class="dot"></span><div><div class="t">${esc(o.title)}</div><div class="d">${esc(o.detail)}</div>${sourceTag(o.source)}</div></li>`).join("")}</ul>`
    : '<p class="note">Nothing crossed a reporting threshold in the loaded data. Each finding needs a minimum sample before it appears.</p>';

  let rhythmCard = `<p class="note">${esc(state.errors.year || "The contribution calendar did not load.")}</p>`;
  if (rhythm && rhythm.activeDays) {
    const m = rhythm.momentum;
    const spread = rhythm.repoSpread;
    rhythmCard = `
      ${stats([["Days holding half the output", fmt(rhythm.halfDays)], ["Typical run of active days", `${fmt(rhythm.medianRun)} d`], ["Longest break", rhythm.longestGap ? `${fmt(rhythm.longestGap.days)} d` : "—"]])}
      ${rhythm.bands ? bars(rhythm.bands.map(([name, x]) => [name, Math.round(x * 100)]), { suffix: "%" }) + '<p class="note">Share of contributions by how busy the day was.</p>' : ""}
      <p class="note">${m ? `The last 28 days (${fmt(m.last28)}) were busier than <strong>${Math.floor(m.percentile * 100)}%</strong> of the ${fmt(m.windows)} earlier rolling 28-day windows. ` : "A 28-day ranking needs at least 56 calendar days. "}
        ${fmt(rhythm.activeWeeks)} of ${fmt(rhythm.weeks)} full weeks had activity.
        ${spread && spread.listed > 1 ? `Commits are distributed like <strong>${spread.effective.toFixed(1)}</strong> equally used repositories across the ${fmt(spread.listed)} totals GitHub returned.` : ""}</p>`;
  } else if (rhythm) {
    rhythmCard = '<p class="note">No active days in the returned calendar.</p>';
  }

  let sessionCard = '<p class="note">No event timestamps are available.</p>';
  let mixCard = sessionCard;
  if (sessions.timed) {
    const { core, edge, weekend } = sessions.dayParts;
    const long = sessions.longest;
    sessionCard = `
      ${stats([["Sessions", fmt(sessions.sessions)], ["Typical length", sessions.multi ? hoursLabel(sessions.medianHours) : "—"], ["Crossed repositories", sessions.multi ? `${fmt(sessions.multiRepo)} / ${fmt(sessions.multi)}` : "—"]])}
      ${bars([["Weekdays 9am–6pm", core], ["Weekday early or late", edge], ["Weekends", weekend]])}
      <p class="note">A session is a run of events with gaps under an hour, in local time. Length and crossings count sessions with more than one event.
        ${long ? `The longest ran ${esc(hoursLabel(long.hours))} on ${esc(new Date(long.start).toLocaleDateString(undefined, { month: "short", day: "numeric" }))} with ${fmt(long.events)} events in ${fmt(long.repos)} ${long.repos === 1 ? "repository" : "repositories"}.` : ""}</p>`;
    const life = sessions.branchLifetimes;
    mixCard = `
      ${bars(sessions.mix, { violet: true })}
      <p class="note">Building covers pushes, branches, releases, and pull request changes. Reviewing covers reviews and review comments. Discussing covers issues and comments.
        ${sessions.ownRepo == null ? "" : `<strong>${pct(sessions.ownRepo / sessions.timed)}</strong> of events were in repositories under your account.`}
        ${life.count ? `${fmt(life.count)} ${life.count === 1 ? "branch was" : "branches were"} created and deleted inside the feed, living a median of <strong>${esc(hoursLabel(life.medianHours))}</strong>.` : ""}</p>`;
  }

  const groups = [["Agent-branch PRs", prPatterns.agent], ["Other PRs", prPatterns.other], ["Smaller half by lines", prPatterns.smaller], ["Larger half by lines", prPatterns.larger]]
    .filter(([, g]) => g && g.count);
  const prCard = prPatterns.merged ? `
      ${stats([["Merged lines with no review", prPatterns.mergedLines ? pct(prPatterns.unreviewedLines / prPatterns.mergedLines) : "—"], ["Open over two weeks", prPatterns.open ? `${fmt(prPatterns.stale)} / ${fmt(prPatterns.open)}` : "—"], ["Oldest open", prPatterns.oldestOpen ? `${fmt(Math.floor(prPatterns.oldestOpen.days))} d` : "—"]])}
      <table class="compare"><caption class="note">Sampled merges by group</caption>
        <thead><tr><th scope="col">Group</th><th scope="col">Merged</th><th scope="col">Median to merge</th><th scope="col">Zero reviews</th><th scope="col">Median lines</th></tr></thead>
        <tbody>${groups.map(([name, g]) => `<tr><th scope="row">${esc(name)}</th><td>${fmt(g.count)}</td><td>${esc(hoursLabel(g.medianHours))}</td><td>${fmt(g.unreviewed)} / ${fmt(g.count)}</td><td>${fmt(Math.round(g.medianSize))}</td></tr>`).join("")}</tbody></table>
      <p class="note">Agent branches are matched by prefix such as <code>claude/</code> or <code>codex/</code>. Size halves appear with six or more merges. Small groups can swing on a single pull request.</p>`
    : `<p class="note">${pr.total ? "No merged pull requests in the loaded details." : "No pull request details are loaded."}</p>`;

  return insightSection("insight-patterns", "Patterns", caption, `
    ${notice ? `<p class="insight-notice">${esc(notice)}</p>` : ""}
    <div class="grid insights">
      <article class="card insight-wide">
        <h4>What stands out</h4>
        ${findings}
      </article>
      <article class="card"><h4>Output rhythm</h4>${sourceTag("Contribution year")}${rhythmCard}</article>
      <article class="card"><h4>Work sessions</h4>${sourceTag("Recent events")}${sessionCard}</article>
      <article class="card"><h4>Work mix</h4>${sourceTag("Recent events")}${mixCard}</article>
      <article class="card"><h4>Merge patterns</h4>${sourceTag("Sampled pull requests")}${prCard}</article>
      <article class="card"><h4>Trajectory</h4>${sourceTag("Contribution year")}${trajectoryCard(trajectory)}</article>
      <article class="card"><h4>Follow-through</h4>${sourceTag("Recent events")}${followCard(follow)}</article>
      <article class="card insight-wide"><h4>Review turnaround</h4>${sourceTag("Sampled pull requests")}${reviewCard(review, pr)}</article>
    </div>`);
}

function trajectoryCard(t) {
  if (!t) return `<p class="note">${esc(state.errors.year || "The contribution calendar did not load.")}</p>`;
  if (!t.series.length) return '<p class="note">No full weeks in the returned calendar.</p>';
  const s = t.shift;
  const max = Math.max(1, ...t.series.map((w) => w.count));
  const cols = t.series.map((w, i) => {
    const later = s && s.clear && i >= s.weeksBefore;
    return `<span class="${later ? "after" : ""}" style="height:${Math.max(2, Math.round((w.count / max) * 100))}%" title="${esc(`Week of ${w.start}: ${fmt(w.count)}`)}"></span>`;
  }).join("");
  const perWeek = (x) => (x >= 10 ? fmt(Math.round(x)) : x.toFixed(1));
  const odds = (o) => (o ? pct(o.rate) : "—");
  const shiftText = !s ? `A level-shift check needs at least 12 full weeks; ${fmt(t.weeks)} are available.`
    : s.clear ? `The clearest shift came in the week of <strong>${esc(s.at)}</strong>: ${perWeek(s.before)} a week before, <strong>${perWeek(s.after)}</strong> a week since.`
    : `No clear shift. The best split, in the week of ${esc(s.at)}, moves from ${perWeek(s.before)} to ${perWeek(s.after)} a week, which random reorderings of the same weeks match or exceed ${pct(1 - s.beaten)} of the time.`;
  return `
    ${stats([["Active the day after an active day", odds(t.afterActive)], ["Active the day after an idle day", odds(t.afterIdle)], ["Full weeks", fmt(t.weeks)]])}
    <div class="weekly" role="img" aria-label="Weekly contribution totals, oldest first">${cols}</div>
    <p class="note">${shiftText} The split is the one that best separates two weekly averages, with six or more weeks on each side. It counts as a shift when it beats 95% of the same weeks shuffled into random order and moves the average by at least a quarter. Today is left out of the next-day rates.</p>`;
}

function followCard(f) {
  if (!f.branches && !f.opened) return '<p class="note">No branches created or pull requests opened in the loaded events.</p>';
  const o = f.outcomes;
  const list = f.withoutPr.slice(0, 4).map((b) => `<li><code>${esc(b.ref)}</code> · ${esc(shortRepo(b.repo))} · ${fmt(Math.floor(b.days))} d</li>`).join("");
  return `
    ${stats([["Branches with no PR", f.settled ? `${fmt(f.withoutPr.length)} / ${fmt(f.settled)}` : "—"], ["Opened PRs merged", f.opened ? `${fmt(o.merged)} / ${fmt(f.opened)}` : "—"], ["Closed unmerged", fmt(o.closed)]])}
    ${f.opened ? bars([["Merged", o.merged], ["Still open", o.open], ["Closed unmerged", o.closed], ["Details unavailable", o.unknown]].filter(([, n]) => n)) : ""}
    ${list ? `<ul class="plain">${list}</ul>` : ""}
    <p class="note">Branches count once they are two days old and match a pull request by head branch from the feed or the sampled details. Pull request outcomes use current state, so they cover only the ${fmt(f.opened)} pull requests opened in the loaded events.</p>`;
}

function reviewCard(r, pr) {
  if (!pr.total) return '<p class="note">No pull request details are loaded.</p>';
  if (!r.authored) return '<p class="note">None of the sampled pull requests were authored by you, so there is no review wait to measure.</p>';
  const people = r.reviewers.slice(0, 5);
  return `
    ${stats([["Median to first human review", r.withHumanReview ? hoursLabel(r.medianFirstReviewHours) : "—"], ["Merges reviewed only by bots", r.merged ? `${fmt(r.botOnly)} / ${fmt(r.merged)}` : "—"], ["Merged by you", r.merged ? `${fmt(r.selfMerged)} / ${fmt(r.merged)}` : "—"]])}
    ${people.length ? bars(people, { violet: true }) + '<p class="note">Pull requests each person reviewed.</p>' : '<p class="note">No one besides you or a bot reviewed the sampled pull requests you authored.</p>'}
    <p class="note">Measured on ${fmt(r.authored)} sampled ${r.authored === 1 ? "pull request" : "pull requests"} you authored, following the CHAOSS time-to-first-response definition: the first review by a human who is not the author, from creation. Draft time counts toward the wait. ${fmt(r.withHumanReview)} had a human review; ${fmt(r.reviewedBeforeMerge)} of ${fmt(r.merged)} merges got one before merging.${r.truncated ? ` ${fmt(r.truncated)} had more than 10 reviews, and only the first 10 are read.` : ""}</p>`;
}

function renderInsights(c) {
  const { ev, pr, year } = c;
  $("insight-nav").querySelectorAll("button").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.source === state.insight));
  });
  const panel = state.insight === "events" ? eventInsights(ev)
    : state.insight === "prs" ? pullRequestInsights(pr)
    : state.insight === "patterns" ? patternInsights(c) : annualInsights(year);
  $("insights").innerHTML = `${state.errors.refresh ? `<p class="insight-notice">${esc(state.errors.refresh)}</p>` : ""}${panel}`;
}

function renderMeta(c) {
  const { ev, year } = c;
  const v = state.viewer;
  const range = dateRange(ev.oldest, ev.newest);
  const cards = [];

  cards.push(`<article class="card"><h3>How far back the stream goes</h3>
    <p class="big"><strong>${fmt(ev.total)}</strong> events loaded${range ? ` · ${range}` : ""}.</p>
    <div class="callout">${esc(state.errors.events || "The stream covers the events returned by GitHub for this token. GitHub limits the feed to 300 recent events.")}</div>
    <p class="note">GitHub can delay events. Insights shows the loaded date range for each source.</p>
  </article>`);

  const kind = state.tokenKind;
  const caps = [];
  caps.push([state.errors.events ? "part" : "ok", "Activity stream", esc(state.errors.events || `${fmt(ev.total)} recent events loaded.`)]);
  caps.push(ev.privateEvents ? ["ok", "Private events", `${fmt(ev.privateEvents)} private events visible.`]
    : ["part", "Private events", kind === "fine-grained" ? "None visible. Add the account permission Events: read to the token if you have private activity." : "None in this window."]);
  caps.push(state.notifications ? [state.errors.notifications ? "part" : "ok", "Notifications", `${fmt(state.notifications.length)} unread loaded. ${esc(state.errors.notifications || "")}`]
    : ["no", "Notifications", esc(state.errors.notifications || "Not available.")]);
  caps.push(year ? ["ok", "Contribution year", `${fmt(year.total)} contributions.`] : ["no", "Contribution year", esc(state.errors.year || "")]);
  const { total, asked, found } = state.prLookup;
  caps.push(asked
    ? [state.errors.prs ? "part" : "ok", "Pull request details", `${fmt(found)} loaded of ${fmt(asked)} requested (${fmt(total)} references). ${esc(state.errors.prs || "")}`]
    : ["part", "Pull request details", "No pull requests in the loaded events."]);
  if (year) {
    caps.push(year.totals.restricted
      ? ["part", "Private contributions", `${fmt(year.totals.restricted)} contributions are counted but hidden from this token.`]
      : ["ok", "Restricted contributions", "GitHub reported no restricted contribution count."]);
  }
  if (state.errors.account) caps.push(["part", "Account details", esc(state.errors.account)]);
  cards.push(`<article class="card"><h3>What this token can see</h3>
    <p class="big">Signed in with a <strong>${esc(kind || "GitHub")}</strong> token.</p>
    <ul class="cap">${caps.map(([s, t, d]) => `<li><span class="${s}">${s === "ok" ? "✓" : s === "no" ? "✕" : "!"}</span><div><div>${esc(t)}</div><div class="d">${d}</div></div></li>`).join("")}</ul>
  </article>`);

  if (v) {
    const created = v.createdAt && new Date(v.createdAt);
    cards.push(`<article class="card"><h3>Account</h3>
      <dl class="kv">
        <dt>On GitHub since</dt><dd>${created ? esc(created.toLocaleDateString(undefined, { month: "short", year: "numeric" })) : "—"}</dd>
        <dt>Repositories you own</dt><dd>${fmt(v.repositories && v.repositories.totalCount)}</dd>
        <dt>Followers</dt><dd>${fmt(v.followers && v.followers.totalCount)}</dd>
        <dt>Repositories committed to this year</dt><dd>${fmt(year && year.totals.repos)}</dd>
        <dt>Commits / PRs / issues / reviews</dt><dd>${year ? `${fmt(year.totals.commits)} / ${fmt(year.totals.prs)} / ${fmt(year.totals.issues)} / ${fmt(year.totals.reviews)}` : "—"}</dd>
      </dl>
      <p class="note">Your public profile can show a different yearly total. It depends on whether private contributions are shown publicly, and this view counts what your token can see.</p>
    </article>`);
  }

  cards.push(`<article class="card"><h3>This session</h3>
    <dl class="kv">
      <dt>Last refreshed</dt><dd>${state.refreshedAt ? esc(state.refreshedAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })) : "—"}</dd>
      <dt>New since marked seen</dt><dd>${fmt(ev.fresh)}</dd>
      <dt>Marked seen at</dt><dd>${state.lastSeen ? esc(new Date(state.lastSeen).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })) : "—"}</dd>
      <dt>Rate limit remaining</dt><dd>${esc(state.remaining ?? "—")}</dd>
    </dl>
    <p class="note">The limit is from the last GitHub response. REST and GraphQL use separate limits.</p>
  </article>`);

  $("meta").innerHTML = cards.join("");
}

function renderAll() {
  const c = computed();
  renderOverview(c);
  renderStream(c);
  renderInsights(c);
  renderMeta(c);
  $("refreshed").textContent = state.refreshedAt ? `Updated ${state.refreshedAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : "";
}

function showTab(tab) {
  document.querySelectorAll(".nav").forEach((b) => {
    const active = b.dataset.tab === tab;
    b.classList.toggle("active", active);
    b.setAttribute("aria-current", active ? "page" : "false");
  });
  document.querySelectorAll("[data-view]").forEach((v) => v.classList.toggle("hidden", v.dataset.view !== tab));
  $("content").scrollTop = 0;
}

function showApp(on) {
  $("signin").classList.toggle("hidden", on);
  $("app").classList.toggle("hidden", !on);
}

// ---------- events ----------
async function boot() {
  const button = $("signin-btn");
  button.disabled = true;
  try {
    const status = await window.desk.status();
    if (!status.ok) throw new Error(status.error);
    if (!status.signedIn) return;
    state.tokenKind = status.kind;
    signinMessage("Loading your saved account…", false);
    await refresh();
    signinMessage("", false);
  } catch (error) {
    $("forget-token").classList.remove("hidden");
    signinMessage(error.message, true);
  } finally {
    button.disabled = false;
  }
}

$("create-token").addEventListener("click", async () => {
  try {
    const result = await window.desk.openTokenPage();
    if (result.ok) return;
  } catch { /* The system browser could not be opened. */ }
  signinMessage("Could not open GitHub in your browser.", true);
});
$("token-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $("signin-btn");
  if (button.disabled) return;
  button.disabled = true;
  $("forget-token").disabled = true;
  signinMessage("Checking token with GitHub…", false);
  const token = $("token").value;
  $("token").value = "";
  let cleanupError = "";
  try {
    const result = await window.desk.signIn(token);
    if (!result.ok) throw new Error(result.error);
    state.tokenKind = result.kind;
    await refresh();
    signinMessage("", false);
  } catch (error) {
    if (error.status === 401) {
      try {
        const result = await window.desk.signOut();
        if (!result.ok) cleanupError = result.error;
      } catch {
        cleanupError = "Could not remove the rejected credential.";
      }
    }
    $("forget-token").classList.toggle("hidden", error.status === 401 && !cleanupError);
    signinMessage(cleanupError ? `${error.message} ${cleanupError}` : error.message, true);
  } finally {
    button.disabled = Boolean(cleanupError);
    $("forget-token").disabled = false;
  }
});

async function signOut() {
  if (signingOut) return;
  signingOut = true;
  showApp(false);
  state = { ...initialState };
  for (const id of ["me-name", "me-login", "initials", "summary", "kpis", "attention", "notes", "year-caption",
    "year-heat", "stream-caption", "chips", "repo-filter", "minor-count", "stream", "insights", "meta",
    "fresh-badge", "refreshed"]) $(id).textContent = "";
  $("search").value = "";
  $("hide-minor").checked = true;
  setBusy("");
  showTab("overview");
  $("signin-btn").disabled = true;
  $("forget-token").disabled = true;
  signinMessage("Removing the saved credential…", false);
  try {
    const result = await window.desk.signOut();
    if (!result.ok) throw new Error(result.error);
    $("forget-token").classList.add("hidden");
    $("signin-btn").disabled = false;
    signinMessage("Signed out. The token was removed from this Mac.", false);
  } catch (error) {
    $("forget-token").classList.remove("hidden");
    signinMessage(error.message, true);
  } finally {
    signingOut = false;
    $("forget-token").disabled = false;
  }
}
$("signout").addEventListener("click", signOut);
$("forget-token").addEventListener("click", signOut);
$("refresh").addEventListener("click", refresh);
document.querySelectorAll(".nav").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
$("insight-nav").addEventListener("click", (event) => {
  const button = event.target.closest("[data-source]");
  if (!button || state.insight === button.dataset.source) return;
  state.insight = button.dataset.source;
  renderInsights(computed());
  $("content").scrollTop = 0;
});
$("insights").addEventListener("click", (event) => {
  const button = event.target.closest("[data-insight-repo]");
  if (!button) return;
  Object.assign(state, { repo: button.dataset.insightRepo, filter: "all", query: "", hideMinor: false });
  $("search").value = "";
  $("hide-minor").checked = false;
  showTab("stream");
  renderStream(computed());
  $("repo-filter").focus();
});
$("chips").addEventListener("click", (event) => {
  const chip = event.target.closest(".chip");
  if (!chip) return;
  state.filter = chip.dataset.filter;
  renderStream(computed());
});
$("repo-filter").addEventListener("change", (event) => {
  state.repo = event.target.value;
  renderStream(computed());
});
$("search").addEventListener("input", (event) => {
  state.query = event.target.value;
  renderStream(computed());
});
$("hide-minor").addEventListener("change", (event) => {
  state.hideMinor = event.target.checked;
  renderStream(computed());
});
$("mark-seen").addEventListener("click", () => {
  if (!state.events[0]) return;
  state.lastSeen = state.events[0].created_at;
  localStorage.setItem(seenKey(), state.lastSeen);
  renderAll();
});
document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "r") {
    event.preventDefault();
    if (!state.busy && !$("app").classList.contains("hidden")) $("refresh").click();
  }
  if ((event.metaKey || event.ctrlKey) && ["1", "2", "3", "4"].includes(event.key)) {
    showTab(["overview", "stream", "insights", "meta"][Number(event.key) - 1]);
  }
});

boot().catch((error) => signinMessage(error.message, true));
})();
