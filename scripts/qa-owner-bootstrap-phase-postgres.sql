-- Issue #1 6.12.10. Disposable database ONLY, immediately after
-- prisma db push + after-push guards, BEFORE application QA seed.
-- Transaction deliberately rolls back every synthetic owner/credential.
BEGIN;
INSERT INTO public."User" (
  id, email, "emailVerified", "registrationEmailVerificationRequired", "updatedAt"
) VALUES (
  'qa-bootstrap-owner-identity', 'guard-owner@mail.ru', NULL, true, now()
);

DO $qa$
BEGIN
  BEGIN
    INSERT INTO public."OwnerBootstrap" (id, "userId", "completedAt")
    VALUES (1, 'qa-bootstrap-owner-identity', now());
    RAISE EXCEPTION 'Direct first INSERT could bypass Passkey setup';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM <> 'billok_owner_initial_completion_requires_passkey' THEN RAISE; END IF;
  END;
END
$qa$;

INSERT INTO public."OwnerBootstrap" (id, "userId")
VALUES (1, 'qa-bootstrap-owner-identity');

DO $qa$
BEGIN
  BEGIN
    UPDATE public."OwnerBootstrap" SET "completedAt" = now() WHERE id=1;
    RAISE EXCEPTION 'Unverified owner could finish bootstrap';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM <> 'billok_owner_unverified_or_inactive' THEN RAISE; END IF;
  END;
END
$qa$;

-- Before first Passkey, verified email must NOT finish registration.
UPDATE public."User" SET "emailVerified"=now() WHERE id='qa-bootstrap-owner-identity';
DO $qa$
BEGIN
  BEGIN
    UPDATE public."OwnerBootstrap" SET "completedAt" = now() WHERE id=1;
    RAISE EXCEPTION 'Owner could finish bootstrap without a Passkey';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM <> 'billok_owner_passkey_required' THEN RAISE; END IF;
  END;
END
$qa$;

-- Isolated SQL fixture only: this byte is NOT a usable WebAuthn public key.
-- In production a real WebAuthn assertion inserts the verified credential.
INSERT INTO public."PasskeyCredential" (id, "userId", "credentialId", "publicKey", "deviceType")
VALUES ('qa-bootstrap-test-key', 'qa-bootstrap-owner-identity', 'qa-bootstrap-credential',
        decode('01','hex'), 'singleDevice');
UPDATE public."OwnerBootstrap" SET "completedAt"=now() WHERE id=1;

DO $qa$
BEGIN
  IF (SELECT "completedAt" FROM public."OwnerBootstrap" WHERE id=1) IS NULL THEN
    RAISE EXCEPTION 'Verified owner with Passkey failed to complete bootstrap';
  END IF;
  BEGIN
    UPDATE public."User" SET "suspendedAt"=now() WHERE id='qa-bootstrap-owner-identity';
    RAISE EXCEPTION 'Completed owner was suspendable';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM <> 'billok_owner_account_immutable' THEN RAISE; END IF;
  END;
END
$qa$;

ROLLBACK;
DO $qa$
BEGIN
  IF EXISTS (SELECT 1 FROM public."OwnerBootstrap") OR
     EXISTS (SELECT 1 FROM public."User" WHERE id='qa-bootstrap-owner-identity') OR
     EXISTS (SELECT 1 FROM public."PasskeyCredential" WHERE id='qa-bootstrap-test-key') THEN
    RAISE EXCEPTION 'Disposable bootstrap QA leaked fixtures outside transaction';
  END IF;
END
$qa$;
