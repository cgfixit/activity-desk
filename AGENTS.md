# Activity Desk

The workspace copy of `Activity Desk.app` is the starting point. Its unpacked app files live in `Activity Desk.app/Contents/Resources/app/`. Keep the bundled Electron runtime and stock assets out of Git.

## Code map

- `main.js` owns the window, tray, token storage for up to two tokens of one account (a fine-grained and a classic slot), the choice of which token answers each read, authenticated GitHub requests, the encrypted saved history it records from those responses (plus weekly outcome snapshots it validates by key and range), the encrypted per-account notes behind Stream → Notes, and the encrypted per-account suggestion card states (trying, snoozed, dismissed), keyed by rule id or, in a repository view, `rule@owner/repo`. It also opens Suggestions' further-reading links by catalogue id. `preload.js` exposes the `window.desk` IPC bridge.
- `renderer.js` loads GitHub REST and GraphQL data and renders Overview, Stream, Insights, Suggestions, and Data & access. `insights.js` computes the summaries, comment text, the suggestion rules, and the `READING` catalogue of sources. It can be required from Node. `notes.js` formats notes for display and can be required from Node.
- `index.html` defines the views and Content Security Policy. `styles.css` controls their layout. `Activity Desk.app/Contents/Info.plist` holds the macOS bundle metadata.

## Working on the app

- Preserve renderer sandboxing, context isolation, disabled Node integration, and the renderer's network restrictions. Keep stored credentials in the main process. Enforce read-only GitHub operations at the main-process boundary.
- Save a token only after GitHub confirms it, and a second token only when GitHub reports the same account for both. The renderer may name a token slot for a read but never receives a token. Say which token answered when a summary joins both.
- The public view has a username and no token. Keep its reads to the public allowlist in `publicRequest()`, for the saved username only, with no credential attached. Keep notes and saved history closed in it, since a username does not prove who is asking. Stay within GitHub's 60 requests an hour for unauthenticated use, and its separate 10 searches a minute for the public pull request search.
- Distinguish the recent Events feed, sampled pull-request details, and the contribution year. Show capped, partial, and unavailable results explicitly when changing summaries.
- Give each suggestion a minimum sample. Cite a `READING` entry for every claim in its Why text, and check the claim against the source first. The main process opens only catalogued links whose host is in `READING_HOSTS`, and github.com pages it builds itself in `githubPageUrl()` from a validated repository name and number. Never accept a URL from the window.
- Use `node --check` on changed JavaScript and run the affected behavior with synthetic GitHub responses. The package has no build or test scripts. The HTML requires the preload bridge for authenticated views.
- For native verification, use a scratch bundle with a distinct app identity. Set Electron's `userData` and `sessionData` to a verified temporary directory before startup and use synthetic tokens. Confirm Computer Use is attached to the scratch bundle before interacting with it.
