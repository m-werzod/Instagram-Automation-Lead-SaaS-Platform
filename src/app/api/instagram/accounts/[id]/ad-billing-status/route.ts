import { route, ok, type RouteCtx, pathParam } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/guard";
import { assertAccountAccess } from "@/lib/auth/access";
import { prisma } from "@/lib/prisma";
import { notFound } from "@/lib/errors";
import { fetchAdAccountBillingStatus, META_BILLING_HUB_URL } from "@/lib/meta/marketing";

/**
 * Whether this Instagram account's linked Meta ad account is actually ready to
 * spend money — Path 1 of the ad-billing model (spec discussion 2026-09-13):
 * Meta bills the ad account's OWN payment method directly, always. This
 * endpoint only ever *reads* Meta's own status; it never collects, stores, or
 * forwards a card, and it never charges anything. When there is a problem
 * (no funding source, disabled, unsettled), the UI links straight to Meta's
 * own billing page rather than pretending this platform can fix it.
 */
export const GET = route(async (_req, ctx: RouteCtx) => {
  const auth = await requireAdmin();
  const id = await pathParam(ctx, "id");
  const account = await prisma.instagramAccount.findUnique({ where: { id } });
  if (!account) throw notFound("Instagram account");
  await assertAccountAccess(auth, account.id);

  if (account.isDemo) {
    return ok({ applicable: false, reason: "Demo account — no real Meta ad spend is ever involved.", billingUrl: META_BILLING_HUB_URL, status: null });
  }
  if (!account.adAccountId) {
    return ok({
      applicable: false,
      reason: "No ad account is linked yet. Connect Facebook (for ads) on this account's card first.",
      billingUrl: META_BILLING_HUB_URL,
      status: null,
    });
  }

  const status = await fetchAdAccountBillingStatus(account);
  return ok({
    applicable: true,
    reason: status ? null : "Meta did not return a billing status for this ad account — check it directly in Meta.",
    billingUrl: META_BILLING_HUB_URL,
    status,
  });
});
