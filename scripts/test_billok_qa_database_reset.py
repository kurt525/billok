#!/usr/bin/env python3
"""BillOK Issue 9.5: ensure destructive reset is never redirected to production."""
import unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parent.parent
class QaReset(unittest.TestCase):
    def test_guards(self):
        workflow=(ROOT/'.github/workflows/billok-ci.yml').read_text()
        for s in ('--label billok.qa.disposable=true','{{json .Mounts}}',
                  'dropdb -U billokqa --if-exists billokqa','createdb -U billokqa billokqa',
                  '127.0.0.1::5432','qa-billok-empty-db.sql'):
            self.assertIn(s,workflow)
        name='billok-mobile-qa-'+'$'+'{GITHUB_RUN_ID}'+'-'+'$'+'{GITHUB_RUN_ATTEMPT}'
        self.assertIn(name,workflow)
        self.assertIn('--tmpfs /var/lib/postgresql/data:rw,size=536870912',workflow)
        self.assertIn('HostConfig.Tmpfs',workflow)
        self.assertLess(workflow.index('qa-billok-empty-db.sql'),workflow.index('npm run db:seed'))
        for s in ('owner_bootstrap_identity_guard.sql','qa-owner-identity-postgres.sql',
                  'qa-email-seed-acceptance.ts','qa-owner-bootstrap-postgres.ts'):
            self.assertIn(s,workflow)
    def test_sentinel_and_table_guard(self):
        fixture=(ROOT/'scripts/qa-disposable-reset-fixture.sql').read_text()
        guard=(ROOT/'scripts/qa-billok-empty-db.sql').read_text()
        for table in ('User','OwnerBootstrap','PasskeyCredential','Group','Receipt','ReceiptItem'):
            self.assertIn('"'+table+'"',fixture)
        self.assertIn('FROM pg_tables',guard)
        self.assertIn('RAISE EXCEPTION',guard)
        self.assertIn('BILLOK_95_EMPTY_DB=PASS',guard)
        seed=(ROOT/'scripts/qa-fixture-database.ts').read_text()
        self.assertIn('Refusing to seed a database other than disposable loopback billokqa',seed)
if __name__=='__main__':unittest.main()
