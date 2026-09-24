-- AI Video Editor: projects, assets, jobs, subtitles, sample analysis, chat.
-- Media bytes live behind a storage driver (local disk / Vercel Blob), never in Postgres:
-- VideoAsset holds only metadata plus a storage key. Heavy work runs as a Job in the
-- "video" lane, which only a resident worker with FFmpeg claims.
--
-- Also: CRM lead tags/follow-up/deal value/outcome reason, and the Meta ad review
-- verdict persisted on Campaign (reported by Meta on sync, never inferred locally).

-- CreateEnum
CREATE TYPE "VideoProjectStatus" AS ENUM ('DRAFT', 'READY', 'ARCHIVED');
-- CreateEnum
CREATE TYPE "VideoAssetRole" AS ENUM ('SOURCE', 'AUDIO', 'SAMPLE', 'EXPORT', 'PREVIEW', 'THUMBNAIL');
-- CreateEnum
CREATE TYPE "VideoAssetStatus" AS ENUM ('UPLOADING', 'READY', 'FAILED', 'DELETED');
-- CreateEnum
CREATE TYPE "VideoJobKind" AS ENUM ('PROBE', 'PREVIEW', 'EXPORT', 'TRANSCRIBE', 'SAMPLE_ANALYZE', 'THUMBNAIL', 'WAVEFORM');
-- CreateEnum
CREATE TYPE "VideoJobStatus" AS ENUM ('QUEUED', 'RUNNING', 'DONE', 'FAILED', 'CANCELLED');
-- CreateEnum
CREATE TYPE "SubtitleSource" AS ENUM ('AUTO', 'MANUAL', 'IMPORTED');
-- AlterTable
ALTER TABLE "Lead" ADD COLUMN     "followUpAt" TIMESTAMP(3),
ADD COLUMN     "outcomeReason" TEXT,
ADD COLUMN     "tags" TEXT[],
ADD COLUMN     "valueCents" INTEGER,
ADD COLUMN     "valueCurrency" TEXT;
-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "reviewIssues" JSONB,
ADD COLUMN     "reviewStatus" TEXT,
ADD COLUMN     "reviewSyncedAt" TIMESTAMP(3);
-- CreateTable
CREATE TABLE "VideoProject" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" "VideoProjectStatus" NOT NULL DEFAULT 'DRAFT',
    "sourceAssetId" TEXT,
    "params" JSONB,
    "history" JSONB,
    "lastExportId" TEXT,
    "createdById" TEXT,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "VideoProject_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "VideoAsset" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "projectId" TEXT,
    "role" "VideoAssetRole" NOT NULL,
    "status" "VideoAssetStatus" NOT NULL DEFAULT 'UPLOADING',
    "filename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "driver" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "publicUrl" TEXT,
    "durationSec" DOUBLE PRECISION,
    "width" INTEGER,
    "height" INTEGER,
    "fps" DOUBLE PRECISION,
    "hasAudio" BOOLEAN NOT NULL DEFAULT false,
    "probe" JSONB,
    "error" TEXT,
    "uploadedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "VideoAsset_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "VideoJob" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "kind" "VideoJobKind" NOT NULL,
    "status" "VideoJobStatus" NOT NULL DEFAULT 'QUEUED',
    "params" JSONB NOT NULL,
    "progressPct" INTEGER NOT NULL DEFAULT 0,
    "outputAssetId" TEXT,
    "logTail" TEXT,
    "error" TEXT,
    "queueJobId" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "VideoJob_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "SubtitleTrack" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "source" "SubtitleSource" NOT NULL DEFAULT 'AUTO',
    "cues" JSONB NOT NULL,
    "style" JSONB NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SubtitleTrack_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "SampleAnalysis" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "sampleAssetId" TEXT NOT NULL,
    "status" "VideoJobStatus" NOT NULL DEFAULT 'QUEUED',
    "measured" JSONB,
    "observed" JSONB,
    "plan" JSONB,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SampleAnalysis_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "VideoChatMessage" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "proposal" JSONB,
    "state" TEXT NOT NULL DEFAULT 'NONE',
    "language" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "VideoChatMessage_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE UNIQUE INDEX "VideoProject_sourceAssetId_key" ON "VideoProject"("sourceAssetId");
-- CreateIndex
CREATE INDEX "VideoProject_accountId_updatedAt_idx" ON "VideoProject"("accountId", "updatedAt");
-- CreateIndex
CREATE INDEX "VideoProject_accountId_status_idx" ON "VideoProject"("accountId", "status");
-- CreateIndex
CREATE INDEX "VideoAsset_accountId_createdAt_idx" ON "VideoAsset"("accountId", "createdAt");
-- CreateIndex
CREATE INDEX "VideoAsset_projectId_role_idx" ON "VideoAsset"("projectId", "role");
-- CreateIndex
CREATE INDEX "VideoAsset_status_idx" ON "VideoAsset"("status");
-- CreateIndex
CREATE INDEX "VideoJob_projectId_createdAt_idx" ON "VideoJob"("projectId", "createdAt");
-- CreateIndex
CREATE INDEX "VideoJob_accountId_status_idx" ON "VideoJob"("accountId", "status");
-- CreateIndex
CREATE INDEX "VideoJob_status_createdAt_idx" ON "VideoJob"("status", "createdAt");
-- CreateIndex
CREATE INDEX "SubtitleTrack_projectId_idx" ON "SubtitleTrack"("projectId");
-- CreateIndex
CREATE INDEX "SampleAnalysis_projectId_createdAt_idx" ON "SampleAnalysis"("projectId", "createdAt");
-- CreateIndex
CREATE INDEX "VideoChatMessage_projectId_createdAt_idx" ON "VideoChatMessage"("projectId", "createdAt");
-- CreateIndex
CREATE INDEX "Lead_accountId_followUpAt_idx" ON "Lead"("accountId", "followUpAt");
-- AddForeignKey
ALTER TABLE "VideoProject" ADD CONSTRAINT "VideoProject_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "InstagramAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "VideoProject" ADD CONSTRAINT "VideoProject_sourceAssetId_fkey" FOREIGN KEY ("sourceAssetId") REFERENCES "VideoAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "VideoAsset" ADD CONSTRAINT "VideoAsset_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "InstagramAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "VideoAsset" ADD CONSTRAINT "VideoAsset_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "VideoProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "VideoJob" ADD CONSTRAINT "VideoJob_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "InstagramAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "VideoJob" ADD CONSTRAINT "VideoJob_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "VideoProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "VideoJob" ADD CONSTRAINT "VideoJob_outputAssetId_fkey" FOREIGN KEY ("outputAssetId") REFERENCES "VideoAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "SubtitleTrack" ADD CONSTRAINT "SubtitleTrack_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "VideoProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "SampleAnalysis" ADD CONSTRAINT "SampleAnalysis_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "VideoProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "SampleAnalysis" ADD CONSTRAINT "SampleAnalysis_sampleAssetId_fkey" FOREIGN KEY ("sampleAssetId") REFERENCES "VideoAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "VideoChatMessage" ADD CONSTRAINT "VideoChatMessage_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "VideoProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
