#!/usr/bin/env bash
# Offline integration test: no network, GitHub API, timer or production changes.
set -euo pipefail
repo_dir="$(cd -- "$(dirname -- "$0")/../.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf -- "$tmp"' EXIT
mkdir -p "$tmp/src/scripts/lib" "$tmp/src/src/lib" "$tmp/bin" "$tmp/state"
for path in scripts/lib/sbp-catalog-sync.mjs scripts/lib/sbp-catalog-sync.test.mjs src/lib/sbp-bank-catalog.json; do
  cp "$repo_dir/$path" "$tmp/src/$path"
done
# Replace only the live HTTP fetch; exercise the actual reconciler and poll.
cat > "$tmp/src/scripts/sync-sbp-banks.mjs" <<'NODE'
import { readFile, writeFile } from 'node:fs/promises';
import { reconcileSbpCatalog } from './lib/sbp-catalog-sync.mjs';
const current = JSON.parse(await readFile('src/lib/sbp-bank-catalog.json','utf8'));
const source = JSON.parse(await readFile(process.env.SBP_TEST_REGISTRY,'utf8'));
const result = reconcileSbpCatalog(current,source);
if (result.changed) await writeFile('src/lib/sbp-bank-catalog.json', JSON.stringify(result.catalog,null,2)+'\n');
console.log(JSON.stringify({changed:result.changed,...result.stats}));
NODE
git -C "$tmp/src" init --quiet -b main
git -C "$tmp/src" config user.name 'BillOK Offline QA'
git -C "$tmp/src" config user.email 'offline@example.invalid'
git -C "$tmp/src" add .
git -C "$tmp/src" commit --quiet -m 'trusted main fixture'
git init --quiet --bare "$tmp/remote.git"
git -C "$tmp/src" remote add origin "file://$tmp/remote.git"
git -C "$tmp/src" push --quiet -u origin main
cp "$repo_dir/scripts/ops/sbp-catalog-poll.sh" "$tmp/bin/sbp-catalog-poll.sh"
cp "$repo_dir/scripts/ops/sbp-catalog-trust.sh" "$tmp/bin/sbp-catalog-trust.sh"
cp "$repo_dir/scripts/ops/sbp-catalog-release-gate.sh" "$tmp/bin/sbp-catalog-release-gate.sh"
python3 - "$tmp" "$(dirname -- "$(command -v node)")" <<'PYCODE'
from pathlib import Path
import sys
tmp, node_dir = sys.argv[1:]
p=Path(tmp,'bin/sbp-catalog-poll.sh')
s=p.read_text()
for old,new in (
 ('repo=kurt525/billok','repo=offline/billok'),
 ('state_dir=/var/lib/billok-sbp-sync','state_dir='+tmp+'/state'),
 ('node_dir=/opt/actions-runner-billok/_work/_tool/node/22.23.4/x64/bin','node_dir='+node_dir),
 ('"https://github.com/$repo.git"','"file://'+tmp+'/remote.git"'),
):
 assert s.count(old)==(2 if 'https://github.com' in old else 1),old
 s=s.replace(old,new)
p.write_text(s)
# Adapt only the disposable test copy. Production still requires a root-owned
# /etc/billok file and has no runtime environment bypass.
approval=Path(tmp,'bin/sbp-catalog-release-gate.sh')
text=approval.read_text()
for old,new in (
 ('sbp_approval_dir=/etc/billok','sbp_approval_dir='+tmp+'/approval'),
 ('sbp_approval_file=/etc/billok/sbp-catalog-release-approval','sbp_approval_file='+tmp+'/approval/approval'),
 ('sbp_approval_owner_uid=0','sbp_approval_owner_uid='+str(__import__('os').getuid())),
):
 assert text.count(old)==1,old
 text=text.replace(old,new,1)
approval.write_text(text)
PYCODE
cat > "$tmp/bin/gh" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == pr && "$2" == list ]]; then
  if [[ -f "$SBP_TEST_PR_FILE" ]]; then cat "$SBP_TEST_PR_FILE"; fi
