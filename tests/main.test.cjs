const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { pathToFileURL } = require("node:url");
const vm = require("node:vm");

const payload = path.resolve(__dirname, "../Activity Desk.app/Contents/Resources/app");
const token = "synthetic-token-for-unit-checks";
const fineGrained = "github_pat_synthetic_token_for_unit_checks";
const bearer = (options) => options.headers.Authorization.replace("Bearer ", "");
const isUser = (url) => url === "https://api.github.com/user";

// Sign-in asks GitHub whose token it is, so the default fixture answers /user with an account.
async function start(t, profile, response = (url) => (isUser(url) ? Response.json({ id: 1, login: "fixture" }) : new Response("{}"))) {
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
      return response(url, options);
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
  // Saving a token costs one read of /user, which confirms the token and names its account.
  assert.deepEqual(calls.map((c) => [c.url, c.options.method, c.options.redirect]), [["https://api.github.com/user", undefined, "error"]]);
  calls.length = 0;
  for (const operation of ["status", "sign-in", "sign-out", "remove-token", "github", "open-token-page", "notes", "note-save", "note-delete"]) {
    assert.equal((await foreign(operation)).status, 403);
  }
  assert.equal((await invoke("github", "unsupported")).status, 400);
  assert.equal((await invoke("github", "events", { login: "fixture", page: 4 })).status, 400);
  assert.equal((await invoke("github", "pullRequests", [{ repo: "fixture/example", number: -1 }])).status, 400);
  assert.equal((await invoke("github", "profile", undefined, "other")).status, 400);
  assert.equal((await invoke("remove-token", "other")).status, 400);
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

test("opens the token forms and keeps unsuccessful response bodies in main", async (t) => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "activity-desk-"));
  t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
  let denied = false;
  const { invoke, opened } = await start(t, profile, () => (denied ? new Response("private fixture detail", {
    status: 403,
    headers: { "x-ratelimit-remaining": "0" },
  }) : Response.json({ id: 1, login: "fixture" })));
  assert.equal((await invoke("open-token-page")).ok, true);
  assert.equal((await invoke("open-token-page", "classic")).ok, true);
  assert.equal((await invoke("open-token-page", "https://example.invalid")).status, 400);
  assert.deepEqual(opened, [
    "https://github.com/settings/personal-access-tokens/new?name=Activity%20Desk",
    "https://github.com/settings/tokens/new?description=Activity%20Desk&scopes=notifications",
  ]);
  assert.equal((await invoke("sign-in", token)).ok, true);
  denied = true;
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
  const encrypted = path.join(profile, "github-tokens.enc");
  fs.writeFileSync(legacy, token, { mode: 0o600 });
  const first = await start(t, profile);
  assert.deepEqual(await first.invoke("status"), { ok: true, signedIn: true, kind: "GitHub", tokens: { "fine-grained": null, classic: "GitHub" } });
  assert.equal(fs.existsSync(legacy), false);
  assert.match(fs.readFileSync(encrypted, "utf8"), /^mock:/);
  assert.doesNotMatch(fs.readFileSync(encrypted, "utf8"), /synthetic/);
  const restarted = await start(t, profile);
  assert.equal((await restarted.invoke("status")).signedIn, true);
  // The single encrypted file of the previous version moves into the token store as well.
  const earlier = fs.mkdtempSync(path.join(os.tmpdir(), "activity-desk-"));
  t.after(() => fs.rmSync(earlier, { recursive: true, force: true }));
  fs.writeFileSync(path.join(earlier, "github-token.enc"), "mock ciphertext");
  const upgraded = await start(t, earlier);
  assert.deepEqual((await upgraded.invoke("status")).tokens, { "fine-grained": null, classic: "GitHub" });
  assert.deepEqual(fs.readdirSync(earlier), ["github-tokens.enc"]);
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
  const { query, variables } = JSON.parse(calls.at(-1).options.body);
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

