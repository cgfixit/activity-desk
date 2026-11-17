# Activity Desk

Activity Desk is a read-only GitHub dashboard for Apple silicon Macs. Use it to catch up on recent activity across your repositories, spot open pull requests and review requests in the loaded data, and compare contribution trends over time.

- **Stream** shows your recent events and, under **Conversations**, the latest comments and reviews from anyone on issues and pull requests that involve you, open or closed. Each refresh reads those threads directly, so new replies appear without waiting for GitHub's activity feed. Comment, review, and agent rows show what was written, and longer text expands in place.
- **Stream → Notes** keeps sticky notes beside your activity, in a list-and-editor layout like Apple Notes. Notes save as you type, can be pinned, colored, searched, and deleted, and stay on your Mac, encrypted, between launches and after you sign out.
- **Insights → Patterns** goes beyond raw counts. It shows how concentrated your output is, whether weekly output shifted, how often branches reach a merge, how long your pull requests wait for a human review, and who you review with in each direction. Each finding names its source and needs a minimum sample before it appears. Pull request findings cover every pull request you opened in the last 90 days, found by search, not only those that appear in the Events feed.
- **Insights → All years** compares every calendar year on your account: this year's pace against the same date last year, your busiest full year, your strongest month across years, how weekend work changed, and your longest streak.
- **Insights → Footprint** shows who finds your repositories: page views, unique visitors, clones, referring sites, and new stars. GitHub keeps only 14 days of traffic. To show trends over months, you can turn on saved history, which keeps daily traffic on your Mac, encrypted. It is off until you turn it on.
- **Suggestions** turns patterns in the loaded data into specific changes to try, such as splitting large pull requests, asking for a reviewer up front, or reviewing agent branches before merging. Each card says what it saw and what to try. Where it gives a reason, each claim links to its source, and further reading opens in your browser. A list shows every check, including those without enough data.
- **Data & access** checks the token itself: when it expires, whether a classic token's scopes allow writes, which permission GitHub says a denied request needs, and how much of the REST and GraphQL rate limits remain.

- [Quick start](docs/quick-start.md) for installation and GitHub token setup
- [User guide](docs/user-guide.md) for the dashboard, data limits, and privacy
- [Documentation](docs/) for setup, usage, and release maintenance

![Activity Desk showing contribution trends for a fictional account](docs/screenshots/contribution-year.png)

Activity Desk reads GitHub data using a token you provide. A read-only fine-grained token is recommended. macOS Keychain backs encryption of the saved token. See the [security policy](SECURITY.md) for private vulnerability reporting.
