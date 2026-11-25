(() => {
"use strict";

const I = window.DeskInsights;
const N = window.DeskNotes;
const $ = (id) => document.getElementById(id);
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const LAST_SEEN_KEY = "desk.lastSeen";
const EVENT_PAGES = 3; // GitHub serves at most 300 events
const PR_LOOKUP_LIMIT = 40;
const AUTHORED_PAGES = 3; // 100 pull requests per page
const AUTHORED_DAYS = 90; // matches the authored search window in main.js
const FOOTPRINT_REPOS = 10; // most recently pushed repositories you own
const STAR_DATES_MAX = 100;
const HISTORY_YEARS = 20; // matches the batched year limit in main.js // star dates are read for repositories with at most one page of stars
const TRAFFIC_CONCURRENCY = 4;
const GLYPHS = { PushEvent: "↑", PullRequestEvent: "⇄", IssuesEvent: "◉", IssueCommentEvent: "✎", CreateEvent: "+", DeleteEvent: "−", PullRequestReviewEvent: "✓", ReleaseEvent: "◆", WatchEvent: "★", ForkEvent: "⑂" };
const CHIPS = [["all", "All"], ["push", "Pushes"], ["pr", "Pull requests"], ["issue", "Issues"], ["comment", "Comments"], ["branch", "Branches"], ["agent", "Agents"]];
const CONVERSATION_CHIPS = [["all", "All"], ["awaiting", "Awaiting reply"], ["others", "From others"], ["mine", "Yours"], ["reviews", "Reviews"], ["bots", "Bots"]];
const PUSH_BURST_MINUTES = 60; // pushes to one branch this close together read as one row
const CONVERSATION_GLYPHS = { comment: "✎", review: "✓", inline: "‹›" };
const CONVERSATION_LABELS = { comment: "Comment", review: "Review", inline: "Review comment" };
const TEXT_PREVIEW = 180;
const PUBLIC_STAR_REPOS = 3; // star dates read without a token, to stay inside 60 requests an hour
// What the public view cannot load, by the key each view reads its explanation from.
const NEEDS_TOKEN = {
  year: "The contribution calendar needs a token.",
  years: "Contribution history needs a token.",
  authored: "Reviews, sizes, and branches of pull requests need a token. Public pull requests load by search.",
  reviewed: "Pull requests you reviewed need a token.",
  conversations: "Conversations need a token.",
  requests: "Review requests need a token.",
  notifications: "Unread notifications need a classic token.",
  footprint: "Repository traffic needs a token. Stars and forks are public.",
  history: "Saved history needs a token.",
};
const PUBLIC_NOTES = "Notes need a token. A username alone does not show whose notes to open.";
const PUBLIC_LIMIT = "GitHub's hourly limit for requests without a token was reached. Try again later, or add a token in Data & access.";

const initialState = {
  public: false, // true in the public view: a username and no token
  locked: null, // in the public view: the sources that need a token
  tokens: {}, // slot → kind for each saved token
  tokenUse: null, // with two tokens: what each one added to the merged sources
  answered: {}, // operation → slots that answered it in this refresh
  ledger: {}, // operation → requests sent to GitHub in this refresh, counting a retry with the other token
  user: null,
  viewer: null,
  events: [],
  prInfo: {},
  reviewed: null,
  requests: null, // GitHub's search for open pull requests that ask you for a review
  prLookup: { authored: null, referenced: { total: 0, covered: 0, asked: 0, found: 0 }, commits: null },
  snapshotSaved: false,
  cards: {},
  suggestScope: "",
  rateLimit: null,
  tokenMeta: null,
  footprint: null,
  savedHistory: null,
  contributionHistory: null,
  contributions: null,
  notifications: null,
  errors: {},
  remaining: null,
  refreshedAt: null,
  lastSeen: null,
  filter: "all",
  conversations: null,
  notes: null,
  streamSource: "events",
  conversationFilter: "all",
  repo: "",
  query: "",
  hideMinor: true,
  insight: "year",
  busy: false,
};
let state = { ...initialState };
let signingOut = false;
// Comment texts the reader expanded, kept open when the stream re-renders.
const openTexts = new Set();
let indexCache = { items: null, login: null, index: null };
const conversationTexts = new WeakMap();
const seenKey = () => `${LAST_SEEN_KEY}.${state.public ? "public." : ""}${state.user.id}`;
const SLOTS = I.TOKEN_SLOTS;
// True when both a fine-grained and a classic token are saved, so sources can be read with each.
const dual = (account) => SLOTS.every((slot) => account.tokens[slot]);
const savedSlots = (account) => SLOTS.filter((slot) => account.tokens[slot]);

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

// Your comments in the loaded conversations, used for event comments that arrive without text.
function commentIndex() {
  const items = state.conversations?.items || null;
  const login = state.user?.login || null;
  if (indexCache.items !== items || indexCache.login !== login) {
    indexCache = { items, login, index: I.conversationIndex(items, login) };
  }
  return indexCache.index;
}

// Written text under a stream row. Short text shows in full; longer text shows a preview that expands.
function textBlock(key, t, agent) {
  if (!t) return "";
  const tone = agent ? " agent" : "";
  if (t.missing) return `<p class="body-missing">${esc(t.label)} text was not in GitHub's event payload or the loaded conversations.</p>`;
  const from = t.source === "conversation" ? '<span class="src">text from Conversations</span>' : "";
  const flat = t.text.replace(/\s+/g, " ");
  if (t.text.length <= TEXT_PREVIEW && t.text.split("\n").length <= 3 && !t.clipped) {
    return `<p class="body-short${tone}">${esc(t.text)}${from ? ` ${from}` : ""}</p>`;
  }
  const preview = flat.length > TEXT_PREVIEW ? `${flat.slice(0, TEXT_PREVIEW).trimEnd()}…` : flat;
  const what = t.label.toLowerCase();
  const rest = t.clipped ? `\n\n… ${fmt(t.clipped)} more characters not shown.` : "";
  return `<details class="body${tone}" data-text-key="${esc(key)}"${openTexts.has(key) ? " open" : ""}>
    <summary><span class="body-preview">${esc(preview)}</span>
      <span class="body-toggle"><span class="when-closed">Show full ${esc(what)} · ${fmt(t.text.length + t.clipped)} characters</span><span class="when-open">Hide ${esc(what)}</span></span>${from}</summary>
    <div class="body-full">${esc(t.text + rest)}</div>
  </details>`;
}

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
// Without a slot the main process picks the token: fine-grained first, classic when GitHub denies it,
// and classic alone for notifications. With a slot, only that saved token is used.
async function api(account, operation, args, slot) {
  if (account !== state) throw new Error("Session changed.");
  const result = await window.desk.github(operation, args, slot);
  if (account !== state) throw new Error("Session changed.");
  // A request the main process refused before sending (status 400 without a response) costs nothing.
  if (result.via != null || result.status === 0) account.ledger[operation] = (account.ledger[operation] || 0) + 1 + (result.skipped?.length || 0);
  if (result.remaining != null) account.remaining = result.remaining;
  const accepted = recordToken(account, operation, result);
  if (result.ok && SLOTS.includes(result.via)) (account.answered[operation] || (account.answered[operation] = new Set())).add(result.via);
  if (!result.ok) {
    const need = accepted.length && (result.status === 403 || result.status === 404)
      ? ` GitHub accepts ${accepted.map((set) => set.join(" with ")).join(", or ")} for this request.` : "";
    const detail = (result.error || (account.public ? { 403: PUBLIC_LIMIT, 429: PUBLIC_LIMIT } : {
      401: "GitHub rejected the saved token.",
      403: "GitHub denied the request. Check token permissions and rate limits.",
      429: "GitHub rate limit reached.",
    })[result.status] || `GitHub returned HTTP ${result.status}.`) + need;
    throw Object.assign(new Error(detail), { status: result.status });
  }
  return { data: JSON.parse(result.body || "null"), more: /rel="next"/.test(result.link || ""), via: result.via };
}

// Token metadata from response headers, kept per saved token: expiry, classic scopes, the permissions
// a denied request needs, and whether GitHub rejected the token outright.
function recordToken(account, operation, result) {
  const meta = account.tokenMeta || (account.tokenMeta = {});
  const note = (slot, t, failed, status) => {
    if (!SLOTS.includes(slot) || !t) return [];
    const m = meta[slot] || (meta[slot] = { expires: null, scopes: null, denied: {}, rejected: false });
    if (t.expires) m.expires = t.expires;
    if (t.scopes != null) m.scopes = t.scopes;
    if (status === 401) m.rejected = true;
    const accepted = I.parseAcceptedPermissions(t.accepted);
    if (failed && accepted.length) m.denied[operation] = accepted;
    return accepted;
  };
  // Tokens GitHub denied before another saved token answered.
  for (const s of result.skipped || []) note(s.slot, s.token, true, s.status);
  return note(result.via, result.token, !result.ok, result.status);
}

async function loadEvents(account, login, slot) {
  const events = [];
  let more = false;
  for (let page = 1; page <= EVENT_PAGES; page += 1) {
    try {
      const result = await api(account, "events", { login, page }, slot);
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

// With two tokens, each reads the feed and the pages are joined by event id, since a token only
// returns the private events it is allowed to see.
async function loadAllEvents(account, login) {
  if (!dual(account)) return loadEvents(account, login);
  const loads = await Promise.all(SLOTS.map(async (slot) => ({ slot, ...(await loadEvents(account, login, slot)) })));
  const { events, only } = I.mergeTokenEvents(loads);
  const same = loads.every((l) => l.issue === loads[0].issue);
  const issue = same ? loads[0].issue : loads.filter((l) => l.issue).map((l) => `With the ${l.slot} token: ${l.issue}`).join(" ");
  return { events, issue, only };
}

// Details for pull requests referenced in events. With two tokens, those the first token could not
// read are asked for again with the other one.
async function lookupPullRequests(account, refs) {
  const usable = refs.slice(0, PR_LOOKUP_LIMIT);
  if (!usable.length) return { info: {}, total: 0, asked: 0, found: 0 };
  const info = {};
  const read = async (list, slot) => {
    const { data: result, via } = await api(account, "pullRequests", list, slot);
    const errors = result?.errors || [];
    const failed = new Set(errors.map((error) => error.path?.[0]));
    list.forEach((r, i) => {
      const alias = `p${i}`;
      const pr = failed.has(undefined) || failed.has(alias) ? null
        : I.normalizePullRequest(result?.data?.[alias]?.pullRequest, r.repo, r.number, "events");
      if (pr) info[I.prKey(r.repo, r.number)] = pr;
    });
    return via;
  };
  const via = await read(usable);
  const missing = usable.filter((r) => !info[I.prKey(r.repo, r.number)]);
  const other = SLOTS.find((slot) => slot !== via);
  if (missing.length && dual(account) && via) {
    await read(missing, other).catch((error) => { if (error.message === "Session changed.") throw error; });
  }
  return {
    info, total: refs.length, asked: usable.length, found: Object.keys(info).length,
  };
}

// Save this week's numbers only when the authored search covered the full window.
async function saveWeeklySnapshot(account, mine) {
  account.snapshotSaved = false;
  const h = account.savedHistory;
  if (account.public || !h?.enabled) return;
  if (!mine || mine.capped || mine.partial || mine.issue || mine.loaded < mine.total) {
    account.errors.snapshot = "A weekly snapshot needs a complete search for pull requests you opened. This refresh kept the previously saved weeks.";
    return;
  }
  const snapshot = I.snapshotOf(I.summarizeOutcomes(account.prInfo, account.user.login, account.refreshedAt));
  const result = await window.desk.saveSnapshot(snapshot).catch(() => ({ ok: false, error: "The weekly snapshot could not be saved." }));
  if (result.ok) {
    account.snapshotSaved = true;
    h.week = result.week;
  } else {
    account.errors.snapshot = result.error;
  }
}

// When the last commit landed on each merged pull request you opened, newest merges first. A separate
// read, so a token that cannot see commits loses only the working-and-waiting split. Capped at
// COMMIT_LOOKUP_LIMIT merges, in batches the main process accepts.
const COMMIT_LOOKUP_LIMIT = 120;
async function lookupCommitTimes(account, info, login) {
  const me = String(login || "").toLowerCase();
  const merged = Object.values(info).filter((pr) => pr.merged && String(pr.author || "").toLowerCase() === me)
    .sort((a, b) => Date.parse(b.mergedAt) - Date.parse(a.mergedAt));
  const usable = merged.slice(0, COMMIT_LOOKUP_LIMIT);
  const out = { total: merged.length, asked: usable.length, found: 0, issue: "" };
  for (let i = 0; i < usable.length; i += 40) {
    const list = usable.slice(i, i + 40).map((pr) => ({ repo: pr.repo, number: pr.number }));
    try {
      const { data: result } = await api(account, "pullRequestCommits", list);
      if (result?.errors?.length && !out.issue) out.issue = "GitHub returned errors for some commit reads, which can mean the token cannot read the repository's contents.";
      list.forEach((r, j) => {
        const at = result?.data?.[`p${j}`]?.pullRequest?.commits?.nodes?.[0]?.commit?.committedDate;
        if (typeof at === "string" && Number.isFinite(Date.parse(at))) {
          info[I.prKey(r.repo, r.number)].lastCommitAt = at;
          out.found += 1;
        }
      });
    } catch (error) {
      if (error.message === "Session changed.") throw error;
      out.issue = error.message;
      break;
    }
  }
  return out;
}

async function mapLimit(items, limit, fn) {
  const queue = items.slice();
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) await fn(queue.shift());
  }));
}

// Traffic for your most recently pushed repositories, plus star dates for small ones.
// The first repository's views decide whether the token can read traffic at all, so a token
// without Administration: read costs one request instead of thirty.
async function loadFootprint(account) {
  const { data } = await api(account, "ownedRepos");
  if (!Array.isArray(data)) throw new Error("GitHub did not return a usable repository list.");
  const own = data.filter((r) => !r.fork && !r.archived);
  const repos = own.slice().sort((a, b) => String(b.pushed_at).localeCompare(String(a.pushed_at))).slice(0, FOOTPRINT_REPOS);
  const fp = { repos, listed: own.length, more: data.length >= 100, traffic: {}, stars: {}, denied: "", issues: [] };
  const read = async (repo) => {
    const t = {};
    for (const kind of ["views", "clones", "referrers"]) t[kind] = (await api(account, "traffic", { repo: repo.full_name, kind })).data;
    fp.traffic[repo.full_name] = t;
  };
  // Traffic is never public. The public view reads the repository list and a few star dates only.
  if (account.public) fp.denied = NEEDS_TOKEN.footprint;
  else if (repos.length) {
    try {
      await read(repos[0]);
    } catch (error) {
      if (error.message === "Session changed.") throw error;
      fp.denied = error.message;
    }
    if (!fp.denied) {
      await mapLimit(repos.slice(1), TRAFFIC_CONCURRENCY, (r) => read(r).catch((error) => {
        if (error.message === "Session changed.") throw error;
        fp.issues.push(`${r.full_name}: ${error.message}`);
      }));
    }
  }
  for (const r of repos) if (r.stargazers_count === 0) fp.stars[r.full_name] = [];
  const small = repos.filter((r) => r.stargazers_count > 0 && r.stargazers_count <= STAR_DATES_MAX)
    .slice(0, account.public ? PUBLIC_STAR_REPOS : FOOTPRINT_REPOS);
  await mapLimit(small, TRAFFIC_CONCURRENCY, async (r) => {
    try {
      const { data: dates } = await api(account, "stargazers", { repo: r.full_name });
      if (Array.isArray(dates)) fp.stars[r.full_name] = dates;
    } catch (error) {
      if (error.message === "Session changed.") throw error;
      fp.issues.push(`${r.full_name} stars: ${error.message}`);
    }
  });
  const saved = account.public ? null : await window.desk.history().catch(() => null);
  return { fp, saved };
}

// Pull requests from a search over the last AUTHORED_DAYS days: those you opened, or those by others you reviewed.
// Up to AUTHORED_PAGES pages of 100, newest first. A failure after the first page keeps what loaded.
async function loadAuthoredPullRequests(account, login, operation = "authoredPullRequests", slot) {
  const what = operation === "reviewedPullRequests" ? "Reviewed" : "Authored";
  const info = {};
  let total = null;
  let after;
  let more = false;
  let partial = false;
  let issue = "";
  for (let page = 1; page <= AUTHORED_PAGES; page += 1) {
    let search;
    try {
      const { data } = await api(account, operation, after ? { login, after } : { login }, slot);
      search = data?.data?.search;
      if (!search || !Array.isArray(search.nodes)) throw new Error("GitHub did not return a usable pull request search.");
      if (data.errors?.length) partial = true;
    } catch (error) {
      if (page === 1) throw error;
      issue = `${what} pull requests page ${page} did not load. ${error.message}`;
      break;
    }
    if (Number.isInteger(search.issueCount)) total = search.issueCount;
    for (const node of search.nodes) {
      const repo = node?.repository?.nameWithOwner;
      if (!node || node.__typename !== "PullRequest") { partial = true; continue; }
      const pr = typeof repo === "string" && Number.isInteger(node.number) ? I.normalizePullRequest(node, repo, node.number, "search") : null;
      if (pr && operation === "reviewedPullRequests") {
        const at = node.myReviews?.nodes?.[0]?.submittedAt;
        pr.myFirstReviewAt = typeof at === "string" ? at : null;
        delete pr.myReviews;
      }
      if (pr) info[I.prKey(repo, node.number)] = pr; else partial = true;
    }
    more = Boolean(search.pageInfo?.hasNextPage && search.pageInfo.endCursor);
    if (!more) break;
    after = search.pageInfo.endCursor;
  }
  const loaded = Object.keys(info).length;
  return { info, loaded, total: total ?? loaded, capped: more || Boolean(issue), partial, issue, days: AUTHORED_DAYS };
}

// With two tokens, each runs the search and the results are joined by pull request, since a search
// returns only what its token can read. One token's failure keeps the other's results.
async function loadPullRequestSearch(account, login, operation = "authoredPullRequests") {
  if (!dual(account)) return loadAuthoredPullRequests(account, login, operation);
  const settled = await Promise.allSettled(SLOTS.map((slot) => loadAuthoredPullRequests(account, login, operation, slot)));
  const loads = SLOTS.map((slot, i) => ({ slot, load: settled[i].value, reason: settled[i].reason }));
  const good = loads.filter((l) => l.load);
  if (!good.length) throw loads[0].reason;
  const merged = I.mergePullRequestLoads(good);
  const failed = loads.filter((l) => !l.load).map((l) => `The ${l.slot} token's search did not load. ${l.reason?.message || ""}`.trim());
  if (failed.length) merged.issue = [merged.issue, ...failed].filter(Boolean).join(" ");
  return merged;
}

// Conversations as GitHub's response body. With two tokens, each search runs with both and threads are
// joined, keeping the copy with more comments.
async function loadConversations(account, login) {
  if (!dual(account)) return (await api(account, "conversations", { login })).data;
  const settled = await Promise.allSettled(SLOTS.map((slot) => api(account, "conversations", { login }, slot)));
  const loads = SLOTS.map((slot, i) => ({ slot, body: settled[i].value?.data, reason: settled[i].reason }));
  const good = loads.filter((l) => l.body?.data);
  if (!good.length) {
    const body = loads.find((l) => l.body)?.body;
    if (body) return body;
    throw loads[0].reason;
  }
  const { data, only } = I.mergeConversationData(good.map((l) => ({ slot: l.slot, data: l.body.data })));
  return {
    data, only,
    errors: good.flatMap((l) => l.body.errors || []),
    partialSlots: good.filter((l) => l.body.errors?.length).map((l) => l.slot),
    failed: loads.filter((l) => !l.body?.data).map((l) => `The ${l.slot} token's search did not load. ${l.reason?.message || l.body?.errors?.[0]?.message || ""}`.trim()),
  };
}

// Open pull requests that ask you for a review, as GitHub's search body. With two tokens, each runs the
// search and the results are joined by pull request, since each sees only what its token can read.
async function loadReviewRequests(account, login) {
  if (!dual(account)) {
    const { data } = await api(account, "reviewRequests", { login });
    if (!Array.isArray(data?.data?.search?.nodes)) throw new Error(data?.errors?.[0]?.message || "GitHub did not return a usable review-request search.");
    return { search: data.data.search, partial: Boolean(data.errors?.length) };
  }
  const settled = await Promise.allSettled(SLOTS.map((slot) => api(account, "reviewRequests", { login }, slot)));
  const good = SLOTS.map((slot, i) => ({ slot, data: settled[i].value?.data })).filter((l) => Array.isArray(l.data?.data?.search?.nodes));
  if (!good.length) throw settled[0].reason || new Error("GitHub did not return a usable review-request search.");
  const key = (n) => `${n?.repository?.nameWithOwner}#${n?.number}`;
  const nodes = new Map();
  const seen = new Map();
  for (const l of good) {
    for (const n of l.data.data.search.nodes) {
      if (!n?.repository) continue;
      if (!nodes.has(key(n))) nodes.set(key(n), n);
      seen.set(key(n), (seen.get(key(n)) || new Set()).add(l.slot));
    }
  }
  const only = Object.fromEntries(SLOTS.map((slot) => [slot, [...seen.values()].filter((v) => v.size === 1 && v.has(slot)).length]));
  const counts = good.map((l) => l.data.data.search.issueCount).filter(Number.isInteger);
  return {
    search: { nodes: [...nodes.values()], issueCount: Math.max(nodes.size, ...counts) },
    partial: good.some((l) => l.data.errors?.length),
    partialSlots: good.filter((l) => l.data.errors?.length).map((l) => l.slot),
    only,
    failed: SLOTS.filter((slot) => !good.some((l) => l.slot === slot)).map((slot) => `The ${slot} token's search did not load.`),
  };
}

// The contribution year. With two tokens, both read it and the one that hides fewer contributions is
// kept, so the calendar and the per-repository breakdown come from a single token.
async function loadYear(account) {
  if (!dual(account)) return api(account, "year");
  const settled = await Promise.allSettled(SLOTS.map((slot) => api(account, "year", undefined, slot)));
  const reads = SLOTS.map((slot, i) => ({ slot, data: settled[i].value?.data })).filter((r) => r.data);
  const best = I.pickContributionYear(reads);
  if (best) return { data: best.data, slot: best.slot };
  if (reads.length) return { data: reads[0].data, slot: reads[0].slot };
  throw settled[0].reason;
}

// "with this token" for one saved token, and the tokens by name for two.
function tokenPhrase(slots) {
  if (!slots || !slots.length) return "with this token";
  return slots.length > 1 ? "with either token" : `with the ${slots[0]} token`;
}

// Public pull requests the username opened in the last AUTHORED_DAYS days, from GitHub's issue search
// without a token. Up to AUTHORED_PAGES pages of 100, newest first. Search has its own limit without a
// token, 10 requests a minute, so a refresh never spends the 60-an-hour budget on it.
const PUBLIC_SEARCH_LIMIT = "GitHub's search limit without a token, 10 searches a minute, was reached. Refresh again in a minute.";
async function loadPublicPullRequests(account, login) {
  const info = {};
  let total = 0;
  let issue = "";
  let more = false;
  let incomplete = false;
  for (let page = 1; page <= AUTHORED_PAGES; page += 1) {
    let data;
    try {
      ({ data } = await api(account, "authoredPullRequests", { login, page }));
      if (!Array.isArray(data?.items)) throw new Error("GitHub did not return a usable pull request search.");
    } catch (error) {
      const message = error.status === 403 || error.status === 429 ? PUBLIC_SEARCH_LIMIT : error.message;
      if (page === 1) throw Object.assign(new Error(message), { status: error.status });
      issue = `Public pull requests page ${page} did not load. ${message}`;
      break;
    }
    total = Number.isInteger(data.total) ? data.total : total;
    incomplete = incomplete || data.incomplete;
    for (const item of data.items) {
      const pr = I.normalizeSearchPullRequest(item);
      if (pr) info[I.prKey(pr.repo, pr.number)] = pr;
    }
    more = data.items.length === 100 && page * 100 < total;
    if (!more) break;
  }
  const loaded = Object.keys(info).length;
  return { info, loaded, total: Math.max(total, loaded), capped: more || Boolean(issue), partial: incomplete, issue, days: AUTHORED_DAYS, public: true };
}

// The public view: a username and no token. It loads what GitHub serves to anyone: the profile, public
// events, public pull requests by search, public repositories, and a few star dates, and marks the rest
// as locked.
async function refreshPublic() {
  const account = state;
  account.tokenMeta = null;
  account.answered = {};
  account.ledger = {};
  setBusy("Loading the public profile…");
  try {
    const { data: user } = await api(account, "profile");
    if (typeof user?.login !== "string" || !user.login || !Number.isSafeInteger(user.id)) throw new Error("Unexpected GitHub profile.");
    setBusy("Loading public activity…");
    const feed = await loadEvents(account, user.login);
    if (account !== state) return;
    const events = [...new Map(feed.events.map((e) => [e.id, e])).values()]
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    setBusy("Loading public pull requests and repositories…");
    const [footprint, authored] = await Promise.allSettled([loadFootprint(account), loadPublicPullRequests(account, user.login)]);
    if (account !== state) return;
    const rate = await api(account, "rateLimit").catch(() => null);
    if (account !== state) return;

    const errors = { ...NEEDS_TOKEN };
    const locked = new Set(Object.keys(NEEDS_TOKEN));
    if (feed.issue) errors.events = feed.issue;
    const fp = footprint.value?.fp || null;
    if (!fp) {
      errors.footprint = `Public repositories did not load. ${footprint.reason?.message || ""}`.trim();
      locked.delete("footprint");
    } else if (fp.issues.length) {
      errors.footprint = `${NEEDS_TOKEN.footprint} Some star dates did not load: ${fp.issues.slice(0, 3).join("; ")}${fp.issues.length > 3 ? "; …" : ""}`;
      locked.delete("footprint");
    }
    const mine = authored.value || null;
    locked.delete("authored");
    delete errors.authored;
    if (!mine) errors.authored = `Public pull requests did not load. ${authored.reason?.message || ""}`.trim();
    else {
      const parts = [];
      if (mine.issue) parts.push(mine.issue);
      if (mine.capped) parts.push(`Loaded the newest ${fmt(mine.loaded)} of ${fmt(mine.total)} public pull requests opened in the last ${AUTHORED_DAYS} days.`);
      if (mine.partial) parts.push("GitHub marked the search incomplete, so some public pull requests may be missing.");
      if (parts.length) errors.authored = parts.join(" ");
    }
    const count = (n) => (Number.isFinite(n) ? { totalCount: n } : null);
    Object.assign(account, {
      prInfo: mine ? mine.info : {},
      prLookup: { authored: mine && { loaded: mine.loaded, total: mine.total, capped: mine.capped, partial: mine.partial, days: mine.days, public: true },
        referenced: { total: 0, covered: 0, asked: 0, found: 0 }, commits: null },
      user, events, errors, locked, footprint: fp, refreshedAt: new Date(),
      viewer: { createdAt: user.createdAt, followers: count(user.followers), repositories: count(user.publicRepos) },
      rateLimit: rate ? { resources: I.summarizeRateLimit(rate.data), at: new Date() } : null,
      notes: { userId: user.id, failed: PUBLIC_NOTES, list: [] },
    });
    if (!events.some((e) => I.repoName(e) === account.repo)) account.repo = "";
    account.lastSeen = localStorage.getItem(seenKey());
    if (!account.lastSeen && newestActivity(account)) {
      account.lastSeen = newestActivity(account);
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

async function refresh() {
  if (state.public) return refreshPublic();
  const account = state;
  account.tokenMeta = null;
  account.answered = {};
  account.ledger = {};
  setBusy("Loading your profile…");
  try {
    const { data: user } = await api(account, "profile");
    if (typeof user?.login !== "string" || !user.login || !Number.isSafeInteger(user.id)) throw new Error("Unexpected GitHub profile.");
    setBusy("Loading activity…");
    const feed = await loadAllEvents(account, user.login);
    if (account !== state) return;
    const events = [...new Map(feed.events.map((e) => [e.id, e])).values()]
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));

    setBusy("Loading contribution year and notifications…");
    const refs = I.prRefsFromEvents(events);
    const classic = Boolean(account.tokens.classic);
    // The event-referenced lookup skips pull requests the authored search already returned.
    let pendingRefs = refs;
    const authoredTask = loadPullRequestSearch(account, user.login);
    const reviewedTask = loadPullRequestSearch(account, user.login, "reviewedPullRequests");
    const lookupTask = authoredTask.catch(() => null).then((found) => {
      pendingRefs = refs.filter((r) => !found?.info[I.prKey(r.repo, r.number)]);
      return lookupPullRequests(account, pendingRefs);
    });
    // Every calendar year GitHub lists, read in one batched request once the year query returns them.
    // The history is read with the token chosen for the year, so both describe the same visibility.
    const yearTask = loadYear(account);
    const historyTask = yearTask.then(({ data, slot }) => {
      const listed = data?.data?.viewer?.contributionsCollection?.contributionYears;
      const years = (Array.isArray(listed) ? listed : []).filter(Number.isInteger).sort((a, b) => b - a).slice(0, HISTORY_YEARS);
      if (!years.length) throw new Error("GitHub listed no contribution years.");
      return api(account, "contributionHistory", { years }, slot).then((result) => ({ ...result, years, listed: listed.length }));
    });
    // Notes load once per account. Later refreshes keep the notes in memory, including unsaved edits.
    const notesTask = account.notes?.userId === user.id && !account.notes.failed ? null : window.desk.notes();
    const [notes, year, prs, talk, authored, footprint, yearsResult, reviewedResult, notebook, cardStates, asks] = await Promise.allSettled([
      classic ? api(account, "notifications") : null,
      yearTask,
      lookupTask,
      loadConversations(account, user.login),
      authoredTask,
      loadFootprint(account),
      historyTask,
      reviewedTask,
      notesTask,
      window.desk.cards(),
      loadReviewRequests(account, user.login),
    ]);
    if (account !== state) return;
    if (notesTask) account.notes = notesFrom(notebook.value, user.id);
    // Suggestion card states belong to the signed-in account; a failed read shows every card.
    const cardRead = cardStates.value;
    account.cards = cardRead?.ok ? cardRead.cards : {};
    // Read last so the budget reflects this refresh. GitHub does not count this call against the limit.
    const rate = await api(account, "rateLimit").catch(() => null);
    if (account !== state) return;

    const errors = {};
    if (cardRead && !cardRead.ok) errors.cards = cardRead.error;
    else if (cardRead?.note) errors.cards = cardRead.note;
    if (feed.issue) errors.events = feed.issue;
    const notifications = Array.isArray(notes.value?.data) ? notes.value.data : null;
    if (!notifications) errors.notifications = classic
      ? notes.reason?.message || "Notifications are unavailable."
      : "Unread notifications require a classic token. Add one beside this token in Data & access.";
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
    const lookup = prs.value || { info: {}, total: pendingRefs.length, asked: Math.min(pendingRefs.length, PR_LOOKUP_LIMIT), found: 0 };
    if (lookup.found < lookup.asked) errors.prs = prs.reason?.message || "Some requested pull requests were unavailable.";
    if (lookup.asked < lookup.total) errors.prs = `${errors.prs ? `${errors.prs} ` : ""}Details for pull requests referenced in events are capped at the first ${PR_LOOKUP_LIMIT}.`;
    const mine = authored.value || null;
    if (!mine) errors.authored = `Pull requests you opened did not load. ${authored.reason?.message || ""}`.trim();
    else {
      const parts = [];
      if (mine.issue) parts.push(mine.issue);
      if (mine.capped) parts.push(`Loaded the newest ${fmt(mine.loaded)} of ${fmt(mine.total)} pull requests you opened in the last ${AUTHORED_DAYS} days.`);
      if (mine.partial) parts.push(`Some pull requests you opened could not be read ${tokenPhrase(mine.partialSlots)}.`);
      if (parts.length) errors.authored = parts.join(" ");
    }
    const prLookup = {
      authored: mine && { loaded: mine.loaded, total: mine.total, capped: mine.capped, partial: mine.partial, days: mine.days },
      referenced: { total: refs.length, covered: refs.length - pendingRefs.length, asked: lookup.asked, found: lookup.found },
    };
    const prInfo = { ...lookup.info, ...(mine ? mine.info : {}) };
    const commitTimes = mine && !account.public ? await lookupCommitTimes(account, prInfo, user.login) : null;
    prLookup.commits = commitTimes;
    if (commitTimes && commitTimes.found < commitTimes.asked) {
      errors.commits = `Last-commit times loaded for ${fmt(commitTimes.found)} of ${fmt(commitTimes.asked)} merged pull requests you opened${commitTimes.issue ? `. ${commitTimes.issue}` : "."}`;
    }
    if (commitTimes && commitTimes.asked < commitTimes.total) {
      errors.commits = `${errors.commits ? `${errors.commits} ` : ""}Last-commit times are read for the newest ${COMMIT_LOOKUP_LIMIT} merges.`;
    }
    // Kept apart from prInfo: these are other people's pull requests, and the PR summaries describe yours.
    const theirs = reviewedResult.value || null;
    if (!theirs) errors.reviewed = `Pull requests you reviewed did not load. ${reviewedResult.reason?.message || ""}`.trim();
    else {
      const parts = [];
      if (theirs.issue) parts.push(theirs.issue);
      if (theirs.capped) parts.push(`Loaded the newest ${fmt(theirs.loaded)} of ${fmt(theirs.total)} pull requests by others that you reviewed in the last ${AUTHORED_DAYS} days.`);
      if (theirs.partial) parts.push(`Some pull requests you reviewed could not be read ${tokenPhrase(theirs.partialSlots)}.`);
      if (parts.length) errors.reviewed = parts.join(" ");
    }
    const reviewed = theirs;
    const requestLoad = asks.value || null;
    const requests = requestLoad ? { ...requestLoad, loadedAt: new Date() } : null;
    if (!requests) errors.requests = `Review requests did not load. ${asks.reason?.message || ""}`.trim();
    else {
      const parts = [];
      if (requestLoad.search.issueCount > requestLoad.search.nodes.length) parts.push(`Showing the ${fmt(requestLoad.search.nodes.length)} oldest of ${fmt(requestLoad.search.issueCount)} open review requests.`);
      if (requestLoad.partial) parts.push(`Some review requests could not be read ${tokenPhrase(requestLoad.partialSlots)}.`);
      if (requestLoad.failed?.length) parts.push(...requestLoad.failed);
      if (parts.length) errors.requests = parts.join(" ");
    }
    const rateLimit = rate ? { resources: I.summarizeRateLimit(rate.data), at: new Date() } : null;

    const fpLoad = footprint.value || null;
    if (!fpLoad) errors.footprint = `Repository traffic did not load. ${footprint.reason?.message || ""}`.trim();
    else {
      const parts = [];
      if (fpLoad.fp.denied) parts.push(`Repository traffic needs read access to Administration on your repositories. ${fpLoad.fp.denied}`);
      if (fpLoad.fp.issues.length) parts.push(`Some repositories did not load: ${fpLoad.fp.issues.slice(0, 3).join("; ")}${fpLoad.fp.issues.length > 3 ? "; …" : ""}`);
      if (parts.length) errors.footprint = parts.join(" ");
      if (!fpLoad.saved?.ok) errors.history = `Saved history is unavailable. ${fpLoad.saved?.error || ""}`.trim();
      else if (fpLoad.saved.note) errors.history = fpLoad.saved.note;
    }
    const footprintData = fpLoad ? fpLoad.fp : null;

    const yearsData = yearsResult.value?.data;
    let contributionHistory = null;
    if (yearsData?.data?.viewer) {
      const byYear = {};
      for (const y of yearsResult.value.years) {
        const c = yearsData.data.viewer[`y${y}`];
        if (Array.isArray(c?.contributionCalendar?.weeks)) byYear[y] = c;
      }
      const missing = yearsResult.value.years.filter((y) => !byYear[y]);
      if (Object.keys(byYear).length) contributionHistory = { byYear, missing, listed: yearsResult.value.listed };
      if (missing.length) errors.years = `GitHub did not return ${missing.length === 1 ? "the year" : "the years"} ${missing.sort().join(", ")}.`;
      if (yearsResult.value.listed > HISTORY_YEARS) errors.years = `${errors.years ? `${errors.years} ` : ""}Showing the latest ${HISTORY_YEARS} of ${yearsResult.value.listed} years.`;
    }
    if (!contributionHistory) errors.years = `Contribution history did not load. ${yearsResult.reason?.message || ""}`.trim();
    const savedHistory = fpLoad?.saved?.ok ? fpLoad.saved : null;

    const talkData = talk.value;
    const flat = talkData?.data ? I.flattenConversations(talkData.data, user.login) : null;
    let conversations = flat?.usable ? { ...flat, loadedAt: new Date() } : null;
    const talkProblem = talk.reason?.message || talkData?.errors?.[0]?.message || "GitHub did not return a usable conversation search.";
    if (!conversations && account.conversations && account.user?.id === user.id) {
      conversations = account.conversations;
      errors.conversations = `Conversations did not refresh. ${talkProblem} Showing the previous load.`;
    } else if (!conversations) errors.conversations = `Conversations did not load. ${talkProblem}`;
    else {
      const parts = [];
      const lost = [["issues", "Issue"], ["pullRequests", "Pull request"]].filter(([key]) => !conversations.searches[key]);
      if (lost.length) parts.push(`${lost.map(([, name]) => name).join(" and ")} threads did not load.`);
      if (talkData.errors?.length) parts.push(`Some conversations could not be read ${tokenPhrase(talkData.partialSlots)}.`);
      if (talkData.failed?.length) parts.push(...talkData.failed);
      if (parts.length) errors.conversations = parts.join(" ");
    }
    // With two tokens: what only one of them returned for each merged source, and which read the year.
    const tokenUse = dual(account)
      ? { events: feed.only, authored: mine?.only, reviewed: theirs?.only, conversations: talkData?.only, requests: requestLoad?.only, year: year.value?.slot || null }
      : null;

    Object.assign(account, { tokenUse, user, viewer, contributions, events, notifications, prLookup, prInfo, reviewed, requests, rateLimit, footprint: footprintData, savedHistory, contributionHistory, conversations, errors, refreshedAt: new Date() });
    await saveWeeklySnapshot(account, mine);
    if (!events.some((e) => I.repoName(e) === account.repo)) account.repo = "";
    account.lastSeen = localStorage.getItem(seenKey());
    if (!account.lastSeen && newestActivity(account)) {
      account.lastSeen = newestActivity(account);
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

// The latest timestamp across your events and loaded conversations, used for "seen".
function newestActivity(account) {
  const times = [account.events[0]?.created_at, account.conversations?.items[0]?.at].filter(Boolean);
  return times.sort().pop() || null;
}

// ---------- rendering ----------
function renderIdentity() {
  const u = state.user;
  if (!u) return;
  const name = typeof u.name === "string" ? u.name.trim() : "";
  $("me-name").textContent = name || u.login;
  $("me-login").textContent = `@${u.login}${state.public ? " · public view" : ""}`;
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
  const a = state.prLookup.authored;
  const complete = Boolean(a && state.reviewed && !a.capped && !state.reviewed.capped);
  const collab = I.summarizeCollaboration(state.prInfo, state.reviewed?.info, state.user && state.user.login, { complete });
  // Outcome findings cover the pull requests the authored search returned, so they wait for it.
  const outcomes = a ? I.summarizeOutcomes(state.prInfo, state.user && state.user.login, state.refreshedAt) : null;
  const requests = state.requests ? I.summarizeReviewRequests(state.requests.search, state.user && state.user.login, state.refreshedAt) : null;
  const waiting = I.summarizeWaiting({ requests, conversations: state.conversations, prInfo: a ? state.prInfo : null, login: state.user && state.user.login, now: state.refreshedAt });
  // One chance budget across every check on the page, which findings and suggestions both use.
  const chance = I.chanceBudget({ prs: prPatterns, outcomes, trajectory });
  // Public search records carry no branch names, so a branch cannot be matched to its pull request there,
  // and every branch would read as having none.
  const observations = [...I.deriveObservations({ rhythm, sessions, prs: prPatterns, trajectory, follow: state.public ? null : follow, review, outcomes, chance }), ...collab.findings];
  const h = state.savedHistory;
  const snapshots = h?.enabled ? I.summarizeSnapshots(h.snapshots, state.snapshotSaved ? I.snapshotOf(outcomes) : null, h.week) : null;
  const footprint = state.footprint ? I.summarizeFootprint(state.footprint, state.savedHistory, state.refreshedAt) : null;
  const years = state.contributionHistory
    ? I.summarizeContributionHistory(state.contributionHistory.byYear, localDayKey(new Date()), state.viewer?.createdAt) : null;
  // The classic token is the one whose scopes can allow writes, so it is the one the access check reads.
  const tokenKind = state.public ? "none" : state.tokens.classic || state.tokens["fine-grained"] || null;
  const token = tokenKind ? { kind: tokenKind, write: I.classicScopes(state.tokenMeta?.classic?.scopes)?.write ?? null, paired: dual(state) } : null;
  // Summaries of a source that failed are passed as null, so its suggestions say "source unavailable"
  // instead of "nothing found". Events failed when none loaded and the feed reported an issue.
  const eventsLoaded = state.events.length > 0 || !state.errors.events;
  const prsLoaded = Boolean(a) || Object.keys(state.prInfo).length > 0;
  const suggestions = I.applyCardStates(I.deriveSuggestions({
    login: state.user && state.user.login, now: state.refreshedAt,
    ev: eventsLoaded ? ev : null, sessions: eventsLoaded ? sessions : null,
    // Public search records carry no branch names, so branches cannot be matched to pull requests there.
    follow: eventsLoaded && prsLoaded && !state.public ? follow : null,
    prPatterns: prsLoaded ? prPatterns : null, review: a ? review : null, prInfo: a ? state.prInfo : null,
    trajectory, notes, notesNote: state.errors.notifications || "", footprint, conversations: state.conversations, token,
    collab: state.reviewed ? collab : null, requests, outcomes, observations, chance, publicView: state.public,
  }), state.public ? {} : state.cards, state.refreshedAt, null, snapshots);
  const scoped = scopedSuggestions({ ev, eventsLoaded, sessions, follow, prsLoaded, trajectory, notes, footprint, token, requests });
  return { years, ev, pr, notes, year: state.contributions, rhythm, sessions, prPatterns, trajectory, follow, review, collab, outcomes, observations, footprint, suggestions, chance, snapshots, scoped, requests, waiting };
}

// Suggestions for one repository: the pull request rules run on that repository's pull requests,
// with their own chance budget, while feed, calendar, traffic, and token rules stay account-wide.
// Null in the account view, or when the chosen repository no longer has enough loaded merges.
function scopedSuggestions({ ev, eventsLoaded, sessions, follow, prsLoaded, trajectory, notes, footprint, token, requests }) {
  const login = state.user && state.user.login;
  const repos = I.scopeRepos(state.prInfo, login);
  const repo = state.suggestScope;
  if (!repo || !repos.some((r) => r.repo === repo)) return null;
  const a = state.prLookup.authored;
  const prInfo = I.scopePullRequests(state.prInfo, repo);
  const prPatterns = I.summarizePrPatterns(prInfo, state.refreshedAt);
  const review = I.summarizeReviewFlow(prInfo, login);
  const reviewed = state.reviewed ? I.scopePullRequests(state.reviewed.info, repo) : null;
  const complete = Boolean(a && state.reviewed && !a.capped && !state.reviewed.capped);
  const collab = I.summarizeCollaboration(prInfo, reviewed, login, { complete });
  const outcomes = a ? I.summarizeOutcomes(prInfo, login, state.refreshedAt) : null;
  // The trajectory belongs to the whole account, so the repository's budget leaves it out.
  const chance = I.chanceBudget({ prs: prPatterns, outcomes });
  const result = I.deriveSuggestions({
    login, now: state.refreshedAt, scope: repo,
    ev: eventsLoaded ? ev : null, sessions: eventsLoaded ? sessions : null,
    follow: eventsLoaded && prsLoaded && !state.public ? follow : null,
    prPatterns: prsLoaded ? prPatterns : null, review: a ? review : null, prInfo: a ? prInfo : null,
    trajectory, notes, notesNote: state.errors.notifications || "", footprint, conversations: state.conversations, token,
    collab: state.reviewed ? collab : null, outcomes, observations: [], chance, publicView: state.public,
    requests: requests && { ...requests, items: requests.items.filter((r) => r.repo === repo) },
  });
  return { ...I.applyCardStates(result, state.public ? {} : state.cards, state.refreshedAt, repo), chance, repo: repos.find((r) => r.repo === repo) };
}

const WAITING_ROWS = 5;
// One waiting item: how long it has waited, what it is, and who it waits on. The pull request or issue
// opens on github.com from a link the main process builds.
function waitingRow(item, detail) {
  const label = `${item.repo} #${item.number}`;
  return `<li><span class="age${item.hours >= I.REQUEST_LATE_HOURS ? " late" : ""}" title="${esc(`Waiting since ${new Date(item.at).toLocaleString()}`)}">${esc(I.durationLabel(item.hours))}</span>
    <div><div class="t"><button type="button" class="link where-link" data-open-repo="${esc(item.repo)}" data-open-number="${item.number}" title="${esc(`Open ${label} on github.com`)}">${esc(`${shortRepo(item.repo)} #${item.number}`)}</button> ${esc(item.title)}</div>
    <div class="d">${esc(detail)}</div></div></li>`;
}
function waitingGroup(title, list, empty, detail) {
  const rows = list == null ? `<p class="note">${esc(empty)}</p>`
    : list.length ? `<ul class="waiting-list">${list.slice(0, WAITING_ROWS).map((x) => waitingRow(x, detail(x))).join("")}</ul>${list.length > WAITING_ROWS ? `<p class="note">And ${fmt(list.length - WAITING_ROWS)} more, oldest first above.</p>` : ""}`
    : `<p class="note">${esc(empty)}</p>`;
  return `<section class="waiting-group"><h4>${esc(title)} <span class="n">${list ? fmt(list.length) : "—"}</span></h4>${rows}</section>`;
}

function renderWaiting(c) {
  const w = c.waiting;
  const r = c.requests;
  if (state.public) {
    $("waiting-caption").textContent = "";
    $("waiting").innerHTML = '<p class="note waiting-note">Needs a token. Review requests, conversations, and review verdicts are not public, so nothing here can show what waits on you.</p>';
    return;
  }
  const reviewDetail = (x) => [x.direct ? "Asked by name" : "Asked through a team", x.since === "request" ? "" : "no request time recorded, so timed from opening",
    `by ${x.author}`, x.draft ? "draft" : "", x.lines ? `${fmt(x.lines)} lines` : ""].filter(Boolean).join(" · ");
  const replyDetail = (x) => `${x.author} ${x.kind === "review" ? "reviewed" : "replied"} on ${x.yours ? "your" : x.isPr ? "a" : "an"} ${x.isPr ? "pull request" : "issue"}${x.yours ? "" : " you wrote in"}`;
  const changeDetail = (x) => `${x.author} requested changes`;
  const unavailable = state.public ? NEEDS_TOKEN.requests : state.errors.requests || "Review requests did not load.";
  $("waiting").innerHTML = [
    waitingGroup("Review requests", r ? w.reviews : null, r ? "No open pull request asks you for a review." : unavailable, reviewDetail),
    waitingGroup("Replies to answer", w.replies, state.conversations ? "No open thread you opened or wrote in ends with someone else's reply." : (state.public ? NEEDS_TOKEN.conversations : state.errors.conversations || "Conversations did not load."), replyDetail),
    waitingGroup("Changes requested on your pull requests", state.prLookup.authored && !state.public ? w.changes : null, state.public ? "Review verdicts need a token. GitHub's public search lists pull requests without their reviews."
      : state.prLookup.authored ? "No open pull request of yours has changes requested as its latest verdict." : state.errors.authored || "Pull requests you opened did not load.", changeDetail),
  ].join("");
  const notes = [];
  if (r) notes.push(`Review requests come from GitHub's search for open pull requests that ask you, by name or through a team, and are timed from the latest ask. GitHub drops a request from the search once you review.${state.errors.requests ? ` ${state.errors.requests}` : ""}`);
  if (w.replies) notes.push("Replies come from Conversations: open threads you opened or wrote in, whose latest comment from a person is someone else's.");
  if (w.unsure) notes.push(`${fmt(w.unsure)} open ${w.unsure === 1 ? "pull request has" : "pull requests have"} more than 10 reviews, so its latest verdict is unknown and it is left out.`);
  $("waiting-caption").textContent = w.count ? `${fmt(w.count)} ${w.count === 1 ? "item" : "items"}, oldest first` : "";
  $("waiting").insertAdjacentHTML("beforeend", notes.length ? `<p class="note waiting-note">${esc(notes.join(" "))}</p>` : "");
}

function renderOverview(c) {
  const { ev, pr, notes, year, waiting: w, outcomes } = c;
  const parts = [];
  if (w.reviews?.length) parts.push(`<strong>${fmt(w.reviews.length)} review request${w.reviews.length === 1 ? "" : "s"}</strong> ${w.reviews.length === 1 ? "waits" : "wait"} on you${c.requests.late ? `, ${fmt(c.requests.late)} for a day or more` : ""}.`);
  if (w.replies?.length) parts.push(`<strong>${fmt(w.replies.length)} thread${w.replies.length === 1 ? "" : "s"}</strong> ${w.replies.length === 1 ? "ends" : "end"} with someone else's reply.`);
  if (ev.fresh) parts.push(`<strong>${fmt(ev.fresh)} new event${ev.fresh === 1 ? "" : "s"}</strong> since you last marked the stream seen.`);
  const replies = freshConversations();
  if (replies) parts.push(`<strong>${fmt(replies)} new comment${replies === 1 ? "" : "s"} from others</strong> on issues and pull requests that involve you.`);
  if (year?.last30 != null) {
    const trend = year.trend ? ` (${year.trend > 0 ? "up" : "down"} ${pct(Math.abs(year.trend))} from the prior 30 days)` : "";
    parts.push(`${fmt(year.last30)} contributions in the last 30 days${trend}.`);
  }
  if (ev.agentEvents) parts.push(`${pct(ev.agentShare)} of loaded events matched a known agent app or branch prefix.`);
  const pace = c.years?.pace;
  if (pace?.change != null) parts.push(`${fmt(pace.ytd)} contributions so far this year, ${pct(Math.abs(pace.change))} ${pace.change >= 0 ? "ahead of" : "behind"} the same date last year.`);
  const fpt = c.footprint?.totals;
  if (fpt?.views != null) parts.push(`${fmt(fpt.views)} page views across ${fmt(fpt.withTraffic)} of your repositories in the last 14 days.`);
  $("summary").innerHTML = parts.join(" ");

  // Waiting on you replaces the streak: a streak rewards activity for its own sake, while the queue
  // says what someone is blocked on. The streak stays in the contribution year's line.
  const waitingParts = [w.reviews && `${fmt(w.reviews.length)} reviews`, w.replies && `${fmt(w.replies.length)} replies`, state.prLookup.authored && !state.public && `${fmt(w.changes.length)} changes requested`].filter(Boolean);
  const base = outcomes?.baseline;
  const kpis = [
    ["Contribution year", year ? fmt(year.total) : "—", year ? `${fmt(year.activeDays)} active days of ${fmt(year.dayCount)} · streak ${fmt(year.currentStreak)} d` : esc(state.errors.year || "")],
    ["Waiting on you", waitingParts.length ? fmt(w.count) : "—", waitingParts.length ? esc(waitingParts.join(" · ")) : esc(state.public ? "Needs a token." : "Sources did not load.")],
    ["Time to merge", base ? esc(I.durationLabel(base.medianHours)) : "—", base ? `Median of ${fmt(base.n)} ${state.public ? "public " : ""}merges in ${AUTHORED_DAYS} days · slowest quarter past ${esc(I.durationLabel(base.p75Hours))}` : "Needs six merges of yours."],
    ["Agent signals", ev.total ? pct(ev.agentShare) : "—", ev.agents.length ? ev.agents.slice(0, 3).map(([n, k]) => `${esc(n)} ${k}`).join(" · ") : "No matches in loaded events"],
  ];
  $("kpis").innerHTML = kpis.map(([label, value, sub]) =>
    `<div class="kpi"><div class="label">${esc(label)}</div><div class="value">${value}</div><div class="sub">${sub}</div></div>`).join("");

  renderWaiting(c);

  // Warnings follow the rule Patterns and Suggestions use: outcomes in your own pull requests and
  // token access. How work was reviewed is a note, since a merge without a recorded review may still
  // have been checked another way.
  const items = [];
  for (const t of tokenWarnings()) items.push(["warn", t.title, t.detail]);
  // The same warnings Patterns shows, so both views flag the same outcomes by the same rules.
  const warned = c.observations.filter((o) => o.tone === "warn");
  for (const o of warned) items.push(["warn", o.title, `${o.detail} From Patterns.`]);
  const overdue = outcomes?.overdue || [];
  const others = pr.openMine.filter((p) => !overdue.some((o) => o.repo === p.repo && o.number === p.number));
  if (others.length) items.push(["info", `${others.length}${overdue.length ? " other" : ""} open pull request${others.length === 1 ? "" : "s"} of yours`, `${base ? "Within your usual merge time. " : ""}${others.slice(0, 4).map((p) => `${shortRepo(p.repo)} #${p.number}${p.isDraft ? " (draft)" : ""}`).join(", ")}`]);
  if (pr.unreviewed.length) items.push(["info", `${pr.unreviewed.length} of ${pr.merged} loaded merges have no recorded review`, `${pr.unreviewed.slice(0, 3).map((p) => `${shortRepo(p.repo)} #${p.number}`).join(", ")}. A note, not a warning: see Suggestions for whether your own merges back a second look.`]);
  if (notes && notes.missed.length) items.push(["warn", `${notes.missed.length} unread notification${notes.missed.length === 1 ? "" : "s"} flagged`, "Includes review requests, mentions, and failed checks."]);
  if (state.public) items.push(["warn", "Public view, without a token", `Showing what GitHub serves to anyone for @${state.user.login}: public events, public pull requests found by search, public repositories, and stars. The contribution calendar, reviews and sizes of pull requests, conversations, review requests, notifications, repository traffic, and notes need a token. Data & access lists what a token would add.`]);
  // Sources the public view cannot load are covered by the item above, not listed one by one.
  const coverage = Object.entries(state.errors).filter(([key]) => !state.locked?.has(key)).map(([, text]) => text);
  if (coverage.length) items.push(["warn", "Some data is missing or limited", `${coverage.join(" ")} Data & access → What to change says what to do about each.`]);
  else if (!items.length) items.push(["good", "Nothing flagged in the loaded data", `Open PRs and review counts cover pull requests you opened in the last ${AUTHORED_DAYS} days plus those referenced in recent events.`]);
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

function freshConversations() {
  const lastSeen = state.lastSeen ? Date.parse(state.lastSeen) : null;
  return lastSeen && state.conversations ? state.conversations.items.filter((c) => !c.mine && Date.parse(c.at) > lastSeen).length : 0;
}

function renderConversations() {
  const conv = state.conversations;
  $("hide-minor-label").classList.add("hidden");
  $("search").setAttribute("aria-label", "Search conversations");
  $("chips").setAttribute("aria-label", "Comment type");
  if (!conv) {
    $("stream-caption").textContent = state.errors.conversations || "Conversations have not loaded.";
    $("chips").innerHTML = "";
    $("repo-filter").innerHTML = '<option value="">All repositories</option>';
    $("stream").innerHTML = `<div class="empty">${esc(state.errors.conversations || "No conversations loaded.")}</div>`;
    return;
  }
  const notes = [];
  const capped = [["issues", "issues"], ["pullRequests", "pull requests"]]
    .map(([key, name]) => [conv.searches?.[key], name]).filter(([s]) => s && s.matched > s.loaded);
  if (capped.length) notes.push(`Showing the most recently updated ${capped.map(([s, name]) => `${fmt(s.loaded)} of ${fmt(s.matched)} ${name}`).join(" and ")}.`);
  const t = conv.truncated;
  if (t.threads) notes.push(`Older comments are omitted on ${fmt(t.threads)} busy ${t.threads === 1 ? "thread" : "threads"}; each thread shows its latest 10 comments and reviews.`);
  if (state.errors.conversations) notes.push(state.errors.conversations);
  const at = conv.loadedAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
  $("stream-caption").textContent = `${fmt(conv.items.length)} comments and reviews on ${fmt(conv.threads)} issues and pull requests that involve you, open or closed, updated in the last 30 days. Read live from each thread at ${at}. ${notes.join(" ")}`.trim();

  const repos = [...new Set(conv.items.map((c) => c.thread.repo))].sort();
  if (state.repo && !repos.includes(state.repo)) repos.unshift(state.repo);
  $("repo-filter").innerHTML = `<option value="">All repositories</option>${repos.map((r) => `<option value="${esc(r)}"${r === state.repo ? " selected" : ""}>${esc(shortRepo(r))}</option>`).join("")}`;
  $("chips").innerHTML = CONVERSATION_CHIPS.map(([k, label]) =>
    `<button class="chip" role="tab" type="button" data-filter="${k}" aria-selected="${state.conversationFilter === k}">${esc(label)}<span class="n">${I.filterConversations(conv.items, k, state.repo, "").length}</span></button>`).join("");

  const list = I.filterConversations(conv.items, state.conversationFilter, state.repo, state.query);
  const lastSeen = state.lastSeen ? Date.parse(state.lastSeen) : null;
  if (!list.length) {
    $("stream").innerHTML = `<div class="empty">${!conv.items.length ? "No comments on issues or pull requests that involve you in the last 30 days."
      : state.conversationFilter === "awaiting" ? "No open thread you opened or wrote in ends with someone else's reply." : "No comments match these filters."}</div>`;
    return;
  }
  const groups = new Map();
  for (const c of list) {
    const key = localDayKey(new Date(c.at));
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  $("stream").innerHTML = [...groups.entries()].map(([key, rows]) => `
    <div class="day"><div class="day-head">${esc(dayHeading(key))} · ${rows.length}</div><div class="rows">${rows.map((c) => {
      const when = new Date(c.at);
      const fresh = lastSeen && !c.mine && when.getTime() > lastSeen;
      const th = c.thread;
      const action = c.kind === "inline" ? "commented on a change in"
        : c.kind === "review" ? (c.verdict === "approved" ? "approved" : c.verdict === "changes_requested" ? "requested changes on" : "reviewed")
        : "commented on";
      const tags = [];
      if (fresh) tags.push('<span class="tag new">New</span>');
      if (c.awaiting) tags.push('<span class="tag warn">awaiting reply</span>');
      if (c.bot) tags.push('<span class="tag agent">bot</span>');
      if (c.mine) tags.push('<span class="tag">you</span>');
      tags.push(`<span class="tag ${th.state}">${th.isPr ? "PR" : "issue"} ${th.state}</span>`);
      const key = `c:${th.repo}#${th.number}:${c.kind}:${c.at}:${c.author}`;
      if (!conversationTexts.has(c)) conversationTexts.set(c, I.textInfo(CONVERSATION_LABELS[c.kind], c.body));
      return `<div class="row${fresh ? " fresh" : ""}">
        <span class="time">${esc(when.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }))}</span>
        <span class="glyph" title="${esc(CONVERSATION_LABELS[c.kind])}">${esc(CONVERSATION_GLYPHS[c.kind])}</span>
        <div class="what"><div class="title">${esc(`${c.author} ${action} #${th.number} ${th.title}`)}</div>
          ${textBlock(key, conversationTexts.get(c), c.bot)}
          <div class="meta"><span>${openLink(th.repo, th.number)}</span>${c.path ? `<span>${esc(c.path)}</span>` : ""}</div></div>
        <div class="tags">${tags.join("")}</div>
      </div>`;
    }).join("")}</div></div>`).join("");
}

function renderStream(c) {
  const { ev } = c;
  $("stream-source").querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.stream === state.streamSource)));
  const others = freshConversations();
  $("conversation-count").textContent = others ? String(others) : "";
  const badge = $("fresh-badge");
  const freshTotal = ev.fresh + others;
  badge.textContent = freshTotal > 99 ? "99+" : String(freshTotal);
  badge.classList.toggle("hidden", !freshTotal);
  const notesView = state.streamSource === "notes";
  $("stream-toolbar").classList.toggle("hidden", notesView);
  $("stream").classList.toggle("hidden", notesView);
  $("notes-pane").classList.toggle("hidden", !notesView);
  notesCaption();
  if (notesView) {
    // A refresh that reloaded notes, for example after a failed first load, redraws the pane.
    if (renderedNotes !== state.notes) renderNotes();
    return;
  }
  if (state.streamSource === "conversations") return renderConversations();
  $("hide-minor-label").classList.remove("hidden");
  $("search").setAttribute("aria-label", "Search events");
  $("chips").setAttribute("aria-label", "Event type");
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

  const index = commentIndex();
  const list = I.filterEvents(state.events, state.filter, state.repo, state.query, state.hideMinor, state.prInfo, index);
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
      <div class="day"><div class="day-head">${esc(dayHeading(key))} · ${rows.length}</div><div class="rows">${pushBursts(rows).map((burst) => {
        if (burst.length > 1) return pushBurstRow(burst, lastSeen);
        const e = burst[0];
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
          if (info.merged && !info.reviews) tags.push(`<span class="tag">no review</span>`);
        }
        const branch = I.branchOf(e);
        return `<div class="row${fresh ? " fresh" : ""}">
          <span class="time">${esc(when.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }))}</span>
          <span class="glyph" title="${esc(I.eventLabel(e.type))}">${esc(GLYPHS[e.type] || "•")}</span>
          <div class="what"><div class="title">${esc(I.describeEvent(e, state.prInfo))}</div>
            ${textBlock(`e:${e.id}`, I.eventText(e, index), agent)}
            <div class="meta"><span>${openLink(I.repoName(e), eventNumber(e))}</span>${branch && e.type !== "PushEvent" && e.type !== "CreateEvent" && e.type !== "DeleteEvent" ? `<span>${esc(branch)}</span>` : ""}${e.public === false ? "<span>private</span>" : ""}</div></div>
          <div class="tags">${tags.join("")}</div>
        </div>`;
      }).join("")}</div></div>`).join("");
  }
}

// The issue or pull request an event belongs to, when it names one.
function eventNumber(e) {
  const p = e.payload || {};
  const n = p.pull_request?.number || p.issue?.number || (e.type === "PullRequestEvent" ? p.number : null);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// A repository name, or "repo #n", that opens on github.com. The main process builds the link.
function openLink(repo, number) {
  if (!repo || !/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(repo)) return esc(shortRepo(repo || ""));
  const label = `${shortRepo(repo)}${number ? ` #${number}` : ""}`;
  return `<button type="button" class="link open-link" data-open-repo="${esc(repo)}"${number ? ` data-open-number="${number}"` : ""} title="${esc(`Open ${repo}${number ? ` #${number}` : ""} on github.com`)}">${esc(label)}</button>`;
}

// Consecutive pushes to one branch within PUSH_BURST_MINUTES of each other, newest first, as runs.
// Every other event is a run of one.
function pushBursts(rows) {
  const runs = [];
  for (const e of rows) {
    const last = runs.at(-1);
    const head = last?.[0];
    const prev = last?.at(-1);
    if (e.type === "PushEvent" && head?.type === "PushEvent" && I.repoName(e) === I.repoName(head) && I.branchOf(e) === I.branchOf(head) &&
        Date.parse(prev.created_at) - Date.parse(e.created_at) <= PUSH_BURST_MINUTES * 6e4) last.push(e);
    else runs.push([e]);
  }
  return runs;
}

function pushBurstRow(burst, lastSeen) {
  const newest = new Date(burst[0].created_at);
  const oldest = new Date(burst.at(-1).created_at);
  const commits = burst.reduce((n, e) => {
    const p = e.payload || {};
    return n + (Array.isArray(p.commits) && p.commits.length ? p.commits.length : Number(p.size) || 0);
  }, 0);
  const fresh = lastSeen && newest.getTime() > lastSeen;
  const agent = burst.map(I.agentOf).find(Boolean);
  const branch = I.branchOf(burst[0]) || burst[0].payload?.ref || "an unspecified ref";
  const time = (d) => d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return `<div class="row${fresh ? " fresh" : ""}">
    <span class="time">${esc(time(newest))}</span>
    <span class="glyph" title="Pushes">${esc(GLYPHS.PushEvent)}</span>
    <div class="what"><div class="title">${esc(`Pushed ${commits ? `${commits} commit${commits === 1 ? "" : "s"} ` : ""}to ${branch} in ${burst.length} pushes`)}</div>
      <div class="meta"><span>${openLink(I.repoName(burst[0]))}</span><span>${esc(`${time(oldest)} to ${time(newest)}`)}</span></div></div>
    <div class="tags">${fresh ? '<span class="tag new">New</span>' : ""}${agent ? `<span class="tag agent">${esc(agent)}</span>` : ""}<span class="tag push-count">${burst.length} pushes</span></div>
  </div>`;
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
  const caption = pullRequestCaption();
  const notice = [state.errors.authored, state.errors.events, state.errors.prs].filter(Boolean).join(" ");
  return insightSection("insight-prs", "Pull requests", caption, `
    ${notice ? `<p class="insight-notice">${esc(notice)}</p>` : ""}
    ${pr.total ? `<div class="grid insights">
      <article class="card">
        <h4>Merge activity</h4>
        ${stats([["Merged", fmt(pr.merged)], ["Median time to merge", hoursLabel(pr.medianHoursToMerge)], ["Zero recorded reviews", state.public ? "Needs a token" : pr.merged ? `${fmt(pr.unreviewed.length)} / ${fmt(pr.merged)}` : "—"]])}
        <p class="note">${state.public ? `Public pull requests you opened in the last ${AUTHORED_DAYS} days, found by search. ${PUBLIC_PR_GAP}` : `${fmt(pr.selfMerged)} merged by the PR author. Review counts reflect the loaded PR details.`}</p>
      </article>
      <article class="card">
        <h4>Current status and size</h4>
        ${stats([["Open", fmt(pr.open.length)], ["Open drafts", fmt(pr.drafts)], ["Median lines changed", fmt(pr.medianSize)]])}
        ${bars(pr.largest.map((p) => [`${shortRepo(p.repo)} #${p.number}`, p.additions + p.deletions]))}
        <p class="note">${state.public ? "Sizes and branch names need a token." : `Largest loaded changes by additions plus deletions. ${fmt(pr.agentBranches)} loaded PRs had a known agent branch prefix.`}</p>
      </article>
    </div>` : ""}`);
}

const sourceTag = (name) => `<span class="src">${esc(name)}</span>`;

// The five strongest findings show first: warnings, then those that passed a chance check.
const FINDINGS_SHOWN = 5;

function patternInsights({ ev, pr, rhythm, sessions, prPatterns, trajectory, follow, review, collab, outcomes, observations, suggestions, chance, snapshots }) {
  const sources = [
    rhythm ? "the contribution year" : "",
    ev.total ? `${fmt(ev.total)} loaded events` : "",
    pr.total ? `${fmt(pr.total)} loaded pull requests` : "",
  ].filter(Boolean);
  const caption = sources.length ? `Derived from ${new Intl.ListFormat(undefined, { type: "conjunction" }).format(sources)}` : "No data loaded";
  const notice = [state.errors.year, state.errors.events, state.errors.authored, state.errors.reviewed, state.errors.prs].filter(Boolean).join(" ");

  const finding = (o) => {
    // A finding that a shown suggestion acts on links to it.
    const link = o.id && suggestions.links[o.id];
    const go = link ? ` <button type="button" class="link jump" data-suggestion="${esc(link.id)}">Suggestion: ${esc(link.title)} →</button>` : "";
    const tag = o.confirmed ? '<span class="src confirmed">Beyond chance</span>' : "";
    return `<li class="${esc(o.tone)}"${o.id ? ` data-finding="${esc(o.id)}" tabindex="-1"` : ""}><span class="dot"></span><div><div class="t">${esc(o.title)}</div><div class="d">${esc(o.detail)}</div>${sourceTag(o.source)}${tag}${go}</div></li>`;
  };
  // The rest stay one click away. A jump from a suggestion opens the list first (see jumpTo).
  const top = observations.slice(0, FINDINGS_SHOWN);
  const rest = observations.slice(FINDINGS_SHOWN);
  const findings = observations.length
    ? `<ul class="attention">${top.map(finding).join("")}</ul>${rest.length ? `<details class="more-findings"><summary>Show all ${fmt(observations.length)} findings</summary><ul class="attention">${rest.map(finding).join("")}</ul></details>` : ""}
      ${chanceNoteLine(chance)}`
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
      <table class="compare"><caption class="note">Loaded merges by group</caption>
        <thead><tr><th scope="col">Group</th><th scope="col">Merged</th><th scope="col">Median to merge</th><th scope="col">Slowest quarter over</th><th scope="col">Zero reviews</th><th scope="col">Median lines</th></tr></thead>
        <tbody>${groups.map(([name, g]) => `<tr><th scope="row">${esc(name)}</th><td>${fmt(g.count)}</td><td>${esc(hoursLabel(g.medianHours))}</td><td>${g.p75Hours != null ? esc(hoursLabel(g.p75Hours)) : "—"}</td><td>${fmt(g.unreviewed)} / ${fmt(g.count)}</td><td>${fmt(Math.round(g.medianSize))}</td></tr>`).join("")}</tbody></table>
      <p class="note">${chanceSummary(prPatterns, chance)}</p>
      <p class="note">Agent branches are matched by prefix such as <code>claude/</code> or <code>codex/</code>. Size halves appear with six or more merges, the slowest quarter with four in a group, and the size correlation with eight. Chance checks deal the same merges out at random 999 times, and every check on the page shares one bar (see What stands out), so small groups rarely pass.</p>`
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
      <article class="card"><h4>Merge patterns</h4>${sourceTag("Pull requests")}${prCard}</article>
      <article class="card"><h4>Trajectory</h4>${sourceTag("Contribution year")}${trajectoryCard(trajectory)}</article>
      <article class="card"><h4>Follow-through</h4>${sourceTag("Recent events")}${followCard(follow)}</article>
      <article class="card"><h4>After the merge</h4>${sourceTag("Pull requests you opened")}${reworkCard(outcomes, chance)}</article>
      <article class="card"><h4>Open work</h4>${sourceTag("Pull requests you opened")}${openWorkCard(outcomes, chance)}</article>
      <article class="card"><h4>Working and waiting</h4>${sourceTag("Pull requests you opened")}${workWaitCard(outcomes, chance)}</article>
      <article class="card"><h4>Week by week</h4>${sourceTag("Saved history")}${snapshotCard(snapshots)}</article>
      <article class="card insight-wide"><h4>Review turnaround</h4>${sourceTag("Pull requests you opened")}${reviewCard(review, pr)}</article>
      <article class="card insight-wide"><h4>Review partners</h4>${sourceTag("Pull requests you opened and reviewed")}${partnersCard(collab)}</article>
    </div>`);
}

// Whether a chance check passed the page's shared bar; without a budget, 5% alone.
const beyond = (chance, key, p) => (chance ? Boolean(chance.cleared[key]) : p != null && p < 0.05);

// How many chance checks ran on the page and how many passed the shared bar, in one line.
function chanceNoteLine(chance) {
  if (!chance || !chance.tested) return "";
  const passed = chance.entries.filter((t) => t.clear);
  const list = passed.length ? ` Passed: ${passed.map((t) => `${t.label.toLowerCase()} (${oftenPct(t.p)})`).join("; ")}.` : "";
  return `<p class="note">${fmt(chance.tested)} chance ${chance.tested === 1 ? "check ran" : "checks ran"} on this page and ${fmt(passed.length)} passed. They share one bar (Holm's method), so with no real effect anywhere the chance of any finding reading "beyond chance" stays near 5%: the strongest result must beat ${esc(String(Number((5 / chance.tested).toFixed(2))))}%, the next a little less strict, and so on.${esc(list)}</p>`;
}

// The merge-pattern chance checks in one sentence each, or what they still need.
function chanceSummary(p, chance) {
  const out = [];
  if (p.agentGapP != null) {
    out.push(beyond(chance, "agent-gap", p.agentGapP)
      ? `Agent-branch merge times differ from the rest beyond chance: random regroupings match the gap ${p.agentGapP < 0.01 ? "under 1%" : pct(p.agentGapP)} of the time.`
      : `Agent-branch merge times: random regroupings match the gap ${pct(p.agentGapP)} of the time, so treat it as unconfirmed.`);
  }
  if (p.agentReviewP != null && p.agent.unreviewed !== p.other.unreviewed) {
    out.push(`The gap in zero-review merges between agent branches and the rest ${beyond(chance, "agent-review", p.agentReviewP) ? "is beyond chance" : "is within chance"} (random regroupings match it ${p.agentReviewP < 0.01 ? "under 1%" : pct(p.agentReviewP)} of the time).`);
  }
  const c = p.sizeVsTime;
  if (c) out.push(`Size against time to merge: rank correlation <strong>ρ ${esc(c.rho.toFixed(2))}</strong> across ${fmt(c.n)} merges, ${beyond(chance, "size-time", c.p) ? "beyond chance" : "within chance"} (shuffles match it ${c.p < 0.01 ? "under 1%" : pct(c.p)} of the time).`);
  else out.push(`A size correlation needs 8 timed merges; ${fmt(p.merged)} ${p.merged === 1 ? "is" : "are"} loaded.`);
  return out.join(" ");
}

const oftenPct = (p) => (p < 0.01 ? "under 1%" : pct(p));

// Time to merge split at the last commit: work still landing, then finished work waiting.
function workWaitCard(o, chance) {
  if (state.public) return `<p class="note">Working and waiting needs a token. ${PUBLIC_PR_GAP}</p>`;
  if (!o) return noOutcomes();
  const c = state.prLookup.commits;
  if (!o.merged) return `<p class="note">You merged no pull requests in the last ${AUTHORED_DAYS} days that this token can read.</p>`;
  const s = o.split;
  const read = c ? `Last-commit times loaded for ${fmt(c.found)} of ${fmt(c.asked)} merges${c.asked < c.total ? ` (the newest ${fmt(c.asked)} of ${fmt(c.total)})` : ""}.` : "Last-commit times were not requested.";
  if (!s) {
    return `<p class="note">${esc(state.errors.commits || read)} The split needs six merges with a last-commit time; ${fmt(o.commits.read)} ${o.commits.read === 1 ? "has" : "have"} one.</p>`;
  }
  const w = s.waitingLoad;
  const load = w ? ` Open work against the waiting part: <strong>ρ ${esc(w.rho.toFixed(2))}</strong> across ${fmt(w.n)} merges, ${beyond(chance, "waiting", w.p) ? "beyond chance" : "within chance"} (shuffles match it ${oftenPct(w.p)} of the time).` : "";
  return `
    ${stats([["Open to last commit", hoursLabel(s.workingHours)], ["Last commit to merge", hoursLabel(s.waitingHours)], ["Open hours after the last commit", s.waitingShare != null ? pct(s.waitingShare) : "—"]])}
    ${bars(s.idle.map((x) => [`${x.repo.split("/").pop()} #${x.number}`, Math.round(x.waiting)]), { suffix: " h" })}
    <p class="note">The longest waits after the last commit, in hours.${load}</p>
    <p class="note">Medians across ${fmt(s.n)} merges. A last commit made before the pull request opened counts as no work time. ${esc(read)} A last commit is not always the end of the work: a review can still ask for changes, and a rebase rewrites commit times.</p>`;
}

// The saved weekly numbers: where each started, where it was about four weeks ago, and where it is now.
function snapshotCard(snap) {
  const h = state.savedHistory;
  if (state.public) return '<p class="note">Weekly numbers need a token. A username alone does not show whose saved history to open.</p>';
  if (!h || !h.enabled) return '<p class="note">Turn on saved history in Data &amp; access to keep one snapshot a week of your merge time, follow-up fixes, open work, and waiting. Changes appear from the second week.</p>';
  if (!snap || snap.weeks < 2) {
    const status = snap?.latest ? `First snapshot saved for the week of ${esc(snap.latest)}. Changes appear when a second week is saved.`
      : "The first snapshot will appear after a successful save.";
    return `<p class="note">${state.errors.snapshot ? `${esc(state.errors.snapshot)} ` : ""}${status}</p>`;
  }
  const rows = snap.rows.filter((r) => r.latest);
  const day = (w) => new Date(`${w}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
  const cell = (r, p) => (p ? `${esc(r.format(p.value))}<span class="week">${esc(day(p.week))}</span>` : "—");
  return `
    <table class="compare"><caption class="note">${fmt(snap.weeks)} saved weeks, from the week of ${esc(day(snap.first))}</caption>
      <thead><tr><th scope="col">Number</th><th scope="col">First saved</th><th scope="col">About 4 weeks ago</th><th scope="col">Now</th></tr></thead>
      <tbody>${rows.map((r) => `<tr><th scope="row">${esc(r.label)}</th><td>${cell(r, r.first)}</td><td>${cell(r, r.back)}</td><td>${cell(r, r.latest)}</td></tr>`).join("")}</tbody></table>
    <p class="note">${state.errors.snapshot ? `${esc(state.errors.snapshot)} ` : ""}Each week's numbers cover the ${AUTHORED_DAYS} days before it, so neighbouring weeks share most of their pull requests and a change you make shows up gradually. Compare points at least four weeks apart. Only complete pull request searches update the weekly snapshot.</p>`;
}
const noOutcomes = () => `<p class="note">${esc(state.errors.authored || "The search for pull requests you opened did not load, so there are no outcomes to compare.")}</p>`;

// Whether merges needed a follow-up fix, and which kind of merge needed one more often.
function reworkCard(o, budget) {
  if (!o) return noOutcomes();
  const r = o.rework;
  if (!r.merged) return `<p class="note">You merged no pull requests in the last ${AUTHORED_DAYS} days that this token can read.</p>`;
  const ratio = (x) => `${fmt(x.followed)} / ${fmt(x.n)}`;
  const chance = (g) => (g.p == null ? "—" : `${(budget ? beyond(budget, `rework:${g.key}`, g.p) : g.clear) ? "Beyond chance" : "Within chance"} (${oftenPct(g.p)})`);
  const table = r.groups.length ? `<table class="compare"><caption class="note">Settled merges followed by a fix, by group</caption>
      <thead><tr><th scope="col">Group</th><th scope="col">Followed</th><th scope="col">Against</th><th scope="col">Followed</th><th scope="col">Random regroupings match</th></tr></thead>
      <tbody>${r.groups.map((g) => `<tr><th scope="row">${esc(g.a.label)}</th><td>${ratio(g.a)}</td><td>${esc(g.b.label)}</td><td>${ratio(g.b)}</td><td>${esc(chance(g))}</td></tr>`).join("")}</tbody></table>` : "";
  return `
    ${stats([["Followed by a fix", r.settled ? `${fmt(r.followed)} / ${fmt(r.settled)}` : "—"], ["Median until the fix", r.followed ? hoursLabel(r.medianHours) : "—"], ["Fixes naming the merge", r.followed ? `${fmt(r.named)} / ${fmt(r.followed)}` : "—"]])}
    ${table}
    <p class="note">A settled merge is one you opened that merged at least ${I.REWORK_HOURS / 24} days ago${r.merged > r.settled ? `; ${fmt(r.merged - r.settled)} newer ${r.merged - r.settled === 1 ? "one is" : "ones are"} left out` : ""}. It counts as followed when a loaded pull request in the same repository, titled as a fix or revert, opened within ${I.REWORK_HOURS / 24} days of it. A follow-up that names a merge by number or quoted title counts against that merge, any other against the nearest merge before it. Titles are a proxy, and fixes opened by people whose pull requests did not load are missed.
      ${r.tested ? `Groups are compared once each side has four merges. ${fmt(r.tested)} ${r.tested === 1 ? "comparison ran" : "comparisons ran"} on the same merges${budget ? `, and each shares the page's bar with the other ${fmt(budget.tested - r.tested)} chance ${budget.tested - r.tested === 1 ? "check" : "checks"}` : `, so each must be matched by fewer than ${esc(String(Number((r.bar * 100).toFixed(2))))}% of random regroupings to count as beyond chance`}.` : "Groups are compared once each side has four merges and two merges were followed."}</p>`;
}

// How much the user keeps open at once, and how open pull requests compare with their own merges.
function openWorkCard(o, chance) {
  if (!o) return noOutcomes();
  if (!o.authored) return `<p class="note">You opened no pull requests in the last ${AUTHORED_DAYS} days that this token can read.</p>`;
  const f = o.flow;
  const b = o.baseline;
  const count = (x) => (x == null ? "—" : Number.isInteger(x) ? fmt(x) : x.toFixed(1));
  const split = f.split ? `<table class="compare"><caption class="note">Merges by how many of your others were open when each one opened</caption>
      <thead><tr><th scope="col">Others open</th><th scope="col">Merged</th><th scope="col">Median to merge</th></tr></thead>
      <tbody><tr><th scope="row">${f.split.cut === 0 ? "None" : `${esc(count(f.split.cut))} or fewer`}</th><td>${fmt(f.split.quiet.n)}</td><td>${esc(hoursLabel(f.split.quiet.medianHours))}</td></tr>
        <tr><th scope="row">${f.split.cut === 0 ? "One or more" : `More than ${esc(count(f.split.cut))}`}</th><td>${fmt(f.split.busy.n)}</td><td>${esc(hoursLabel(f.split.busy.medianHours))}</td></tr></tbody></table>` : "";
  const load = f.load
    ? `Open work against time to merge: rank correlation <strong>ρ ${esc(f.load.rho.toFixed(2))}</strong> across ${fmt(f.load.n)} merges, ${beyond(chance, "open-work", f.load.p) ? "beyond chance" : "within chance"} (shuffles match it ${oftenPct(f.load.p)} of the time).`
    : `A correlation between open work and time to merge needs 8 merges with differing counts; ${fmt(o.merged)} ${o.merged === 1 ? "is" : "are"} loaded.`;
  const l = o.late;
  const late = l && l.slow.n && l.quick.n
    ? ` Of ${fmt(l.slow.n)} finished pull requests still open after ${esc(hoursLabel(l.afterHours))}, <strong>${fmt(l.slow.merged)}</strong> merged, against ${fmt(l.quick.merged)} of ${fmt(l.quick.n)} that finished sooner${l.p == null ? "" : ` (random regroupings match that gap ${oftenPct(l.p)} of the time)`}.` : "";
  return `
    ${stats([["Open now", fmt(f.openNow.length)], ["Others open when you start one", count(f.typicalOthers)], ["Most open at once", f.peak ? fmt(f.peak.count) : "—"]])}
    ${stats([["Half your merges finish within", b ? hoursLabel(b.medianHours) : "—"], ["90% finish within", b ? hoursLabel(b.p90Hours) : "—"], ["Open past your usual time", b ? `${fmt(o.overdue.length)} / ${fmt(f.openNow.length)}` : "—"]])}
    ${split}
    <p class="note">${load}${late}</p>
    <p class="note">Each pull request you opened counts as open from creation until it merged, closed, or now${f.peak ? `; the most at once came on ${esc(f.peak.at)}` : ""}. Your usual time comes from your own merges once six are loaded, and an open pull request is past it when it is older than 90% of them took, and at least a day old.${f.unknownEnd ? ` ${fmt(f.unknownEnd)} closed ${f.unknownEnd === 1 ? "pull request has" : "pull requests have"} no recorded close time and ${f.unknownEnd === 1 ? "is" : "are"} left out.` : ""} Pull requests opened before the ${AUTHORED_DAYS}-day window are not loaded, so the earliest counts run low.</p>`;
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
  if (state.public) return `<p class="note">Follow-through needs a token. GitHub's public search lists pull requests without their branch names, so a branch cannot be matched to its pull request. After the merge and Open work, below, cover what happened to your public pull requests.</p>`;
  if (!f.branches && !f.opened) return '<p class="note">No branches created or pull requests opened in the loaded events.</p>';
  const o = f.outcomes;
  const list = f.withoutPr.slice(0, 4).map((b) => `<li><code>${esc(b.ref)}</code> · ${esc(shortRepo(b.repo))} · ${fmt(Math.floor(b.days))} d</li>`).join("");
  return `
    ${stats([["Branches with no PR", f.settled ? `${fmt(f.withoutPr.length)} / ${fmt(f.settled)}` : "—"], ["Opened PRs merged", f.opened ? `${fmt(o.merged)} / ${fmt(f.opened)}` : "—"], ["Closed unmerged", fmt(o.closed)]])}
    ${f.opened ? bars([["Merged", o.merged], ["Still open", o.open], ["Closed unmerged", o.closed], ["Details unavailable", o.unknown]].filter(([, n]) => n)) : ""}
    ${list ? `<ul class="plain">${list}</ul>` : ""}
    <p class="note">Branches count once they are two days old and match a pull request by head branch from the feed or the loaded details. Pull request outcomes use current state, so they cover only the ${fmt(f.opened)} pull requests opened in the loaded events.</p>`;
}

function reviewCard(r, pr) {
  if (state.public) return `<p class="note">Review turnaround needs a token. ${PUBLIC_PR_GAP}</p>`;
  if (!pr.total) return '<p class="note">No pull request details are loaded.</p>';
  if (!r.authored) return `<p class="note">${state.prLookup.authored ? `You opened no pull requests in the last ${AUTHORED_DAYS} days that this token can read, so there is no review wait to measure.` : "The search for pull requests you opened did not load, and none of the other loaded pull requests were authored by you."}</p>`;
  const people = r.reviewers.slice(0, 5);
  const ratio = (n, d) => (d && n != null ? `${fmt(n)} / ${fmt(d)}` : "—");
  const verdicts = r.states ? stats([["Merges approved by another person", ratio(r.approvedBeforeMerge, r.merged)], ["Median to first approval", r.approved ? hoursLabel(r.medianFirstApprovalHours) : "—"], ["Changes requested", ratio(r.changesRequested, r.withHumanReview)]]) : "";
  const repos = r.byRepo.filter((x) => x.merged || x.timed).slice(0, REVIEW_REPO_ROWS);
  const repoTable = r.byRepo.length > 1 && repos.length ? `<table class="compare"><caption class="note">By repository, busiest first</caption>
      <thead><tr><th scope="col">Repository</th><th scope="col">Opened</th><th scope="col">Merged</th><th scope="col">No human review</th>${r.states ? '<th scope="col">Approved</th>' : ""}<th scope="col">Median first review</th></tr></thead>
      <tbody>${repos.map((x) => `<tr><th scope="row">${esc(shortRepo(x.repo))}</th><td>${fmt(x.authored)}</td><td>${fmt(x.merged)}</td><td>${ratio(x.noHuman, x.merged)}</td>${r.states ? `<td>${ratio(x.approved, x.merged)}</td>` : ""}<td>${x.timed ? esc(hoursLabel(x.medianFirstReviewHours)) : "—"}</td></tr>`).join("")}</tbody></table>` : "";
  return `
    ${stats([["Median to first human review", r.withHumanReview ? hoursLabel(r.medianFirstReviewHours) : "—"], ["Slowest quarter waited over", r.p75FirstReviewHours != null ? hoursLabel(r.p75FirstReviewHours) : "—"], ["Merged by you", r.merged ? `${fmt(r.selfMerged)} / ${fmt(r.merged)}` : "—"]])}
    ${verdicts}
    ${people.length ? bars(people, { violet: true }) + '<p class="note">Pull requests each person reviewed.</p>' : '<p class="note">No one besides you or a bot reviewed the pull requests you authored.</p>'}
    ${repoTable}
    <p class="note">Measured on ${fmt(r.authored)} ${r.authored === 1 ? "pull request" : "pull requests"} you authored${authoredCoverage()}, following the CHAOSS time-to-first-response definition: the first review by a human who is not the author. The wait starts when the pull request was ready for review: when it opened, or for a draft, when it was first marked ready. ${clockNote(r.clocks, r.noTimeline)}${fmt(r.withHumanReview)} had a human review; ${fmt(r.reviewedBeforeMerge)} of ${fmt(r.merged)} merges got one before merging, and ${fmt(r.botOnly)} ${r.botOnly === 1 ? "was" : "were"} reviewed only by bots. The slowest quarter appears from four timed waits.${r.states ? " An approval counts when another person approved before the merge. Comment-only reviews count as reviewed but not approved." : ""}${r.truncated ? ` ${fmt(r.truncated)} had more than 10 reviews, and only the first 10 are read.` : ""}</p>`;
}

// Where the waits in review turnaround started, when any started later than opening.
function clockNote(clocks, missing) {
  const parts = [];
  if (clocks?.ready) parts.push(`${fmt(clocks.ready)} ${clocks.ready === 1 ? "wait starts" : "waits start"} when a draft was marked ready.`);
  if (missing) parts.push(`${fmt(missing)} ${missing === 1 ? "pull request's timeline" : "pull requests' timelines"} did not load, so draft time counts there.`);
  return parts.length ? `${parts.join(" ")} ` : "";
}

const PARTNER_ROWS = 8;
const REVIEW_REPO_ROWS = 6;
const PARTNER_KINDS = { mutual: "Both ways", "reviews-you": "Reviews you", "you-review": "You review" };
// What a public search record lacks, for cards that need it.
const PUBLIC_PR_GAP = "GitHub's public search lists pull requests without their reviews, sizes, branches, or commit times, so this needs a token.";

function partnersCard(c) {
  if (state.public) return `<p class="note">Review partners need a token. ${PUBLIC_PR_GAP}</p>`;
  const a = state.prLookup.authored;
  const r = state.reviewed;
  if (!a && !r) return '<p class="note">Neither pull request search loaded, so there are no review partners to show.</p>';
  if (!c.people.length) {
    return `<p class="note">No one else reviewed the pull requests you opened, and you reviewed no pull requests by other people, in the last ${AUTHORED_DAYS} days.${a && r ? "" : " One of the two searches did not load."} Bots and your own reviews are left out.</p>`;
  }
  const time = (h, n) => (n ? esc(hoursLabel(h)) : "—");
  const rows = c.people.slice(0, PARTNER_ROWS).map((p) => `<tr><th scope="row">${esc(p.login)}</th><td>${esc(PARTNER_KINDS[p.kind])}</td><td>${fmt(p.in)}</td><td>${time(p.inMedianHours, p.inTimed)}</td><td>${fmt(p.out)}</td><td>${time(p.outMedianHours, p.outTimed)}</td></tr>`).join("");
  const more = c.people.length > PARTNER_ROWS ? ` Showing the ${PARTNER_ROWS} busiest of ${fmt(c.people.length)} people.` : "";
  const window = (x, noun) => (x ? `${x.capped ? `the newest ${fmt(x.loaded)} of ${fmt(x.total)}` : fmt(x.loaded)} ${noun}` : `no ${noun} (the search did not load)`);
  return `
    ${stats([["People", fmt(c.people.length)], ["Both ways", fmt(c.mutual)], ["Reviews received / given", `${a ? fmt(c.received) : "—"} / ${r ? fmt(c.given) : "—"}`]])}
    <table class="compare"><caption class="note">Pull requests in each direction, last ${AUTHORED_DAYS} days</caption>
      <thead><tr><th scope="col">Person</th><th scope="col">Direction</th><th scope="col">Reviewed yours</th><th scope="col">Their median first review</th><th scope="col">You reviewed theirs</th><th scope="col">Your median first review</th></tr></thead>
      <tbody>${rows}</tbody></table>
    ${c.outTimed ? `<p class="note">Your first review on other people's pull requests came a median of <strong>${esc(hoursLabel(c.outMedianHours))}</strong> after you were asked, or after they were ready for review where no request to you came first, across ${fmt(c.outTimed)}${c.outP75Hours != null ? `. The slowest quarter took over ${esc(hoursLabel(c.outP75Hours))}` : ""}. ${esc(I.clockText(c.outClocks, "your"))}</p>` : ""}
    <p class="note">From ${window(a, "pull requests you opened")} and ${window(r, "pull requests by others that you reviewed")}. Each person counts once per pull request. Each person's first review is timed from the request to them when one came first, else from when the pull request was ready for review, so a late request or a long draft no longer reads as a slow reviewer. ${esc(I.clockText(c.inClocks, "their"))}${more}${c.truncated ? ` ${fmt(c.truncated)} of your pull requests had more than 10 reviews, and only the first 10 are read.` : ""}${c.botAuthored ? ` ${fmt(c.botAuthored)} ${c.botAuthored === 1 ? "pull request by a bot that you reviewed is" : "pull requests by bots that you reviewed are"} left out.` : ""}${c.unmatched ? ` ${fmt(c.unmatched)} reviewed ${c.unmatched === 1 ? "pull request had" : "pull requests had"} no readable review time.` : ""}</p>`;
}

// Where the loaded pull requests came from, for captions.
function pullRequestCaption() {
  const { authored, referenced } = state.prLookup;
  const parts = [];
  if (authored) parts.push(`${fmt(authored.loaded)}${authored.capped ? ` of ${fmt(authored.total)}` : ""}${authored.public ? " public" : ""} you opened in the last ${authored.days} days`);
  if (referenced.total) {
    const others = referenced.asked ? `, ${fmt(referenced.found)} of ${fmt(referenced.asked)} others loaded` : "";
    parts.push(`${fmt(referenced.total)} referenced in the feed${referenced.covered ? `, ${fmt(referenced.covered)} already among yours` : ""}${others}`);
  }
  return parts.length ? parts.join(" · ") : "No pull requests loaded.";
}

function authoredCoverage() {
  const a = state.prLookup.authored;
  if (!a) return " among pull requests referenced in recent events";
  const older = Object.values(state.prInfo).filter((p) => p.source === "events" && p.author && state.user &&
    p.author.toLowerCase() === state.user.login.toLowerCase()).length;
  const window = a.capped ? `the newest ${fmt(a.loaded)} of ${fmt(a.total)} opened in the last ${a.days} days` : `every one opened in the last ${a.days} days that this token can read`;
  return ` (${window}${older ? `, plus ${fmt(older)} older ${older === 1 ? "one" : "ones"} referenced in recent events` : ""})`;
}

function historyInsights(h) {
  const notice = state.errors.years ? `<p class="insight-notice">${esc(state.errors.years)}</p>` : "";
  if (!h || !h.years.length) return insightSection("insight-history", "All years", "Unavailable", notice || '<p class="card muted">Contribution history did not load.</p>');
  const first = h.years[0].year;
  const last = h.years.at(-1).year;
  const caption = `${fmt(h.total)} contributions · ${first === last ? first : `${first}–${last}`} · calendar years`;
  const findings = h.findings.length
    ? `<ul class="attention">${h.findings.map((o) => `<li class="${esc(o.tone)}"><span class="dot"></span><div><div class="t">${esc(o.title)}</div><div class="d">${esc(o.detail)}</div>${sourceTag(o.source)}</div></li>`).join("")}</ul>`
    : '<p class="note">Nothing crossed a reporting threshold. Year comparisons need two full years with at least 50 contributions each.</p>';
  const yearLabel = (y) => `${y.year}${y.partial ? " (so far)" : !y.complete ? " (partial)" : ""}`;
  const table = `<table class="compare"><caption class="note">Calendar years, oldest first</caption>
    <thead><tr><th scope="col">Year</th><th scope="col">Total</th><th scope="col">Active days</th><th scope="col">Longest streak</th><th scope="col">Commits</th><th scope="col">PRs</th><th scope="col">Reviews</th><th scope="col">Issues</th><th scope="col">Weekends</th></tr></thead>
    <tbody>${h.years.map((y) => `<tr><th scope="row">${esc(yearLabel(y))}</th><td>${fmt(y.total)}</td><td>${fmt(y.activeDays)}</td><td>${fmt(y.longestStreak)} d</td><td>${fmt(y.commits)}</td><td>${fmt(y.prs)}</td><td>${fmt(y.reviews)}</td><td>${fmt(y.issues)}</td><td>${pct(y.weekendShare)}</td></tr>`).join("")}</tbody></table>`;
  const seasons = h.seasons
    ? `${bars(h.seasons.share.map((x, m) => [MONTHS[m], Math.round(x * 100)]), { suffix: "%" })}
       <p class="note">Each full year's share of contributions by month, averaged across ${fmt(h.seasons.years)} years so one busy year does not dominate. An even spread is about 8% a month.</p>`
    : '<p class="note">Seasonality needs two full calendar years with at least 50 contributions each. The year the account was created and the current year are not full years.</p>';
  const range = (r) => r.start ? `${esc(r.start)} to ${esc(r.end)}` : "";
  return insightSection("insight-history", "All years", caption, `
    ${notice}
    ${h.restricted ? `<p class="insight-notice">${fmt(h.restricted)} restricted contributions are counted without details across these years.</p>` : ""}
    <div class="grid insights">
      <article class="card insight-wide"><h4>What stands out</h4>${findings}</article>
      <article class="card"><h4>Contributions by year</h4>${sourceTag("Contribution history")}
        ${bars(h.years.map((y) => [yearLabel(y), y.total]))}
        ${h.pace ? `<p class="note">${fmt(h.pace.ytd)} so far this year against ${fmt(h.pace.lastYtd)} by the same date last year.</p>` : ""}
      </article>
      <article class="card"><h4>Records</h4>${sourceTag("Contribution history")}
        ${stats([["Longest streak", h.bestRun.days ? `${fmt(h.bestRun.days)} d` : "—"], ["Longest break", h.bestGap.days ? `${fmt(h.bestGap.days)} d` : "—"], ["Busiest day", h.busiestDay?.contributionCount ? fmt(h.busiestDay.contributionCount) : "—"]])}
        <p class="note">${h.bestRun.days ? `Streak ${range(h.bestRun)}. ` : ""}${h.bestGap.days ? `Break ${range(h.bestGap)}, between two active days. ` : ""}${h.busiestDay?.contributionCount ? `Busiest day ${esc(h.busiestDay.date)}. ` : ""}Streaks continue across New Year.</p>
      </article>
      <article class="card"><h4>Seasonality</h4>${sourceTag("Contribution history")}${seasons}</article>
      <article class="card insight-wide"><h4>Year by year</h4>${sourceTag("Contribution history")}
        ${table}
        <p class="note">Calendar years from January 1 to December 31, read from GitHub's contribution calendar. The current year runs to today. The Contribution year tab uses GitHub's rolling 12 months instead, so its totals differ.</p>
      </article>
    </div>`);
}

function footprintInsights(f) {
  const fp = state.footprint;
  const notice = [state.errors.footprint, state.errors.history].filter(Boolean).join(" ");
  const noticeHtml = notice ? `<p class="insight-notice">${esc(notice)}</p>` : "";
  if (!f || !fp) return insightSection("insight-footprint", "Footprint", "No repository data loaded", noticeHtml || '<p class="card muted">Repository traffic did not load.</p>');
  const saved = state.savedHistory;
  const caption = [
    `${fmt(f.totals.withTraffic)} of ${fmt(fp.listed)}${fp.more ? "+" : ""} repositories you own · 14-day traffic`,
    saved?.enabled === false ? "saved history off" : f.firstSaved ? `daily views since ${f.firstSaved}` : "",
  ].filter(Boolean).join(" · ");

  const findings = f.findings.length
    ? `<ul class="attention">${f.findings.map((o) => `<li class="${esc(o.tone)}"><span class="dot"></span><div><div class="t">${esc(o.title)}</div><div class="d">${esc(o.detail)}</div>${sourceTag(o.source)}</div></li>`).join("")}</ul>`
    : `<p class="note">Nothing crossed a reporting threshold. Findings need at least ${fmt(20)} visitors, and trend findings need 56 days of saved history.</p>`;

  const max = Math.max(1, ...f.weeks.map((w) => w.count));
  const cols = f.weeks.map((w) => `<span class="${w.known ? "after" : ""}" style="height:${w.known ? Math.max(2, Math.round(w.count / max * 100)) : 2}%" title="${esc(`Week of ${w.start}: ${w.known ? fmt(w.count) : "no data"}`)}"></span>`).join("");
  const trendText = f.trend
    ? `Last 28 days: <strong>${fmt(f.trend.last)}</strong> views, against ${fmt(f.trend.prev)} in the 28 before.`
    : `A four-week comparison needs 56 days of saved history; ${fmt(f.coveredDays)} ${f.coveredDays === 1 ? "day is" : "days are"} covered so far.`;

  const refs = f.referrers.slice(0, 6).map((r) => [r.referrer, r.count]);
  const newRefs = f.newReferrers.slice(0, 5).map((r) => `<li><strong>${esc(r.referrer)}</strong> · ${esc(shortRepo(r.repo))} · first seen ${esc(r.first)}</li>`).join("");

  const stars30 = (r) => r.stars30 == null ? "—" : `${r.stars30 > 0 ? "+" : ""}${fmt(r.stars30)}${r.starSource === "history" ? "*" : ""}`;
  const table = `<table class="compare"><caption class="note">Your most recently pushed repositories, up to ${FOOTPRINT_REPOS}</caption>
    <thead><tr><th scope="col">Repository</th><th scope="col">Views</th><th scope="col">Unique</th><th scope="col">Clones</th><th scope="col">Stars</th><th scope="col">Stars, 30 d</th><th scope="col">Forks</th></tr></thead>
    <tbody>${f.rows.map((r) => `<tr><th scope="row">${esc(shortRepo(r.repo))}${r.private ? ' <span class="src">private</span>' : ""}</th><td>${fmt(r.views)}</td><td>${fmt(r.uniques)}</td><td>${fmt(r.clones)}</td><td>${fmt(r.stars)}</td><td>${stars30(r)}</td><td>${fmt(r.forks)}</td></tr>`).join("")}</tbody></table>`;

  const optIn = saved?.enabled === false ? `<div class="callout">GitHub keeps only 14 days of traffic. To see trends over months, Activity Desk can save daily traffic, star and fork counts, and referring sites for your repositories on this Mac, encrypted, for up to 400 days.
      <div class="actions"><button class="btn ghost" type="button" data-action="history-on">Save history on this Mac</button></div></div>` : "";
  return insightSection("insight-footprint", "Footprint", caption, `
    ${noticeHtml}
    ${optIn}
    <div class="grid insights">
      <article class="card insight-wide"><h4>What stands out</h4>${findings}</article>
      <article class="card"><h4>Views by week</h4>${sourceTag("Traffic and saved history")}
        <div class="weekly" role="img" aria-label="Weekly page views across your repositories, oldest first">${cols}</div>
        <p class="note">${trendText} GitHub keeps 14 days of traffic. Older weeks come from history saved on this Mac, and grey weeks have no data.</p>
      </article>
      <article class="card"><h4>Where visitors come from</h4>${sourceTag("Traffic, last 14 days")}
        ${refs.length ? bars(refs) : '<p class="note">No referrers reported.</p>'}
        ${newRefs ? `<p class="note">First seen in the last 30 days:</p><ul class="plain">${newRefs}</ul>` : ""}
        <p class="note">Views from each referring site, summed across repositories. GitHub lists up to 10 per repository.</p>
      </article>
      <article class="card insight-wide"><h4>Repositories</h4>${sourceTag("Traffic and repository list")}
        ${table}
        <p class="note">Views, unique visitors, and clones cover the last 14 days. Stars over 30 days come from star dates for repositories with up to ${STAR_DATES_MAX} stars, or from saved daily counts (marked *). Clones can include automated ones such as CI checkouts.</p>
      </article>
    </div>`);
}

function renderInsights(c) {
  const { ev, pr, year } = c;
  $("insight-nav").querySelectorAll("button").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.source === state.insight));
  });
  const panel = state.insight === "events" ? eventInsights(ev)
    : state.insight === "prs" ? pullRequestInsights(pr)
    : state.insight === "patterns" ? patternInsights(c)
    : state.insight === "footprint" ? footprintInsights(c.footprint)
    : state.insight === "history" ? historyInsights(c.years) : annualInsights(year);
  $("insights").innerHTML = `${state.errors.refresh ? `<p class="insight-notice">${esc(state.errors.refresh)}</p>` : ""}${panel}`;
}

// ---------- suggestions ----------
const SUGGESTION_STATUS = {
  shown: ["→", "part", "Suggested"],
  folded: ["↳", "part", "Shown inside another suggestion"],
  clear: ["✓", "ok", "Nothing found"],
  short: ["…", "muted", "Not enough data"],
  unavailable: ["✕", "no", "Source unavailable"],
  snoozed: ["◷", "muted", "Snoozed"],
  dismissed: ["–", "muted", "Dismissed"],
};
const shortDate = (iso) => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });

