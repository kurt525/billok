-- TASK-BILLOK-012: additive migration from 1.2.0. Apply once with a backup and explicit production approval.
BEGIN;

-- CreateTable
CREATE TABLE "EmailChangeRequest" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "oldEmailHash" VARCHAR(64) NOT NULL,
    "newEmail" VARCHAR(254) NOT NULL,
    "sessionBindingHash" VARCHAR(64) NOT NULL,
    "sessionSecurityVersion" INTEGER NOT NULL,
    "challengeHash" VARCHAR(64) NOT NULL,
    "signerCredentialRowId" TEXT,
    "tokenHash" VARCHAR(64),
    "challengeExpiresAt" TIMESTAMP(3) NOT NULL,
    "approvedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailChangeRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailChangeNotification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "encryptedRecipient" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "leaseUntil" TIMESTAMP(3),
    "leaseId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailChangeNotification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EmailChangeRequest_userId_key" ON "EmailChangeRequest"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "EmailChangeRequest_challengeHash_key" ON "EmailChangeRequest"("challengeHash");

-- CreateIndex
CREATE UNIQUE INDEX "EmailChangeRequest_tokenHash_key" ON "EmailChangeRequest"("tokenHash");

-- CreateIndex
CREATE INDEX "EmailChangeRequest_expiresAt_idx" ON "EmailChangeRequest"("expiresAt");

-- CreateIndex
CREATE INDEX "EmailChangeNotification_nextAttemptAt_expiresAt_idx" ON "EmailChangeNotification"("nextAttemptAt", "expiresAt");

-- CreateIndex
CREATE INDEX "EmailChangeNotification_expiresAt_idx" ON "EmailChangeNotification"("expiresAt");

-- CreateIndex
CREATE INDEX "EmailChangeNotification_userId_idx" ON "EmailChangeNotification"("userId");

-- AddForeignKey
ALTER TABLE "EmailChangeRequest" ADD CONSTRAINT "EmailChangeRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailChangeNotification" ADD CONSTRAINT "EmailChangeNotification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;


COMMIT;
