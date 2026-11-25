import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPackage, getRawHeader } from "@electron/asar";
import { flipFuses, FuseState, FuseV1Options, FuseVersion, getCurrentFuseWire } from "@electron/fuses";

const [mode, app, payload] = process.argv.slice(2);
assert(app?.endsWith(".app") && (mode === "verify" || (mode === "pack" && payload)),
  "Usage: node macos.mjs pack <bundle.app> <payload> | verify <bundle.app>");

const contents = path.join(app, "Contents");
const plist = path.join(contents, "Info.plist");
const resources = path.join(contents, "Resources");
const frameworks = path.join(contents, "Frameworks");
const archive = path.join(resources, "app.asar");
const nested = readdirSync(frameworks);
const helpers = nested.filter((name) => name.endsWith(".app"));
const renderer = "Electron Helper (Renderer).app";
const jitEntitlements = fileURLToPath(new URL("./jit.entitlements.plist", import.meta.url));
const adhocEntitlements = fileURLToPath(new URL("./adhoc.entitlements.plist", import.meta.url));
const fusePolicy = {
  [FuseV1Options.RunAsNode]: false,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
  [FuseV1Options.OnlyLoadAppFromAsar]: true,
};

function archiveIntegrity() {
  const hash = createHash("sha256").update(getRawHeader(archive).headerString).digest("hex");
  return { "Resources/app.asar": { algorithm: "SHA256", hash } };
}

function sign(target, options = []) {
  execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", ...options, target], { stdio: "inherit" });
}

if (mode === "pack") {
  await createPackage(payload, archive);
  execFileSync("/usr/bin/plutil", ["-replace", "ElectronAsarIntegrity", "-json", JSON.stringify(archiveIntegrity()), plist]);
  rmSync(path.join(resources, "default_app.asar"), { force: true });
  await flipFuses(app, { version: FuseVersion.V1, ...fusePolicy });

  // The stock frameworks need resource seals, including Electron Framework with its changed fuses.
  for (const framework of nested.filter((name) => name.endsWith(".framework"))) {
    sign(path.join(frameworks, framework));
  }
  for (const helper of helpers) {
    const entitlements = helper === renderer ? jitEntitlements : adhocEntitlements;
    sign(path.join(frameworks, helper), ["--options", "runtime", "--entitlements", entitlements]);
  }
  sign(app, ["--options", "runtime", "--entitlements", jitEntitlements]);
}

assert(helpers.includes(renderer), "Missing Electron renderer helper");
assert(!existsSync(path.join(resources, "app")), "Found loose application source beside app.asar");
assert(!existsSync(path.join(resources, "default_app.asar")), "Found stock Electron app");
const metadata = execFileSync("/usr/bin/plutil", ["-extract", "ElectronAsarIntegrity", "json", "-o", "-", plist], { encoding: "utf8" });
assert.deepEqual(JSON.parse(metadata), archiveIntegrity(), "Application ASAR header hash does not match Info.plist");

const wire = await getCurrentFuseWire(app);
assert.equal(wire.version, FuseVersion.V1);
for (const [key, enabled] of Object.entries(fusePolicy)) {
  assert.equal(wire[key], enabled ? FuseState.ENABLE : FuseState.DISABLE, `Unexpected fuse state for ${FuseV1Options[key]}`);
}
for (const target of [app, ...helpers.map((helper) => path.join(frameworks, helper))]) {
  const signature = spawnSync("/usr/bin/codesign", ["--display", "--verbose=2", "--xml", "--entitlements", "-", target], { encoding: "utf8" });
  assert.equal(signature.status, 0, signature.stderr);
  assert.match(signature.stderr, /flags=[^\n]*\bruntime\b/, `Hardened Runtime flag missing on ${target}`);
  const actual = execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", "--", "-"], { input: signature.stdout, encoding: "utf8" });
  // Ad-hoc signatures have no Team ID to match when Electron loads the bundled frameworks.
  const expected = { "com.apple.security.cs.disable-library-validation": true };
  if (target === app || path.basename(target) === renderer) expected["com.apple.security.cs.allow-jit"] = true;
  assert.deepEqual(JSON.parse(actual), expected, `Unexpected runtime entitlements on ${target}`);
}
execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", app], { stdio: "inherit" });
