import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { route, ok, parseBody, assertSameOrigin, clientIp } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/guard";
import { assertAccountAccess } from "@/lib/auth/access";
import { audit } from "@/lib/audit";
import { notFound } from "@/lib/errors";
import { requirePaymentConfig } from "@/lib/billing/config";
import { collectPayment, createCampaignFeePayment, ensureCustomer } from "@/lib/billing/service";

/**
 * Start paying for something. Today: the platform fee of a campaign. The
 * amount is recomputed server-side from PricingConfig — the client never sends
 * a price. Returns a hosted Checkout URL, or the settled payment when the
 * customer has automatic payments on and a saved card.
 */
const schema = z.object({
  kind: z.literal("CAMPAIGN_FEE"),
  campaignId: z.string().min(1),
  returnPath: z.string().startsWith("/").max(200).optional(),
});

export const POST = route(async (req: NextRequest) => {
  assertSameOrigin(req);
  const auth = await requireAdmin();
  requirePaymentConfig();
  const body = await parseBody(req, schema);

  const campaign = await prisma.campaign.findUnique({ where: { id: body.campaignId } });
  if (!campaign) throw notFound("Campaign");
  await assertAccountAccess(auth, campaign.accountId);

  const customer = await ensureCustomer(auth.admin);
  const { payment, quote } = await createCampaignFeePayment(customer, campaign.id);
  if (!payment) return ok({ payment: null, quote, checkoutUrl: null, free: true });

  const outcome = await collectPayment(payment, customer, { allowOffSession: true, returnPath: body.returnPath ?? "/campaigns" });
  await audit({
    adminId: auth.admin.id,
    action: "PAYMENT_CREATED",
    resourceType: "payment",
    resourceId: payment.id,
    after: { kind: payment.kind, amountCents: payment.amountCents, currency: payment.currency, campaignId: campaign.id, offSession: outcome.checkoutUrl === null },
    ip: clientIp(req),
  });
  return ok({ payment: outcome.payment, quote, checkoutUrl: outcome.checkoutUrl, free: false });
});
