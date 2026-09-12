import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { route, ok, enforceRateLimit } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/guard";
import { assertAccountAccess } from "@/lib/auth/access";
import { notFound, validationError } from "@/lib/errors";
import { searchCities, searchInterests } from "@/lib/meta/marketing";

/** Targeting typeahead backed by Meta's Targeting Search API (adinterest / adgeolocation). */
export const GET = route(async (req: NextRequest) => {
  const auth = await requireAdmin();
  enforceRateLimit(`targeting-search:${auth.admin.id}`, 60, 60_000);
  const sp = req.nextUrl.searchParams;
  const accountId = sp.get("accountId");
  const type = sp.get("type");
  const q = (sp.get("q") ?? "").trim();
  const country = sp.get("country")?.trim().toUpperCase() || undefined;
  if (!accountId) throw validationError("accountId is required");
  if (type !== "interest" && type !== "city") throw validationError("type must be interest or city");
  if (q.length < 2) return ok({ results: [] });

  const account = await prisma.instagramAccount.findUnique({ where: { id: accountId } });
  if (!account) throw notFound("Instagram account");
  await assertAccountAccess(auth, account.id);
  if (!account.adAccountId || account.isDemo) {
    return ok({ results: [], reason: "Connect Facebook (ads) to search Meta's audience catalogue." });
  }

  const results = type === "interest" ? await searchInterests(account, q) : await searchCities(account, q, country);
  return ok({ results });
});
