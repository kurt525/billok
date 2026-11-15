-- 6.14.3: disposable-only PostgreSQL checks. Called after both mandatory
-- after-push guards, BEFORE any QA seed. All synthetic rows are rolled back.
BEGIN;
DO $qa$
DECLARE
  bad text;
  good text;
  domain_index_oid oid;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public."User"'::regclass
      AND conname = 'billok_user_email_ru_su_check' AND convalidated
  ) THEN RAISE EXCEPTION 'Email CHECK is missing or NOT VALID'; END IF;
  SELECT to_regclass('public."User_email_lower_key"') INTO domain_index_oid;
  IF domain_index_oid IS NULL THEN RAISE EXCEPTION 'Email unique index missing'; END IF;

  -- Normal registered users, technical placeholders, subdomains, Punycode
  -- A-label and mixed-case addresses with permitted terminal zones.
  FOREACH good IN ARRAY ARRAY[
    'user@company.ru', 'user+tag@sub.company.su',
    'User@Sub.Company.RU', 'user@xn--d1acufc.ru',
    'placeholder-1234567890@placeholder.billok.ru',
    'user@domain--ru.ru'
  ] LOOP
    IF NOT public.billok_user_email_ru_su_allowed(good) THEN
      RAISE EXCEPTION 'Valid address rejected: %', good;
    END IF;
  END LOOP;

  -- Verify the guard function itself AND the real INSERT constraint. Every
  -- attempted insertion of an invalid zone must fail with SQLSTATE 23514.
  FOREACH bad IN ARRAY ARRAY[
    'user@example.com', 'user@domain.net', 'user@domain.org',
    'user@domain.рф', 'user@domain.local', 'user@domain-ru.com',
    'user@company.ru.evil.com', 'user@domain.su.',
    'user@domain..ru', 'user@.ru', 'user@domain.ru@evil.ru',
    'user name@domain.ru', 'user@dоmain.ru', 'user@ab--cd.ru',
    'user@domain.ru' || chr(10), 'user@domain.ru' || chr(13)
  ] LOOP
    IF public.billok_user_email_ru_su_allowed(bad) THEN
      RAISE EXCEPTION 'Guard function accepted invalid address: %', bad;
    END IF;
    BEGIN
      INSERT INTO public."User" (id, email, "updatedAt")
      VALUES ('qa-invalid-' || md5(bad), bad, now());
      RAISE EXCEPTION 'Direct SQL INSERT accepted invalid email: %', bad;
    EXCEPTION WHEN check_violation THEN
      IF SQLERRM NOT LIKE '%billok_user_email_ru_su_check%' THEN RAISE; END IF;
    END;
  END LOOP;

  INSERT INTO public."User" (id, email, "updatedAt")
  VALUES ('qa-email-guard-one', 'User+Tag@Sub.Billok.RU', now());
  INSERT INTO public."User" (id, email, "updatedAt")
  VALUES ('qa-email-guard-two', 'holder@billok.su', now());
  BEGIN
    INSERT INTO public."User" (id, email, "updatedAt")
    VALUES ('qa-email-case-duplicate', 'user+tag@sub.billok.ru', now());
    RAISE EXCEPTION 'Case variant duplicate bypassed unique lower(email) index';
  EXCEPTION WHEN unique_violation THEN
    IF SQLERRM NOT LIKE '%User_email_lower_key%' THEN RAISE; END IF;
  END;
  BEGIN
    UPDATE public."User" SET email='updated@example.com'
    WHERE id='qa-email-guard-two';
    RAISE EXCEPTION 'Direct SQL UPDATE bypassed email CHECK';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM NOT LIKE '%billok_user_email_ru_su_check%' THEN RAISE; END IF;
  END;
  BEGIN
    INSERT INTO public."User" (id, email, "updatedAt")
    VALUES ('qa-raw-import', 'import@external.com', now())
    ON CONFLICT (id) DO NOTHING;
    RAISE EXCEPTION 'INSERT ON CONFLICT bypassed email CHECK';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM NOT LIKE '%billok_user_email_ru_su_check%' THEN RAISE; END IF;
  END;
  IF (SELECT email FROM public."User" WHERE id='qa-email-guard-two') <> 'holder@billok.su'
  THEN RAISE EXCEPTION 'Forbidden SQL UPDATE modified original email'; END IF;
  IF (SELECT count(*) FROM public."User" WHERE id LIKE 'qa-email-%') <> 2
  THEN RAISE EXCEPTION 'SQL test inserted unexpected User rows'; END IF;
END
$qa$;
ROLLBACK;
SELECT 'USER_EMAIL_RU_SU_SQL_GUARD=PASS' AS verification;
