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

  -- Section 6.12.10: a stable OwnerBootstrap pointer alone is NOT enough:
  -- attacks must also fail against the underlying User row itself.
  IF (SELECT "completedAt" FROM public."OwnerBootstrap" WHERE id=1) IS NULL OR
     (SELECT "emailVerified" FROM public."User" WHERE id=registered_owner) IS NULL THEN
    RAISE EXCEPTION 'QA requires a real completed and verified owner';
  END IF;
  IF (SELECT count(*) FROM public."PasskeyCredential"
      WHERE "userId"=registered_owner AND "revokedAt" IS NULL) NOT BETWEEN 1 AND 3 THEN
    RAISE EXCEPTION 'QA owner must have one to three active Passkeys';
  END IF;

  BEGIN
    UPDATE public."User" SET id='forged-owner-id' WHERE id=registered_owner;
    RAISE EXCEPTION 'User.id could be replaced for the owner';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM <> 'billok_user_id_immutable' THEN RAISE; END IF;
  END;
  BEGIN
    UPDATE public."User" SET id='forged-normal-id' WHERE id=ordinary_user;
    RAISE EXCEPTION 'User.id could be replaced for a regular account';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM <> 'billok_user_id_immutable' THEN RAISE; END IF;
  END;

  BEGIN
    UPDATE public."User" SET "suspendedAt" = now() WHERE id=registered_owner;
    RAISE EXCEPTION 'Owner could be suspended';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM <> 'billok_owner_account_immutable' THEN RAISE; END IF;
  END;
  BEGIN
    UPDATE public."User" SET "isPlaceholder" = true WHERE id=registered_owner;
    RAISE EXCEPTION 'Owner could be converted to a guest placeholder';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM <> 'billok_owner_account_immutable' THEN RAISE; END IF;
  END;
  BEGIN
    UPDATE public."User" SET "emailVerified" = NULL WHERE id=registered_owner;
    RAISE EXCEPTION 'Owner could lose verified email status';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM <> 'billok_owner_account_immutable' THEN RAISE; END IF;
  END;
  BEGIN
    UPDATE public."User" SET email='attacker@mail.ru' WHERE id=registered_owner;
    RAISE EXCEPTION 'Owner verified identity email could be replaced';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM <> 'billok_owner_account_immutable' THEN RAISE; END IF;
  END;
  BEGIN
    UPDATE public."User" SET "webAuthnUserHandle" = 'attacker-handle' WHERE id=registered_owner;
    RAISE EXCEPTION 'Owner WebAuthn identity could be replaced';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM <> 'billok_owner_account_immutable' THEN RAISE; END IF;
  END;
  BEGIN
    UPDATE public."User" SET "registrationEmailVerificationRequired"=false WHERE id=registered_owner;
    RAISE EXCEPTION 'Owner could lose verification-required flag';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM <> 'billok_owner_account_immutable' THEN RAISE; END IF;
  END;
  BEGIN
    DELETE FROM public."User" WHERE id=registered_owner;
    RAISE EXCEPTION 'Owner User row could be deleted';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM <> 'billok_owner_account_immutable' THEN RAISE; END IF;
  END;

  -- PostgreSQL TRUNCATE ... CASCADE does not execute DELETE row triggers;
  -- the already installed OwnerBootstrap statement-level trigger must stop it.
  BEGIN
    TRUNCATE public."User" CASCADE;
    RAISE EXCEPTION 'TRUNCATE User CASCADE could erase the sole owner';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM <> 'billok_owner_identity_immutable' THEN RAISE; END IF;
  END;

  -- Legitimate profile changes and revocation/version rotation still work.
  UPDATE public."User"
     SET name=name, "sessionSecurityVersion"="sessionSecurityVersion"
   WHERE id=registered_owner;
  IF NOT FOUND THEN RAISE EXCEPTION 'Owner profile update unexpectedly blocked'; END IF;

  IF (SELECT count(*) FROM public."OwnerBootstrap") <> 1 OR
     (SELECT "userId" FROM public."OwnerBootstrap" WHERE id=1) IS DISTINCT FROM registered_owner OR
     (SELECT count(*) FROM public."User" WHERE id=registered_owner AND
       "suspendedAt" IS NULL AND "isPlaceholder"=false AND "emailVerified" IS NOT NULL) <> 1
  THEN
    RAISE EXCEPTION 'Owner identity or security state changed during QA';
  END IF;
END
$qa$;