elif [[ "$1" == pr && "$2" == create ]]; then
  test ! -f "$SBP_TEST_PR_FILE" || { echo 'Duplicate PR creation' >&2; exit 1; }
  shift 2
  while [[ $# -gt 0 ]]; do
    if [[ "$1" == --head ]]; then printf '%s' "$2" > "$SBP_TEST_PR_FILE"; exit 0; fi
    shift
  done
  exit 1
else
  echo 'Unexpected GitHub API call' >&2; exit 1
fi
MOCK
chmod +x "$tmp/bin/gh"
export PATH="$tmp/bin:$PATH"
export SBP_TEST_REGISTRY="$tmp/registry.json"
export SBP_TEST_PR_FILE="$tmp/pr-branch"
python3 - "$tmp" <<'PYCODE'
import json,sys
from datetime import datetime,timedelta
from pathlib import Path
root=Path(sys.argv[1])
catalog=json.loads((root/'src/src/lib/sbp-bank-catalog.json').read_text())
source={'updatedAt':(datetime.fromisoformat(catalog['sourceUpdatedAt'].replace('Z','+00:00'))+timedelta(minutes=1)).isoformat(),
'banks':[{'id':b['nspkId'],'name':b.get('sourceName',b['name'])} for b in catalog['banks']]}
(root/'registry.json').write_text(json.dumps(source,ensure_ascii=False))
PYCODE
poll() { bash "$tmp/bin/sbp-catalog-poll.sh" >"$tmp/poll.log" 2>&1 || { tail -n 45 "$tmp/poll.log"; return 1; }; }
baseline="$(git --git-dir="$tmp/remote.git" rev-parse refs/heads/main)"
# A timer inadvertently enabled before the first accepted release must have
# no GitHub calls, worktree changes, or even create a state lock.
if poll; then echo 'Unapproved poll unexpectedly succeeded' >&2; exit 1; fi
grep -q 'SBP automation denied' "$tmp/poll.log"
test ! -e "$tmp/state/sync.lock"
test ! -e "$SBP_TEST_PR_FILE"
test "$(git --git-dir="$tmp/remote.git" rev-parse refs/heads/main)" = "$baseline"
echo 'offline poll: prior to accepted launch zero GitHub requests or changes'

mkdir -p "$tmp/approval"
printf 'firstReleasePublishedAndAccepted=true\ncatalogAutomationExplicitlyEnabled=false\n' > "$tmp/approval/approval"
if poll; then echo 'Missing separate opt-in unexpectedly accepted' >&2; exit 1; fi
printf 'firstReleasePublishedAndAccepted=false\ncatalogAutomationExplicitlyEnabled=true\n' > "$tmp/approval/approval"
if poll; then echo 'Missing accepted first release unexpectedly accepted' >&2; exit 1; fi
printf 'firstReleasePublishedAndAccepted=true\ncatalogAutomationExplicitlyEnabled=true\n' > "$tmp/approval/approval"
chmod 666 "$tmp/approval/approval"
if poll; then echo 'Insecure approval file unexpectedly accepted' >&2; exit 1; fi
chmod 600 "$tmp/approval/approval"
printf 'firstReleasePublishedAndAccepted=true\ncatalogAutomationExplicitlyEnabled=true\nunknown=true\n' > "$tmp/approval/approval"
if poll; then echo 'Extra approval fields unexpectedly accepted' >&2; exit 1; fi
printf 'firstReleasePublishedAndAccepted=true\ncatalogAutomationExplicitlyEnabled=true\n' > "$tmp/approval/approval"
mv "$tmp/approval/approval" "$tmp/approval/real"
ln -s real "$tmp/approval/approval"
if poll; then echo 'Approval symlink unexpectedly accepted' >&2; exit 1; fi
rm "$tmp/approval/approval"
mv "$tmp/approval/real" "$tmp/approval/approval"
chmod 600 "$tmp/approval/approval"
echo 'offline poll: separate secure acceptance and explicit owner enablement required'
poll
test ! -e "$SBP_TEST_PR_FILE"
test "$(git --git-dir="$tmp/remote.git" rev-parse refs/heads/main)" = "$baseline"
grep -q 'no commit and no PR' "$tmp/poll.log"
echo 'offline poll: date-only refresh skips commit and PR'
python3 - "$tmp" <<'PYCODE'
import json,sys
from pathlib import Path
p=Path(sys.argv[1])/'registry.json'
data=json.loads(p.read_text())
data['banks'].append({'id':'999999999993','name':'Новый банк QA'})
p.write_text(json.dumps(data,ensure_ascii=False))
PYCODE
poll
test -s "$SBP_TEST_PR_FILE"
branch="$(cat "$SBP_TEST_PR_FILE")"
head1="$(git --git-dir="$tmp/remote.git" rev-parse "refs/heads/$branch")"
test "$head1" != "$baseline"
test "$(git --git-dir="$tmp/remote.git" diff --name-only main "$branch")" = 'src/lib/sbp-bank-catalog.json'
test "$(git --git-dir="$tmp/remote.git" rev-parse refs/heads/main)" = "$baseline"
echo 'offline poll: new bank creates one JSON-only PR branch without changing main'
poll
test "$(git --git-dir="$tmp/remote.git" rev-parse "refs/heads/$branch")" = "$head1"
grep -q 'no commit and no PR' "$tmp/poll.log"
echo 'offline poll: unchanged existing proposal skips duplicate commit'
python3 - "$tmp" <<'PYCODE'
import json,sys
from datetime import datetime,timedelta
from pathlib import Path
p=Path(sys.argv[1])/'registry.json'
data=json.loads(p.read_text())
data['updatedAt']=(datetime.fromisoformat(data['updatedAt'])+timedelta(minutes=1)).isoformat()
data['banks'][-1]['name']='Новый банк QA — переименован'
p.write_text(json.dumps(data,ensure_ascii=False))
PYCODE
poll
test "$(cat "$SBP_TEST_PR_FILE")" = "$branch"
test "$(git --git-dir="$tmp/remote.git" rev-parse "refs/heads/$branch")" != "$head1"
test "$(git --git-dir="$tmp/remote.git" rev-parse refs/heads/main)" = "$baseline"
echo 'offline poll: later name change adds a normal commit to existing PR branch'
