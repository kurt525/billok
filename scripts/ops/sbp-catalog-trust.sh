#!/usr/bin/env bash
# Load from the locally installed, reviewed systemd script; NEVER source this
# from an open proposal branch.
verify_sbp_catalog_checkout() {
  local trusted_ref="$1"
  local path
  # The proposal branch is only allowed to differ from reviewed main in the
  # JSON catalog. Reject any other tracked change (including workflows,
  # config, scripts, deletions and executable mode bits) before running code.
  # A fresh clone supplies no local untracked files. Do not auto-rebase.
  if ! git rev-parse --verify --quiet "$trusted_ref^{commit}" >/dev/null ||
    ! git diff --quiet --no-ext-diff --no-renames "$trusted_ref" HEAD -- . ':(exclude)src/lib/sbp-bank-catalog.json'; then
    echo 'Unsafe SBP proposal: changes outside the JSON catalog require review' >&2
    return 1
  fi
  for path in \
    scripts/sync-sbp-banks.mjs \
    scripts/lib/sbp-catalog-sync.mjs \
    scripts/lib/sbp-catalog-sync.test.mjs; do
    if [[ ! -f "$path" || -L "$path" ]] ||
      ! git cat-file -e "$trusted_ref:$path" 2>/dev/null ||
      ! cmp -s "$path" <(git show "$trusted_ref:$path"); then
      echo "Unsafe SBP proposal: executable differs from trusted main: $path" >&2
      return 1
    fi
  done
  if [[ ! -f src/lib/sbp-bank-catalog.json || -L src/lib/sbp-bank-catalog.json ]]; then
    echo 'Unsafe SBP proposal: catalog must be a regular JSON file' >&2
    return 1
  fi

  # The proposal JSON itself is unreviewed. Preserve stable bank identities,
  # locally stored icons and catalog provenance from trusted main. Legitimate
  # upstream renames, activations/retirements and new NSPK IDs stay possible.
  python3 - "$trusted_ref" <<'PYCODE' || return 1
import json
import re
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

def parse_registry_date(value):
    if not isinstance(value, str):
        raise ValueError('invalid catalog timestamp')
    try:
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError as error:
        raise ValueError('invalid catalog timestamp') from error
    if parsed.tzinfo is None:
        raise ValueError('catalog timestamp must include timezone')
    return parsed.astimezone(timezone.utc)

try:
    trusted = json.loads(subprocess.check_output(
        ['git', 'show', sys.argv[1] + ':src/lib/sbp-bank-catalog.json'], text=True
    ))
    proposed = json.loads(Path('src/lib/sbp-bank-catalog.json').read_text())
    if not isinstance(trusted.get('banks'), list) or not isinstance(proposed.get('banks'), list):
        raise ValueError('invalid catalog entries')
    if any(proposed.get(key) != trusted.get(key) for key in ('source', 'sourceSystem')):
        raise ValueError('catalog provenance changed')
    if len(proposed['banks']) < len(trusted['banks']):
        raise ValueError('previously saved banks were removed')
    names = set()
    registry_ids = set()
    for index, bank in enumerate(proposed['banks']):
        if not isinstance(bank, dict) or not isinstance(bank.get('name'), str):
            raise ValueError('invalid bank')
        name = bank['name'].strip()
        if not 2 <= len(name) <= 120 or re.search(r'[<>\x00-\x1f]', name):
            raise ValueError('invalid bank name')
        if not isinstance(bank.get('nspkId'), str) or not re.fullmatch(r'\d{12}', bank['nspkId']):
            raise ValueError('invalid NSPK identifier')
        if not isinstance(bank.get('id'), str) or bank['id'] in names or bank['nspkId'] in registry_ids:
            raise ValueError('duplicate or invalid bank ID')
        names.add(bank['id'])
        registry_ids.add(bank['nspkId'])
        if bank.get('active', True) not in (True, False) or not isinstance(bank.get('active', True), bool):
            raise ValueError('invalid active flag')
        if index < len(trusted['banks']):
            original = trusted['banks'][index]
            if any(bank.get(key) != original.get(key) for key in ('id', 'nspkId', 'icon')):
                raise ValueError('existing bank identity or logo changed')
        elif bank['id'] != bank['nspkId'] or bank.get('icon') is not None:
            raise ValueError('new bank has unexpected ID or icon')
        if set(bank).difference({'id', 'nspkId', 'icon', 'name', 'sourceName', 'active'}):
            raise ValueError('unexpected bank fields')
    trusted_date = parse_registry_date(trusted.get('sourceUpdatedAt'))
    proposal_date = parse_registry_date(proposed.get('sourceUpdatedAt'))
    if proposal_date < trusted_date:
        raise ValueError('catalog timestamp predates trusted main')
    if proposal_date > datetime.now(timezone.utc) + timedelta(hours=24):
        raise ValueError('catalog timestamp is implausibly far in the future')
except (OSError, ValueError, TypeError, subprocess.CalledProcessError) as error:
    print('Unsafe SBP proposal: ' + str(error), file=sys.stderr)
    sys.exit(1)
PYCODE
}
