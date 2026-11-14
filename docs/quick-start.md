# Quick start

1. On an Apple silicon Mac, download `Activity-Desk-macos-arm64.zip` and its `.sha256` file from the [latest release](https://github.com/cgfixit/activity-desk/releases/latest). Sign in to GitHub with an account that has access to the repository.
2. In the download directory, run `shasum -a 256 -c Activity-Desk-macos-arm64.zip.sha256`. Continue after the archive reports `OK`.
3. Unzip the archive and open **Activity Desk**. Current builds use an ad-hoc signature and lack Apple notarization. See the [release notes for maintainers](development.md#automated-releases) for details.
4. In Activity Desk, select **Which token should I use?**, then **Create a fine-grained token**. Start with a fine-grained personal access token. Grant **Events** read access for private activity and **Pull requests** read access for the selected repositories whose private PR details you want to see.
5. Paste the token into Activity Desk and select **Sign in**. Open **Data & access** to see what GitHub returned for that token.

GitHub's unread notifications endpoint requires a classic token with the `notifications` scope. Grant only the permissions you need. [GitHub personal access token documentation](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)

For a local build, see [Development and releases](development.md).
