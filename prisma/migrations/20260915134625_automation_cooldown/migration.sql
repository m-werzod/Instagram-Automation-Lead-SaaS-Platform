-- AlterTable
ALTER TABLE "Automation" ADD COLUMN     "cooldownSec" INTEGER;

-- AlterTable
ALTER TABLE "AutomationRun" ADD COLUMN     "actorIgsid" TEXT;

-- CreateIndex
CREATE INDEX "AutomationRun_automationId_actorIgsid_createdAt_idx" ON "AutomationRun"("automationId", "actorIgsid", "createdAt");
