import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { route, ok, assertSameOrigin, parseBody, clientIp, pathParam, type RouteCtx } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/guard";
import { assertAccountAccess } from "@/lib/auth/access";
import { audit, AuditActions } from "@/lib/audit";
import { notFound } from "@/lib/errors";
import { fetchAdAccountBillingStatus, updateAdAccountSpendCap } from "@/lib/meta/marketing";

/**
 * The ad-account spend cap, changed from inside the platform.
 *
 * This is the one advertising money control Meta genuinely exposes to the API,
 * so it is the one an operator should never have to leave for. Meta pauses
 * every campaign on the account the moment spending reaches the cap, which
 * makes it a real hard ceiling rather than a warning — and the reason it is
 * audited with before/after values like any other spend-affecting action.
 *
 * Adding or changing the payment method itself is NOT here, because Meta has no
 * API for it: that happens once on Meta's own billing page. Everything after
 * that one-time step is in this platform.
 */

const bodySchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("set"),
    /** Whole currency units, as an operator types them (e.g. 250 = 250 USD). */
    amount: z.number().positive().max(10_000_000),
  }),
  z.object({ action: z.literal("reset") }),
  z.object({ action: z.literal("remove") }),
]);

export const POST = route(async (req: NextRequest, ctx: RouteCtx) => {
  assertSameOrigin(req);
  const auth = await requireAdmin();
  const id = await pathParam(ctx, "id");
  const body = await parseBody(req, bodySchema);

  const account = await prisma.instagramAccount.findUnique({ where: { id } });
  if (!account) throw notFound("Instagram account");
  await assertAccountAccess(auth, account.id);

  // Read Meta's own numbers before and after, so the audit trail records what
  // actually changed at Meta rather than what this platform asked for.
  const before = await fetchAdAccountBillingStatus(account);

  await updateAdAccountSpendCap(
    account,
    body.action === "set" ? { kind: "set", amountMinor: Math.round(body.amount * 100) } : { kind: body.action },
  );

  const after = await fetchAdAccountBillingStatus(account);

  await audit({
    adminId: auth.admin.id,
    action: AuditActions.CHANGED_AD_SPEND_CAP,
    resourceType: "InstagramAccount",
    resourceId: account.id,
    before: { spendCapMinor: before?.spendCapMinor ?? null, amountSpentMinor: before?.amountSpentMinor ?? null },
    after: {
      requested: body,
      spendCapMinor: after?.spendCapMinor ?? null,
      amountSpentMinor: after?.amountSpentMinor ?? null,
    },
    ip: clientIp(req),
  });

  return ok({ status: after });
});
