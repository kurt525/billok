-- Disposable QA database ONLY. Called after mobile auth fixture creates the
-- owner and ordinary member. Every forbidden SQL write must reject with the
-- owner-identity guard; no production data is ever touched.
DO $qa$
DECLARE
  registered_owner text;
  ordinary_user text;
BEGIN
  SELECT "userId" INTO registered_owner FROM public."OwnerBootstrap" WHERE id = 1;
  SELECT id INTO ordinary_user FROM public."User" WHERE email = 'member-manage@mail.ru';
  IF registered_owner IS NULL OR ordinary_user IS NULL OR registered_owner = ordinary_user THEN
    RAISE EXCEPTION 'Owner QA fixture missing or owner not unique';
  END IF;
  IF (SELECT count(*) FROM public."OwnerBootstrap") <> 1 THEN
    RAISE EXCEPTION 'More than one bootstrap row';
  END IF;

  BEGIN
    UPDATE public."OwnerBootstrap" SET "userId" = ordinary_user WHERE id = 1;
    RAISE EXCEPTION 'Owner userId was mutable';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM <> 'billok_owner_identity_immutable' THEN RAISE; END IF;
  END;

  BEGIN
    UPDATE public."OwnerBootstrap" SET id = 2 WHERE id = 1;
    RAISE EXCEPTION 'Owner singleton ID was mutable';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM <> 'billok_owner_identity_immutable' THEN RAISE; END IF;
  END;

  BEGIN
    UPDATE public."OwnerBootstrap" SET "completedAt" = now() WHERE id = 1;
    RAISE EXCEPTION 'Completed bootstrap could be reopened or overwritten';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM <> 'billok_owner_identity_immutable' THEN RAISE; END IF;
  END;

  BEGIN
    INSERT INTO public."OwnerBootstrap" (id, "userId", "createdAt", "emailAttempts")
    VALUES (2, ordinary_user, now(), 0);
    RAISE EXCEPTION 'A second owner could be created';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM NOT LIKE '%owner_bootstrap_singleton_id_one%' THEN RAISE; END IF;
  END;

  BEGIN
    DELETE FROM public."OwnerBootstrap" WHERE id = 1;
    RAISE EXCEPTION 'Owner row could be deleted';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM <> 'billok_owner_identity_immutable' THEN RAISE; END IF;
  END;

  BEGIN
    TRUNCATE public."OwnerBootstrap";
    RAISE EXCEPTION 'Owner row could be truncated';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM <> 'billok_owner_identity_immutable' THEN RAISE; END IF;
  END;

  IF (SELECT count(*) FROM public."OwnerBootstrap") <> 1 OR
     (SELECT "userId" FROM public."OwnerBootstrap" WHERE id=1) IS DISTINCT FROM registered_owner
  THEN
    RAISE EXCEPTION 'Owner identity changed during QA';
  END IF;
END
$qa$;
