#!/bin/bash
set -euo pipefail

: "${GH_TOKEN:?}" "${COMMIT:?}" "${REPOSITORY:?}"
consecutive=0
for ((attempt = 1; attempt <= 180; attempt++)); do
  echo "Checking commit status ($attempt/180)"
  checks=$(gh api --paginate "repos/$REPOSITORY/commits/$COMMIT/check-runs?per_page=100" --jq '.check_runs[] | {id, name, status, conclusion, app: .app.slug}')
  statuses=$(gh api --paginate "repos/$REPOSITORY/commits/$COMMIT/statuses?per_page=100" --jq '.[] | {id, context, state}')
  if printf '%s\n' "$checks" | jq -s -e '
    sort_by(.id) | group_by([.app, .name]) | map(last) |
    map(select(.app != "github-actions" or (.name != "release" and (.name != "Adjust Configuration" or .conclusion != "skipped")))) as $checks |
    (["verify", "Analyze (javascript-typescript)", "Analyze (actions)"] | all(. as $name | any($checks[]; .name == $name and .app == "github-actions" and .status == "completed" and .conclusion == "success"))) and
    all($checks[]; .status == "completed" and .conclusion == "success")
  ' >/dev/null && printf '%s\n' "$statuses" | jq -s -e 'sort_by(.id) | group_by(.context) | map(last) | all(.[]; .state == "success")' >/dev/null; then
    consecutive=$((consecutive + 1))
    if [ "$consecutive" -ge 6 ]; then exit 0; fi
  else
    consecutive=0
  fi
  sleep 10
done
echo "Required checks did not all succeed within 30 minutes." >&2
exit 1
