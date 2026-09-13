/*
  Warnings:

  - You are about to drop the column `agentId` on the `Automation` table. All the data in the column will be lost.
  - You are about to drop the column `title` on the `MediaAsset` table. All the data in the column will be lost.

*/
-- DropForeignKey
ALTER TABLE "Automation" DROP CONSTRAINT "Automation_agentId_fkey";

-- AlterTable
ALTER TABLE "Automation" DROP COLUMN "agentId";

-- AlterTable
ALTER TABLE "MediaAsset" DROP COLUMN "title";

-- CreateTable
CREATE TABLE "CommentResource" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "data" BYTEA,
    "externalUrl" TEXT,
    "uploadedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommentResource_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CommentResource_accountId_createdAt_idx" ON "CommentResource"("accountId", "createdAt");

-- AddForeignKey
ALTER TABLE "CommentResource" ADD CONSTRAINT "CommentResource_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "InstagramAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
