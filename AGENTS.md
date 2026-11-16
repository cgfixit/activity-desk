# Activity Desk

The workspace copy of `Activity Desk.app` is the starting point. Its unpacked app files live in `Activity Desk.app/Contents/Resources/app/`. Keep the bundled Electron runtime and stock assets out of Git.

## Code map

- `main.js` owns the window, tray, token storage, authenticated GitHub requests, the encrypted saved history it records from those responses, and the encrypted per-account notes behind Stream → Notes. `preload.js` exposes the `window.desk` IPC bridge.
- `renderer.js` loads GitHub REST and GraphQL data and renders Overview, Stream, Insights, and Data & access. `insights.js` computes the summaries and comment text and can be required from Node. `notes.js` formats notes for display and can be required from Node.
- `index.html` defines the views and Content Security Policy. `styles.css` controls their layout. `Activity Desk.app/Contents/Info.plist` holds the macOS bundle metadata.

## Working on the app

- Preserve renderer sandboxing, context isolation, disabled Node integration, and the renderer's network restrictions. Keep stored credentials in the main process. Enforce read-only GitHub operations at the main-process boundary.
- Distinguish the recent Events feed, sampled pull-request details, and the contribution year. Show capped, partial, and unavailable results explicitly when changing summaries.
- Use `node --check` on changed JavaScript and run the affected behavior with synthetic GitHub responses. The package has no build or test scripts. The HTML requires the preload bridge for authenticated views.
- For native verification, use a scratch bundle with a distinct app identity. Set Electron's `userData` and `sessionData` to a verified temporary directory before startup and use synthetic tokens. Confirm Computer Use is attached to the scratch bundle before interacting with it.
