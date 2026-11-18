-- Disposable BillOK 9.5 test data, never a real owner's identity.
INSERT INTO "User" ("id", "email", "name", "updatedAt")
 VALUES ('00000000-0000-4000-8000-000000000095','qa95-reset@qa.billok.ru','QA reset sentinel',now());
INSERT INTO "OwnerBootstrap" ("id","userId")
 VALUES (1,'00000000-0000-4000-8000-000000000095');
INSERT INTO "PasskeyCredential" ("id","userId","credentialId","publicKey","deviceType")
 VALUES ('qa95-credential','00000000-0000-4000-8000-000000000095',
 'qa95-test-key',decode('deadbeef','hex'),'singleDevice');
INSERT INTO "Group" ("id","name","updatedAt") VALUES ('qa95-group','Synthetic QA group',now());
INSERT INTO "Receipt" ("id","groupId","uploadedById","updatedAt")
 VALUES ('qa95-receipt','qa95-group','00000000-0000-4000-8000-000000000095',now());
INSERT INTO "ReceiptItem" ("id","receiptId","name","unitPrice","totalPrice")
 VALUES ('qa95-item','qa95-receipt','Synthetic QA dish',100,100);
DO $$
BEGIN
  IF (SELECT count(*) FROM "User") != 1 OR (SELECT count(*) FROM "OwnerBootstrap") != 1
  OR (SELECT count(*) FROM "PasskeyCredential") != 1 OR (SELECT count(*) FROM "Receipt") != 1
  OR (SELECT count(*) FROM "ReceiptItem") != 1 THEN
    RAISE EXCEPTION 'BillOK 9.5 QA sentinel rows not installed';
  END IF;
END $$;
SELECT 'BILLOK_95_FIXTURE=PASS';
