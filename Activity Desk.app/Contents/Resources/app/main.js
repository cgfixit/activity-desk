"use strict";

const { app, BrowserWindow, ipcMain, safeStorage, shell, Tray, Menu, nativeImage } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const TOKEN_PAGE = "https://github.com/settings/personal-access-tokens/new?name=Activity%20Desk";
const API = "https://api.github.com";

const DOCUMENT = pathToFileURL(path.join(__dirname, "index.html")).href;
const singleInstance = app.requestSingleInstanceLock();

let mainWindow = null;
let tray = null;

let credentialQueue = Promise.resolve();
let session = new AbortController();

function withCredentials(operation) {
  const pending = credentialQueue.then(operation);
  credentialQueue = pending.catch(() => {});
  return pending;
}

function readIfPresent(file) {
  try {
    return fs.readFileSync(file);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

// Encrypts with safeStorage and replaces the target file in one rename.
async function writeEncrypted(name, text) {
  const encrypted = await safeStorage.encryptStringAsync(text);
  const profile = app.getPath("userData");
  const staging = fs.mkdtempSync(path.join(profile, "credential-"));
  try {
    const file = path.join(staging, "data");
    fs.writeFileSync(file, encrypted, { mode: 0o600 });
    fs.renameSync(file, path.join(profile, name));
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

function writeToken(token) {
  return writeEncrypted("github-token.enc", token);
}

async function readToken() {
  const profile = app.getPath("userData");
  const legacy = path.join(profile, "github-token");
  const encrypted = readIfPresent(path.join(profile, "github-token.enc"));
  if (encrypted) {
    const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(encrypted);
    if (shouldReEncrypt) await writeToken(result);
    fs.rmSync(legacy, { force: true });
    return result;
  }
  const token = readIfPresent(legacy)?.toString("utf8").trim();
  if (!token) return "";
  await writeToken(token);
  fs.rmSync(legacy, { force: true });
  return token;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 640,
    title: "Activity Desk",
    backgroundColor: "#0d1014",
    autoHideMenuBar: true,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    trafficLightPosition: { x: 14, y: 16 },
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  mainWindow.loadFile(path.join(__dirname, "index.html"));
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function createTray() {
  const image = nativeImage.createFromBuffer(
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAACXBIWXMAAAsTAAALEwEAmpwYAAAA" +
        "IklEQVR4nO3OMQEAMAgAsA/1/zYjC0gJbG1t7QE2sQdYwQJWAAB4kQdYwQJWAAAAAElFTkSuQmCC",
      "base64"
    )
  );
  tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image);
  tray.setToolTip("Activity Desk");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Show Activity Desk", click: () => focusWindow() },
    { type: "separator" },
    { label: "Quit", click: () => app.quit() },
  ]));
  tray.on("click", () => focusWindow());
}

