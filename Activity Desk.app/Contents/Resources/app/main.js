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

async function writeToken(token) {
  const encrypted = await safeStorage.encryptStringAsync(token);
  const profile = app.getPath("userData");
  const staging = fs.mkdtempSync(path.join(profile, "credential-"));
  try {
    const file = path.join(staging, "token");
    fs.writeFileSync(file, encrypted, { mode: 0o600 });
    fs.renameSync(file, path.join(profile, "github-token.enc"));
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
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
}

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
      totalCommitContributions totalIssueContributions totalPullRequestContributions
      totalPullRequestReviewContributions restrictedContributionsCount totalRepositoriesWithContributedCommits
      contributionCalendar { totalContributions weeks { contributionDays { date contributionCount } } }
      commitContributionsByRepository(maxRepositories: 10) { repository { nameWithOwner isPrivate } contributions { totalCount } }
    }
  }
}`;

const REPO_NAME = /^[A-Za-z0-9_.-]{1,100}$/;
const PR_FIELDS = `title state merged isDraft createdAt mergedAt additions deletions headRefName
  author { login } mergedBy { login } reviews { totalCount }`;

function githubRequest(operation, args) {
  switch (operation) {
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
    Accept: "application/vnd.github+json",
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
    if (!response.ok) {
      await response.body?.cancel();
      return { ok: false, status: response.status, remaining: response.headers.get("x-ratelimit-remaining") };
    }
    let body = await response.text();
    if (operation === "profile") {
      const { id, login, name } = JSON.parse(body);
      body = JSON.stringify({ id, login, name });
    }
    return {
      ok: true,
      status: response.status,
      body,
      link: response.headers.get("link"),
      remaining: response.headers.get("x-ratelimit-remaining"),
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
