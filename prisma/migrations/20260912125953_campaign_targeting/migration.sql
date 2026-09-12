-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "estimate" JSONB,
ADD COLUMN     "insightsSnapshot" JSONB,
ADD COLUMN     "insightsSyncedAt" TIMESTAMP(3),
ADD COLUMN     "platformFeeCents" INTEGER,
ADD COLUMN     "stoppedAt" TIMESTAMP(3);
