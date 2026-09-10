-- Switch admin authentication from email to a username-style "login".
-- Data-preserving: existing rows are backfilled from the local-part of their
-- email before the NOT NULL + UNIQUE constraints are applied.

-- 1. add the column nullable so existing rows survive
ALTER TABLE "Admin" ADD COLUMN "login" TEXT;

-- 2. backfill from email local-part, lowercased (e.g. "a.owner@x.com" -> "a.owner")
UPDATE "Admin"
SET "login" = lower(split_part("email", '@', 1))
WHERE "login" IS NULL AND "email" IS NOT NULL;

-- 3. any row still without a login (shouldn't exist) gets a deterministic fallback
UPDATE "Admin" SET "login" = 'admin_' || substr("id", 1, 8) WHERE "login" IS NULL;

-- 4. de-duplicate collisions produced by the backfill, keeping the oldest row intact
WITH ranked AS (
  SELECT "id", "login",
         row_number() OVER (PARTITION BY "login" ORDER BY "createdAt" ASC, "id" ASC) AS rn
  FROM "Admin"
)
UPDATE "Admin" a
SET "login" = a."login" || '_' || (ranked.rn - 1)
FROM ranked
WHERE a."id" = ranked."id" AND ranked.rn > 1;

-- 5. enforce the constraints
ALTER TABLE "Admin" ALTER COLUMN "login" SET NOT NULL;
CREATE UNIQUE INDEX "Admin_login_key" ON "Admin"("login");

-- 6. email is now optional (authentication no longer depends on it)
ALTER TABLE "Admin" ALTER COLUMN "email" DROP NOT NULL;
