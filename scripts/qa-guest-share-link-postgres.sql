-- Disposable CI database ONLY. Rejected inserts have no side effects.
-- The SQL guard must reject plaintext legacy cuid, UUID and missing ciphertext
-- even when a caller bypasses Prisma and writes directly through PostgreSQL.
DO $qa$
BEGIN
  BEGIN
    INSERT INTO public."GuestSplit"
      (id, "shareToken", "shareTokenSealed", "receiptData", items, people, assignments, "expiresAt", "updatedAt")
    VALUES
      ('qa-plaintext-probe', 'public-shared-link-cuid', 'v1.' || repeat('A',95),
       '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, now() + interval '1 day', now());
    RAISE EXCEPTION 'Unsafe legacy share token was persisted';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM NOT LIKE '%guest_share_link_storage_format%' THEN RAISE; END IF;
  END;

  BEGIN
    INSERT INTO public."GuestSplit"
      (id, "shareToken", "shareTokenSealed", "receiptData", items, people, assignments, "expiresAt", "updatedAt")
    VALUES
      ('qa-null-cipher-probe', repeat('a',64), NULL,
       '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, now() + interval '1 day', now());
    RAISE EXCEPTION 'Missing ciphertext was persisted';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM NOT LIKE '%guest_share_link_storage_format%' THEN RAISE; END IF;
  END;

  BEGIN
    INSERT INTO public."GuestSplit"
      (id, "shareToken", "shareTokenSealed", "receiptData", items, people, assignments, "expiresAt", "updatedAt")
    VALUES
      ('qa-plain-cipher-probe', repeat('a',64), 'my-plaintext-bearer',
       '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, now() + interval '1 day', now());
    RAISE EXCEPTION 'Unsealed shared bearer was persisted';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM NOT LIKE '%guest_share_link_storage_format%' THEN RAISE; END IF;
  END;

  IF EXISTS (SELECT 1 FROM public."GuestSplit" WHERE id LIKE 'qa-%-probe') THEN
    RAISE EXCEPTION 'Unsafe QA share probe persisted';
  END IF;
END
$qa$;
