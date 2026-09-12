-- AlterTable
ALTER TABLE "Lead" ADD COLUMN     "aiQualification" JSONB,
ADD COLUMN     "assignedAdminId" TEXT,
ADD COLUMN     "lastInteractionAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Lead_assignedAdminId_idx" ON "Lead"("assignedAdminId");

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_assignedAdminId_fkey" FOREIGN KEY ("assignedAdminId") REFERENCES "Admin"("id") ON DELETE SET NULL ON UPDATE CASCADE;