test("a second token is saved only for the same account, and each read goes to the right token", async (t) => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "activity-desk-"));
  t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
  const stranger = "ghp_synthetic_token_for_another_account";
  const revoked = "ghp_synthetic_token_that_was_revoked";
  const owners = { [fineGrained]: { id: 1, login: "fixture" }, [token]: { id: 1, login: "fixture" }, [stranger]: { id: 2, login: "stranger" } };
  let limited = false;
  const { invoke, calls } = await start(t, profile, (url, options) => {
    const who = bearer(options);
    if (!owners[who]) return new Response("", { status: 401 });
    if (isUser(url)) return Response.json(owners[who]);
    if (limited) return new Response("", { status: 403, headers: { "x-ratelimit-remaining": "0" } });
    if (url.includes("/traffic/") && who === fineGrained) {
      return new Response("", { status: 403, headers: { "x-accepted-github-permissions": "administration=read" } });
    }
    return new Response("[]", { headers: { "x-oauth-scopes": who === token ? "notifications" : "" } });
  });
  const used = () => calls.splice(0).map((c) => bearer(c.options));

  assert.equal((await invoke("sign-in", revoked)).status, 401);
  assert.equal((await invoke("status")).signedIn, false, "a rejected token is not saved");
  const first = await invoke("sign-in", fineGrained);
  assert.deepEqual([first.ok, first.slot, first.replaced, first.tokens], [true, "fine-grained", false, { "fine-grained": "fine-grained", classic: null }]);
  assert.equal((await invoke("github", "notifications")).status, 403, "notifications wait for a classic token");
  assert.equal((await invoke("github", "profile", undefined, "classic")).status, 400);
  used();

  const refused = await invoke("sign-in", stranger);
  assert.equal(refused.status, 409);
  assert.match(refused.error, /@stranger.*@fixture/);
  assert.deepEqual((await invoke("status")).tokens, { "fine-grained": "fine-grained", classic: null });
  const second = await invoke("sign-in", token);
  assert.deepEqual([second.ok, second.slot, second.tokens], [true, "classic", { "fine-grained": "fine-grained", classic: "GitHub" }]);
  assert.doesNotMatch(fs.readFileSync(path.join(profile, "github-tokens.enc"), "utf8"), /synthetic/);
  used();

  const inbox = await invoke("github", "notifications");
  assert.deepEqual([inbox.ok, inbox.via, used()], [true, "classic", [token]]);
  const profileRead = await invoke("github", "profile");
  assert.deepEqual([profileRead.via, profileRead.skipped, used()], ["fine-grained", [], [fineGrained]]);
  assert.equal((await invoke("github", "events", { login: "fixture", page: 1 }, "classic")).via, "classic");
  assert.deepEqual(used(), [token], "a named slot uses only that token");

  // GitHub denies the fine-grained token, the classic one answers, and it goes first from then on.
  const views = await invoke("github", "traffic", { repo: "fixture/example", kind: "views" });
  assert.deepEqual([views.ok, views.via, views.skipped.map((s) => [s.slot, s.status, s.token.accepted])],
    [true, "classic", [["fine-grained", 403, "administration=read"]]]);
  assert.deepEqual(used(), [fineGrained, token]);
  assert.equal((await invoke("github", "traffic", { repo: "fixture/example", kind: "clones" })).via, "classic");
  assert.deepEqual(used(), [token]);
  // Both tokens share the account's rate limit, so a rate-limited read is not repeated.
  limited = true;
  const stars = await invoke("github", "stargazers", { repo: "fixture/example" });
  assert.deepEqual([stars.status, stars.via, used()], [403, "fine-grained", [fineGrained]]);
  limited = false;

  assert.deepEqual((await invoke("remove-token", "fine-grained")).tokens, { "fine-grained": null, classic: "GitHub" });
  assert.equal((await invoke("github", "profile")).via, "classic");
  const last = await invoke("remove-token", "classic");
  assert.deepEqual([last.ok, last.signedIn], [true, false]);
  assert.equal(fs.existsSync(path.join(profile, "github-tokens.enc")), false);
});