// What a card's owner can do with it. Pinned cards (token access) offer nothing to set them aside.
function cardActions(s) {
  if (state.public || s.pinned) return "";
  const metric = s.metric ? ` data-metric="1"` : "";
  if (s.trying) {
    const m = s.metric;
    const then = s.trying.then && s.trying.now ? `. ${esc(m.label)}: ${esc(s.trying.then)} then, ${esc(s.trying.now)} now` : "";
    return `<div class="card-actions"><span class="trying-since">Trying since ${esc(shortDate(s.trying.at))}${then}</span>
      <button type="button" class="link" data-card="${esc(s.key)}" data-state="">Stop trying</button></div>`;
  }
  return `<div class="card-actions">
    <button type="button" class="link" data-card="${esc(s.key)}" data-state="trying"${metric}>Trying this</button>
    ${I.SNOOZE_DAYS.map((d) => `<button type="button" class="link" data-card="${esc(s.key)}" data-state="snoozed" data-days="${d}">Snooze ${d} days</button>`).join("")}
    <button type="button" class="link" data-card="${esc(s.key)}" data-state="dismissed"${metric}>Dismiss</button></div>`;
}
const readingHost = (url) => new URL(url).hostname.replace(/^www\./, "");

// Text segments are [text, ...reading ids]; each cited id becomes a numbered button that opens the source.
function citedText(segments, numbers) {
  return segments.map(([text, ...ids]) => `${esc(text)}${ids.filter((id) => numbers.has(id)).map((id) => {
    const r = I.READING[id];
    return `<sup><button type="button" class="cite" data-reading="${esc(id)}" title="${esc(`${r.title} · ${readingHost(r.url)}`)}" aria-label="${esc(`Source ${numbers.get(id)}: ${r.title}`)}">[${numbers.get(id)}]</button></sup>`;
  }).join("")}`).join(" ");
}

