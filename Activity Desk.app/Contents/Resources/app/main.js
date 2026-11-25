"use strict";

const { app, BrowserWindow, ipcMain, safeStorage, shell, Tray, Menu, nativeImage } = require("electron");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL, URL: NodeURL } = require("node:url");

const TOKEN_PAGES = {
  "fine-grained": "https://github.com/settings/personal-access-tokens/new?name=Activity%20Desk",
  classic: "https://github.com/settings/tokens/new?description=Activity%20Desk&scopes=notifications",
};
const API = "https://api.github.com";
// Suggestions cite sources from this catalogue. The renderer asks for a link by id only.
const { READING } = require(path.join(__dirname, "insights.js"));
const READING_HOSTS = new Set(["docs.github.com", "github.com", "google.github.io", "chaoss.community", "doi.org", "dora.dev"]);

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

// ---------- Saved tokens ----------
// Up to two tokens for one GitHub account, one per slot: a fine-grained personal access token and a
// classic (scope-based) token. They are kept together in one encrypted file, and a token is only saved
// after GitHub confirms it and, when the other slot is in use, that both belong to the same account.
const TOKENS_FILE = "github-tokens.enc";
const TOKENS_VERSION = 1;
const SLOTS = ["fine-grained", "classic"];
const TOKEN = /^[!-~]{20,512}$/;
const slotOf = (token) => (token.startsWith("github_pat_") ? "fine-grained" : "classic");

function cleanTokens(parsed) {
  const tokens = {};
  if (parsed?.version !== TOKENS_VERSION || !parsed.tokens || typeof parsed.tokens !== "object") return tokens;
  for (const slot of SLOTS) {
    const token = parsed.tokens[slot];
    if (typeof token === "string" && TOKEN.test(token) && slotOf(token) === slot) tokens[slot] = token;
  }
  return tokens;
}

function writeTokens(tokens) {
  return writeEncrypted(TOKENS_FILE, JSON.stringify({ version: TOKENS_VERSION, tokens }));
}

// Earlier versions kept a single token, first in a plaintext file and then in github-token.enc.
const LEGACY_TOKEN_FILES = ["github-token", "github-token.enc"];
function removeLegacyTokens() {
  for (const name of LEGACY_TOKEN_FILES) fs.rmSync(path.join(app.getPath("userData"), name), { force: true });
}

async function readTokens() {
  const profile = app.getPath("userData");
  const encrypted = readIfPresent(path.join(profile, TOKENS_FILE));
  if (encrypted) {
    const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(encrypted);
    const tokens = cleanTokens(JSON.parse(result));
    if (shouldReEncrypt) await writeTokens(tokens);
    removeLegacyTokens();
    return tokens;
  }
  let single = "";
  const earlier = readIfPresent(path.join(profile, "github-token.enc"));
  if (earlier) single = (await safeStorage.decryptStringAsync(earlier)).result;
  else single = readIfPresent(path.join(profile, "github-token"))?.toString("utf8").trim() || "";
  if (!TOKEN.test(single)) return {};
  const tokens = { [slotOf(single)]: single };
  await writeTokens(tokens);
  removeLegacyTokens();
  return tokens;
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

// What the renderer learns about the saved tokens: which slots are in use and each token's kind.
function tokenSummary(tokens) {
  const saved = {};
  for (const slot of SLOTS) saved[slot] = tokenKind(tokens[slot]);
  const first = SLOTS.find((slot) => tokens[slot]);
  return { signedIn: Boolean(first), kind: first ? saved[first] : null, tokens: saved };
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
  publicUser = null;
  preferred.clear();
}

// ---------- Saved history ----------
// Daily repository traffic, star and fork counts, and referrer sightings, kept so trends can outlast
// GitHub's 14-day traffic window. Only the main process writes it, and only from GitHub responses it
// fetched itself for the signed-in account's own repositories. It is encrypted like the token.
// It also keeps one snapshot a week of outcome numbers the window computed from those responses. The
// main process accepts only the known keys, as bounded numbers, under a week it works out itself.
const HISTORY_FILE = "history.enc";
const HISTORY_ON = "history-on"; // present only after the user turned saved history on
const HISTORY_VERSION = 1;
const HISTORY_DAYS = 400;
const HISTORY_REPOS = 50;
const HISTORY_REFERRERS = 50;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const REFERRER = /^[A-Za-z0-9.-]{1,100}$/;

let sessionUser = null; // { id, login } from the profile read in this session
// The account shown in the public view. It is never a sessionUser: a username does not prove who is
// asking, so notes and saved history stay closed until a token confirms the account.
let publicUser = null;
const signInFirst = () => (publicUser ? "This needs a token. A username alone does not show whose saved data to open." : "Sign in first.");
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

// Snapshot keys and the largest value each may take. Rates and shares are between 0 and 1.
const SNAPSHOT_LIMITS = { merged: 100000, medianMergeHours: HISTORY_DAYS * 24, reworkRate: 1, averageOpen: 10000, waitingShare: 1 };
const SNAPSHOT_WEEKS = 60;

// The Monday that starts the current week, in UTC.
function weekStart() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

function cleanSnapshot(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out = {};
  for (const [key, limit] of Object.entries(SNAPSHOT_LIMITS)) {
    const v = value[key];
    if (v === null || v === undefined) continue;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > limit) return null;
    out[key] = key === "merged" ? Math.round(v) : Math.round(v * 1000) / 1000;
  }
  return Object.keys(out).length ? out : null;
}

