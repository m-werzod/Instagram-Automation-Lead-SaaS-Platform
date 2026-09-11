-- Lead Button: visual button spec + lead attribution to the capturing config.
-- Additive only — no data is modified or dropped.

-- CtaConfig gains the Lead Button appearance spec (rendered on /f/{slug} and in the builder preview)
ALTER TABLE "CtaConfig" ADD COLUMN "buttonSpec" JSONB;

-- Lead gains attribution to the Lead Button configuration that captured it
ALTER TABLE "Lead" ADD COLUMN "ctaConfigId" TEXT;

ALTER TABLE "Lead" ADD CONSTRAINT "Lead_ctaConfigId_fkey"
  FOREIGN KEY ("ctaConfigId") REFERENCES "CtaConfig"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Lead_ctaConfigId_idx" ON "Lead"("ctaConfigId");
