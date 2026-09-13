-- AlterTable
ALTER TABLE "Automation" ADD COLUMN     "agentId" TEXT,
ADD COLUMN     "contentId" TEXT;

-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "ctaConfigId" TEXT;

-- AlterTable
ALTER TABLE "MediaAsset" ADD COLUMN     "title" TEXT;

-- CreateIndex
CREATE INDEX "Automation_contentId_idx" ON "Automation"("contentId");

-- CreateIndex
CREATE INDEX "Campaign_ctaConfigId_idx" ON "Campaign"("ctaConfigId");

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_ctaConfigId_fkey" FOREIGN KEY ("ctaConfigId") REFERENCES "CtaConfig"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Automation" ADD CONSTRAINT "Automation_contentId_fkey" FOREIGN KEY ("contentId") REFERENCES "ContentItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Automation" ADD CONSTRAINT "Automation_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "AIAgent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