function pruneHistory(store) {
  const oldest = new Date(Date.now() - HISTORY_DAYS * 864e5).toISOString().slice(0, 10);
  for (const account of Object.values(store.accounts)) {
    if (account.snapshots) {
      const weeks = Object.keys(account.snapshots).filter((w) => DAY.test(w) && w >= oldest).sort();
      for (const w of Object.keys(account.snapshots)) if (!weeks.slice(-SNAPSHOT_WEEKS).includes(w)) delete account.snapshots[w];
    }
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
  pruneHistory(history);
  await writeEncrypted(HISTORY_FILE, JSON.stringify(history));
  historyDirty = false;
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
  if (!sessionUser) return { ok: false, error: signInFirst() };
  try {
    const store = await loadHistory();
    await saveHistory();
    const account = store.accounts[String(sessionUser.id)];
    const file = readIfPresent(path.join(app.getPath("userData"), HISTORY_FILE));
    return { ok: true, enabled: historyEnabled(), repos: account ? account.repos : {}, snapshots: account?.snapshots || {}, week: weekStart(), bytes: file ? file.length : 0, note: historyNote };
  } catch {
    return { ok: false, error: "Saved history could not be read or saved." };
  }
}));

// This week's outcome numbers for the signed-in account, replacing any saved earlier in the same week.
handle("snapshot", (value) => withHistory(async () => {
  if (!sessionUser) return { ok: false, error: signInFirst() };
  if (!historyEnabled()) return { ok: false, error: "Saved history is off." };
  const clean = cleanSnapshot(value);
  if (!clean) return { ok: false, error: "Invalid snapshot." };
  try {
    const account = accountHistory(await loadHistory(), sessionUser);
    const week = weekStart();
    (account.snapshots || (account.snapshots = {}))[week] = clean;
    scheduleHistorySave();
    return { ok: true, week };
  } catch {
    return { ok: false, error: "The weekly snapshot could not be saved." };
  }
}));

