# Quick start

1. On an Apple silicon Mac, download `Activity-Desk-macos-arm64.zip` and its `.sha256` file from the [latest release](https://github.com/cgfixit/activity-desk/releases/latest). Sign in to GitHub with an account that has access to the repository.
2. In the download directory, run `shasum -a 256 -c Activity-Desk-macos-arm64.zip.sha256`. Continue after the archive reports `OK`.
3. Unzip the archive and open **Activity Desk**. Current builds use an ad-hoc signature and lack Apple notarization. See the [release notes for maintainers](development.md#automated-releases) for details.
4. In Activity Desk, select **Which token should I use?**, then **Create a fine-grained token**. We recommend one read-only fine-grained personal access token:
   - **Resource owner:** your account. A fine-grained token covers one account or organization, so organization repositories need a token for that organization.
   - **Repository access:** all repositories, or the ones you want covered.
   - **Permissions, all read-only:** the account permission **Events** for private activity, **Pull requests** for private PR details and review comments, and **Issues** for conversations on private issues. GitHub adds **Metadata** automatically. Activity Desk needs no write permission.
5. Paste the token into Activity Desk and select **Sign in**. Open **Data & access** to see what GitHub returned for that token. **Token check** shows the expiry when GitHub reports one and names the permission GitHub asks for when a request is denied.

GitHub's unread notifications endpoint requires a classic token with the `notifications` scope. Grant only the permissions you need. [GitHub personal access token documentation](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)

For a local build, see [Development and releases](development.md).
