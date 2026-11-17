const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { pathToFileURL } = require("node:url");
const vm = require("node:vm");

const payload = path.resolve(__dirname, "../Activity Desk.app/Contents/Resources/app");
const token = "synthetic-token-for-unit-checks";

async function start(t, profile, response = () => new Response("{}")) {
  const handlers = new Map();
  const calls = [];
  const opened = [];
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
    shell: { openExternal: async (url) => opened.push(url) },
    // The token encrypts to a fixed string. Anything else, such as notes, uses a reversible mock encoding.
    safeStorage: {
      encryptStringAsync: async (value) => Buffer.from(value === token ? "mock ciphertext" : `mock:${Buffer.from(value).toString("base64")}`),
      decryptStringAsync: async (buffer) => {
        const text = buffer.toString();
        if (text === "mock ciphertext") return { result: token, shouldReEncrypt: false };
        assert.match(text, /^mock:/, "unreadable fixture ciphertext");
        return { result: Buffer.from(text.slice(5), "base64").toString(), shouldReEncrypt: false };
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
      return response();
    },
  });
  await Promise.resolve();
  const event = { sender, senderFrame: frame };
  return {
    calls,
    opened,
    // IPC structured-clones results, which also moves them out of the vm realm for deepEqual.
    invoke: async (name, ...args) => structuredClone(await handlers.get(`desk:${name}`)(event, ...args)),
    foreign: async (name) => structuredClone(await handlers.get(`desk:${name}`)({ ...event, senderFrame: null })),
  };
}

test("only supported reads from the app frame reach the GitHub transport", async (t) => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "activity-desk-"));
  t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
  const { invoke, foreign, calls } = await start(t, profile);
  assert.equal((await invoke("sign-in", token)).ok, true);
  for (const operation of ["status", "sign-in", "sign-out", "github", "open-token-page", "notes", "note-save", "note-delete"]) {
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

test("opens the fine-grained token form and keeps unsuccessful response bodies in main", async (t) => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "activity-desk-"));
  t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
  const { invoke, opened } = await start(t, profile, () => new Response("private fixture detail", {
    status: 403,
    headers: { "x-ratelimit-remaining": "0" },
  }));
  assert.equal((await invoke("open-token-page")).ok, true);
  assert.deepEqual(opened, ["https://github.com/settings/personal-access-tokens/new?name=Activity%20Desk"]);
  assert.equal((await invoke("sign-in", token)).ok, true);
  const result = await invoke("github", "profile");
  assert.equal(result.status, 403);
  assert.equal(result.remaining, "0");
  assert.equal(Object.hasOwn(result, "body"), false);
});

test("profile IPC returns only display identity", async (t) => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "activity-desk-"));
  t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
  const { invoke } = await start(t, profile, () => Response.json({
    id: 1, login: "fixture", name: "Test account", email: "fixture@example.invalid",
    avatar_url: "https://avatars.githubusercontent.com/u/1",
  }));
  assert.equal((await invoke("sign-in", token)).ok, true);
  assert.deepEqual(JSON.parse((await invoke("github", "profile")).body), {
    id: 1, login: "fixture", name: "Test account",
  });
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

test("conversations search issues and pull requests separately, each with a type qualifier", async (t) => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "activity-desk-"));
  t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
  const { invoke, calls } = await start(t, profile);
  assert.equal((await invoke("sign-in", token)).ok, true);
  assert.equal((await invoke("github", "conversations", { login: "bad login" })).status, 400);
  assert.equal((await invoke("github", "conversations", { login: "fixture" })).ok, true);
  const { query, variables } = JSON.parse(calls[0].options.body);
  assert.match(query, /issues: search\(query: \$issues, type: ISSUE/);
  assert.match(query, /pullRequests: search\(query: \$pullRequests, type: ISSUE/);
  // GitHub rejects issue searches that name neither is:issue nor is:pr.
  assert.match(variables.issues, /^involves:fixture is:issue updated:>=\d{4}-\d{2}-\d{2} sort:updated-desc$/);
  assert.match(variables.pullRequests, /^involves:fixture is:pr updated:>=\d{4}-\d{2}-\d{2} sort:updated-desc$/);
});

