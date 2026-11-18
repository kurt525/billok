-- After BillOK QA database reset, every application table must be empty.
DO $$
DECLARE t record; n bigint;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables
    WHERE schemaname='public' AND tablename <> '_prisma_migrations'
  LOOP
    EXECUTE format('SELECT count(*) FROM %I.%I', 'public', t.tablename) INTO n;
    IF n != 0 THEN RAISE EXCEPTION 'BillOK 9.5 nonempty table %: %',t.tablename,n; END IF;
  END LOOP;
  IF to_regclass('public."User"') IS NULL OR
     to_regclass('public."Receipt"') IS NULL OR
     to_regclass('public."OwnerBootstrap"') IS NULL OR
     to_regclass('public."PasskeyCredential"') IS NULL THEN
    RAISE EXCEPTION 'BillOK 9.5 required table missing';
  END IF;
  IF EXISTS (SELECT 1 FROM "OwnerBootstrap") OR
     EXISTS (SELECT 1 FROM "User" WHERE "id"='00000000-0000-4000-8000-000000000095') THEN
    RAISE EXCEPTION 'BillOK 9.5 test owner identity retained';
  END IF;
END $$;
SELECT 'BILLOK_95_EMPTY_DB=PASS';