// Turning saved history on starts recording. Turning it off deletes it for every account on this Mac.
handle("history-setting", (enabled) => withHistory(async () => {
  if (!sessionUser) return { ok: false, error: signInFirst() };
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
  if (!sessionUser) return { ok: false, error: signInFirst() };
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

// ---------- Notes ----------
// Sticky notes written in Stream → Notes, kept per account in the app's data folder (userData), not in
// the signed app bundle, which updates replace. Encrypted like the token. Only the main process reads or
// writes the file. A file that cannot be read is set aside for recovery instead of being overwritten.
const NOTES_FILE = "notes.enc";
const NOTES_VERSION = 1;
const NOTES_MAX = 300;
const NOTE_CHARS = 20000;
const NOTE_COLORS = ["yellow", "green", "blue", "pink", "purple"];
const NOTE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;

let notesStore = null;
let notesNote = "";
let notesQueue = Promise.resolve();

function withNotes(operation) {
  const pending = notesQueue.then(operation);
  notesQueue = pending.catch(() => {});
  return pending;
}

function cleanNote(n) {
  if (!n || typeof n.id !== "string" || !NOTE_ID.test(n.id) || typeof n.text !== "string") return null;
  const created = typeof n.created === "string" && ISO_TIME.test(n.created) ? n.created : new Date(0).toISOString();
  return {
    id: n.id,
    text: n.text.slice(0, NOTE_CHARS),
    color: NOTE_COLORS.includes(n.color) ? n.color : NOTE_COLORS[0],
    pinned: n.pinned === true,
    created,
    updated: typeof n.updated === "string" && ISO_TIME.test(n.updated) ? n.updated : created,
  };
}

async function loadNotes() {
  if (notesStore) return notesStore;
  const profile = app.getPath("userData");
  const file = path.join(profile, NOTES_FILE);
  const encrypted = readIfPresent(file);
  const store = { version: NOTES_VERSION, accounts: {} };
  if (encrypted) {
    let parsed = null;
    let reEncrypt = false;
    try {
      const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(encrypted);
      parsed = JSON.parse(result);
      reEncrypt = shouldReEncrypt;
    } catch {
      parsed = null;
    }
    if (parsed?.version === NOTES_VERSION && parsed.accounts && typeof parsed.accounts === "object") {
      for (const [key, account] of Object.entries(parsed.accounts)) {
        if (!/^\d+$/.test(key) || !Array.isArray(account?.notes)) continue;
        store.accounts[key] = {
          login: typeof account.login === "string" ? account.login : "",
          notes: account.notes.map(cleanNote).filter(Boolean).slice(0, NOTES_MAX),
        };
      }
      if (reEncrypt) await writeEncrypted(NOTES_FILE, JSON.stringify(store));
    } else {
      const aside = `notes-unreadable-${Date.now()}.enc`;
      fs.renameSync(file, path.join(profile, aside));
      notesNote = `Saved notes could not be read, so a new notebook started. The unreadable file was kept as ${aside} in the app's data folder.`;
    }
  }
  notesStore = store;
  return store;
}

const noteCopy = (n) => ({ id: n.id, text: n.text, color: n.color, pinned: n.pinned, created: n.created, updated: n.updated });

handle("notes", () => withNotes(async () => {
  if (!sessionUser) return { ok: false, error: signInFirst() };
  try {
    const store = await loadNotes();
    const account = store.accounts[String(sessionUser.id)];
    return {
      ok: true, notes: account ? account.notes.map(noteCopy) : [],
      note: notesNote, colors: NOTE_COLORS, limits: { notes: NOTES_MAX, chars: NOTE_CHARS },
    };
  } catch {
    return { ok: false, error: "Saved notes could not be opened." };
  }
}));

// Without an id this creates a note. Text, color, and pinned are each optional. Only a text change
// moves the edited time, so pinning or recoloring does not reorder the list.
handle("note-save", (input) => withNotes(async () => {
  if (!sessionUser) return { ok: false, error: signInFirst() };
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, error: "Invalid note." };
  const { id, text, color, pinned } = input;
  if ((id !== undefined && (typeof id !== "string" || !NOTE_ID.test(id))) ||
      (text !== undefined && (typeof text !== "string" || text.length > NOTE_CHARS)) ||
      (color !== undefined && !NOTE_COLORS.includes(color)) ||
      (pinned !== undefined && typeof pinned !== "boolean")) {
    return { ok: false, error: "Invalid note." };
  }
  let store;
  try {
    store = await loadNotes();
  } catch {
    return { ok: false, error: "Saved notes could not be opened." };
  }
  const key = String(sessionUser.id);
  const account = store.accounts[key] || (store.accounts[key] = { login: sessionUser.login, notes: [] });
  account.login = sessionUser.login;
  let note = id ? account.notes.find((n) => n.id === id) : null;
  if (id && !note) return { ok: false, error: "That note was deleted." };
  const before = account.notes.map(noteCopy);
  const now = new Date().toISOString();
  if (!note) {
    if (account.notes.length >= NOTES_MAX) return { ok: false, error: `You can keep up to ${NOTES_MAX} notes. Delete one to add another.` };
    note = { id: crypto.randomUUID(), text: "", color: NOTE_COLORS[0], pinned: false, created: now, updated: now };
    account.notes.push(note);
  }
  if (text !== undefined && text !== note.text) { note.text = text; note.updated = now; }
  if (color !== undefined) note.color = color;
  if (pinned !== undefined) note.pinned = pinned;
  try {
    await writeEncrypted(NOTES_FILE, JSON.stringify(store));
  } catch {
    account.notes = before;
    return { ok: false, error: "The note could not be saved. Your text is still in the editor." };
  }
  return { ok: true, note: noteCopy(note) };
}));

handle("note-delete", (id) => withNotes(async () => {
  if (!sessionUser) return { ok: false, error: signInFirst() };
  if (typeof id !== "string" || !NOTE_ID.test(id)) return { ok: false, error: "Invalid note." };
  try {
    const store = await loadNotes();
    const account = store.accounts[String(sessionUser.id)];
    const at = account ? account.notes.findIndex((n) => n.id === id) : -1;
    if (at < 0) return { ok: true };
    const [removed] = account.notes.splice(at, 1);
    try {
      await writeEncrypted(NOTES_FILE, JSON.stringify(store));
    } catch (error) {
      account.notes.splice(at, 0, removed);
      throw error;
    }
    return { ok: true };
  } catch {
    return { ok: false, error: "The note could not be deleted. Try again." };
  }
}));

// ---------- Suggestion card states ----------
// What the user said about each suggestion card: trying it, snoozed until a date, or dismissed. Kept
// per account, encrypted like notes, and only after the user acts on a card. Rule ids and dates only,
// plus the one number a card was measured by when the user acted, so "trying" can show then and now.
const CARDS_FILE = "cards.enc";
const CARDS_VERSION = 1;
const CARDS_MAX = 300;
// A rule id, or a rule id and the repository its card was scoped to: rule@owner/repo.
const CARD_ID = /^[a-z0-9-]{1,60}(@[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100})?$/;
const validCardId = (id) => typeof id === "string" && CARD_ID.test(id) &&
  !id.split("@")[1]?.split("/").some((part) => part === "." || part === "..");
const CARD_STATES = ["trying", "snoozed", "dismissed"];
const CARD_UNITS = ["share", "hours", "lines", "count"];
const SNOOZE_MAX_DAYS = 90;
let cardsStore = null;
let cardsNote = "";
let cardsQueue = Promise.resolve();

function withCards(operation) {
  const pending = cardsQueue.then(operation);
  cardsQueue = pending.catch(() => {});
  return pending;
}

// The number a card was measured by, or null. Shares are 0 to 1; the others are bounded counts.
function cleanCardMetric(m) {
  if (!m || typeof m !== "object" || !CARD_UNITS.includes(m.unit) || typeof m.value !== "number" ||
      !Number.isFinite(m.value) || m.value < 0 || m.value > (m.unit === "share" ? 1 : 1e7) ||
      typeof m.label !== "string" || m.label.length > 80) return null;
  return { unit: m.unit, value: m.value, label: m.label };
}

function cleanCard(c, now = Date.now()) {
  if (!c || !CARD_STATES.includes(c.state) || typeof c.at !== "string" || !ISO_TIME.test(c.at)) return null;
  const out = { state: c.state, at: c.at };
  if (c.state === "snoozed") {
    const until = typeof c.until === "string" && ISO_TIME.test(c.until) ? Date.parse(c.until) : NaN;
    if (!(until > Date.parse(c.at)) || until - Date.parse(c.at) > SNOOZE_MAX_DAYS * 864e5 + 6e4) return null;
    if (until <= now) return null; // an expired snooze is dropped on the next save
    out.until = c.until;
  }
  const metric = cleanCardMetric(c.metric);
  if (metric) out.metric = metric;
  return out;
}

async function loadCards() {
  if (cardsStore) return cardsStore;
  const store = { version: CARDS_VERSION, accounts: {} };
  const encrypted = readIfPresent(path.join(app.getPath("userData"), CARDS_FILE));
  if (encrypted) {
    try {
      const parsed = JSON.parse((await safeStorage.decryptStringAsync(encrypted)).result);
      if (parsed?.version !== CARDS_VERSION || !parsed.accounts || typeof parsed.accounts !== "object") throw new Error("format");
      for (const [key, cards] of Object.entries(parsed.accounts)) {
        if (!/^\d+$/.test(key) || !cards || typeof cards !== "object") continue;
        const clean = {};
        for (const [id, c] of Object.entries(cards).slice(0, CARDS_MAX)) {
          const card = validCardId(id) ? cleanCard(c) : null;
          if (card) clean[id] = card;
        }
        store.accounts[key] = clean;
      }
    } catch {
      cardsNote = "Saved suggestion states could not be read, so every card starts fresh.";
    }
  }
  cardsStore = store;
  return store;
}

handle("cards", () => withCards(async () => {
  if (!sessionUser) return { ok: false, error: signInFirst() };
  try {
    const store = await loadCards();
    return { ok: true, cards: { ...(store.accounts[String(sessionUser.id)] || {}) }, note: cardsNote };
  } catch {
    return { ok: false, error: "Saved suggestion states could not be opened." };
  }
}));

// Sets one card's state, or clears it with state null. The main process stamps the time itself.
handle("card-set", (id, input) => withCards(async () => {
  if (!sessionUser) return { ok: false, error: signInFirst() };
  if (!validCardId(id)) return { ok: false, error: "Invalid card." };
  const key = String(sessionUser.id);
  let card = null;
  if (input !== null) {
    if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, error: "Invalid card state." };
    const at = new Date().toISOString();
    const days = input.state === "snoozed" ? input.days : 0;
    if (input.state === "snoozed" && !(Number.isInteger(days) && days >= 1 && days <= SNOOZE_MAX_DAYS)) return { ok: false, error: "Invalid snooze." };
    card = cleanCard({ state: input.state, at, until: days ? new Date(Date.now() + days * 864e5).toISOString() : undefined, metric: input.metric });
    if (!card) return { ok: false, error: "Invalid card state." };
  }
  try {
    const store = await loadCards();
    const cards = { ...store.accounts[key] };
    if (card) cards[id] = card; else delete cards[id];
    for (const [old, c] of Object.entries(cards)) if (c.state === "snoozed" && Date.parse(c.until) <= Date.now()) delete cards[old];
    if (Object.keys(cards).length > CARDS_MAX) return { ok: false, error: "Too many saved suggestion states." };
    await writeEncrypted(CARDS_FILE, JSON.stringify({ ...store, accounts: { ...store.accounts, [key]: cards } }));
    store.accounts[key] = cards;
    cardsNote = "";
    return { ok: true, cards: { ...cards } };
  } catch {
    return { ok: false, error: "The suggestion state could not be saved." };
  }
}));

// ---------- Public view ----------
// Without a token, a username shows what GitHub serves to anyone: the profile, public events, public
// repositories, and star dates. These requests carry no credential and count against GitHub's limit
// for the network address. Only the username is kept, in a plain file, so the view reopens.
const PUBLIC_FILE = "public-user";

function readPublicLogin() {
  const text = readIfPresent(path.join(app.getPath("userData"), PUBLIC_FILE))?.toString("utf8").trim();
  return text && LOGIN.test(text) ? text : null;
}
const forgetPublicLogin = () => fs.rmSync(path.join(app.getPath("userData"), PUBLIC_FILE), { force: true });

const PUBLIC_LIMIT = "GitHub's hourly limit for requests without a token was reached. Try again later, or sign in with a token.";

handle("browse", (login) => withCredentials(async () => {
  const value = typeof login === "string" ? login.trim().replace(/^@/, "") : "";
  if (!LOGIN.test(value)) return { ok: false, error: "That does not look like a GitHub username." };
  try {
    fs.mkdirSync(app.getPath("userData"), { recursive: true });
    if (tokenSummary(await readTokens()).signedIn) {
      return { ok: false, status: 409, error: "A token is saved. Remove it before opening the public view." };
    }
  } catch {
    return { ok: false, error: "Could not open the saved credential or finish its migration." };
  }
  let found;
  try {
    const response = await fetch(`${API}/users/${value}`, { headers: githubHeaders(null), redirect: "error", signal: AbortSignal.timeout(15000) });
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 404) return { ok: false, status: 404, error: `GitHub has no account named @${value}.` };
      if (response.status === 403 || response.status === 429) return { ok: false, status: response.status, error: PUBLIC_LIMIT };
      return { ok: false, status: response.status, error: `GitHub returned HTTP ${response.status}.` };
    }
    found = await response.json();
  } catch {
    return { ok: false, status: 0, error: "Could not reach GitHub to look up that username." };
  }
  if (!Number.isSafeInteger(found?.id) || typeof found.login !== "string" || !LOGIN.test(found.login)) return { ok: false, status: 0, error: "Unexpected GitHub profile." };
  if (found.type !== "User") return { ok: false, status: 400, error: `@${found.login} is not a user account. The public view covers people's accounts.` };
  try {
    fs.writeFileSync(path.join(app.getPath("userData"), PUBLIC_FILE), found.login, { mode: 0o600 });
  } catch {
    return { ok: false, error: "Could not save the username." };
  }
  resetSession();
  publicUser = { id: found.id, login: found.login };
  return { ok: true, id: found.id, login: found.login };
}));

