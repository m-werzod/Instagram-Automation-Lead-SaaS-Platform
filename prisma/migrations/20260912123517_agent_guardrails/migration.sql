-- AlterTable
ALTER TABLE "AIAgent" ADD COLUMN     "allowedTopics" TEXT,
ADD COLUMN     "ctaText" TEXT,
ADD COLUMN     "fallbackReply" TEXT,
ADD COLUMN     "faq" TEXT,
ADD COLUMN     "outsideHoursReply" TEXT,
ADD COLUMN     "prohibitedTopics" TEXT,
ADD COLUMN     "responseLength" TEXT NOT NULL DEFAULT 'SHORT',
ADD COLUMN     "workingHours" JSONB;
