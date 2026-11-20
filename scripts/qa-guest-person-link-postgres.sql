-- Disposable CI PostgreSQL ONLY. Even a direct SQL writer cannot store
-- plaintext UUID, 256-bit bearer, NULL, or malformed personal-link JSON.
DO $qa$
DECLARE
  probe text := 'qa-person-link-storage';
  guest_id text := 'aaaaaaaa-0000-4000-8000-000000000001';
BEGIN
  INSERT INTO public."GuestSplit"
    (id, "shareToken", "shareTokenSealed", "receiptData", items, people,
     assignments, "expiresAt", "updatedAt")
  VALUES
    (probe, repeat('a', 64), 'v1.' || repeat('A', 95),
     '{}'::jsonb, '[]'::jsonb,
     jsonb_build_array(jsonb_build_object('id',guest_id,'name','Гость')),
     '[]'::jsonb, now() + interval '1 day', now());

  IF NOT public.billok_guest_person_tokens_sealed(
    jsonb_build_array(jsonb_build_object('id', guest_id, 'name', 'Гость',
                                        'personToken', 'v1.' || repeat('A', 95)))
  ) THEN
    RAISE EXCEPTION 'Valid sealed-format token rejected';
  END IF;

  BEGIN
    UPDATE public."GuestSplit"
       SET people = jsonb_build_array(jsonb_build_object(
          'id',guest_id,'name','Гость','personToken',
          'aaaaaaaa-0000-4000-8000-000000000001'))
     WHERE id = probe;
    RAISE EXCEPTION 'Plain UUID token stored';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM NOT LIKE '%guest_person_link_storage_format%' THEN RAISE; END IF;
  END;

  BEGIN
    UPDATE public."GuestSplit"
       SET people = jsonb_build_array(jsonb_build_object(
          'id',guest_id,'name','Гость','personToken', repeat('A',43)))
     WHERE id = probe;
    RAISE EXCEPTION 'Plain 256-bit bearer stored';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM NOT LIKE '%guest_person_link_storage_format%' THEN RAISE; END IF;
  END;

  BEGIN
    UPDATE public."GuestSplit"
       SET people = jsonb_build_array(jsonb_build_object(
          'id',guest_id,'name','Гость','personToken', 'v1.invalid'))
     WHERE id = probe;
    RAISE EXCEPTION 'Malformed ciphertext stored';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM NOT LIKE '%guest_person_link_storage_format%' THEN RAISE; END IF;
  END;

  BEGIN
    UPDATE public."GuestSplit"
       SET people = jsonb_build_array(jsonb_build_object(
          'id',guest_id,'name','Гость','personToken', NULL))
     WHERE id = probe;
    RAISE EXCEPTION 'Null personal bearer stored';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM NOT LIKE '%guest_person_link_storage_format%' THEN RAISE; END IF;
  END;

  BEGIN
    UPDATE public."GuestSplit"
       SET people = jsonb_build_array(jsonb_build_object(
          'name','Гость без personId','personToken', 'v1.' || repeat('A', 95)))
     WHERE id = probe;
    RAISE EXCEPTION 'Sealed token without a personId was stored';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM NOT LIKE '%guest_person_link_storage_format%' THEN RAISE; END IF;
  END;

  DELETE FROM public."GuestSplit" WHERE id = probe;
  IF EXISTS (SELECT 1 FROM public."GuestSplit" WHERE id = probe) THEN
    RAISE EXCEPTION 'QA probe was not removed';
  END IF;
END
$qa$;
