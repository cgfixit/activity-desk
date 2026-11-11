# Activity Desk

Activity Desk is a macOS Electron dashboard for GitHub activity, pull requests, notifications, and contribution trends.

## Run a local copy

This repository contains the app payload and bundle metadata. Use an existing compatible arm64 Activity Desk bundle with Electron 45 or later. Copy the bundle to a separate development location, then copy the contents of `Activity Desk.app/Contents/Resources/app/` into the development bundle's `Contents/Resources/app/`. The supplied launcher does not have a complete bundle signature. Distribution requires a separately built and signed package.

For fixture runs, use a separate bundle identity and set both Electron data paths before loading `main.js`. Use synthetic credentials and GitHub responses. Run the focused main-process checks with `node --test tests/main.test.cjs`.

## GitHub access and local data

Use a fine-grained GitHub token with access to the repositories you want to see. Grant read access to Events and Pull requests where needed. GitHub requires a classic token for its notifications endpoint. A classic token's repository scopes can grant write permissions to other clients using that token.

Activity Desk sends the token to `api.github.com` for specific read operations. macOS Keychain backs encryption of the token stored in the local Electron profile. On first use after an upgrade, the app encrypts the old token and removes the plaintext file. Sign-out clears the dashboard and removes saved credentials. The app keeps a local timestamp per GitHub account for events marked seen. An old profile-wide timestamp has no account identity, so the updated app starts a fresh timestamp for each account.

Stream and review summaries cover the data loaded for the current token. The app flags page failures, capped results, and unavailable PR details. GitHub may delay events or omit activity outside its Events feed.

For vulnerability reporting, see [SECURITY.md](SECURITY.md).