test("notes are per account, validated, encrypted at rest, and survive a restart", async (t) => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "activity-desk-"));
  t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
  const as = (id, login) => () => Response.json({ id, login, name: "" });
  const first = await start(t, profile, as(1, "fixture"));
  assert.equal((await first.invoke("sign-in", token)).ok, true);
  assert.deepEqual(await first.invoke("notes"), { ok: false, error: "Sign in first." }, "notes wait for the profile");
  await first.invoke("github", "profile");
  const empty = await first.invoke("notes");
  assert.deepEqual([empty.ok, empty.notes, empty.colors[0], empty.limits], [true, [], "yellow", { notes: 300, chars: 20000 }]);

  const created = await first.invoke("note-save", {});
  assert.equal(created.ok, true);
  assert.match(created.note.id, /^[0-9a-f-]{36}$/);
  assert.deepEqual([created.note.text, created.note.color, created.note.pinned], ["", "yellow", false]);
  const { id } = created.note;
  assert.equal((await first.invoke("note-save", { id, text: "Groceries\nmilk" })).note.text, "Groceries\nmilk");
  const styled = (await first.invoke("note-save", { id, color: "blue", pinned: true })).note;
  assert.deepEqual([styled.color, styled.pinned], ["blue", true]);
  for (const bad of [null, [], "text", { id: "not-a-uuid" }, { text: 1 }, { text: "x".repeat(20001) }, { color: "red" }, { pinned: "yes" }]) {
    assert.equal((await first.invoke("note-save", bad)).error, "Invalid note.", JSON.stringify(bad));
  }
  assert.equal((await first.invoke("note-save", { id: "00000000-0000-4000-8000-000000000000", text: "x" })).ok, false);
  assert.equal((await first.invoke("note-delete", "../notes.enc")).error, "Invalid note.");
  const other = (await first.invoke("note-save", { text: "Second" })).note.id;

  const stored = fs.readFileSync(path.join(profile, "notes.enc"), "utf8");
  assert.match(stored, /^mock:/);
  assert.doesNotMatch(stored, /Groceries/);

  const restarted = await start(t, profile, as(1, "fixture"));
  await restarted.invoke("github", "profile");
  assert.deepEqual((await restarted.invoke("notes")).notes.map((n) => [n.text, n.color, n.pinned]),
    [["Groceries\nmilk", "blue", true], ["Second", "yellow", false]]);
  assert.equal((await restarted.invoke("note-delete", other)).ok, true);
  assert.equal((await restarted.invoke("notes")).notes.length, 1);

  const someoneElse = await start(t, profile, as(2, "other"));
  await someoneElse.invoke("github", "profile");
  assert.deepEqual((await someoneElse.invoke("notes")).notes, [], "another account sees none of these notes");
  assert.equal((await restarted.invoke("sign-out")).ok, true);
  assert.equal(fs.existsSync(path.join(profile, "notes.enc")), true, "sign-out keeps notes");
});

test("an unreadable notes file is set aside instead of overwritten", async (t) => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "activity-desk-"));
  t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
  fs.writeFileSync(path.join(profile, "notes.enc"), "mock:not base64 json");
  const { invoke } = await start(t, profile, () => Response.json({ id: 1, login: "fixture" }));
  assert.equal((await invoke("sign-in", token)).ok, true);
  await invoke("github", "profile");
  const result = await invoke("notes");
  assert.deepEqual([result.ok, result.notes], [true, []]);
  assert.match(result.note, /could not be read.*notes-unreadable-\d+\.enc/);
  const kept = fs.readdirSync(profile).filter((f) => f.startsWith("notes-unreadable-"));
  assert.equal(kept.length, 1);
  assert.equal(fs.readFileSync(path.join(profile, kept[0]), "utf8"), "mock:not base64 json");
  assert.equal(fs.existsSync(path.join(profile, "notes.enc")), false);
});
