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
  prLookup: { asked: 0, found: 0 },
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
  tab: "overview",
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
function hoursLabel(h) {
  if (h == null) return "—";
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min`;
  if (h < 48) return `${h < 10 ? h.toFixed(1) : Math.round(h)} h`;
  return `${Math.round(h / 24)} days`;
}
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
function level(count, max) {
  if (!count) return 0;
  const r = count / Math.max(1, max);
  return r > 0.6 ? 4 : r > 0.35 ? 3 : r > 0.15 ? 2 : 1;
}
function bars(rows, opts) {
  const o = opts || {};
  const max = Math.max(1, ...rows.map((r) => r[1]));
  return `<div class="bars">${rows.map(([name, n]) =>
    `<div class="bar ${o.violet ? "violet" : ""}"><span class="name" title="${esc(name)}">${esc(name)}</span><span class="track"><span class="fill" style="width:${Math.max(2, (n / max) * 100).toFixed(1)}%"></span></span><span class="num">${esc(o.pct ? pct(n) : fmt(n))}</span></div>`
  ).join("")}</div>`;
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
    let detail = result.error || `GitHub returned ${result.status}`;
    try {
      const parsed = JSON.parse(result.body || "{}");
      if (parsed.message) detail = parsed.message;
    } catch { /* Response was not JSON. */ }
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
      return { events, issue: `Events page ${page} did not load: ${error.message}` };
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
      ...pr, repo: r.repo, number: r.number, files: pr.changedFiles,
      headRef: pr.headRefName, author: pr.author?.login, mergedBy: pr.mergedBy?.login,
      reviews: pr.reviews.totalCount,
    };
  });
  return {
    info, total: refs.length, asked: usable.length, found: Object.keys(info).length,
    error: errors[0]?.message,
  };
}

async function refresh() {
  const account = state;
  setBusy("Loading your profile…");
  try {
    const { data: user } = await api(account, "profile");
    if (!user?.login || !Number.isSafeInteger(user.id)) throw new Error("Unexpected GitHub profile.");
    setBusy("Loading activity…");
    const feed = await loadEvents(account, user.login);
    if (account !== state) return;
    const events = [...new Map(feed.events.map((e) => [e.id, e])).values()]
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));

    setBusy("Loading contribution year and notifications…");
    const refs = I.prRefsFromEvents(events);
    const [notes, year, prs] = await Promise.allSettled([
      api(account, "notifications"),
      api(account, "year"),
      lookupPullRequests(account, refs),
    ]);
    if (account !== state) return;

    const errors = {};
    if (feed.issue) errors.events = feed.issue;
    const notifications = notes.status === "fulfilled" && Array.isArray(notes.value.data) ? notes.value.data : null;
    if (!notifications) errors.notifications = `Notifications did not load: ${notes.reason?.message || "unexpected response"}`;
    else if (notes.value.more) errors.notifications = "Showing the first page of unread notifications.";
    const yearData = year.value?.data;
    const yearErrors = yearData?.errors || [];
    const contributionError = yearErrors.some(({ path }) => !path || path.length < 2 || path[1] === "contributionsCollection");
    const viewer = yearData?.data?.viewer;
    const contributions = !contributionError && viewer?.contributionsCollection?.contributionCalendar
      ? I.summarizeContributions(viewer.contributionsCollection, localDayKey(new Date())) : null;
    if (!contributions) errors.year = `Contribution year did not load: ${year.reason?.message || yearData?.errors?.[0]?.message || "contribution data unavailable"}`;
    else if (yearErrors.length) errors.year = "Some account details are unavailable.";
    const prLookup = prs.value || { info: {}, total: refs.length, asked: Math.min(refs.length, PR_LOOKUP_LIMIT), found: 0 };
    if (prs.status === "rejected") errors.prs = `Pull request details did not load: ${prs.reason.message}`;
    else if (prLookup.found < prLookup.asked) errors.prs = `Some pull request details are unavailable.${prLookup.error ? ` ${prLookup.error}` : ""}`;
    else if (prLookup.asked < prLookup.total) errors.prs = "Pull request details are limited to the first 40 references.";

    Object.assign(account, { user, viewer, contributions, events, notifications, prLookup, prInfo: prLookup.info, errors, refreshedAt: new Date() });
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
    account.errors.refresh = `Refresh failed: ${error.message}. Showing the last loaded data.`;
    renderAll();
  } finally {
    if (account === state) setBusy("");
  }
}

// ---------- rendering ----------
function renderIdentity() {
  const u = state.user;
  if (!u) return;
  $("me-name").textContent = u.name || u.login;
  $("me-login").textContent = `@${u.login}`;
  const avatar = String(u.avatar_url || "");
  $("avatar").removeAttribute("src");
  if (avatar.startsWith("https://avatars.githubusercontent.com/")) $("avatar").src = `${avatar}${avatar.includes("?") ? "&" : "?"}s=72`;
}

function computed() {
  const ev = I.summarizeEvents(state.events, { lastSeen: state.lastSeen });
  const pr = I.summarizePullRequests(state.prInfo, state.user && state.user.login);
  const notes = state.notifications ? I.summarizeNotifications(state.notifications) : null;
  return { ev, pr, notes, year: state.contributions };
}

function renderOverview(c) {
  const { ev, pr, notes, year } = c;
  const parts = [];
  if (ev.fresh) parts.push(`<strong>${fmt(ev.fresh)} new event${ev.fresh === 1 ? "" : "s"}</strong> since you last marked the stream seen.`);
  if (year) {
    const trend = year.trend == null ? "" : ` (${year.trend >= 0 ? "up" : "down"} ${pct(Math.abs(year.trend))} on the 30 days before)`;
    parts.push(`${fmt(year.last30)} contributions in the last 30 days${trend}.`);
  }
  if (ev.total) parts.push(`${pct(ev.agentShare)} of your recent feed traces back to AI agents.`);
  $("summary").innerHTML = parts.join(" ");

  const kpis = [
    ["Contributions this year", year ? fmt(year.total) : "—", year ? `${fmt(year.activeDays)} active days of ${fmt(year.dayCount)}` : esc(state.errors.year || "")],
    ["Current streak", year ? `${fmt(year.currentStreak)} d` : "—", year ? `Longest ${fmt(year.longestStreak)} days` : ""],
    ["Last 30 days", year ? fmt(year.last30) : "—", year && year.trend != null ? `<span class="${year.trend >= 0 ? "up" : "down"}">${year.trend >= 0 ? "▲" : "▼"} ${pct(Math.abs(year.trend))}</span> vs prior 30` : ""],
    ["Agent share of feed", ev.total ? pct(ev.agentShare) : "—", ev.agents.length ? ev.agents.slice(0, 3).map(([n, k]) => `${esc(n)} ${k}`).join(" · ") : "No agent activity found"],
  ];
  $("kpis").innerHTML = kpis.map(([label, value, sub]) =>
    `<div class="kpi"><div class="label">${esc(label)}</div><div class="value">${value}</div><div class="sub">${sub}</div></div>`).join("");

  const items = [];
  if (pr.agentUnreviewed.length) items.push(["bad", `${pr.agentUnreviewed.length} agent-branch PR${pr.agentUnreviewed.length === 1 ? "" : "s"} merged with no review`, pr.agentUnreviewed.slice(0, 3).map((p) => `${shortRepo(p.repo)} #${p.number}`).join(", ")]);
  else if (pr.unreviewed.length) items.push(["warn", `${pr.unreviewed.length} of ${pr.merged} merged PRs had no review`, "From the pull requests in your recent feed."]);
  if (pr.openMine.length) items.push(["warn", `${pr.openMine.length} of your PRs are still open`, pr.openMine.slice(0, 4).map((p) => `${shortRepo(p.repo)} #${p.number}${p.isDraft ? " (draft)" : ""}`).join(", ")]);
  if (notes && notes.missed.length) items.push(["bad", `${notes.missed.length} unread notification${notes.missed.length === 1 ? "" : "s"} that need you`, "Review requests, mentions, assignments or failed checks."]);
  if (ev.defaultPushes) items.push([ev.defaultPushShare > 0.5 ? "warn" : "", `${pct(ev.defaultPushShare)} of pushes went straight to main`, `${ev.defaultPushes} direct pushes vs ${ev.branchPushes} to branches in the feed window.`]);
  if (ev.branchesCreated > ev.branchesDeleted + 3) items.push(["", `${ev.branchesCreated - ev.branchesDeleted} more branches created than deleted`, "Stale agent branches pile up quietly."]);
  if (year && year.totals.prs && year.totals.reviews / year.totals.prs < 0.05) items.push(["warn", `1 review for every ${Math.round(year.totals.prs / Math.max(1, year.totals.reviews))} PRs this year`, `${fmt(year.totals.reviews)} reviews against ${fmt(year.totals.prs)} pull requests.`]);
  const coverage = Object.values(state.errors);
  if (coverage.length) items.push(["warn", "Some data is missing or limited", coverage.join(" ")]);
  else if (!items.length) items.push(["good", "Nothing stands out in the loaded data", "No unreviewed merges, open PRs or direct-push spikes in the loaded sample."]);
  $("attention").innerHTML = items.map(([cls, t, d]) =>
    `<li class="${cls}"><span class="dot"></span><div><div class="t">${esc(t)}</div><div class="d">${esc(d)}</div></div></li>`).join("");

  if (!notes) {
    $("notes").innerHTML = `<p class="note">${esc(state.errors.notifications || "Notifications are not available.")}</p><p class="note">Use a classic token with the <code>notifications</code> scope to see unread review requests, mentions and failed checks here.</p>`;
  } else {
    $("notes").innerHTML = `<p class="big"><strong>${fmt(notes.unread)}</strong> unread loaded · ${fmt(notes.ciNoise)} are routine CI updates</p>${bars(notes.byReason.slice(0, 6))}` +
      (notes.missed.length ? `<ul class="attention">${notes.missed.slice(0, 5).map((n) => `<li class="warn"><span class="dot"></span><div><div class="t">${esc((n.subject && n.subject.title) || "Notification")}</div><div class="d">${esc(n.reason)} · ${esc(n.repository && n.repository.full_name)}</div></div></li>`).join("")}</ul>` : "");
  }

  renderYear(year);
}