// The reads the public view may make, each for the saved username only.
function publicRequest(operation, args, login) {
  const mine = (value) => typeof value === "string" && value.toLowerCase() === login.toLowerCase();
  switch (operation) {
    case "profile": return { route: `/users/${login}` };
    case "events": {
      const { login: asked, page } = args || {};
      if (mine(asked) && Number.isInteger(page) && page >= 1 && page <= 3) return { route: `/users/${login}/events/public?per_page=100&page=${page}` };
      break;
    }
    case "ownedRepos": return { route: `/users/${login}/repos?type=owner&sort=pushed&per_page=100` };
    case "stargazers": {
      if (!validRepo(args?.repo) || !mine(args.repo.split("/")[0])) break;
      return { route: `/repos/${args.repo}/stargazers?per_page=100`, accept: "application/vnd.github.star+json" };
    }
    // Public pull requests the username opened in the authored window, by GitHub's issue search. Search has
    // its own limit without a token, 10 requests a minute, apart from the 60 an hour for other reads.
    case "authoredPullRequests": {
      const { login: asked, page } = args || {};
      if (!mine(asked) || !Number.isInteger(page) || page < 1 || page > 3) break;
      const since = new Date(Date.now() - AUTHORED_DAYS * 864e5).toISOString().slice(0, 10);
      const q = encodeURIComponent(`author:${login} is:pr is:public created:>=${since}`);
      return { route: `/search/issues?q=${q}&sort=created&order=desc&per_page=100&page=${page}` };
    }
    case "rateLimit": return { route: "/rate_limit" };
  }
  return null;
}

