import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { route, ok, parseBody, assertSameOrigin, clientIp } from "@/lib/api";
import { requireAdmin, requireOwner } from "@/lib/auth/guard";
import { audit } from "@/lib/audit";
import { getPricing, toPricing } from "@/lib/billing/service";
import { computeCampaignQuote, SUPPORTED_PRICING_CURRENCIES } from "@/lib/billing/pricing";

/** Centralised pricing. Anyone signed in may read it (the wizard shows the fee); only the OWNER changes it. */
export const GET = route(async (req: NextRequest) => {
  await requireAdmin();
  const pricing = await getPricing();
  const sp = req.nextUrl.searchParams;
  const daily = sp.get("dailyBudgetCents");
  const lifetime = sp.get("lifetimeBudgetCents");
  const quote =
    daily || lifetime
      ? computeCampaignQuote({ dailyBudgetCents: daily ? Number(daily) : null, lifetimeBudgetCents: lifetime ? Number(lifetime) : null }, pricing)
      : null;
  return ok({ pricing, quote });
});

const putSchema = z.object({
  // Restricted to currencies confirmed 2-decimal in Stripe's model — see
  // SUPPORTED_PRICING_CURRENCIES' own comment for why this isn't free text.
  currency: z.enum(SUPPORTED_PRICING_CURRENCIES),
  campaignFeeCents: z.number().int().min(0).max(100_000_000),
  campaignFeePercent: z.number().min(0).max(100),
  planName: z.string().max(120).nullable(),
  planAmountCents: z.number().int().min(0).max(100_000_000),
  planIntervalDays: z.number().int().min(1).max(365),
  taxPercent: z.number().min(0).max(100),
});

export const PUT = route(async (req: NextRequest) => {
  assertSameOrigin(req);
  const auth = await requireOwner();
  const body = await parseBody(req, putSchema);
  const before = await getPricing();
  const row = await prisma.pricingConfig.upsert({ where: { id: 1 }, create: { id: 1, ...body }, update: body });
  await audit({ adminId: auth.admin.id, action: "CHANGED_PRICING", resourceType: "pricing_config", before, after: toPricing(row), ip: clientIp(req) });
  return ok({ pricing: toPricing(row) });
});