function renderYear(year) {
  if (!year) {
    $("year-heat").innerHTML = `<p class="note">${esc(state.errors.year || "Contribution year did not load.")}</p>`;
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
  $("year-heat").innerHTML = html;
  const busiest = year.busiest[0];
  $("year-caption").textContent = `${fmt(year.total)} contributions${busiest ? ` · busiest ${busiest.date} (${busiest.contributionCount})` : ""}`;
}

function renderStream(c) {
  const { ev } = c;
  const span = ev.spanHours < 48 ? `${Math.max(1, Math.round(ev.spanHours))} hours` : `${Math.round(ev.spanHours / 24)} days`;
  $("stream-caption").textContent = ev.total
    ? `${fmt(ev.total)} events loaded across ${span}.`
    : "No recent events loaded.";
  if (state.errors.events) $("stream-caption").textContent += ` ${state.errors.events}`;

  const counts = Object.fromEntries(CHIPS.map(([k]) => [k, I.filterEvents(state.events, k, state.repo, "", state.hideMinor).length]));
  const minor = state.events.filter(I.isMinor).length;
  $("minor-count").textContent = minor ? `(${minor})` : "";
  $("chips").innerHTML = CHIPS.map(([k, label]) =>
    `<button class="chip" role="tab" type="button" data-filter="${k}" aria-selected="${state.filter === k}">${esc(label)}<span class="n">${counts[k]}</span></button>`).join("");

  const repos = ev.byRepo.map(([r]) => r);
  $("repo-filter").innerHTML = `<option value="">All repositories</option>${repos.map((r) => `<option value="${esc(r)}"${r === state.repo ? " selected" : ""}>${esc(shortRepo(r))}</option>`).join("")}`;

  const list = I.filterEvents(state.events, state.filter, state.repo, state.query, state.hideMinor);
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
          if (info.merged && !info.reviews) tags.push(`<span class="tag warn">no review</span>`);
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

function renderInsights(c) {
  const { ev, pr, year } = c;
  const cards = [];

  // Rhythm
  const maxHour = Math.max(1, ...ev.hourGrid.flat());
  let grid = `<span></span>${Array.from({ length: 24 }, (_, h) => `<span class="axis">${h % 6 === 0 ? esc(hourName(h)) : ""}</span>`).join("")}`;
  for (let d = 1; d <= 7; d += 1) {
    const day = d % 7;
    grid += `<span class="lab">${DAY_NAMES[day]}</span>${ev.hourGrid[day].map((n, h) => `<span class="h l${level(n, maxHour)}" title="${DAY_NAMES[day]} ${hourName(h)}: ${n} events"></span>`).join("")}`;
  }
  const weekdayMax = year ? Math.max(1, ...year.weekday) : 1;
  cards.push(`<article class="card"><h3>Work rhythm</h3>
    <p class="big">${ev.peakHour ? `Busiest slot in the feed: <strong>${DAY_NAMES[ev.peakHour.day]} ${hourName(ev.peakHour.hour)}</strong>, your local time.` : "Not enough events yet."}</p>
    <div class="hours">${grid}</div>
    ${year ? `<div class="cols">${year.weekday.map((n, i) => `<div class="col"><i style="height:${Math.max(2, (n / weekdayMax) * 70).toFixed(0)}px" title="${fmt(n)}"></i><span>${DAY_NAMES[i]}</span></div>`).join("")}</div>
    <p class="note">Bottom: contributions by weekday across the year. ${pct(year.weekendShare)} land on weekends.</p>` : ""}
  </article>`);

  // Streaks
  if (year) {
    cards.push(`<article class="card"><h3>Consistency</h3>
      <div class="stat-row"><div class="stat"><b>${fmt(year.currentStreak)}</b><span>day streak now</span></div><div class="stat"><b>${fmt(year.longestStreak)}</b><span>longest streak</span></div><div class="stat"><b>${pct(year.activeDays / Math.max(1, year.dayCount))}</b><span>days active</span></div></div>
      <p class="big">A typical active day has <strong>${fmt(year.medianActiveDay)}</strong> contributions. Your top day had <strong>${fmt(year.busiest[0] && year.busiest[0].contributionCount)}</strong>, about ${year.medianActiveDay ? Math.round(year.busiest[0].contributionCount / year.medianActiveDay) : "—"}× normal.</p>
      ${bars(year.busiest.map((d) => [new Date(`${d.date}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }), d.contributionCount]))}
    </article>`);
  }

  // Focus
  if (year && year.commits.length) {
    cards.push(`<article class="card"><h3>Focus</h3>
      <p class="big"><strong>${pct(year.focusShare)}</strong> of this year's commits went to <strong>${esc(shortRepo(year.commits[0].repo))}</strong>. You committed to ${fmt(year.totals.repos)} repositories in total.</p>
      ${bars(year.commits.slice(0, 7).map((r) => [shortRepo(r.repo) + (r.isPrivate ? " 🔒" : ""), r.count]))}
      ${ev.reposPerDay != null ? `<p class="note">In the feed window you touch a median of ${fmt(ev.reposPerDay)} repositories per day.</p>` : ""}
    </article>`);
  }

  // Collaboration balance
  if (year) {
    const t = year.totals;
    cards.push(`<article class="card"><h3>Shipping vs reviewing</h3>
      ${bars([["Commits", t.commits], ["Pull requests", t.prs], ["Issues", t.issues], ["Reviews given", t.reviews]])}
      <div class="callout">${t.reviews ? `You gave <strong>1 review for every ${fmt(Math.round(t.prs / t.reviews))} pull requests</strong> you opened this year.` : "You did not review any pull requests this year."} On solo repos that is expected. Where agents open the PRs, it means most code merges without a second reader.</div>
    </article>`);
  }

  // PR health
  if (pr.total) {
    cards.push(`<article class="card"><h3>Pull request health</h3>
      <div class="stat-row"><div class="stat"><b>${hoursLabel(pr.medianHoursToMerge)}</b><span>median to merge</span></div><div class="stat"><b>${fmt(pr.medianSize)}</b><span>median lines changed</span></div><div class="stat"><b>${pct(pr.merged ? pr.unreviewed.length / pr.merged : null)}</b><span>merged unreviewed</span></div></div>
      <p class="big">${fmt(pr.total)} PRs from the feed: ${fmt(pr.merged)} merged, ${fmt(pr.open.length)} open, ${fmt(pr.selfMerged)} merged by their own author.</p>
      ${pr.largest.length ? `<p class="note">Largest: ${pr.largest.map((p) => `${esc(shortRepo(p.repo))} #${p.number} (+${fmt(p.additions)} −${fmt(p.deletions)})`).join(", ")}</p>` : ""}
    </article>`);
  }

  // Agents
  cards.push(`<article class="card"><h3>AI agents in your activity</h3>
    <p class="big">${ev.agentEvents ? `<strong>${fmt(ev.agentEvents)}</strong> of ${fmt(ev.total)} feed events (${pct(ev.agentShare)}) came from an agent app or an agent branch.` : "No agent apps or agent branches found in the feed."}</p>
    ${ev.agents.length ? bars(ev.agents, { violet: true }) : ""}
    ${pr.agentAuthored ? `<div class="callout"><strong>${fmt(pr.agentAuthored)}</strong> PRs came from agent branches. ${pr.agentUnreviewed.length ? `<strong>${fmt(pr.agentUnreviewed.length)}</strong> were merged with no review.` : "None were merged without review."}</div>` : ""}
    <p class="note">Comments and issues count when an agent app posted them. Pushes, branches and PRs count when the branch starts with claude/, codex/, cursor/, copilot/, devin/ or jules/.</p>
  </article>`);

  // Branch hygiene
  cards.push(`<article class="card"><h3>Branch habits</h3>
    <div class="stat-row"><div class="stat"><b>${pct(ev.defaultPushShare)}</b><span>pushes to main</span></div><div class="stat"><b>${fmt(ev.branchesCreated)}</b><span>branches created</span></div><div class="stat"><b>${fmt(ev.branchesDeleted)}</b><span>branches deleted</span></div></div>
    <p class="big">${ev.defaultPushes ? `${fmt(ev.defaultPushes)} direct pushes to main skipped a pull request.` : "Every push in the window went to a branch."} ${ev.prActions.merged ? `${fmt(ev.prActions.merged)} PRs merged in the window.` : ""}</p>
  </article>`);

  // Work mix
  if (ev.tags.length) {
    cards.push(`<article class="card"><h3>Work mix</h3>
      <p class="big">From the <code>[tag]</code> at the start of issues you opened in the feed window.</p>
      ${bars(ev.tags.slice(0, 8))}
    </article>`);
  }

  // Monthly trend
  if (year && year.monthly.length) {
    const max = Math.max(1, ...year.monthly.map(([, n]) => n));
    cards.push(`<article class="card"><h3>Monthly trend</h3>
      <div class="cols">${year.monthly.map(([m, n]) => `<div class="col"><i style="height:${Math.max(2, (n / max) * 70).toFixed(0)}px" title="${esc(m)}: ${fmt(n)}"></i><span>${MONTHS[Number(m.slice(5, 7)) - 1].slice(0, 1)}</span></div>`).join("")}</div>
      <p class="note">${year.trend == null ? "" : `Last 30 days: ${fmt(year.last30)} vs ${fmt(year.prev30)} the 30 before.`}</p>
    </article>`);
  }

  $("insights").innerHTML = cards.join("");
}

function renderMeta(c) {
  const { ev, year } = c;
  const v = state.viewer;
  const span = ev.spanHours < 48 ? `${Math.max(1, Math.round(ev.spanHours))} hours` : `${Math.round(ev.spanHours / 24)} days`;
  const cards = [];

  cards.push(`<article class="card"><h3>How far back the stream goes</h3>
    <p class="big">The feed holds <strong>${fmt(ev.total)}</strong> events covering <strong>${span}</strong>.</p>
    <div class="callout">${esc(state.errors.events || "The stream covers the events returned by GitHub for this token. GitHub limits the feed to 300 recent events.")}</div>
    <p class="note">Insights marked as feed-based cover only this window. Year cards use the full contribution calendar.</p>
  </article>`);

  const kind = state.tokenKind;
  const caps = [];
  caps.push([state.errors.events ? "part" : "ok", "Activity stream", esc(state.errors.events || "Recent events loaded.")]);
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
      : ["ok", "Private contributions", "None hidden from this token."]);
  }
  cards.push(`<article class="card"><h3>What this token can see</h3>
    <p class="big">Signed in with a <strong>${esc(kind || "GitHub")}</strong> token.</p>
    <ul class="cap">${caps.map(([s, t, d]) => `<li><span class="${s}">${s === "ok" ? "✓" : s === "no" ? "✕" : "!"}</span><div><div>${esc(t)}</div><div class="d">${d}</div></div></li>`).join("")}</ul>
  </article>`);

  if (v) {
    const created = new Date(v.createdAt);
    const years = ((Date.now() - created.getTime()) / (365.25 * 864e5)).toFixed(1);
    cards.push(`<article class="card"><h3>Account</h3>
      <dl class="kv">
        <dt>On GitHub since</dt><dd>${esc(created.toLocaleDateString(undefined, { month: "short", year: "numeric" }))} · ${years} years</dd>
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
      <dt>API requests left this hour</dt><dd>${esc(state.remaining ?? "—")}</dd>
    </dl>
    <p class="note">Each refresh uses about 6 API requests. The token stays on this Mac and is sent only to api.github.com.</p>
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
  state.tab = tab;
  document.querySelectorAll(".nav").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
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

$("create-token").addEventListener("click", () => window.desk.openTokenPage());
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
  for (const id of ["me-name", "me-login", "summary", "kpis", "attention", "notes", "year-caption",
    "year-heat", "stream-caption", "chips", "repo-filter", "minor-count", "stream", "insights", "meta",
    "fresh-badge", "refreshed"]) $(id).textContent = "";
  $("avatar").removeAttribute("src");
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