function suggestionCard(s) {
  const numbers = new Map(s.reading.map((id, i) => [id, i + 1]));
  const reading = s.reading.map((id) => {
    const r = I.READING[id];
    return `<li><button type="button" class="link" data-reading="${esc(id)}">${esc(r.title)}</button> <span class="muted">${esc(r.by)} · ${esc(readingHost(r.url))}</span></li>`;
  }).join("");
  const also = s.also.map((text) => `<p class="also">${esc(text)}</p>`).join("");
  const from = s.patterns.length ? `<p class="basis">From Patterns: ${s.patterns.map((f) =>
    `<button type="button" class="link" data-finding="${esc(f.id)}">${esc(f.title)}</button>`).join(" · ")}</p>` : "";
  const back = s.returned ? `<p class="returned">Back after you dismissed it on ${esc(shortDate(s.returned.at))}: ${esc(s.returned.label.toLowerCase())} was ${esc(s.returned.then)}, now ${esc(s.returned.now)}.</p>` : "";
  return `<article class="card suggestion ${esc(s.tone)}${s.trying ? " is-trying" : ""}" id="suggestion-${esc(s.id)}" tabindex="-1">
    <div class="suggestion-tags"><span class="src area">${esc(s.area)}</span>${sourceTag(s.source)}${s.accountWide ? '<span class="src" title="The same in every repository view.">Account-wide</span>' : ""}${s.confirmed ? '<span class="src confirmed" title="The gap or correlation behind this suggestion passed its chance check.">Beyond chance</span>' : ""}</div>
    <h4>${esc(s.title)}</h4>
    ${back}
    ${s.basis ? `<p class="basis">Based on ${esc(s.basis)}</p>` : ""}
    ${from}
    <dl class="suggestion-body">
      <dt>Seen</dt><dd>${esc(s.seen)}${also}</dd>
      ${s.why.length ? `<dt>Why</dt><dd>${citedText(s.why, numbers)}</dd>` : ""}
      <dt>Try</dt><dd>${citedText(s.act, numbers)}</dd>
      ${s.targets.length ? `<dt>Where</dt><dd><ul class="targets">${s.targets.map((t, i) => `<li>${whereLine(t, s.refs?.[i])}</li>`).join("")}</ul></dd>` : ""}
    </dl>
    ${reading ? `<h5>Further reading</h5><ol class="reading">${reading}</ol>` : ""}
    ${cardActions(s)}
  </article>`;
}

