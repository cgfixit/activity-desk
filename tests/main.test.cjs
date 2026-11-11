const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { pathToFileURL } = require("node:url");
const vm = require("node:vm");

const payload = path.resolve(__dirname, "../Activity Desk.app/Contents/Resources/app");
const token = "synthetic-token-for-unit-checks";

async function start(t, profile) {
  const handlers = new Map();
  const calls = [];
  const frame = { url: pathToFileURL(path.join(payload, "index.html")).href };
  const sender = { mainFrame: frame, on() {}, setWindowOpenHandler() {} };
  const electron = {
    app: {
      getPath: () => profile,
      requestSingleInstanceLock: () => true,
      whenReady: () => Promise.resolve(),
      on() {},
    },
    BrowserWindow: class {
      webContents = sender;
      loadFile() {}
      on() {}
    },
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    safeStorage: {
      encryptStringAsync: async (value) => {
        assert.equal(value, token);
        return Buffer.from("mock ciphertext");
      },
      decryptStringAsync: async (buffer) => {
        assert.equal(buffer.toString(), "mock ciphertext");
        return { result: token, shouldReEncrypt: false };
      },
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(payload, "main.js"), "utf8"), {
    __dirname: payload,
    require: (name) => name === "electron" ? electron : require(name),
    process,
    AbortController,
    AbortSignal,
    fetch: async (url, options) => {
      calls.push({ url, options });
      return new Response("{}");
    },
  });
  await Promise.resolve();
  const event = { sender, senderFrame: frame };
  return {
    calls,
    invoke: (name, ...args) => handlers.get(`desk:${name}`)(event, ...args),
    foreign: (name) => handlers.get(`desk:${name}`)({ ...event, senderFrame: null }),
  };
}

test("only supported reads from the app frame reach the GitHub transport", async (t) => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "activity-desk-"));
  t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
  const { invoke, foreign, calls } = await start(t, profile);
  assert.equal((await invoke("sign-in", token)).ok, true);
  for (const operation of ["status", "sign-in", "sign-out", "github", "open-token-page"]) {
    assert.equal((await foreign(operation)).status, 403);
  }
  assert.equal((await invoke("github", "unsupported")).status, 400);
  assert.equal((await invoke("github", "events", { login: "fixture", page: 4 })).status, 400);
  assert.equal((await invoke("github", "pullRequests", [{ repo: "fixture/example", number: -1 }])).status, 400);
  assert.equal(calls.length, 0);
  assert.equal((await invoke("github", "profile")).ok, true);
  assert.equal((await invoke("github", "pullRequests", [{ repo: "fixture/example", number: 1 }])).ok, true);
  assert.equal(calls[0].url, "https://api.github.com/user");
  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[0].options.redirect, "error");
  const body = JSON.parse(calls[1].options.body);
  assert.match(body.query, /^query \(/);
  assert.deepEqual(body.variables, { o0: "fixture", r0: "example", n0: 1 });
});

test("migration survives restart and sign-out reports removal failure", async (t) => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "activity-desk-"));
  t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
  const legacy = path.join(profile, "github-token");
  const encrypted = path.join(profile, "github-token.enc");
  fs.writeFileSync(legacy, token, { mode: 0o600 });
  const first = await start(t, profile);
  assert.equal((await first.invoke("status")).signedIn, true);
  assert.equal(fs.existsSync(legacy), false);
  assert.equal(fs.readFileSync(encrypted, "utf8"), "mock ciphertext");
  const restarted = await start(t, profile);
  assert.equal((await restarted.invoke("status")).signedIn, true);
  const saved = encrypted + ".saved";
  fs.renameSync(encrypted, saved);
  fs.mkdirSync(encrypted);
  assert.equal((await restarted.invoke("sign-out")).ok, false);
  fs.rmdirSync(encrypted);
  fs.renameSync(saved, encrypted);
  assert.equal((await restarted.invoke("sign-out")).ok, true);
  const afterSignOut = await start(t, profile);
  assert.equal((await afterSignOut.invoke("status")).signedIn, false);
});
