# User guide

Activity Desk gives you one place to review GitHub activity across the repositories visible to your token. See [Quick start](quick-start.md) to install the app and sign in.

## Views

- **Overview** highlights recent contribution trends, open pull requests in the loaded sample, and unread notifications when available.
- **Stream** filters loaded events by type, repository, and search text. Clear **Hide routine changes** to include events such as PR label changes. **Mark all seen** updates a timestamp for your account on this Mac.
- **Insights** shows your contribution calendar, an event heatmap, and merge timing, recorded reviews, and change sizes for sampled pull requests. In **Recent events**, select a repository to open its events in Stream.
- **Data & access** shows which sources loaded and flags limits, missing data, and permission errors.

![Recent events and repository filters using fictional activity](screenshots/recent-events.png)

## What the numbers cover

| Source | Coverage |
| --- | --- |
| [Recent events](https://docs.github.com/en/rest/activity/events) | Up to 300 recent events from the past 30 days. GitHub can delay events, and token permissions affect what appears. |
| Pull requests | Details for up to 40 distinct PRs referenced in the loaded events. Review counts reflect records visible at refresh time. |
| [Contribution year](https://docs.github.com/en/graphql/reference/users#contributionscollection) | GitHub's rolling contribution calendar and up to 10 repository totals for commit contributions. The 30-day comparison includes today. |
| [Unread notifications](https://docs.github.com/en/rest/activity/notifications) | The first page of up to 50 unread notifications with a supported token. |

Push counts describe the reported refs, including branches named `main` or `master`, other branches, and tags. A branch name alone cannot establish default-branch status or whether a push bypassed review. Agent signals are estimates based on known app slugs and branch prefixes.

## Local data and privacy

The main process sends the token to `api.github.com` for allowlisted reads. macOS Keychain backs encryption of the token in the local Electron profile. Activity Desk encrypts a legacy plaintext token on first use.

**Sign out** clears the dashboard and removes the saved token. The account's seen timestamp remains in the local profile. The dashboard can display private repository names and activity. Use a separate profile and synthetic data for screenshots you plan to share.