// A public search page reduced to what a pull request record needs. Search returns no reviews, sizes,
// branches, or commits, so the window marks those unknown rather than zero.
function shapePublicSearch(body) {
  const data = JSON.parse(body);
  if (!Array.isArray(data?.items) || !Number.isInteger(data.total_count) || data.total_count < 0) {
    throw new Error("Invalid public search response.");
  }
  const repoOf = (url) => {
    const match = typeof url === "string" ? /^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)$/.exec(url) : null;
    return match && validRepo(match[1]) ? match[1] : null;
  };
  const items = data.items.filter((i) => i?.pull_request && Number.isInteger(i.number) && repoOf(i.repository_url)).map((i) => ({
    repo: repoOf(i.repository_url), number: i.number, title: typeof i.title === "string" ? i.title : "", state: i.state === "open" ? "open" : "closed",
    draft: Boolean(i.draft), createdAt: i.created_at, closedAt: i.closed_at || null, mergedAt: i.pull_request.merged_at || null,
    author: typeof i.user?.login === "string" ? i.user.login : null, authorType: typeof i.user?.type === "string" ? i.user.type : null,
  }));
  return JSON.stringify({ total: data.total_count, incomplete: Boolean(data.incomplete_results), dropped: data.items.length - items.length, items });
}

async function publicRead(operation, args, login, signal) {
  const request = publicRequest(operation, args, login);
  if (!request) return { ok: false, status: 400, error: "That read needs a token." };
  try {
    const response = await fetch(API + request.route, {
      headers: githubHeaders(null, request),
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
    });
    const remaining = response.headers.get("x-ratelimit-remaining");
    if (!response.ok) {
      await response.body?.cancel();
      return { ok: false, status: response.status, remaining, via: "public" };
    }
    let body = await response.text();
    if (operation === "profile") {
      const { id, login: name, name: display, created_at: createdAt, followers, public_repos: publicRepos } = JSON.parse(body);
      body = JSON.stringify({ id, login: name, name: display, createdAt, followers, publicRepos });
      if (!signal.aborted && Number.isSafeInteger(id) && typeof name === "string" && LOGIN.test(name)) publicUser = { id, login: name };
    } else if (operation === "authoredPullRequests") {
      body = shapePublicSearch(body);
    } else {
      body = shapeBody(operation, body, { search: true });
    }
    return { ok: true, status: response.status, body, link: response.headers.get("link"), remaining, via: "public" };
  } catch {
    return { ok: false, status: 0, error: "GitHub request did not complete." };
  }
}

handle("status", () => withCredentials(async () => {
  try {
    const summary = tokenSummary(await readTokens());
    return { ok: true, ...summary, publicLogin: summary.signedIn ? null : readPublicLogin() };
  } catch {
    return { ok: false, error: "Could not open the saved credential or finish its migration." };
  }
}));

