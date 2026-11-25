# Development and releases

## Build locally

The repository tracks the app source under `Activity Desk.app/Contents/Resources/app/` and the macOS bundle metadata. The Electron runtime is fetched during packaging.

On Apple silicon macOS with Node.js 22.12 or newer and npm, run the packaging script from a Git checkout.

```sh
bash scripts/package-macos.sh /path/to/output
```

The script verifies the pinned Electron archive's SHA-256 and uses lockfile-pinned build tools to package tracked source into `app.asar`. It records the archive header hash in the bundle, enables Electron's archive validation, requires the archive at launch, and disables Electron's Node execution, Node environment options, and Node inspector command-line flags. It ad-hoc signs the bundle and Electron helpers with Hardened Runtime. The main app and renderer helper get the JIT entitlement. These ad-hoc builds use the library-validation exception because the bundled frameworks have no Team ID. The signed executables retain the Hardened Runtime protection against DYLD environment overrides. The script checks the fuse states, archive header hash, signed entitlements, and code signatures before writing the ZIP and its checksum.

To update Electron, verify the new arm64 archive digest against the [upstream release](https://github.com/electron/electron/releases), update the packaging pin, and review the bundle metadata and fuse checks against the new runtime. Build and exercise the new app before shipping it.

## Verification

Run `actionlint` for GitHub Actions and `shellcheck scripts/*.sh` for packaging scripts. The Verify workflow checks JavaScript syntax, runs the Node test fixtures, lints workflows and scripts, and scans for dotenv files and secrets. The macOS package check builds and validates the ZIP on relevant pull requests. The app has no runtime npm dependencies. Dependabot monitors the build tools and GitHub Actions pins. Electron and the workflow's lint and scan tools use versioned downloads and checksum pins that maintainers update when reviewing their upstream releases.

For a native fixture run, use a scratch bundle identity. Set Electron's `userData` and `sessionData` to temporary directories before loading `main.js`, then use synthetic credentials and GitHub responses. Authenticated views require the preload bridge. To test the hardened runtime with a fixture entry point, assemble its payload in a separate directory and run `node scripts/electron-package/macos.mjs pack /path/to/Scratch.app /path/to/fixture-payload` after editing the scratch bundle metadata. This rebuilds the integrity-checked archive and signs the scratch bundle. On Linux, use the Electron version pinned in the packaging script under `xvfb-run` with Playwright's `_electron` API. Root containers need `--no-sandbox`, and `--password-store=basic` replaces the Keychain, so on-disk checks there show that notes and tokens are not plaintext, not that they are Keychain-protected.

## Automated releases

After a pull request merges into `main`, the release workflow waits for Verify, both CodeQL analyses, and other checks reported on that commit. It allows GitHub's skipped CodeQL configuration adjustment. The gate waits for six consecutive successful polls across 50 seconds. Checks that register after that window can arrive after publication.

Each release tag contains the merge commit SHA. The release ZIP contains an Apple silicon build with an ad-hoc signature. Gatekeeper can block these builds. Developer ID signing, notarization, and clean Mac upgrade verification are tracked in [issue #2](https://github.com/cgfixit/activity-desk/issues/2).
