const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");

test("release gate requires successful checks and allows the skipped CodeQL adjustment", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "activity-desk-gate-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "gh"), `#!/bin/bash
if [[ "$*" == *check-runs* ]]; then
  printf '%s\\n' '{"id":1,"name":"verify","status":"completed","conclusion":"success","app":"github-actions"}' '{"id":2,"name":"Analyze (javascript-typescript)","status":"completed","conclusion":"success","app":"github-actions"}' '{"id":3,"name":"Analyze (actions)","status":"completed","conclusion":"success","app":"github-actions"}' '{"id":4,"name":"Adjust Configuration","status":"completed","conclusion":"skipped","app":"github-actions"}'
  if [[ "$GATE_FAILURE" == yes ]]; then printf '%s\\n' '{"id":5,"name":"external","status":"completed","conclusion":"failure","app":"other"}'; fi
fi
`, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "sleep"), "#!/bin/bash\nexit 0\n", { mode: 0o755 });
  const run = (failure) => spawnSync("bash", [path.join(__dirname, "../scripts/wait-for-checks.sh")], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, GH_TOKEN: "fixture", COMMIT: "fixture", REPOSITORY: "fixture/repo", GATE_FAILURE: failure },
  });
  assert.equal(run("no").status, 0);
  const failed = run("yes");
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /did not all succeed/);
});
