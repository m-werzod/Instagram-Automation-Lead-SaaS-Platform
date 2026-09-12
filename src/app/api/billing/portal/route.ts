import { NextRequest } from "next/server";
import { route, ok, assertSameOrigin } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/guard";
import { coreEnv } from "@/lib/env";
import { requirePaymentConfig } from "@/lib/billing/config";
import { ensureCustomer, provider } from "@/lib/billing/service";

/** Stripe's self-service portal (manage cards, download receipts). Null when the portal is not enabled in Stripe. */
export const POST = route(async (req: NextRequest) => {
  assertSameOrigin(req);
  const auth = await requireAdmin();
  requirePaymentConfig();
  const customer = await ensureCustomer(auth.admin);
  const url = await provider().portalUrl(customer.providerCustomerId, `${coreEnv().APP_URL}/billing`);
  return ok({ url, reason: url ? null : "The Stripe customer portal is not enabled — turn it on in the Stripe dashboard (Settings → Billing → Customer portal)." });
});