// Asks GitHub whose token this is. Used before a token is saved, never with a renderer-chosen route.
async function tokenOwner(token) {
  try {
    const response = await fetch(`${API}/user`, {
      headers: githubHeaders(token),
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return { ok: false, status: response.status };
    }
    const { id, login } = await response.json();
    if (!Number.isSafeInteger(id) || typeof login !== "string" || !LOGIN.test(login)) return { ok: false, status: 0 };
    return { ok: true, id, login };
  } catch {
    return { ok: false, status: 0 };
  }
}

// Saves a token in its slot. A token for the slot already in use replaces it. A token for the other
// slot is added beside it, but only when GitHub reports the same account for both.
handle("sign-in", (token) => withCredentials(async () => {
  const value = typeof token === "string" ? token.trim() : "";
  if (!TOKEN.test(value)) return { ok: false, error: "That does not look like a GitHub token." };
  const slot = slotOf(value);
  let tokens;
  try {
    fs.mkdirSync(app.getPath("userData"), { recursive: true });
    tokens = await readTokens();
  } catch {
    return { ok: false, error: "Could not open the saved credential or finish its migration." };
  }
  const owner = await tokenOwner(value);
  if (!owner.ok) {
    return owner.status === 401
      ? { ok: false, status: 401, error: "GitHub rejected that token. Nothing was saved." }
      : { ok: false, status: owner.status, error: "Could not check that token with GitHub. Nothing was saved. Try again." };
  }
  // While an account is loaded, its tokens can be added or replaced, not swapped for another account's.
  if (sessionUser && sessionUser.id !== owner.id) {
    return { ok: false, status: 409, error: `That token belongs to @${owner.login}, not @${sessionUser.login}. Sign out to switch accounts.` };
  }
  const other = SLOTS.find((s) => s !== slot && tokens[s]);
  let dropped = null;
  if (other) {
    const saved = await tokenOwner(tokens[other]);
    if (saved.ok && saved.id !== owner.id) {
      return {
        ok: false, status: 409,
        error: `That token belongs to @${owner.login}, and the saved ${other} token belongs to @${saved.login}. Both tokens must be for the same account. Remove the saved token first to switch accounts.`,
      };
    }
    // A saved token GitHub no longer accepts cannot vouch for an account, so it is removed.
    if (!saved.ok && saved.status === 401) { delete tokens[other]; dropped = other; }
    else if (!saved.ok) return { ok: false, status: saved.status, error: `Could not check the saved ${other} token with GitHub. Nothing was saved. Try again.` };
  }
  const replaced = Boolean(tokens[slot]);
  tokens[slot] = value;
  try {
    await writeTokens(tokens);
    removeLegacyTokens();
  } catch {
    return { ok: false, error: "Could not save the credential securely or remove the legacy copy." };
  }
  // An account that is already loaded keeps its session. Otherwise requests in flight are dropped,
  // and a public view ends, since the token now says whose account this is.
  if (sessionUser) preferred.clear();
  else resetSession();
  try { forgetPublicLogin(); } catch { /* The saved username is ignored while a token is saved. */ }
  return { ok: true, slot, replaced, dropped, login: owner.login, ...tokenSummary(tokens) };
}));

// Removes one saved token. Removing the last one signs out.
handle("remove-token", (slot) => withCredentials(async () => {
  if (typeof slot !== "string" || !SLOTS.includes(slot)) return { ok: false, status: 400, error: "Unknown token." };
  try {
    const tokens = await readTokens();
    delete tokens[slot];
    preferred.clear();
    if (SLOTS.some((s) => tokens[s])) await writeTokens(tokens);
    else {
      resetSession();
      fs.rmSync(path.join(app.getPath("userData"), TOKENS_FILE), { force: true });
    }
    return { ok: true, ...tokenSummary(tokens) };
  } catch {
    return { ok: false, error: "Could not remove the saved token. Try again." };
  }
}));

handle("sign-out", () => withCredentials(() => {
  resetSession();
  try {
    removeLegacyTokens();
    fs.rmSync(path.join(app.getPath("userData"), TOKENS_FILE), { force: true });
    forgetPublicLogin();
    return { ok: true };
  } catch {
    return { ok: false, error: "Could not remove the saved credential. Try signing out again." };
  }
}));

// Opens GitHub's form for a new token of the given kind. The classic link asks for only the
// notifications scope. GitHub documents URL parameters for the fine-grained form alone, so the app
// tells the user to check the selected scopes instead of relying on the preselection.
handle("open-token-page", async (kind = "fine-grained") => {
  if (typeof kind !== "string" || !Object.hasOwn(TOKEN_PAGES, kind)) return { ok: false, status: 400, error: "Unknown token type." };
  await shell.openExternal(TOKEN_PAGES[kind]);
  return { ok: true };
});

// Opens a further-reading link in the browser. Only catalogued ids on allowlisted HTTPS hosts open.
function readingUrl(id) {
  if (typeof id !== "string" || !Object.hasOwn(READING, id)) return null;
  let url;
  try {
    url = new NodeURL(READING[id].url);
  } catch {
    return null;
  }
  const plain = url.protocol === "https:" && !url.username && !url.password && !url.port;
  return plain && READING_HOSTS.has(url.hostname) ? url.href : null;
}

handle("open-reading", async (id) => {
  const url = readingUrl(id);
  if (!url) return { ok: false, status: 400, error: "Unknown reading link." };
  await shell.openExternal(url);
  return { ok: true };
});

// A repository, or an issue or pull request in it, on github.com. The window sends only a repository
// name and an optional number; the URL is built here, on github.com only, and nothing else is accepted.
// /issues/<n> also reaches a pull request: GitHub redirects it.
function githubPageUrl(repo, number) {
  if (typeof repo !== "string") return null;
  const [owner, name, extra] = repo.split("/");
  if (extra !== undefined || !REPO_NAME.test(owner || "") || !REPO_NAME.test(name || "") ||
      [owner, name].some((part) => part === "." || part === "..")) return null;
  if (number !== null && number !== undefined && !(Number.isInteger(number) && number >= 1 && number <= 2147483647)) return null;
  const url = new URL(`https://github.com/${owner}/${name}${number ? `/issues/${number}` : ""}`);
  return url.hostname === "github.com" && url.protocol === "https:" ? url.href : null;
}

handle("open-github", async (repo, number) => {
  const url = githubPageUrl(repo, number);
  if (!url) return { ok: false, status: 400, error: "Not a GitHub repository or number." };
  await shell.openExternal(url);
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
// When each review clock starts: a draft marked ready for review, and who was asked to review and when.
// Only a requested user's login is read. A team request is known by its type alone, since team details
// can need organization access the token may not have.
const REQUEST_FIELDS = "createdAt requestedReviewer { __typename ... on User { login } }";
const PR_FIELDS = `title state merged isDraft createdAt mergedAt closedAt additions deletions headRefName
  author { __typename login } mergedBy { login }
  reviews(first: 10) { totalCount nodes { submittedAt state author { __typename login } } }
  timelineItems(first: 10, itemTypes: [READY_FOR_REVIEW_EVENT, REVIEW_REQUESTED_EVENT]) { totalCount nodes {
    __typename ... on ReadyForReviewEvent { createdAt } ... on ReviewRequestedEvent { ${REQUEST_FIELDS} } } }`;

// When the last commit on a pull request was made, which splits time to merge into work and waiting.
const COMMIT_FIELDS = "commits(last: 1) { nodes { commit { committedDate } } }";

// Recent comments on issues and pull requests that involve the user, open or closed.
// Search finds the threads; each thread's latest comments, reviews, and review comments are read live.
// GitHub's issue search rejects a query without is:issue or is:pr, so issues and pull requests are
// two aliased searches in one request, each returning its most recently updated threads.
const COMMENT_FIELDS = "author { __typename login } bodyText createdAt";
const THREAD_FIELDS = `__typename
      ... on Issue { number title issueState: state updatedAt author { login } repository { nameWithOwner }
        comments(last: 10) { totalCount nodes { ${COMMENT_FIELDS} } } }
      ... on PullRequest { number title prState: state merged updatedAt author { login } repository { nameWithOwner }
        comments(last: 10) { totalCount nodes { ${COMMENT_FIELDS} } }
        reviews(last: 10) { totalCount nodes { ${COMMENT_FIELDS} state
          comments(first: 5) { totalCount nodes { ${COMMENT_FIELDS} path } } } } }`;
const CONVERSATION_THREADS = 25;
const CONVERSATIONS_QUERY = `query ($issues: String!, $pullRequests: String!) {
  issues: search(query: $issues, type: ISSUE, first: ${CONVERSATION_THREADS}) { issueCount nodes { ${THREAD_FIELDS} } }
  pullRequests: search(query: $pullRequests, type: ISSUE, first: ${CONVERSATION_THREADS}) { issueCount nodes { ${THREAD_FIELDS} } }
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
// Pull requests by other people that the user reviewed, over the same window as the authored search.
// The aliased reviews field returns the user's own first review, which the first 10 reviews can miss.
const REVIEWED_QUERY = `query ($q: String!, $after: String, $login: String!) {
  search(query: $q, type: ISSUE, first: 100, after: $after) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes { __typename ... on PullRequest { number repository { nameWithOwner } ${PR_FIELDS}
      myReviews: reviews(first: 1, author: $login) { nodes { submittedAt } } } }
  }
}`;
// Open pull requests that ask the user for a review, directly or through a team. Search drops a pull
// request once the requested person has reviewed it. The latest request events say when each ask came.
const REQUESTED_THREADS = 50;
// Opaque IDs match timeline events to pending teams without reading team membership or names.
const PENDING_REVIEWER_FIELDS = "__typename ... on User { login } ... on Node { id }";
const REQUESTED_QUERY = `query ($q: String!) {
  search(query: $q, type: ISSUE, first: ${REQUESTED_THREADS}) {
    issueCount
    nodes { __typename ... on PullRequest { number title isDraft createdAt additions deletions repository { nameWithOwner }
      author { __typename login }
      reviewRequests(first: 10) { nodes { requestedReviewer { ${PENDING_REVIEWER_FIELDS} } } }
      timelineItems(last: 10, itemTypes: [REVIEW_REQUESTED_EVENT]) { nodes { ... on ReviewRequestedEvent { createdAt requestedReviewer { ${PENDING_REVIEWER_FIELDS} } } } } } }
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
      const q = (type) => `involves:${login} ${type} updated:>=${since} sort:updated-desc`;
      return { route: "/graphql", body: { query: CONVERSATIONS_QUERY, variables: { issues: q("is:issue"), pullRequests: q("is:pr") } } };
    }
    case "authoredPullRequests": {
      const { login, after } = args || {};
      if (typeof login !== "string" || !LOGIN.test(login)) break;
      if (after !== undefined && (typeof after !== "string" || !CURSOR.test(after))) break;
      const since = new Date(Date.now() - AUTHORED_DAYS * 864e5).toISOString().slice(0, 10);
      return { route: "/graphql", body: { query: AUTHORED_QUERY, variables: { q: `author:${login} is:pr created:>=${since} sort:created-desc`, after: after ?? null } } };
    }
    case "reviewedPullRequests": {
      const { login, after } = args || {};
      if (typeof login !== "string" || !LOGIN.test(login)) break;
      if (after !== undefined && (typeof after !== "string" || !CURSOR.test(after))) break;
      const since = new Date(Date.now() - AUTHORED_DAYS * 864e5).toISOString().slice(0, 10);
      return { route: "/graphql", body: { query: REVIEWED_QUERY, variables: { q: `reviewed-by:${login} -author:${login} is:pr created:>=${since} sort:created-desc`, after: after ?? null, login } } };
    }
    case "reviewRequests": {
      const login = args?.login;
      if (typeof login !== "string" || !LOGIN.test(login)) break;
      return { route: "/graphql", body: { query: REQUESTED_QUERY, variables: { q: `is:pr is:open archived:false review-requested:${login} sort:created-asc` } } };
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
    case "pullRequests":
    case "pullRequestCommits": {
      if (!Array.isArray(args) || args.length === 0 || args.length > 40) break;
      // Commit times are their own request, so a token that cannot read commits loses only them.
      const fieldsFor = operation === "pullRequests" ? PR_FIELDS : COMMIT_FIELDS;
      const declarations = [];
      const fields = [];
      const variables = {};
      for (const [i, ref] of args.entries()) {
        if (typeof ref?.repo !== "string") return null;
        const [owner, repo, extra] = ref.repo.split("/");
        if (extra !== undefined || !REPO_NAME.test(owner) || !repo || !REPO_NAME.test(repo) ||
            !Number.isInteger(ref.number) || ref.number < 1 || ref.number > 2147483647) return null;
        declarations.push(`$o${i}: String!, $r${i}: String!, $n${i}: Int!`);
        fields.push(`p${i}: repository(owner: $o${i}, name: $r${i}) { pullRequest(number: $n${i}) { ${fieldsFor} } }`);
        Object.assign(variables, { [`o${i}`]: owner, [`r${i}`]: repo, [`n${i}`]: ref.number });
      }
      return { route: "/graphql", body: { query: `query (${declarations.join(", ")}) { ${fields.join("\n")} }`, variables } };
    }
  }
  return null;
}

function githubHeaders(token, request) {
  const headers = {
    Accept: request?.accept || "application/vnd.github+json",
    "User-Agent": "ActivityDesk",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  // The public view sends no credential.
  if (token) headers.Authorization = `Bearer ${token}`;
  if (request?.body) headers["Content-Type"] = "application/json";
  return headers;
}

// ---------- Which saved token answers a read ----------
// GitHub's notification endpoints accept classic tokens only. Every other read starts with the
// fine-grained token and moves to the classic one when GitHub denies the first: 401, or a 403 or 404
// that is not a rate limit. Both tokens share the account's rate limit, so a rate-limited request is
// not retried. The slot that answered after a denial goes first for that operation until the session
// or the saved tokens change. The renderer may name a slot to read a source with each token in turn.
const CLASSIC_ONLY = new Set(["notifications"]);
const preferred = new Map();

function tokenOrder(operation, tokens, slot) {
  if (slot !== undefined) return tokens[slot] ? [slot] : [];
  if (CLASSIC_ONLY.has(operation)) return tokens.classic ? ["classic"] : [];
  const first = preferred.get(operation);
  return SLOTS.filter((s) => tokens[s]).sort((a, b) => (b === first) - (a === first));
}

const rateLimited = (response) => response.headers.get("x-ratelimit-remaining") === "0" || response.headers.has("retry-after");
const denied = (response) => response.status === 401 || ((response.status === 403 || response.status === 404) && !rateLimited(response));

// Token metadata GitHub reports on responses: the permissions an endpoint accepts for
// fine-grained tokens, the granted scopes of a classic token, and the token's expiry when sent.
const tokenInfo = (response) => ({
  accepted: response.headers.get("x-accepted-github-permissions"),
  scopes: response.headers.get("x-oauth-scopes"),
  expires: response.headers.get("github-authentication-token-expiration"),
});

// Reduces a response to the fields the renderer uses, the same way with or without a token.
// `search` keeps the search limit too, which only the public view spends.
function shapeBody(operation, body, { search = false } = {}) {
  if (operation === "ownedRepos") {
    const repos = JSON.parse(body);
    return JSON.stringify((Array.isArray(repos) ? repos : []).filter((r) => validRepo(r?.full_name)).map((r) => ({
      full_name: r.full_name, private: Boolean(r.private), fork: Boolean(r.fork), archived: Boolean(r.archived),
      stargazers_count: r.stargazers_count, forks_count: r.forks_count, pushed_at: r.pushed_at,
    })));
  }
  if (operation === "stargazers") {
    const stars = JSON.parse(body);
    return JSON.stringify((Array.isArray(stars) ? stars : []).map((s) => s?.starred_at).filter((t) => typeof t === "string"));
  }
  if (operation === "rateLimit") {
    const resources = JSON.parse(body)?.resources || {};
    const kept = {};
    for (const name of search ? [...RATE_RESOURCES, "search"] : RATE_RESOURCES) {
      const r = resources[name];
      if (r && [r.limit, r.remaining, r.used, r.reset].every(Number.isFinite)) {
        kept[name] = { limit: r.limit, remaining: r.remaining, used: r.used, reset: r.reset };
      }
    }
    return JSON.stringify({ resources: kept });
  }
  return body;
}

handle("github", async (operation, args, slot) => {
  const request = githubRequest(operation, args);
  if (!request || (slot !== undefined && !SLOTS.includes(slot))) return { ok: false, status: 400, error: "Unsupported GitHub read operation." };

  let credential;
  try {
    credential = await withCredentials(async () => ({ tokens: await readTokens(), signal: session.signal }));
  } catch {
    return { ok: false, status: 0, error: "Could not open the saved credential." };
  }
  if (!SLOTS.some((s) => credential.tokens[s])) {
    const login = slot === undefined ? readPublicLogin() : null;
    return login ? publicRead(operation, args, login, credential.signal) : { ok: false, status: 401, error: "Sign in first." };
  }
  const order = tokenOrder(operation, credential.tokens, slot);
  if (!order.length) {
    return slot === undefined
      ? { ok: false, status: 403, error: "GitHub accepts only a classic token for this request, and none is saved." }
      : { ok: false, status: 400, error: `No ${slot} token is saved.` };
  }

  try {
    // Tokens GitHub denied before another one answered, with what GitHub said about each.
    const skipped = [];
    let response;
    let via;
    for (const [i, candidate] of order.entries()) {
      via = candidate;
      response = await fetch(API + request.route, {
        method: request.body ? "POST" : "GET",
        headers: githubHeaders(credential.tokens[candidate], request),
        body: request.body ? JSON.stringify(request.body) : undefined,
        redirect: "error",
        signal: AbortSignal.any([credential.signal, AbortSignal.timeout(30000)]),
      });
      if (response.ok || i === order.length - 1 || !denied(response)) break;
      skipped.push({ slot: candidate, status: response.status, token: tokenInfo(response) });
      await response.body?.cancel();
    }
    const token = tokenInfo(response);
    if (!response.ok) {
      await response.body?.cancel();
      return { ok: false, status: response.status, remaining: response.headers.get("x-ratelimit-remaining"), token, via, skipped };
    }
    if (skipped.length) preferred.set(operation, via);
    let body = await response.text();
    if (operation === "profile") {
      const { id, login, name } = JSON.parse(body);
      body = JSON.stringify({ id, login, name });
      if (!credential.signal.aborted && Number.isSafeInteger(id) && typeof login === "string" && LOGIN.test(login)) sessionUser = { id, login };
    }
    body = shapeBody(operation, body);
    const user = sessionUser;
    if (user && !credential.signal.aborted && (operation === "ownedRepos" ||
        (operation === "traffic" && args.repo.toLowerCase().startsWith(`${user.login.toLowerCase()}/`)))) {
      await recordHistory(user, operation, args, JSON.parse(body)).catch(() => {});
    }
    return {
      ok: true,
      status: response.status,
      body,
      link: response.headers.get("link"),
      remaining: response.headers.get("x-ratelimit-remaining"),
      token,
      via,
      skipped,
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

// Finish the window's pending saves before the app exits.
let drained = false;
app.on("will-quit", (event) => {
  if (drained) return;
  drained = true;
  event.preventDefault();
  (async () => {
    for (let pass = 0; pass < 20; pass += 1) {
      const notes = notesQueue;
      const cards = cardsQueue;
      await Promise.allSettled([notes, cards, withHistory(saveHistory)]);
      await new Promise((resolve) => setTimeout(resolve, 25));
      if (notes === notesQueue && cards === cardsQueue) break;
    }
  })().finally(() => app.quit());
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (singleInstance && BrowserWindow.getAllWindows().length === 0) createWindow();
});