// A Where line whose leading name opens on github.com: "owner/repo #12" or "owner/repo".
// Lines that name a branch or a person stay text, apart from the repository they mention.
function whereLine(text, ref) {
  if (!ref) return esc(text);
  const label = ref.number ? `${ref.repo} #${ref.number}` : ref.repo;
  const at = text.indexOf(label);
  if (at < 0) return esc(text);
  const button = `<button type="button" class="link where-link" data-open-repo="${esc(ref.repo)}"${ref.number ? ` data-open-number="${ref.number}"` : ""} title="${esc(`Open ${label} on github.com`)}">${esc(label)}</button>`;
  return `${esc(text.slice(0, at))}${button}${esc(text.slice(at + label.length))}`;
}

// Cards being tried, with the number each was measured by when you started and now.
function tryingPanel(list, scope) {
  if (!list.length) return "";
  const row = (t) => {
    const series = t.series ? `Week by week ${t.series.before ? `from ${esc(shortDate(t.series.start))}, the last saved week before you started` : `since ${esc(shortDate(t.series.start))}`}: ${t.series.values.map((v) => (v ? esc(v.text) : "…")).join(" → ")}${t.series.same ? " (no change)" : t.series.better ? " (lower)" : " (not lower yet)"}` : "";
    const change = series ? `${esc(t.label || "")}. ${series}` : t.then && t.now ? `${esc(t.label)}: ${esc(t.then)} → <strong>${esc(t.now)}</strong>${t.better == null ? "" : t.better ? " (lower)" : t.then === t.now ? " (no change)" : " (not lower yet)"}` : t.label ? `${esc(t.label)} is not measurable in the loaded data yet.` : "No number to follow for this card.";
    const where = t.showing ? "" : ` <span class="muted small">· ${t.status === "clear" ? "No longer suggested" : esc(SUGGESTION_STATUS[t.status]?.[2] || "")}</span>`;
    return `<li><div><div>${esc(t.title)}${where}</div><div class="d">Since ${esc(shortDate(t.at))}. ${change}</div></div>
      <button type="button" class="link" data-card="${esc(t.key)}" data-state="">Stop</button></li>`;
  };
  return `<article class="card trying-panel"><h4>Trying</h4><ul class="cap">${list.map(row).join("")}</ul>
    <p class="note">Each number covers the loaded window, the last ${AUTHORED_DAYS} days for pull requests, so a change you made shows up gradually as older work leaves the window.${weeklyNote(list, scope)}</p></article>`;
}

