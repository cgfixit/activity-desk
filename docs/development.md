# Development and releases

## Build locally

The repository tracks the app source under `Activity Desk.app/Contents/Resources/app/` and the macOS bundle metadata. The Electron runtime is fetched during packaging.

On Apple silicon macOS, run the packaging script from a Git checkout.

```sh
bash scripts/package-macos.sh /path/to/output
```

The script verifies the pinned Electron archive's SHA-256, assembles the app from tracked source files and ad-hoc signs it, and writes the app ZIP and its checksum. To update Electron, verify the new arm64 archive digest against the [upstream release](https://github.com/electron/electron/releases), update the packaging pin and review the bundle metadata against the new runtime. Build and exercise the new app before shipping it.

## Verification

Run `actionlint` for GitHub Actions and `shellcheck scripts/*.sh` for packaging scripts. The Verify workflow checks JavaScript syntax, runs the Node test fixtures, lints workflows and scripts, and scans for dotenv files and secrets. The macOS package check builds and validates the ZIP on relevant pull requests. The app manifest has no npm dependencies. Dependabot monitors GitHub Actions pins. Electron and the workflow's lint and scan tools use versioned downloads and checksum pins that maintainers update when reviewing their upstream releases.

For a native fixture run, use a scratch bundle identity. Set Electron's `userData` and `sessionData` to temporary directories before loading `main.js`, then use synthetic credentials and GitHub responses. Authenticated views require the preload bridge. On Linux, the same scratch bundle can run under `xvfb-run` with the Electron version pinned in the packaging script, driven by Playwright's `_electron` API. Root containers need `--no-sandbox`, and `--password-store=basic` replaces the Keychain, so on-disk checks there show that notes and tokens are not plaintext, not that they are Keychain-protected.

## Automated releases

After a pull request merges into `main`, the release workflow waits for Verify, both CodeQL analyses, and other checks reported on that commit. It allows GitHub's skipped CodeQL configuration adjustment. The gate waits for six consecutive successful polls across 50 seconds. Checks that register after that window can arrive after publication.

Each release tag contains the merge commit SHA. The release ZIP contains an Apple silicon build with an ad-hoc signature. Gatekeeper can block these builds. Developer ID signing, notarization, and clean Mac upgrade verification are tracked in [issue #2](https://github.com/cgfixit/activity-desk/issues/2).
