-- AlterEnum
ALTER TYPE "AdminRole" ADD VALUE 'USER';

-- AlterTable
ALTER TABLE "Admin" ADD COLUMN     "lastLoginAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "AccountAccess" (
    "id" TEXT NOT NULL,
    "adminId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "grantedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccountAccess_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AccountAccess_accountId_idx" ON "AccountAccess"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "AccountAccess_adminId_accountId_key" ON "AccountAccess"("adminId", "accountId");

-- AddForeignKey
ALTER TABLE "AccountAccess" ADD CONSTRAINT "AccountAccess_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "Admin"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountAccess" ADD CONSTRAINT "AccountAccess_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "InstagramAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