// Says where a trial's numbers come from: the weekly snapshots when saved history has them, or the
// number saved when the trial started.
function weeklyNote(list, scope) {
  if (scope && list.some((t) => I.TRIAL_SNAPSHOTS[t.id])) return " Week by week is saved for the whole account, so a trial in one repository compares with its number when it started.";
  if (list.some((t) => t.series)) return " Where saved history has weekly snapshots, a trial reads them from the week it started.";
  if (!list.some((t) => t.weekly)) return "";
  return state.savedHistory?.enabled ? " A trial reads its weekly snapshots once two weeks are saved."
    : " Turn on saved history and a trial will read its weekly snapshots once two weeks are saved.";
}

// Snoozed and dismissed cards, each with an undo.
function setAsideList(snoozed, dismissed) {
  const all = [...snoozed.map((x) => [x, `Snoozed until ${shortDate(x.until)}`]), ...dismissed.map((x) => [x, `Dismissed ${shortDate(x.dismissedAt)}`])];
  if (!all.length) return "";
  return `<details class="card set-aside"><summary>Set aside: ${fmt(all.length)}</summary><ul class="cap">${all.map(([x, label]) =>
    `<li><div><div>${esc(x.title)} <span class="muted small">· ${esc(label)}</span></div></div><button type="button" class="link" data-card="${esc(x.key)}" data-state="">Show again</button></li>`).join("")}</ul>
    <p class="note">A dismissed card comes back on its own when the number it was measured by gets clearly worse. The token-access warning cannot be set aside.</p></details>`;
}

