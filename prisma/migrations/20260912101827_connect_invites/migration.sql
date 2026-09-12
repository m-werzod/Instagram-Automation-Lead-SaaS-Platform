-- CreateTable
CREATE TABLE "ConnectInvite" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "label" TEXT,
    "createdById" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "accountId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConnectInvite_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ConnectInvite_tokenHash_key" ON "ConnectInvite"("tokenHash");

-- CreateIndex
CREATE INDEX "ConnectInvite_expiresAt_idx" ON "ConnectInvite"("expiresAt");

-- CreateIndex
CREATE INDEX "ConnectInvite_createdById_idx" ON "ConnectInvite"("createdById");

-- AddForeignKey
ALTER TABLE "ConnectInvite" ADD CONSTRAINT "ConnectInvite_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "Admin"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConnectInvite" ADD CONSTRAINT "ConnectInvite_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "InstagramAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