function focusWindow() {
  if (!mainWindow) createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function tokenKind(token) {
  if (!token) return null;
  if (token.startsWith("github_pat_")) return "fine-grained";
  if (token.startsWith("ghp_")) return "classic";
  if (token.startsWith("gho_")) return "OAuth";
  return "GitHub";
}

function handle(channel, operation) {
  ipcMain.handle(`desk:${channel}`, (event, ...args) => {
    const frame = event.senderFrame;
    if (event.sender !== mainWindow?.webContents || !frame ||
        frame !== event.sender.mainFrame || frame.url.split("#", 1)[0] !== DOCUMENT) {
      return { ok: false, status: 403, error: "Blocked IPC sender." };
    }
    return operation(...args);
  });
}

function resetSession() {
  session.abort();
  session = new AbortController();
  sessionUser = null;
}

// ---------- Saved history ----------
// Daily repository traffic, star and fork counts, and referrer sightings, kept so trends can outlast
// GitHub's 14-day traffic window. Only the main process writes it, and only from GitHub responses it
// fetched itself for the signed-in account's own repositories. It is encrypted like the token.
const HISTORY_FILE = "history.enc";
const HISTORY_ON = "history-on"; // present only after the user turned saved history on
const HISTORY_VERSION = 1;
const HISTORY_DAYS = 400;
const HISTORY_REPOS = 50;
const HISTORY_REFERRERS = 50;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const REFERRER = /^[A-Za-z0-9.-]{1,100}$/;

let sessionUser = null; // { id, login } from the profile read in this session
let history = null;
let historyNote = "";
let historyQueue = Promise.resolve();
let historyTimer = null;
let historyDirty = false;

function withHistory(operation) {
  const pending = historyQueue.then(operation);
  historyQueue = pending.catch(() => {});
  return pending;
}

const count = (n) => Number.isSafeInteger(n) && n >= 0;
const today = () => new Date().toISOString().slice(0, 10);

async function loadHistory() {
  if (history) return history;
  history = { version: HISTORY_VERSION, accounts: {} };
  const encrypted = readIfPresent(path.join(app.getPath("userData"), HISTORY_FILE));
  if (!encrypted) return history;
  try {
    const { result } = await safeStorage.decryptStringAsync(encrypted);
    const parsed = JSON.parse(result);
    if (parsed?.version === HISTORY_VERSION && parsed.accounts && typeof parsed.accounts === "object") history = parsed;
    else historyNote = "Saved history used an unknown format, so it started again.";
  } catch {
    historyNote = "Saved history could not be decrypted, so it started again.";
  }
  return history;
}

function accountHistory(store, user) {
  const key = String(user.id);
  const account = store.accounts[key] || (store.accounts[key] = { login: user.login, repos: {} });
  account.login = user.login;
  return account;
}

function repoHistory(account, repo) {
  const entry = account.repos[repo] || (account.repos[repo] = { views: {}, clones: {}, counts: {}, referrers: {}, seen: "" });
  entry.seen = today();
  return entry;
}

function pruneHistory(store) {
  const oldest = new Date(Date.now() - HISTORY_DAYS * 864e5).toISOString().slice(0, 10);
  for (const account of Object.values(store.accounts)) {
    for (const [repo, entry] of Object.entries(account.repos)) {
      if (!entry.seen || entry.seen < oldest) { delete account.repos[repo]; continue; }
      for (const series of [entry.views, entry.clones, entry.counts]) {
        for (const day of Object.keys(series)) if (day < oldest) delete series[day];
      }
      const refs = Object.entries(entry.referrers).sort((a, b) => b[1].last.localeCompare(a[1].last));
      for (const [name] of refs.slice(HISTORY_REFERRERS)) delete entry.referrers[name];
    }
    const repos = Object.entries(account.repos).sort((a, b) => b[1].seen.localeCompare(a[1].seen));
    for (const [repo] of repos.slice(HISTORY_REPOS)) delete account.repos[repo];
  }
}

async function saveHistory() {
  clearTimeout(historyTimer);
  if (!historyDirty || !history) return;
  historyDirty = false;
  pruneHistory(history);
  await writeEncrypted(HISTORY_FILE, JSON.stringify(history));
}

function scheduleHistorySave() {
  historyDirty = true;
  clearTimeout(historyTimer);
  historyTimer = setTimeout(() => withHistory(saveHistory).catch(() => {}), 400);
}

// Saved history is opt-in. Nothing is recorded until the user turns it on.
const historyEnabled = () => readIfPresent(path.join(app.getPath("userData"), HISTORY_ON)) !== null;

// Records a traffic or repository-list response for the account that requested it.
function recordHistory(user, operation, args, data) {
  return withHistory(async () => {
    if (!historyEnabled()) return;
    const store = await loadHistory();
    const account = accountHistory(store, user);
    if (operation === "ownedRepos") {
      const day = today();
      for (const repo of data) {
        if (!repo.full_name.toLowerCase().startsWith(`${user.login.toLowerCase()}/`)) continue;
        if (count(repo.stargazers_count) && count(repo.forks_count)) repoHistory(account, repo.full_name).counts[day] = [repo.stargazers_count, repo.forks_count];
      }
    } else if (operation === "traffic") {
      const entry = repoHistory(account, args.repo);
      if (args.kind === "referrers") {
        const day = today();
        for (const r of Array.isArray(data) ? data : []) {
          if (typeof r?.referrer !== "string" || !REFERRER.test(r.referrer) || !count(r.count)) continue;
          const seen = entry.referrers[r.referrer] || (entry.referrers[r.referrer] = { first: day, last: day, peak: 0 });
          seen.last = day;
          seen.peak = Math.max(seen.peak, r.count);
        }
      } else {
        const series = entry[args.kind];
        for (const d of Array.isArray(data?.[args.kind]) ? data[args.kind] : []) {
          const day = typeof d?.timestamp === "string" ? d.timestamp.slice(0, 10) : "";
          if (DAY.test(day) && count(d.count) && count(d.uniques)) series[day] = [d.count, d.uniques];
        }
      }
    }
    scheduleHistorySave();
  });
}

handle("history", () => withHistory(async () => {
  if (!sessionUser) return { ok: false, error: "Sign in first." };
  try {
    const store = await loadHistory();
    await saveHistory();
    const account = store.accounts[String(sessionUser.id)];
    const file = readIfPresent(path.join(app.getPath("userData"), HISTORY_FILE));
    return { ok: true, enabled: historyEnabled(), repos: account ? account.repos : {}, bytes: file ? file.length : 0, note: historyNote };
  } catch {
    return { ok: false, error: "Saved history could not be read or saved." };
  }
}));

// Turning saved history on starts recording. Turning it off deletes it for every account on this Mac.
handle("history-setting", (enabled) => withHistory(async () => {
  if (typeof enabled !== "boolean") return { ok: false, error: "Invalid setting." };
  const profile = app.getPath("userData");
  try {
    if (enabled) {
      fs.writeFileSync(path.join(profile, HISTORY_ON), "", { mode: 0o600 });
    } else {
      fs.rmSync(path.join(profile, HISTORY_ON), { force: true });
      clearTimeout(historyTimer);
      historyDirty = false;
      history = { version: HISTORY_VERSION, accounts: {} };
      historyNote = "";
      fs.rmSync(path.join(profile, HISTORY_FILE), { force: true });
    }
    return { ok: true, enabled: historyEnabled() };
  } catch {
    return { ok: false, error: "The saved history setting could not be changed." };
  }
}));

handle("clear-history", () => withHistory(async () => {
  if (!sessionUser) return { ok: false, error: "Sign in first." };
  try {
    const store = await loadHistory();
    delete store.accounts[String(sessionUser.id)];
    historyDirty = false;
    clearTimeout(historyTimer);
    if (Object.keys(store.accounts).length) await writeEncrypted(HISTORY_FILE, JSON.stringify(store));
    else fs.rmSync(path.join(app.getPath("userData"), HISTORY_FILE), { force: true });
    historyNote = "";
    return { ok: true };
  } catch {
    return { ok: false, error: "Saved history could not be removed. Try again." };
  }
}));

handle("status", () => withCredentials(async () => {
  try {
    const token = await readToken();
    return { ok: true, signedIn: Boolean(token), kind: tokenKind(token) };
  } catch {
    return { ok: false, error: "Could not open the saved credential or finish its migration." };
  }
}));

handle("sign-in", (token) => withCredentials(async () => {
  const value = typeof token === "string" ? token.trim() : "";
  if (value.length < 20 || !/^[!-~]+$/.test(value)) {
    return { ok: false, error: "That does not look like a GitHub token." };
  }
  try {
    fs.mkdirSync(app.getPath("userData"), { recursive: true });
    await writeToken(value);
    resetSession();
    fs.rmSync(path.join(app.getPath("userData"), "github-token"), { force: true });
    return { ok: true, kind: tokenKind(value) };
  } catch {
    return { ok: false, error: "Could not save the credential securely or remove the legacy copy." };
  }
}));

handle("sign-out", () => withCredentials(() => {
  resetSession();
  try {
    const profile = app.getPath("userData");
    fs.rmSync(path.join(profile, "github-token"), { force: true });
    fs.rmSync(path.join(profile, "github-token.enc"), { force: true });
    return { ok: true };
  } catch {
    return { ok: false, error: "Could not remove the saved credential. Try signing out again." };
  }
}));

handle("open-token-page", async () => {
  await shell.openExternal(TOKEN_PAGE);
  return { ok: true };
});

const YEAR_QUERY = `query {
  viewer {
    createdAt
    followers { totalCount }
    repositories(ownerAffiliations: OWNER) { totalCount }
    contributionsCollection {
      contributionYears
      totalCommitContributions totalIssueContributions totalPullRequestContributions
      totalPullRequestReviewContributions restrictedContributionsCount totalRepositoriesWithContributedCommits
      contributionCalendar { totalContributions weeks { contributionDays { date contributionCount } } }
      commitContributionsByRepository(maxRepositories: 10) { repository { nameWithOwner isPrivate } contributions { totalCount } }
    }
  }
}`;

const REPO_NAME = /^[A-Za-z0-9_.-]{1,100}$/;
const PR_FIELDS = `title state merged isDraft createdAt mergedAt additions deletions headRefName
  author { login } mergedBy { login }
  reviews(first: 10) { totalCount nodes { submittedAt author { __typename login } } }`;

// Recent comments on issues and pull requests that involve the user, open or closed.
// Search finds the threads; each thread's latest comments, reviews, and review comments are read live.
const COMMENT_FIELDS = "author { __typename login } bodyText createdAt";
const CONVERSATIONS_QUERY = `query ($q: String!) {
  search(query: $q, type: ISSUE, first: 25) {
    issueCount
    nodes {
      __typename
      ... on Issue { number title issueState: state updatedAt author { login } repository { nameWithOwner }
        comments(last: 10) { totalCount nodes { ${COMMENT_FIELDS} } } }
      ... on PullRequest { number title prState: state merged updatedAt author { login } repository { nameWithOwner }
        comments(last: 10) { totalCount nodes { ${COMMENT_FIELDS} } }
        reviews(last: 10) { totalCount nodes { ${COMMENT_FIELDS} state
          comments(first: 5) { totalCount nodes { ${COMMENT_FIELDS} path } } } } }
    }
  }
}`;
const CONVERSATION_DAYS = 30;

// Pull requests the user authored in a recent window, found by search instead of the Events feed.
const AUTHORED_DAYS = 90;
const AUTHORED_QUERY = `query ($q: String!, $after: String) {
  search(query: $q, type: ISSUE, first: 100, after: $after) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes { __typename ... on PullRequest { number repository { nameWithOwner } ${PR_FIELDS} } }
  }
}`;
const CURSOR = /^[A-Za-z0-9+/=_:-]{1,256}$/;
const LOGIN = /^[A-Za-z0-9-]{1,39}$/;
const RATE_RESOURCES = ["core", "graphql"];

// Calendar years of contributions, batched into one GraphQL request with an alias per year.
// GitHub limits a contributionsCollection range to one year, so each alias covers one calendar year.
const HISTORY_YEARS_MAX = 20;
const HISTORY_FIELDS = `totalCommitContributions totalIssueContributions totalPullRequestContributions
  totalPullRequestReviewContributions restrictedContributionsCount
  contributionCalendar { totalContributions weeks { contributionDays { date contributionCount } } }`;
const TRAFFIC_ROUTES = { views: "views?per=day", clones: "clones?per=day", referrers: "popular/referrers" };

function validRepo(value) {
  if (typeof value !== "string") return false;
  const [owner, repo, extra] = value.split("/");
  // Names made only of dots would turn into path segments that leave /repos/{owner}/{repo}.
  return extra === undefined && [owner, repo].every((part) => part && REPO_NAME.test(part) && !/^\.+$/.test(part));
}

function githubRequest(operation, args) {
  switch (operation) {
    case "conversations": {
      const login = args?.login;
      if (typeof login !== "string" || !/^[A-Za-z0-9-]{1,39}$/.test(login)) break;
      const since = new Date(Date.now() - CONVERSATION_DAYS * 864e5).toISOString().slice(0, 10);
      return { route: "/graphql", body: { query: CONVERSATIONS_QUERY, variables: { q: `involves:${login} updated:>=${since} sort:updated-desc` } } };
    }
    case "authoredPullRequests": {
      const { login, after } = args || {};
      if (typeof login !== "string" || !LOGIN.test(login)) break;
      if (after !== undefined && (typeof after !== "string" || !CURSOR.test(after))) break;
      const since = new Date(Date.now() - AUTHORED_DAYS * 864e5).toISOString().slice(0, 10);
      return { route: "/graphql", body: { query: AUTHORED_QUERY, variables: { q: `author:${login} is:pr created:>=${since} sort:created-desc`, after: after ?? null } } };
    }
    case "rateLimit": return { route: "/rate_limit" };
    case "contributionHistory": {
      const current = new Date().getUTCFullYear();
      const years = args?.years;
      if (!Array.isArray(years) || years.length < 1 || years.length > HISTORY_YEARS_MAX ||
          new Set(years).size !== years.length ||
          !years.every((y) => Number.isInteger(y) && y >= 2008 && y <= current)) break;
      const declarations = [];
      const fields = [];
      const variables = {};
      for (const y of years) {
        declarations.push(`$f${y}: DateTime!, $t${y}: DateTime!`);
        fields.push(`y${y}: contributionsCollection(from: $f${y}, to: $t${y}) { ${HISTORY_FIELDS} }`);
        variables[`f${y}`] = `${y}-01-01T00:00:00Z`;
        variables[`t${y}`] = y === current ? new Date().toISOString() : `${y}-12-31T23:59:59Z`;
      }
      return { route: "/graphql", body: { query: `query (${declarations.join(", ")}) { viewer { ${fields.join("\n")} } }`, variables } };
    }
    case "ownedRepos": return { route: "/user/repos?affiliation=owner&sort=pushed&per_page=100" };
    case "traffic": {
      const { repo, kind } = args || {};
      if (!validRepo(repo) || typeof kind !== "string" || !Object.hasOwn(TRAFFIC_ROUTES, kind)) break;
      return { route: `/repos/${repo}/traffic/${TRAFFIC_ROUTES[kind]}` };
    }
    case "stargazers": {
      if (!validRepo(args?.repo)) break;
      return { route: `/repos/${args.repo}/stargazers?per_page=100`, accept: "application/vnd.github.star+json" };
    }
    case "profile": return { route: "/user" };
    case "notifications": return { route: "/notifications?all=false&per_page=50" };
    case "year": return { route: "/graphql", body: { query: YEAR_QUERY } };
    case "events": {
      const { login, page } = args || {};
      if (typeof login === "string" && /^[A-Za-z0-9-]{1,39}$/.test(login) &&
          Number.isInteger(page) && page >= 1 && page <= 3) {
        return { route: `/users/${login}/events?per_page=100&page=${page}` };
      }
      break;
    }
    case "pullRequests": {
      if (!Array.isArray(args) || args.length === 0 || args.length > 40) break;
      const declarations = [];
      const fields = [];
      const variables = {};
      for (const [i, ref] of args.entries()) {
        if (typeof ref?.repo !== "string") return null;
        const [owner, repo, extra] = ref.repo.split("/");
        if (extra !== undefined || !REPO_NAME.test(owner) || !repo || !REPO_NAME.test(repo) ||
            !Number.isInteger(ref.number) || ref.number < 1 || ref.number > 2147483647) return null;
        declarations.push(`$o${i}: String!, $r${i}: String!, $n${i}: Int!`);
        fields.push(`p${i}: repository(owner: $o${i}, name: $r${i}) { pullRequest(number: $n${i}) { ${PR_FIELDS} } }`);
        Object.assign(variables, { [`o${i}`]: owner, [`r${i}`]: repo, [`n${i}`]: ref.number });
      }
      return { route: "/graphql", body: { query: `query (${declarations.join(", ")}) { ${fields.join("\n")} }`, variables } };
    }
  }
  return null;
}

handle("github", async (operation, args) => {
  const request = githubRequest(operation, args);
  if (!request) return { ok: false, status: 400, error: "Unsupported GitHub read operation." };

  let credential;
  try {
    credential = await withCredentials(async () => ({ token: await readToken(), signal: session.signal }));
  } catch {
    return { ok: false, status: 0, error: "Could not open the saved credential." };
  }
  if (!credential.token) return { ok: false, status: 401, error: "Sign in first." };

  const headers = {
    Accept: request.accept || "application/vnd.github+json",
    Authorization: `Bearer ${credential.token}`,
    "User-Agent": "ActivityDesk",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (request.body) headers["Content-Type"] = "application/json";
  try {
    const response = await fetch(API + request.route, {
      method: request.body ? "POST" : "GET",
      headers,
      body: request.body ? JSON.stringify(request.body) : undefined,
      redirect: "error",
      signal: AbortSignal.any([credential.signal, AbortSignal.timeout(30000)]),
    });
    // Token metadata GitHub reports on responses: the permissions an endpoint accepts for
    // fine-grained tokens, the granted scopes of a classic token, and the token's expiry when sent.
    const tokenInfo = {
      accepted: response.headers.get("x-accepted-github-permissions"),
      scopes: response.headers.get("x-oauth-scopes"),
      expires: response.headers.get("github-authentication-token-expiration"),
    };
    if (!response.ok) {
      await response.body?.cancel();
      return { ok: false, status: response.status, remaining: response.headers.get("x-ratelimit-remaining"), token: tokenInfo };
    }
    let body = await response.text();
    if (operation === "profile") {
      const { id, login, name } = JSON.parse(body);
      body = JSON.stringify({ id, login, name });
      if (!credential.signal.aborted && Number.isSafeInteger(id) && typeof login === "string" && LOGIN.test(login)) sessionUser = { id, login };
    }
    if (operation === "ownedRepos") {
      const repos = JSON.parse(body);
      const kept = (Array.isArray(repos) ? repos : []).filter((r) => validRepo(r?.full_name)).map((r) => ({
        full_name: r.full_name, private: Boolean(r.private), fork: Boolean(r.fork), archived: Boolean(r.archived),
        stargazers_count: r.stargazers_count, forks_count: r.forks_count, pushed_at: r.pushed_at,
      }));
      body = JSON.stringify(kept);
    }
    if (operation === "stargazers") {
      const stars = JSON.parse(body);
      body = JSON.stringify((Array.isArray(stars) ? stars : []).map((s) => s?.starred_at).filter((t) => typeof t === "string"));
    }
    const user = sessionUser;
    if (user && !credential.signal.aborted && (operation === "ownedRepos" ||
        (operation === "traffic" && args.repo.toLowerCase().startsWith(`${user.login.toLowerCase()}/`)))) {
      await recordHistory(user, operation, args, JSON.parse(body)).catch(() => {});
    }
    if (operation === "rateLimit") {
      const resources = JSON.parse(body)?.resources || {};
      const kept = {};
      for (const name of RATE_RESOURCES) {
        const r = resources[name];
        if (r && [r.limit, r.remaining, r.used, r.reset].every(Number.isFinite)) {
          kept[name] = { limit: r.limit, remaining: r.remaining, used: r.used, reset: r.reset };
        }
      }
      body = JSON.stringify({ resources: kept });
    }
    return {
      ok: true,
      status: response.status,
      body,
      link: response.headers.get("link"),
      remaining: response.headers.get("x-ratelimit-remaining"),
      token: tokenInfo,
    };
  } catch {
    return { ok: false, status: 0, error: "GitHub request did not complete." };
  }
});

if (!singleInstance) app.quit();
app.on("second-instance", () => { if (app.isReady()) focusWindow(); });

app.whenReady().then(() => {
  if (!singleInstance) return;
  createWindow();
  if (process.platform === "darwin" || process.platform === "linux") {
    try {
      createTray();
    } catch {
      tray = null;
    }
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (singleInstance && BrowserWindow.getAllWindows().length === 0) createWindow();
});