// Saves a card's state in the main process. Trying and dismissing record the card's number now.
async function setCardState(key, next, days) {
  const account = state;
  if (account.public) return;
  const c = computed();
  const shown = c.scoped || c.suggestions;
  const id = key.split("@")[0];
  const item = shown.items.find((i) => i.key === key) || shown.checked.find((i) => i.id === id);
  const input = next ? { state: next, ...(next === "snoozed" ? { days } : {}), ...(item?.metric ? { metric: item.metric } : {}) } : null;
  let result;
  try {
    result = await window.desk.setCard(key, input);
  } catch {
    result = { ok: false, error: "The suggestion state could not be saved." };
  }
  if (account !== state) return;
  if (result.ok) {
    state.cards = result.cards;
    delete state.errors.cards;
  } else {
    state.errors.cards = result.error;
  }
  renderAll();
  // Keep keyboard focus near the card: on it if it is still shown, else on the Set aside list.
  const target = document.getElementById(`suggestion-${id}`) || document.querySelector("#suggestions .set-aside summary");
  if (target) target.focus({ preventScroll: false });
}

// The repository picker, and what a repository view counts and leaves account-wide.
function scopeBar(c) {
  const repos = I.scopeRepos(state.prInfo, state.user && state.user.login);
  if (!repos.length) return "";
  const options = [`<option value="">All repositories</option>`, ...repos.map((r) =>
    `<option value="${esc(r.repo)}"${r.repo === state.suggestScope ? " selected" : ""}>${esc(r.repo)} (${fmt(r.merged)} ${r.merged === 1 ? "merge" : "merges"})</option>`)];
  const s = c.scoped;
  const passed = s ? s.chance.entries.filter((t) => t.clear).length : 0;
  const note = s
    ? `Pull request suggestions count only the ${fmt(s.repo.opened)} pull ${s.repo.opened === 1 ? "request" : "requests"} you opened in ${esc(s.repo.repo)} that loaded, ${fmt(s.repo.merged)} of them merged, so more cards read Not enough data than in the full view. ${s.chance.tested ? `This view runs its own ${fmt(s.chance.tested)} chance ${s.chance.tested === 1 ? "check" : "checks"} under its own shared bar, and ${fmt(passed)} passed.` : "No chance check has enough merges in this repository."} Cards tagged Account-wide come from the Events feed, the contribution calendar, notifications, conversations, traffic, or the token, and are the same in every view. Trying, snoozing, and dismissing here apply to this repository only, except on Account-wide cards. From Patterns links appear in the All repositories view, since Patterns describes the whole account.`
    : `Choose a repository with at least ${fmt(I.SUGGEST_MIN_MERGES)} loaded merges of yours to see its suggestions alone.`;
  return `<div class="card scope-bar"><label for="suggest-scope">Suggestions for</label>
    <select id="suggest-scope">${options.join("")}</select><p class="note">${note}</p></div>`;
}

function renderSuggestions(c) {
  const view = c.scoped || c.suggestions;
  const { items, checked } = view;
  $("suggestion-count").textContent = items.length ? String(items.length) : "";
  $("suggestions-caption").textContent = items.length
    ? `${items.length} ${items.length === 1 ? "change" : "changes"} to try, each triggered by a pattern in the loaded data. Each card says what it saw and what to try. Where it gives a reason, each claim links to its source. Warnings rest on an outcome in your own data or on access. Advice about review stays a note unless your merges back it.`
    : "Nothing in the loaded data calls for a change. Each suggestion needs a minimum sample before it appears.";
  const notice = [state.errors.refresh, state.errors.events, state.errors.authored, state.errors.prs, state.errors.year,
    state.errors.conversations, state.errors.footprint].filter(Boolean).join(" ");
  const rows = checked.map((r) => {
    const [mark, cls, label] = SUGGESTION_STATUS[r.status];
    return `<li><span class="${cls}" aria-hidden="true">${mark}</span><div><div>${esc(r.title)} <span class="muted small">· ${esc(label)}</span></div>${r.detail ? `<div class="d">${esc(r.detail)}</div>` : ""}</div></li>`;
  }).join("");
  $("suggestions").innerHTML = `
    ${notice ? `<p class="insight-notice">${esc(notice)}</p>` : ""}
    <p class="msg error" id="reading-status" role="status"></p>
    ${state.errors.cards ? `<p class="insight-notice">${esc(state.errors.cards)}</p>` : ""}
    ${scopeBar(c)}
    ${tryingPanel(view.trying || [], view.scope)}
    ${items.length ? `<div class="grid suggestion-grid">${items.map(suggestionCard).join("")}</div>` : ""}
    ${setAsideList(view.snoozed || [], view.dismissed || [])}
    <details class="card checked">
      <summary>What was checked: ${fmt(items.length)} of ${fmt(checked.length)} suggested</summary>
      <ul class="cap">${rows}</ul>
      <p class="note">Suggestions describe patterns in the loaded samples, not their causes. Pull request suggestions cover the pull requests you opened in the last ${AUTHORED_DAYS} days plus those referenced in recent events. Sources open in your browser.</p>
    </details>`;
}

function renderMeta(c) {
  const { ev, year } = c;
  const v = state.viewer;
  const range = dateRange(ev.oldest, ev.newest);
  const cards = [];

  cards.push(fixCard(c));
  cards.push(coverageCard(c));

  const use = state.tokenUse;
  const both = dual(state);
  const caps = [];
  caps.push([state.errors.events ? "part" : "ok", "Activity stream", esc((state.errors.events || `${fmt(ev.total)} recent events loaded.`) + onlyNote(use?.events, "event", "events"))]);
  caps.push(ev.privateEvents ? ["ok", "Private events", `${fmt(ev.privateEvents)} private events visible.`]
    : ["part", "Private events", state.public ? "Not visible without a token." : state.tokens["fine-grained"] ? "None visible. Add the account permission Events: read to the fine-grained token if you have private activity." : "None in this window."]);
  caps.push(state.notifications ? [state.errors.notifications ? "part" : "ok", "Notifications", `${fmt(state.notifications.length)} unread loaded. ${esc(state.errors.notifications || "")}`]
    : ["no", "Notifications", esc(state.errors.notifications || "Not available.")]);
  caps.push(year ? ["ok", "Contribution year", `${fmt(year.total)} contributions.${use?.year ? ` Read with the ${esc(use.year)} token, which hides the fewest contributions.` : ""}`] : ["no", "Contribution year", esc(state.errors.year || "")]);
  const { authored, referenced } = state.prLookup;
  caps.push(authored
    ? [state.errors.authored ? "part" : "ok", authored.public ? "Public pull requests you opened" : "Pull requests you opened", esc((state.errors.authored || (authored.public
      ? `${fmt(authored.loaded)} from the last ${fmt(authored.days)} days, found by GitHub's public search. Reviews, sizes, branches, and commit times need a token.`
      : `${fmt(authored.loaded)} from the last ${fmt(authored.days)} days, found by search.`)) + onlyNote(use?.authored, "pull request", "pull requests"))]
    : ["no", "Pull requests you opened", esc(state.errors.authored || "Not available.")]);
  const rv = state.reviewed;
  caps.push(rv
    ? [state.errors.reviewed ? "part" : "ok", "Pull requests you reviewed", esc((state.errors.reviewed || `${fmt(rv.loaded)} by others from the last ${fmt(rv.days)} days, found by search.`) + onlyNote(use?.reviewed, "pull request", "pull requests"))]
    : ["no", "Pull requests you reviewed", esc(state.errors.reviewed || "Not available.")]);
  caps.push(referenced.asked
    ? [state.errors.prs ? "part" : "ok", "Other pull requests in events", `${fmt(referenced.found)} loaded of ${fmt(referenced.asked)} requested. ${fmt(referenced.total)} referenced in events, ${fmt(referenced.covered)} already among yours. ${esc(state.errors.prs || "")}`]
    : ["ok", "Other pull requests in events", referenced.total ? `All ${fmt(referenced.total)} referenced in events were already among yours.` : "No pull requests in the loaded events."]);
  const conv = state.conversations;
  caps.push(conv
    ? [state.errors.conversations ? "part" : "ok", "Conversations", `${fmt(conv.items.length)} comments and reviews on ${fmt(conv.threads)} threads. ${esc((state.errors.conversations || "") + onlyNote(use?.conversations, "thread", "threads"))}`]
    : ["no", "Conversations", esc(state.errors.conversations || "Not available.")]);
  const asked = state.requests;
  caps.push(asked
    ? [state.errors.requests ? "part" : "ok", "Review requests", esc((state.errors.requests || `${fmt(asked.search.nodes.length)} open pull requests ask you for a review, by name or through a team.`) + onlyNote(use?.requests, "request", "requests"))]
    : ["no", "Review requests", esc(state.errors.requests || (state.public ? NEEDS_TOKEN.requests : "Not available."))]);
  if (year) {
    caps.push(year.totals.restricted
      ? ["part", "Private contributions", `${fmt(year.totals.restricted)} contributions are counted but hidden from ${both ? "both tokens" : "this token"}.`]
      : ["ok", "Restricted contributions", "GitHub reported no restricted contribution count."]);
  }
  const ch = state.contributionHistory;
  caps.push(ch ? [state.errors.years ? "part" : "ok", "Contribution history", `${fmt(Object.keys(ch.byYear).length)} calendar years in one request. ${esc(state.errors.years || "")}`]
    : ["no", "Contribution history", esc(state.errors.years || "Not available.")]);
  const fp = state.footprint;
  caps.push(!fp ? ["no", "Repository traffic", esc(state.errors.footprint || "Not available.")]
    : fp.denied ? ["no", "Repository traffic", esc(state.errors.footprint)]
    : [state.errors.footprint ? "part" : "ok", "Repository traffic", `${fmt(Object.keys(fp.traffic).length)} of ${fmt(fp.repos.length)} repositories read. ${esc(state.errors.footprint || "")}`]);
  if (state.errors.account) caps.push(["part", "Account details", esc(state.errors.account)]);
  const kinds = savedSlots(state).map((slot) => `a <strong>${esc(state.tokens[slot])}</strong> token`);
  cards.push(`<article class="card"><h3>${state.public ? "What the public view can see" : both ? "What these tokens can see" : "What this token can see"}</h3>
    <p class="big">${state.public ? `Showing <strong>@${esc(state.user?.login)}</strong> without a token. GitHub allows 60 requests an hour without one, counted for your network address, and a refresh uses up to ${5 + PUBLIC_STAR_REPOS}. Public pull requests come from search, which has its own limit of 10 requests a minute, and a refresh uses up to ${AUTHORED_PAGES}.` : `Signed in with ${kinds.join(" and ") || "a <strong>GitHub</strong> token"}.`}${both ? " Activity, pull requests, and conversations are read with both and joined. Other sources use the fine-grained token first." : ""}</p>
    <ul class="cap">${caps.map(([s, t, d]) => `<li><span class="${s}">${s === "ok" ? "✓" : s === "no" ? "✕" : "!"}</span><div><div>${esc(t)}</div><div class="d">${d}</div></div></li>`).join("")}</ul>
  </article>`);

  if (v) {
    const created = v.createdAt && new Date(v.createdAt);
    cards.push(`<article class="card"><h3>Account</h3>
      <dl class="kv">
        <dt>On GitHub since</dt><dd>${created ? esc(created.toLocaleDateString(undefined, { month: "short", year: "numeric" })) : "—"}</dd>
        <dt>${state.public ? "Public repositories" : "Repositories you own"}</dt><dd>${fmt(v.repositories && v.repositories.totalCount)}</dd>
        <dt>Followers</dt><dd>${fmt(v.followers && v.followers.totalCount)}</dd>
        <dt>Repositories committed to this year</dt><dd>${fmt(year && year.totals.repos)}</dd>
        <dt>Commits / PRs / issues / reviews</dt><dd>${year ? `${fmt(year.totals.commits)} / ${fmt(year.totals.prs)} / ${fmt(year.totals.issues)} / ${fmt(year.totals.reviews)}` : "—"}</dd>
      </dl>
      <p class="note">${state.public ? "Without a token these are public counts. The yearly totals come from the contribution calendar, which needs a token." : `Your public profile can show a different yearly total. It depends on whether private contributions are shown publicly, and this view counts what your ${both ? "tokens" : "token"} can see.`}</p>
    </article>`);
  }

  $("token-check").innerHTML = tokenCard();
  $("add-token-label").textContent = state.public ? "Add a token to load everything else" : "Add a second token for this account, or replace a saved one";
  cards.push(rateCard());
  cards.push(historyCard());
  cards.push(notesCard());

  cards.push(`<article class="card"><h3>This session</h3>
    <dl class="kv">
      <dt>Last refreshed</dt><dd>${state.refreshedAt ? esc(state.refreshedAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })) : "—"}</dd>
      <dt>New since marked seen</dt><dd>${fmt(ev.fresh)} events, ${fmt(freshConversations())} comments from others</dd>
      <dt>Marked seen at</dt><dd>${state.lastSeen ? esc(new Date(state.lastSeen).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })) : "—"}</dd>
      <dt>Last response's remaining limit</dt><dd>${esc(state.remaining ?? "—")}</dd>
    </dl>
    <p class="note">From whichever GitHub response arrived last, REST or GraphQL. See <strong>Rate-limit budget</strong> for both.</p>
  </article>`);

  $("meta").innerHTML = cards.join("");
}

// ---------- Data & access: what to change, what each source covers, and what a refresh cost ----------
// Concrete changes that would fill a gap in this refresh, most useful first. Each names what is missing,
// why, and what to do, with a button where the app can take the first step: GitHub's token forms open
// from the main process's fixed links, and saved history turns on here.
function fixList(c) {
  const out = [];
  const add = (tone, title, detail, action) => out.push({ tone, title, detail, action });
  const fine = Boolean(state.tokens["fine-grained"]);
  if (state.public) {
    const locked = (c.suggestions?.checked || []).filter((x) => x.status === "unavailable").length;
    add("fix", "Add a token to load the rest", `A read-only fine-grained token adds the contribution calendar and every past year, reviews, sizes, branches, and commit times for your pull requests, review requests, conversations, repository traffic, and notes. ${locked ? `${fmt(locked)} suggestion checks are waiting on it. ` : ""}Paste it under Token check above; the dashboard reloads for that account.`, { focus: "add-token", label: "Add a token" });
  }
  for (const w of tokenWarnings().filter((t) => !/rate limit/.test(t.title))) {
    const kind = /classic/.test(w.title) ? "classic" : "fine-grained";
    add("fix", w.title, `${w.detail}${/can make changes/.test(w.title) ? " Create one with only the notifications scope, save it here, then revoke the old one on GitHub." : ""}`, { page: kind, label: `Create a ${kind} token` });
  }
  for (const slot of savedSlots(state)) {
    for (const [op, sets] of Object.entries(state.tokenMeta?.[slot]?.denied || {})) {
      add("fix", `${OPERATION_LABELS[op] || op}: GitHub denied the ${state.tokens[slot]} token`,
        `GitHub accepts ${sets.map((set) => set.join(" with ")).join(", or ")} for this read. Add it as a read permission to the token in GitHub's settings (Settings → Developer settings → Personal access tokens), or create a new token with it and save that here.`,
        { page: slot, label: `Create a ${state.tokens[slot]} token` });
    }
  }
  const fp = state.footprint;
  if (!state.public && fp?.denied && !savedSlots(state).some((slot) => state.tokenMeta?.[slot]?.denied?.traffic)) {
    add("fix", "Repository traffic is not readable", "Footprint's views, visitors, clones, and referring sites need read access to Administration on repositories you own: the fine-grained permission Administration: read, or a classic token with access to them. Read access cannot change anything.", { page: "fine-grained", label: "Create a fine-grained token" });
  }
  if (!state.public && !state.tokens.classic) {
    add("tip", "Unread notifications need a classic token", "GitHub serves the unread inbox only to classic tokens. A classic token with only the notifications scope cannot change anything. Save it beside the fine-grained token and Activity Desk reads the inbox with it.", { page: "classic", label: "Create a classic token" });
  }
  if (!state.public && fine && c.ev.total && !c.ev.privateEvents) {
    add("tip", "No private events are visible", "If you work in private repositories, give the fine-grained token the account permission Events: read. Without it, the stream and the work-session findings cover public activity only.", { page: "fine-grained", label: "Create a fine-grained token" });
  }
  if (!state.public && state.savedHistory?.enabled === false) {
    add("tip", "Saved history is off", "GitHub keeps 14 days of traffic. Saved history keeps daily traffic and one weekly snapshot of your merge time, follow-up fixes, open work, and waiting on this Mac, encrypted, so Footprint and Week by week can show more than the latest window.", { history: "history-on", label: "Turn on saved history" });
  }
  if (state.errors.commits) add("tip", "Some last-commit times are missing", `${state.errors.commits} Working and waiting counts only merges with a commit time. GitHub did not name a missing permission for this read.`);
  for (const r of state.rateLimit?.resources || []) {
    if (r.low) add("fix", `The ${r.label} limit is nearly spent`, `${fmt(r.remaining)} of ${fmt(r.limit)} left. Wait until ${r.resetAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} before refreshing, or reads will start to fail.`);
  }
  const failed = Object.entries(state.errors).filter(([key, text]) => !state.locked?.has(key) && /did not load|did not refresh|did not complete/.test(text)).map(([key]) => key);
  if (failed.length) add("fix", `${fmt(failed.length)} ${failed.length === 1 ? "source" : "sources"} did not load this time`, "A source that failed on a network error or a timeout usually loads on the next refresh. What this token can see, below, gives each one's reason.");
  return out;
}

