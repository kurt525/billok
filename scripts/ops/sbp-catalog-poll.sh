#!/usr/bin/env bash
# Designed for a dedicated VPS systemd timer, not GitHub Actions.
set -euo pipefail

repo=kurt525/billok
state_dir=/var/lib/billok-sbp-sync
branch_prefix=billok/sbp-catalog-
node_dir=/opt/actions-runner-billok/_work/_tool/node/22.23.4/x64/bin
export PATH="$node_dir:$PATH"

test -x "$node_dir/node"
command -v gh >/dev/null
command -v git >/dev/null
command -v flock >/dev/null
mkdir -p "$state_dir"
exec 9>"$state_dir/sync.lock"
if ! flock -n 9; then
  echo 'SBP registry synchronization is already running'
  exit 0
fi

# Reuse an open proposal; do not spawn daily PRs or rewrite branch history.
existing="$(gh pr list --repo "$repo" --state open --limit 100 --json headRefName   --jq 'map(select(.headRefName | startswith("billok/sbp-catalog-"))) | .[0].headRefName // ""')"
if [[ -n "$existing" ]]; then
  branch="$existing"
else
  branch="$branch_prefix$(date -u +%Y%m%d%H%M%S)"
fi

work="$(mktemp -d "$state_dir/job.XXXXXXXX")"
cleanup() {
  if [[ -n "$work" && -d "$work" && "$work" == "$state_dir"/job.* ]]; then
    rm -rf -- "$work"
  fi
}
trap cleanup EXIT

if [[ -n "$existing" ]]; then
  git clone --quiet --depth 1 --branch "$branch" "https://github.com/$repo.git" "$work/repo"
else
  git clone --quiet --depth 1 --branch main "https://github.com/$repo.git" "$work/repo"
fi
cd "$work/repo"

node scripts/sync-sbp-banks.mjs
node --test scripts/lib/sbp-catalog-sync.test.mjs

git add -- src/lib/sbp-bank-catalog.json
if git diff --cached --quiet; then
  echo 'SBP bank list unchanged; no commit and no PR'
  exit 0
fi

if [[ -z "$existing" ]]; then
  git switch --quiet -c "$branch"
fi
git config user.name 'kurt525'
git config user.email '43399208+kurt525@users.noreply.github.com'
git commit --quiet -m 'chore(billok): sync SBP registry for review (refs #1)'
git push --quiet --set-upstream origin "HEAD:refs/heads/$branch"

if [[ -z "$existing" ]]; then
  gh pr create --repo "$repo" --base main --head "$branch"     --title 'chore: review updated SBP bank registry'     --body 'Updated bank names and membership from eav93/sbp (NSPK C2B registry). Review changes and self-hosted CI before merge. Existing saved IDs remain preserved. No auto-merge, no production deployment, no claim of C2C phone-transfer support.'
fi
echo "Review SBP registry update in branch: $branch"
