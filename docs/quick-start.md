# Quick start

1. On an Apple silicon Mac, download `Activity-Desk-macos-arm64.zip` and its `.sha256` file from the [latest release](https://github.com/cgfixit/activity-desk/releases/latest). Sign in to GitHub with an account that has access to the repository.
2. In the download directory, run `shasum -a 256 -c Activity-Desk-macos-arm64.zip.sha256`. Continue after the archive reports `OK`.
3. Unzip the archive and open **Activity Desk**. Current builds use an ad-hoc signature and lack Apple notarization. See the [release notes for maintainers](development.md#automated-releases) for details.
4. In Activity Desk, select **Which token should I use?**, then **Create a fine-grained token**. We recommend one read-only fine-grained personal access token:
   - **Resource owner:** your account. A fine-grained token covers one account or organization, so organization repositories need a token for that organization.
   - **Repository access:** all repositories, or the ones you want covered.
   - **Permissions, all read-only:** the account permission **Events** for private activity, **Pull requests** for private PR details and review comments, **Issues** for conversations on private issues, **Dependabot alerts** for the security suggestion, and **Contents** for community profiles of private repositories. Add **Administration** to see repository traffic in **Footprint**. Read access to Administration cannot change anything. GitHub adds **Metadata** automatically. Activity Desk needs no write permission.
5. Paste the token into Activity Desk and select **Sign in**. Activity Desk asks GitHub whose token it is and saves it only when GitHub accepts it. Open **Data & access** to see what GitHub returned for that token. **Token check** shows the expiry when GitHub reports one and names the permission GitHub asks for when a request is denied.
6. Optional: add a classic token for the same account. GitHub serves unread notifications only to classic tokens, and a fine-grained token reaches one account or organization. In **Data & access → Token check**, select **Create a classic token**, which opens GitHub's classic token form. Select only the `notifications` scope and set an expiration. The link asks GitHub to preselect that scope, but check it before you generate the token. Paste the new token into **Add a second token for this account** and select **Save token**. Activity Desk refuses a token that belongs to a different account.

You can also sign in with a classic token first and add a fine-grained one later. With both saved, the classic token reads notifications, both read your events, pull requests, and conversations, and the fine-grained token goes first for everything else. See [Using two tokens](user-guide.md#using-two-tokens). Grant only the permissions you need. A classic token with only `notifications` cannot change anything, while GitHub's classic `repo` scope also grants write access to private repositories. [GitHub personal access token documentation](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)

## Without a token

To look before you create a token, type a GitHub username under **GitHub username, without a token** on the sign-in screen and select **View public activity**. Activity Desk shows that account's public events, public repositories, stars, and the public pull requests it opened in the last 90 days, with merge times, follow-up fixes, and open work. Everything else needs a token, and you can add one later in **Data & access** without starting over. See [Viewing without a token](user-guide.md#viewing-without-a-token).

For a local build, see [Development and releases](development.md).