function fixCard(c) {
  const list = fixList(c);
  const button = (a) => !a ? "" : a.page ? `<button type="button" class="btn ghost small-btn" data-token-page="${esc(a.page)}">${esc(a.label)}</button>`
    : a.history ? `<button type="button" class="btn ghost small-btn" data-action="${esc(a.history)}">${esc(a.label)}</button>`
    : `<button type="button" class="btn ghost small-btn" data-focus="${esc(a.focus)}">${esc(a.label)}</button>`;
  return `<article class="card fix-card"><h3>What to change</h3>
    ${list.length ? `<ul class="cap fixes">${list.map((f) => `<li><span class="${f.tone === "fix" ? "part" : "muted"}" aria-hidden="true">${f.tone === "fix" ? "!" : "+"}</span><div><div>${esc(f.title)}</div><div class="d">${esc(f.detail)}</div>${button(f.action)}</div></li>`).join("")}</ul>`
      : '<p class="big">Nothing to change. Every source loaded with what it needs.</p>'}
    <p class="note">Changes marked ! fill a gap in this refresh. Those marked + would add data you may want. Activity Desk opens only GitHub's token forms and never changes a token itself.</p>
  </article>`;
}

// How far back each source looks, on one axis of the last year. Each source covers its own window, which
// is why one number can differ from another, or from your profile page. Every bar's dates are also
// written beside it, so the chart never carries the information alone.
const COVERAGE_DAYS = 365;
function coverageRows(c) {
  const now = state.refreshedAt ? state.refreshedAt.getTime() : Date.now();
  const days = (n) => now - n * 864e5;
  const rows = [];
  const row = (name, from, to, text, partial) => { if (Number.isFinite(from) && Number.isFinite(to) && to >= from) rows.push({ name, from, to, text, partial }); };
  const span = (from, to) => `${dateRange(from, to) || ""} · ${fmt(Math.max(1, Math.round((to - from) / 864e5)))} days`;
  const year = c.year;
  if (year?.days?.length) row("Contribution year", Date.parse(`${year.days[0].date}T00:00:00Z`), now, `GitHub's rolling year, ${fmt(year.total)} contributions`);
  const a = state.prLookup.authored;
  if (a) row(a.public ? "Public pull requests" : "Pull requests you opened", days(a.days), now, `${fmt(a.loaded)}${a.capped ? ` of ${fmt(a.total)}` : ""} opened in the last ${a.days} days`, a.capped);
  if (state.reviewed) row("Pull requests you reviewed", days(state.reviewed.days), now, `${fmt(state.reviewed.loaded)} by others, opened in the last ${state.reviewed.days} days`, state.reviewed.capped);
  if (c.ev.total) row("Recent events", c.ev.oldest, c.ev.newest, `${fmt(c.ev.total)} events, ${span(c.ev.oldest, c.ev.newest)}${state.errors.events ? ". GitHub's feed stops at 300 events or 30 days" : ""}`, Boolean(state.errors.events));
  if (state.conversations) row("Conversations", days(30), now, `${fmt(state.conversations.threads)} threads updated in the last 30 days`);
  const asked = c.requests?.items || [];
  if (asked.length) row("Review requests", Date.parse(asked[0].at), now, `${fmt(asked.length)} open, the oldest asked ${I.durationLabel(asked[0].hours)} ago`);
  if (state.footprint && !state.footprint.denied && Object.keys(state.footprint.traffic).length) row("Repository traffic", days(14), now, "The 14 days GitHub keeps");
  const h = state.savedHistory;
  if (h?.enabled) {
    const saved = new Set();
    for (const r of Object.values(h.repos || {})) for (const series of [r.views, r.clones, r.counts]) for (const d of Object.keys(series || {})) saved.add(d);
    for (const w of Object.keys(h.snapshots || {})) saved.add(w);
    const first = [...saved].sort()[0];
    if (first) row("Saved history", Date.parse(`${first}T00:00:00Z`), now, `Kept on this Mac since ${first}`);
  }
  return rows;
}

function coverageCard(c) {
  const rows = coverageRows(c);
  const now = state.refreshedAt ? state.refreshedAt.getTime() : Date.now();
  const start = now - COVERAGE_DAYS * 864e5;
  const at = (t) => Math.min(100, Math.max(0, ((t - start) / (now - start)) * 100));
  const tick = (daysAgo, label) => `<span style="left:${at(now - daysAgo * 864e5).toFixed(2)}%">${esc(label)}</span>`;
  return `<article class="card coverage-card"><h3>What each source covers</h3>
    <p class="big">Each source looks back its own distance, so a count from one is not comparable with a count from another.</p>
    ${rows.length ? `<ul class="coverage">${rows.map((r) => {
      const left = at(r.from);
      const clipped = r.from < start;
      return `<li><span class="name">${esc(r.name)}</span>
        <span class="span-track" aria-hidden="true"><span class="span-fill${r.partial ? " partial" : ""}${clipped ? " clipped" : ""}" style="left:${left.toFixed(2)}%;width:${Math.max(0.8, at(r.to) - left).toFixed(2)}%" title="${esc(`${r.name}: ${r.text}`)}"></span></span>
        <span class="when">${esc(r.text)}</span></li>`;
    }).join("")}</ul>
    <div class="coverage-axis" aria-hidden="true">${tick(COVERAGE_DAYS, "A year ago")}${tick(182, "6 months")}${tick(90, "90 days")}${tick(0, "Now")}</div>` : '<p class="note">No source loaded a time window.</p>'}
    <p class="note">${state.public ? "Without a token, the window for pull requests is the public search's." : "All years reaches back further than this axis, to each calendar year GitHub lists, up to 20."} A lighter bar was cut short by a cap, such as GitHub's 300 events or the newest 300 pull requests. Unread notifications have no window: they are whatever is unread now.</p>
  </article>`;
}

// Which limit each read draws on. GitHub does not count the rate-limit read itself.
const OPERATION_BUCKETS = {
  profile: "core", events: "core", notifications: "core", ownedRepos: "core", traffic: "core", stargazers: "core", rateLimit: "free",
  year: "graphql", contributionHistory: "graphql", pullRequests: "graphql", pullRequestCommits: "graphql", authoredPullRequests: "graphql",
  reviewedPullRequests: "graphql", conversations: "graphql", reviewRequests: "graphql",
};
const bucketOf = (op) => (state.public && op === "authoredPullRequests" ? "search" : OPERATION_BUCKETS[op] || "core");
const BUCKET_LABELS = { core: "REST", graphql: "GraphQL", search: "Search", free: "Free" };

// What this refresh sent to GitHub, by read and by limit, and how many more refreshes the REST budget allows.
function ledgerSection() {
  // Grouped by the limit each read draws on, then busiest first, then by name.
  const order = ["core", "search", "graphql", "free"];
  const entries = Object.entries(state.ledger || {}).filter(([, n]) => n > 0).sort((a, b) => order.indexOf(bucketOf(a[0])) - order.indexOf(bucketOf(b[0])) ||
    b[1] - a[1] || String(OPERATION_LABELS[a[0]] || a[0]).localeCompare(String(OPERATION_LABELS[b[0]] || b[0])));
  if (!entries.length) return "";
  const totals = {};
  for (const [op, n] of entries) totals[bucketOf(op)] = (totals[bucketOf(op)] || 0) + n;
  const sent = entries.reduce((n, [, k]) => n + k, 0);
  const core = (state.rateLimit?.resources || []).find((r) => r.name === "core");
  const used = totals.core || 0;
  const fit = core && used ? Math.floor(core.remaining / used) : null;
  const time = (d) => d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const lines = [`This refresh sent ${fmt(sent)} ${sent === 1 ? "request" : "requests"}: ${["core", "graphql", "search"].filter((b) => totals[b]).map((b) => `${fmt(totals[b])} ${BUCKET_LABELS[b]}`).join(", ")}${totals.free ? ", plus the free rate-limit read" : ""}.`];
  if (fit != null) lines.push(`At ${fmt(used)} REST ${used === 1 ? "request" : "requests"} a refresh, about ${fmt(fit)} more ${fit === 1 ? "refresh fits" : "refreshes fit"} before the REST limit resets at ${time(core.resetAt)}.`);
  if (totals.search) lines.push(`Search allows 10 requests a minute without a token, apart from the hourly limit, so refreshing more than ${fmt(Math.max(1, Math.floor(10 / totals.search)))} ${Math.floor(10 / totals.search) === 1 ? "time" : "times"} a minute can hit it.`);
  if (totals.graphql) lines.push("GraphQL charges points by the size of each query, so the GraphQL bar above moves by points, not requests.");
  return `<h4>This refresh</h4>
    <table class="compare ledger"><thead><tr><th scope="col">Read</th><th scope="col">Limit</th><th scope="col">Requests</th></tr></thead>
    <tbody>${entries.map(([op, n]) => `<tr><th scope="row">${esc(OPERATION_LABELS[op] || op)}</th><td>${esc(BUCKET_LABELS[bucketOf(op)])}</td><td>${fmt(n)}</td></tr>`).join("")}</tbody></table>
    <p class="note">${esc(lines.join(" "))} A read retried with the other token counts twice.</p>`;
}

const OPERATION_LABELS = {
  profile: "Profile", events: "Activity stream", notifications: "Notifications", year: "Contribution year",
  pullRequests: "Pull request details", pullRequestCommits: "Last-commit times", authoredPullRequests: "Pull requests you opened", reviewedPullRequests: "Pull requests you reviewed",
  conversations: "Conversations", reviewRequests: "Review requests", rateLimit: "Rate-limit budget", contributionHistory: "Contribution history",
  ownedRepos: "Repository list", traffic: "Repository traffic", stargazers: "Star dates",
};

// With two tokens: how many items of a merged source only one of them returned.
function onlyNote(only, one, many) {
  if (!only) return "";
  const parts = SLOTS.filter((slot) => only[slot]).map((slot) => `${fmt(only[slot])} ${only[slot] === 1 ? one : many} came only from the ${slot} token`);
  return parts.length ? ` ${parts.join(", and ")}.` : " Both tokens returned the same set.";
}

const tokenExpiry = (slot) => I.tokenExpiryStatus(I.parseTokenExpiry(state.tokenMeta?.[slot]?.expires), new Date());

// Problems with the saved tokens: rejection, expiry, write-capable classic scopes, and a low rate-limit budget.
function tokenWarnings() {
  const out = [];
  const day = (d) => d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  for (const slot of savedSlots(state)) {
    const name = `${state.tokens[slot]} token`;
    const expiry = tokenExpiry(slot);
    if (expiry?.expired) out.push({ title: `The ${name} has expired`, detail: `GitHub reported ${day(expiry.at)}. Create a new token and save it in Data & access.` });
    else if (state.tokenMeta?.[slot]?.rejected) out.push({ title: `GitHub rejected the saved ${name}`, detail: `It may have expired or been revoked.${dual(state) ? " The other token answered where it could." : ""} Replace it in Data & access.` });
    else if (expiry?.soon) {
      const days = Math.max(1, Math.ceil(expiry.days));
      out.push({ title: `The ${name} expires in ${days} ${days === 1 ? "day" : "days"}`, detail: `On ${day(expiry.at)}. Create a replacement and save it in Data & access before then.` });
    }
  }
  const scopes = I.classicScopes(state.tokenMeta?.classic?.scopes);
  if (state.tokens.classic === "classic" && scopes?.write.length) {
    out.push({ title: "This classic token can make changes", detail: `Its ${scopes.write.join(", ")} ${scopes.write.length === 1 ? "scope allows" : "scopes allow"} writes. Activity Desk only reads, so ${dual(state) ? "a classic token with only the notifications scope" : "a read-only fine-grained token"} limits what a leaked copy could do.` });
  }
  for (const r of state.rateLimit?.resources || []) {
    if (r.low) out.push({ title: `${r.label} rate limit is low`, detail: `${fmt(r.remaining)} of ${fmt(r.limit)} left until ${r.resetAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.` });
  }
  return out;
}

const SLOT_TITLES = { "fine-grained": "Fine-grained token", classic: "Classic token" };
const SLOT_MISSING = {
  "fine-grained": "Not saved. A read-only fine-grained token limits what a leaked copy could do, and it can read everything here except unread notifications.",
  classic: "Not saved. Add one to read unread notifications, which GitHub serves only to classic tokens, and to reach organization or private data outside the fine-grained token's resource owner. For the inbox alone, select only the notifications scope when you create it.",
};

// One saved token: what GitHub reported about it and which sources it answered in this refresh.
function tokenSlot(slot) {
  const kind = state.tokens[slot];
  if (!kind) return `<section class="token-slot"><h4>${SLOT_TITLES[slot]} <span class="tag">Not saved</span></h4><p class="note">${SLOT_MISSING[slot]}</p></section>`;
  const meta = state.tokenMeta?.[slot] || {};
  const expiry = tokenExpiry(slot);
  const scopes = I.classicScopes(meta.scopes);
  const denied = Object.entries(meta.denied || {});
  const answered = Object.keys(OPERATION_LABELS).filter((op) => state.answered[op]?.has(slot)).map((op) => OPERATION_LABELS[op]);
  const rows = [
    ["Type", esc(kind)],
    ["Expires", expiry
      ? `${esc(expiry.at.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }))}${expiry.expired ? " (expired)" : ` (in ${fmt(Math.max(1, Math.ceil(expiry.days)))} days)`}`
      : "Not reported by GitHub"],
  ];
  if (slot === "classic") rows.push(["Scopes", scopes?.scopes.length ? esc(scopes.scopes.join(", ")) : "None reported"]);
  rows.push(["Answered this refresh", answered.length ? esc(answered.join(", ")) : "Nothing yet"]);
  const deniedList = denied.length
    ? `<ul class="cap">${denied.map(([op, sets]) => `<li><span class="no">✕</span><div><div>${esc(OPERATION_LABELS[op] || op)}</div><div class="d">GitHub accepts ${esc(sets.map((set) => set.join(" with ")).join(", or "))}.</div></div></li>`).join("")}</ul>`
    : "";
  // The only saved token is removed by signing out, which also clears the dashboard.
  const remove = savedSlots(state).length > 1 ? `<div class="actions"><button class="btn ghost danger" type="button" data-remove-token="${slot}">Remove this token</button></div>` : "";
  return `<section class="token-slot"><h4>${SLOT_TITLES[slot]} <span class="tag saved">Saved</span></h4>
    <dl class="kv">${rows.map(([t, d]) => `<dt>${esc(t)}</dt><dd>${d}</dd>`).join("")}</dl>
    ${deniedList}${remove}</section>`;
}

function tokenCard() {
  const anyDenied = savedSlots(state).some((slot) => Object.keys(state.tokenMeta?.[slot]?.denied || {}).length);
  const advice = state.public
    ? "No token is saved, so this is the public view. Recommended: a fine-grained token with read-only permissions for everything except the unread inbox, and a classic token with only the notifications scope beside it for the inbox."
    : state.tokens["fine-grained"]
    ? "Recommended setup for the fine-grained token: resource owner set to your account, access to all repositories you want covered, and read-only permissions only: <strong>Pull requests</strong>, <strong>Issues</strong>, and the account permission <strong>Events</strong>, plus <strong>Administration</strong> if you want repository traffic in Footprint. GitHub adds <strong>Metadata</strong> automatically."
    : "Recommended: add a fine-grained token with read-only permissions. A fine-grained token covers one resource owner and cannot read notifications, so keep the classic token beside it for the unread inbox.";
  const warnings = tokenWarnings().filter((w) => !/rate limit/.test(w.title));
  return `${warnings.map((w) => `<div class="callout">${esc(w.title)}. ${esc(w.detail)}</div>`).join("")}
    <div class="token-slots">${SLOTS.map(tokenSlot).join("")}</div>
    <p class="note">${advice}</p>
    <p class="note">${dual(state) ? "Both tokens belong to this account, which GitHub confirmed before the second was saved. Notifications use the classic token. Activity, pull requests you opened or reviewed, and conversations are read with each token and joined. The contribution year comes from whichever token hides fewer contributions. Every other source uses the fine-grained token and moves to the classic one only when GitHub denies the request. " : ""}${anyDenied ? "Denied requests list the permissions GitHub reported for them." : "No request was denied with a permission hint."} GraphQL sources report missing access as partial results in the list below instead. Activity Desk only sends allowlisted reads, whatever a token allows.</p>`;
}

function historyCard() {
  const h = state.savedHistory;
  const head = '<article class="card"><h3>Saved history</h3>';
  if (!h) return `${head}<p class="note">${esc(state.errors.history || "Saved history loads with repository traffic.")}</p></article>`;
  if (h.enabled === false) {
    return `${head}<p class="big">Off. Nothing is saved on this Mac.</p>
      <p class="note">Footprint shows only the 14 days GitHub keeps. Turning this on saves daily traffic, star and fork counts, and referring sites for repositories you own, encrypted, for up to 400 days. Turning it on refreshes so today's traffic is saved.</p>
      <button class="btn ghost" type="button" data-action="history-on">Turn on saved history</button></article>`;
  }
  const repos = Object.values(h.repos || {});
  const days = new Set();
  for (const r of repos) for (const series of [r.views, r.clones, r.counts]) for (const d of Object.keys(series || {})) days.add(d);
  const sorted = [...days].sort();
  return `${head}
    ${h.note ? `<div class="callout">${esc(h.note)}</div>` : ""}
    <dl class="kv">
      <dt>Repositories</dt><dd>${fmt(repos.length)}</dd>
      <dt>Days covered</dt><dd>${sorted.length ? `${fmt(sorted.length)} · ${esc(sorted[0])} to ${esc(sorted.at(-1))}` : "—"}</dd>
      <dt>File size</dt><dd>${h.bytes ? `${fmt(Math.ceil(h.bytes / 1024))} KB, encrypted` : "Not written yet"}</dd>
    </dl>
    <p class="note">Each refresh saves daily views and clones, star and fork counts, and referring sites for repositories you own, so Footprint can show more than GitHub's 14 days. It is encrypted with the same macOS Keychain-backed key as the token and kept for 400 days. Signing out keeps it.</p>
    <div class="actions"><button class="btn ghost" type="button" data-action="history-clear">Delete this account's history</button>
    <button class="btn ghost" type="button" data-action="history-off">Turn off and delete all</button></div>
  </article>`;
}

function rateCard() {
  const r = state.rateLimit;
  if (!r || !r.resources.length) {
    return `<article class="card"><h3>Rate-limit budget</h3><p class="note">GitHub did not return rate-limit details for this token.</p>${ledgerSection()}</article>`;
  }
  const time = (d) => d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return `<article class="card"><h3>Rate-limit budget</h3>
    <ul class="bars">${r.resources.map((x) => `<li class="bar"><span class="name">${esc(x.label)}</span><span class="track" aria-hidden="true"><span class="fill" style="width:${((x.share ?? 0) * 100).toFixed(1)}%"></span></span><span class="num">${esc(fmt(x.remaining))} / ${esc(fmt(x.limit))}</span></li>`).join("")}</ul>
    <p class="note">${r.resources.map((x) => `${esc(x.label)}: ${esc(fmt(x.used))} used, resets at ${esc(time(x.resetAt))}.`).join(" ")} Read at ${esc(time(r.at))}, after this refresh. Checking the budget does not count against it. GraphQL charges points by query size, so one GraphQL request can use more than one point.</p>
    ${ledgerSection()}
  </article>`;
}

function renderAll() {
  const c = computed();
  renderOverview(c);
  renderStream(c);
  renderInsights(c);
  renderSuggestions(c);
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

// ---------- notes ----------
// The main process stores notes. Edits update the list straight away and save after a short pause,
// and every pending save is sent before the window closes or the account signs out.
const NOTE_SAVE_DELAY = 450;
const noteTimers = new Map();
let noteInflight = 0;
let noteSheetFor = null; // id of the note whose text the editor holds
let noteCreating = false;
let renderedNotes = null; // the notes object the pane last drew

function notesFrom(result, userId) {
  if (!result?.ok) return { userId, failed: result?.error || "Saved notes could not be opened.", list: [] };
  return {
    userId, list: result.notes, selected: N.sortNotes(result.notes)[0]?.id || null, query: "", status: "",
    fileNote: result.note || "", colors: result.colors, limits: result.limits,
  };
}

const currentNote = () => state.notes?.list.find((n) => n.id === state.notes.selected) || null;
const editedLabel = (note) => `Edited ${new Date(note.updated).toLocaleString([], { dateStyle: "long", timeStyle: "short" })}`;
const lengthLabel = (note) => `${fmt(note.text.length)} of ${fmt(state.notes.limits.chars)} characters`;

function noteStatus(text, isError) {
  if (state.notes) state.notes.status = text;
  $("note-status").textContent = text;
  $("note-status").classList.toggle("error", Boolean(isError));
}

function noteAlert(text) {
  $("notes-alert").textContent = text || "";
  $("notes-alert").classList.toggle("hidden", !text);
}

function renderNotes() {
  const notes = state.notes;
  renderedNotes = notes;
  notesCaption();
  if (!notes) return;
  renderNoteList();
  renderNoteSheet();
}

function notesCaption() {
  const n = state.notes;
  $("notes-count").textContent = n?.list.length ? String(n.list.length) : "";
  if (state.streamSource !== "notes") return;
  $("stream-caption").textContent = !n ? "Notes have not loaded."
    : n.failed ? n.failed
    : `${fmt(n.list.length)} ${n.list.length === 1 ? "note" : "notes"} for @${state.user.login}, kept on this Mac and encrypted. Notes save as you type and stay after you sign out.${n.fileNote ? ` ${n.fileNote}` : ""}`;
}

function renderNoteList() {
  const notes = state.notes;
  notesCaption();
  const shown = N.filterNotes(N.sortNotes(notes.list), notes.query);
  const now = new Date();
  const item = (n) => {
    const title = N.noteTitle(n.text);
    const preview = N.notePreview(n.text) || (title ? "No additional text" : "");
    return `<button type="button" class="note-item c-${esc(n.color)}" data-note="${esc(n.id)}" aria-current="${n.id === notes.selected}">
      <span class="note-title">${esc(title || "New note")}</span>
      <span class="note-sub"><span class="note-date">${esc(N.noteDateLabel(n.updated, now))}</span>${esc(preview)}</span>
    </button>`;
  };
  const pinned = shown.filter((n) => n.pinned);
  const others = shown.filter((n) => !n.pinned);
  $("notes-list").innerHTML = !shown.length
    ? `<p class="note notes-none">${notes.failed ? "" : notes.list.length ? "No notes match your search." : "No notes yet."}</p>`
    : `${pinned.length ? `<div class="notes-group">Pinned</div>${pinned.map(item).join("")}` : ""}${others.length
      ? `${pinned.length ? '<div class="notes-group">Notes</div>' : ""}${others.map(item).join("")}` : ""}`;
}

function renderNoteSheet() {
  const notes = state.notes;
  const note = currentNote();
  $("note-new").disabled = Boolean(notes.failed) || noteCreating;
  $("notes-search").disabled = Boolean(notes.failed);
  if (notes.failed || !note) {
    noteSheetFor = null;
    $("note-sheet").classList.add("hidden");
    $("note-empty").classList.remove("hidden");
    $("note-empty").innerHTML = notes.failed
      ? `<div><p>${esc(notes.failed)}</p><button class="btn" type="button" data-note-action="retry">Try again</button></div>`
      : `<div><h3>${notes.list.length ? "No note selected" : "No notes yet"}</h3><p>Select <strong>New note</strong> to start one. Notes save as you type.</p></div>`;
    return;
  }
  $("note-empty").classList.add("hidden");
  $("note-sheet").className = `note-sheet c-${note.color}`;
  const text = $("note-text");
  if (noteSheetFor !== note.id) {
    text.value = note.text;
    text.maxLength = notes.limits.chars;
    noteSheetFor = note.id;
  }
  $("note-when").textContent = editedLabel(note);
  $("note-length").textContent = lengthLabel(note);
  $("note-pin").textContent = note.pinned ? "Unpin" : "Pin";
  $("note-pin").setAttribute("aria-pressed", String(note.pinned));
  $("note-colors").innerHTML = (notes.colors || []).map((c) => {
    const name = N.COLOR_NAMES[c] || c;
    return `<button type="button" class="swatch c-${esc(c)}" data-note-color="${esc(c)}" aria-pressed="${c === note.color}" aria-label="${esc(name)}" title="${esc(name)}"></button>`;
  }).join("");
  $("note-status").textContent = notes.status || "";
}

function focusNoteEditor() {
  const text = $("note-text");
  text.focus();
  text.setSelectionRange(text.value.length, text.value.length);
}

async function saveNoteText(id) {
  clearTimeout(noteTimers.get(id));
  noteTimers.delete(id);
  const notes = state.notes;
  const note = notes?.list.find((n) => n.id === id);
  if (!note) return;
  const text = note.text;
  noteInflight += 1;
  noteStatus("Saving…");
  let result;
  try {
    result = await window.desk.saveNote({ id, text });
  } catch {
    result = { ok: false, error: "The note could not be saved." };
  }
  noteInflight -= 1;
  if (state.notes !== notes) return;
  if (!result.ok) {
    noteStatus(`Not saved. ${result.error} Keep typing to try again.`, true);
    return;
  }
  if (note.text === text) note.updated = result.note.updated;
  if (!noteInflight && !noteTimers.size) noteStatus("Saved");
}

function scheduleNoteSave(id) {
  clearTimeout(noteTimers.get(id));
  noteTimers.set(id, setTimeout(() => saveNoteText(id), NOTE_SAVE_DELAY));
  noteStatus("Editing…");
}

function flushNotes() {
  return Promise.all([...noteTimers.keys()].map((id) => saveNoteText(id)));
}

// An empty note is dropped when you move away from it, as in Apple Notes.
function discardIfEmpty(note) {
  if (!note || note.text.trim()) return;
  clearTimeout(noteTimers.get(note.id));
  noteTimers.delete(note.id);
  state.notes.list = state.notes.list.filter((n) => n.id !== note.id);
  window.desk.deleteNote(note.id).catch(() => {});
}

function selectNote(id) {
  const notes = state.notes;
  if (!notes || notes.failed) return;
  const previous = currentNote();
  if (previous && previous.id !== id) discardIfEmpty(previous);
  notes.selected = id;
  noteAlert("");
  renderNotes();
  focusNoteEditor();
}

async function newNote() {
  const notes = state.notes;
  if (!notes || notes.failed || noteCreating) return;
  const current = currentNote();
  notes.query = "";
  $("notes-search").value = "";
  if (current && !current.text.trim()) {
    renderNotes();
    focusNoteEditor();
    return;
  }
  noteCreating = true;
  $("note-new").disabled = true;
  let result;
  try {
    result = await window.desk.saveNote({});
  } catch {
    result = { ok: false, error: "The note could not be created." };
  }
  noteCreating = false;
  if (state.notes !== notes) return;
  if (!result.ok) {
    noteAlert(result.error);
    renderNotes();
    return;
  }
  notes.list.push(result.note);
  notes.selected = result.note.id;
  noteAlert("");
  renderNotes();
  focusNoteEditor();
}

async function updateNote(patch) {
  const notes = state.notes;
  const note = currentNote();
  if (!note) return;
  let result;
  try {
    result = await window.desk.saveNote({ id: note.id, ...patch });
  } catch {
    result = { ok: false, error: "The note could not be saved." };
  }
  if (state.notes !== notes) return;
  if (!result.ok) return noteAlert(result.error);
  note.color = result.note.color;
  note.pinned = result.note.pinned;
  noteAlert("");
  renderNotes();
}

async function removeNote() {
  const notes = state.notes;
  const note = currentNote();
  if (!note || !window.confirm(`Delete “${N.noteTitle(note.text) || "New note"}”? This cannot be undone.`)) return;
  const pending = noteTimers.has(note.id);
  clearTimeout(noteTimers.get(note.id));
  noteTimers.delete(note.id);
  let result;
  try {
    result = await window.desk.deleteNote(note.id);
  } catch {
    result = { ok: false, error: "The note could not be deleted. Try again." };
  }
  if (state.notes !== notes) return;
  if (!result.ok) {
    if (pending) scheduleNoteSave(note.id);
    return noteAlert(result.error);
  }
  const order = N.filterNotes(N.sortNotes(notes.list), notes.query);
  const at = order.findIndex((n) => n.id === note.id);
  const next = order[at + 1] || order[at - 1] || null;
  notes.list = notes.list.filter((n) => n.id !== note.id);
  notes.selected = next ? next.id : null;
  noteAlert("");
  noteStatus("");
  renderNotes();
}

async function reloadNotes() {
  const account = state;
  if (!account.user) return;
  const result = await window.desk.notes().catch(() => null);
  if (account !== state) return;
  account.notes = notesFrom(result, account.user.id);
  renderAll();
  renderNotes();
}

function notesCard() {
  const n = state.notes;
  if (!n) return "";
  return `<article class="card"><h3>Notes on this Mac</h3>
    ${n.failed ? `<div class="callout">${esc(n.failed)}</div>` : `<dl class="kv">
      <dt>Notes for this account</dt><dd>${fmt(n.list.length)} of ${fmt(n.limits.notes)}</dd>
      <dt>Pinned</dt><dd>${fmt(n.list.filter((x) => x.pinned).length)}</dd>
    </dl>`}
    ${n.fileNote ? `<p class="insight-notice">${esc(n.fileNote)}</p>` : ""}
    <p class="note">Written in <strong>Stream → Notes</strong> and kept in the app's data folder, encrypted with the same Keychain-backed key as the token. Each account has its own notes. Signing out keeps them.</p>
  </article>`;
}

// ---------- events ----------
async function boot() {
  const button = $("signin-btn");
  button.disabled = true;
  try {
    const status = await window.desk.status();
    if (!status.ok) throw new Error(status.error);
    if (!status.signedIn && !status.publicLogin) return;
    state.tokens = status.tokens;
    state.public = !status.signedIn;
    signinMessage(state.public ? `Loading @${status.publicLogin}'s public activity…` : "Loading your saved account…", false);
    await refresh();
    signinMessage("", false);
  } catch (error) {
    $("forget-token").classList.remove("hidden");
    signinMessage(error.message, true);
  } finally {
    button.disabled = false;
  }
}

async function openTokenPage(kind, report) {
  try {
    const result = await window.desk.openTokenPage(kind);
    if (result.ok) return;
  } catch { /* The system browser could not be opened. */ }
  report("Could not open GitHub in your browser.", true);
}
$("create-token").addEventListener("click", () => openTokenPage("fine-grained", signinMessage));
$("create-classic-token").addEventListener("click", () => openTokenPage("classic", signinMessage));
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
    // The main process saves the token only after GitHub confirms it.
    const result = await window.desk.signIn(token);
    if (!result.ok) throw new Error(result.error);
    state.tokens = result.tokens;
    await refresh();
    signinMessage("", false);
    $("forget-token").classList.add("hidden");
  } catch (error) {
    if (error.status === 401) {
      try {
        const result = await window.desk.signOut();
        if (!result.ok) cleanupError = result.error;
      } catch {
        cleanupError = "Could not remove the rejected credential.";
      }
    }
    // Offer removal only while a token is still saved.
    const saved = await window.desk.status().catch(() => null);
    $("forget-token").classList.toggle("hidden", saved?.ok === true && !saved.signedIn);
    signinMessage(cleanupError ? `${error.message} ${cleanupError}` : error.message, true);
  } finally {
    button.disabled = Boolean(cleanupError);
    $("forget-token").disabled = false;
  }
});

// Opens the public view for a username, with no token.
$("public-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $("public-btn");
  if (button.disabled || $("signin-btn").disabled) return;
  button.disabled = true;
  $("signin-btn").disabled = true;
  signinMessage("Looking up the account on GitHub…", false);
  try {
    const result = await window.desk.browse($("public-login").value);
    if (!result.ok) throw new Error(result.error);
    state.public = true;
    await refresh();
    $("public-login").value = "";
    signinMessage("", false);
    $("forget-token").classList.add("hidden");
  } catch (error) {
    // A view that did not load is not kept for the next launch.
    if (state.public && !state.user) {
      state.public = false;
      await window.desk.signOut().catch(() => {});
    }
    signinMessage(error.message, true);
  } finally {
    button.disabled = false;
    $("signin-btn").disabled = false;
  }
});

// ---------- tokens in Data & access ----------
function tokenMessage(text, isError) {
  $("add-token-msg").textContent = text || "";
  $("add-token-msg").className = `msg${isError ? " error" : ""}`;
}
$("add-fine-grained").addEventListener("click", () => openTokenPage("fine-grained", tokenMessage));
$("add-classic").addEventListener("click", () => openTokenPage("classic", tokenMessage));
// Saves a token beside the one in use, or replaces the saved token of the same type.
$("add-token-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const account = state;
  const button = $("add-token-btn");
  if (button.disabled) return;
  if (state.busy) { tokenMessage("Wait for the refresh to finish, then save the token.", true); return; }
  button.disabled = true;
  const token = $("add-token").value;
  $("add-token").value = "";
  tokenMessage("Checking token with GitHub…", false);
  try {
    const result = await window.desk.signIn(token);
    if (account !== state) return;
    if (!result.ok) throw new Error(result.error);
    // A token ends the public view. The dashboard starts again for the account the token belongs to.
    if (account.public) {
      state = { ...initialState, tokens: result.tokens };
      openTexts.clear();
    } else state.tokens = result.tokens;
    tokenMessage(`${result.replaced ? "Replaced" : "Saved"} the ${result.tokens[result.slot]} token for @${result.login}.${result.dropped ? ` GitHub rejected the saved ${result.dropped} token, so it was removed.` : ""}`, false);
    await refresh();
  } catch (error) {
    if (account.public && state !== account && !state.user) {
      // The token was saved but its account did not load, so the sign-in screen takes over.
      showApp(false);
      $("forget-token").classList.remove("hidden");
      signinMessage(error.message, true);
    } else if (account === state) tokenMessage(error.message, true);
  } finally {
    button.disabled = false;
  }
});
$("token-check").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-remove-token]");
  if (!button || state.busy) return;
  const slot = button.dataset.removeToken;
  const kind = state.tokens[slot];
  if (!window.confirm(`Remove the saved ${kind} token from this Mac? It stays valid on GitHub until you revoke it there.`)) return;
  const account = state;
  button.disabled = true;
  try {
    const result = await window.desk.removeToken(slot);
    if (account !== state) return;
    if (!result.ok) throw new Error(result.error);
    if (!result.signedIn) { signOut(); return; }
    state.tokens = result.tokens;
    tokenMessage(`Removed the ${kind} token from this Mac.`, false);
    await refresh();
  } catch (error) {
    if (account !== state) return;
    button.disabled = false;
    tokenMessage(error.message, true);
  }
});

async function signOut() {
  if (signingOut) return;
  signingOut = true;
  // Pending note edits are saved while this account is still signed in.
  await flushNotes().catch(() => {});
  const wasPublic = state.public;
  showApp(false);
  state = { ...initialState };
  openTexts.clear();
  noteSheetFor = null;
  $("note-text").value = "";
  $("notes-search").value = "";
  noteAlert("");
  for (const id of ["me-name", "me-login", "initials", "summary", "kpis", "attention", "notes", "year-caption",
    "year-heat", "stream-caption", "chips", "repo-filter", "minor-count", "stream", "insights", "meta",
    "fresh-badge", "refreshed", "conversation-count", "notes-count", "notes-list", "note-empty", "note-status", "suggestions", "suggestions-caption", "suggestion-count", "token-check", "add-token-msg"]) $(id).textContent = "";
  $("add-token").value = "";
  $("search").value = "";
  $("hide-minor").checked = true;
  setBusy("");
  showTab("overview");
  $("signin-btn").disabled = true;
  $("forget-token").disabled = true;
  signinMessage(wasPublic ? "Closing the public view…" : "Removing the saved credential…", false);
  try {
    const result = await window.desk.signOut();
    if (!result.ok) throw new Error(result.error);
    $("forget-token").classList.add("hidden");
    $("signin-btn").disabled = false;
    signinMessage(wasPublic ? "Closed the public view. The saved username was removed from this Mac." : "Signed out. Saved tokens were removed from this Mac.", false);
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
async function historyAction(event) {
  const button = event.target.closest("[data-action^=\"history-\"]");
  if (!button || state.busy) return;
  const action = button.dataset.action;
  const prompts = {
    "history-clear": "Delete the saved history for this account? The next refresh starts saving again.",
    "history-off": "Turn off saved history and delete it for every account on this Mac?",
  };
  if (prompts[action] && !window.confirm(prompts[action])) return;
  button.disabled = true;
  const account = state;
  try {
    const result = action === "history-clear" ? await window.desk.clearHistory()
      : await window.desk.setHistory(action === "history-on");
    if (!result.ok) throw new Error(result.error);
    const saved = await window.desk.history();
    if (account !== state) return;
    state.savedHistory = saved.ok ? saved : null;
    delete state.errors.history;
  } catch (error) {
    if (account !== state) return;
    state.errors.history = error.message;
    renderAll();
    return;
  }
  renderAll();
  // Turning history on records today's traffic straight away.
  if (action === "history-on") refresh();
}
$("meta").addEventListener("click", historyAction);
// What to change: GitHub's token forms, and the token field above the cards.
$("meta").addEventListener("click", (event) => {
  const page = event.target.closest("[data-token-page]");
  if (page) {
    openTokenPage(page.dataset.tokenPage, tokenMessage);
    return;
  }
  const focus = event.target.closest("[data-focus]");
  if (focus) {
    $("add-token").scrollIntoView({ block: "center" });
    $("add-token").focus();
  }
});
$("insights").addEventListener("click", historyAction);
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
// A finding and the suggestion that acts on it link to each other.
function jumpTo(selector) {
  const target = document.querySelector(selector);
  if (!target) return;
  const folded = target.closest("details");
  if (folded) folded.open = true;
  target.scrollIntoView({ block: "start" });
  target.focus({ preventScroll: true });
}
$("insights").addEventListener("click", (event) => {
  const button = event.target.closest("[data-suggestion]");
  if (!button) return;
  showTab("suggestions");
  jumpTo(`#suggestion-${CSS.escape(button.dataset.suggestion)}`);
});
// Pull requests and issues named in Overview and Stream open on github.com. Suggestions has its own
// handler, which reports a failure beside its cards.
$("content").addEventListener("click", async (event) => {
  const page = event.target.closest("[data-open-repo]");
  if (!page || page.closest("#suggestions")) return;
  const number = page.dataset.openNumber ? Number(page.dataset.openNumber) : null;
  let opened = false;
  try {
    opened = (await window.desk.openGitHub(page.dataset.openRepo, number)).ok;
  } catch { /* The system browser could not be opened. */ }
  $("open-status").textContent = opened ? "" : `Could not open ${page.textContent} in your browser.`;
});
$("suggestions").addEventListener("change", (event) => {
  if (event.target.id !== "suggest-scope") return;
  state.suggestScope = event.target.value;
  renderAll();
  $("suggest-scope")?.focus();
});
$("suggestions").addEventListener("click", async (event) => {
  const page = event.target.closest("[data-open-repo]");
  if (page) {
    const number = page.dataset.openNumber ? Number(page.dataset.openNumber) : null;
    let opened = false;
    try {
      opened = (await window.desk.openGitHub(page.dataset.openRepo, number)).ok;
    } catch { /* The system browser could not be opened. */ }
    const status = $("reading-status");
    if (status) status.textContent = opened ? "" : `Could not open ${page.textContent} in your browser.`;
    return;
  }
  const card = event.target.closest("[data-card]");
  if (card) {
    await setCardState(card.dataset.card, card.dataset.state, Number(card.dataset.days) || 0);
    return;
  }
  const finding = event.target.closest("[data-finding]");
  if (finding) {
    state.insight = "patterns";
    renderInsights(computed());
    showTab("insights");
    jumpTo(`#insights li[data-finding="${CSS.escape(finding.dataset.finding)}"]`);
    return;
  }
  const button = event.target.closest("[data-reading]");
  if (!button) return;
  const id = button.dataset.reading;
  let ok = false;
  try {
    ok = (await window.desk.openReading(id)).ok;
  } catch { /* The system browser could not be opened. */ }
  const status = $("reading-status");
  if (status) status.textContent = ok ? "" : `Could not open ${I.READING[id]?.title || "that source"} in your browser.`;
});
$("chips").addEventListener("click", (event) => {
  const chip = event.target.closest(".chip");
  if (!chip) return;
  state[state.streamSource === "conversations" ? "conversationFilter" : "filter"] = chip.dataset.filter;
  renderStream(computed());
});
$("stream-source").addEventListener("click", (event) => {
  const button = event.target.closest("[data-stream]");
  if (!button || state.streamSource === button.dataset.stream) return;
  if (state.streamSource === "notes") flushNotes();
  state.streamSource = button.dataset.stream;
  renderStream(computed());
  if (state.streamSource === "notes") renderNotes();
  $("content").scrollTop = 0;
});
$("notes-list").addEventListener("click", (event) => {
  const item = event.target.closest("[data-note]");
  if (item) selectNote(item.dataset.note);
});
$("note-new").addEventListener("click", newNote);
$("note-pin").addEventListener("click", () => {
  const note = currentNote();
  if (note) updateNote({ pinned: !note.pinned });
});
$("note-colors").addEventListener("click", (event) => {
  const swatch = event.target.closest("[data-note-color]");
  if (swatch) updateNote({ color: swatch.dataset.noteColor });
});
$("note-delete").addEventListener("click", removeNote);
$("note-empty").addEventListener("click", (event) => {
  if (event.target.closest("[data-note-action=\"retry\"]")) reloadNotes();
});
$("notes-search").addEventListener("input", (event) => {
  if (!state.notes) return;
  state.notes.query = event.target.value;
  renderNoteList();
});
$("note-text").addEventListener("input", (event) => {
  const note = currentNote();
  if (!note) return;
  note.text = event.target.value;
  note.updated = new Date().toISOString();
  $("note-when").textContent = editedLabel(note);
  $("note-length").textContent = lengthLabel(note);
  renderNoteList();
  scheduleNoteSave(note.id);
});
$("note-text").addEventListener("blur", () => { flushNotes(); });
window.addEventListener("beforeunload", () => { flushNotes(); });
// toggle does not bubble, so it is caught on the way down.
$("stream").addEventListener("toggle", (event) => {
  const key = event.target.dataset?.textKey;
  if (!key) return;
  if (event.target.open) openTexts.add(key); else openTexts.delete(key);
}, true);
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
  const newest = newestActivity(state);
  if (!newest) return;
  state.lastSeen = newest;
  localStorage.setItem(seenKey(), state.lastSeen);
  renderAll();
});
document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "r") {
    event.preventDefault();
    if (!state.busy && !$("app").classList.contains("hidden")) $("refresh").click();
  }
  // New note while Stream → Notes is showing.
  if ((event.metaKey || event.ctrlKey) && event.key === "n" && !$("notes-pane").closest(".hidden")) {
    event.preventDefault();
    newNote();
  }
  const tabs = ["overview", "stream", "insights", "suggestions", "meta"];
  if ((event.metaKey || event.ctrlKey) && /^[1-5]$/.test(event.key)) showTab(tabs[Number(event.key) - 1]);
});

boot().catch((error) => signinMessage(error.message, true));
})();
