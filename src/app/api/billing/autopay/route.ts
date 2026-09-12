import { NextRequest } from "next/server";
import { z } from "zod";
import { route, ok, parseBody, assertSameOrigin } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/guard";
import { requirePaymentConfig } from "@/lib/billing/config";
import { ensureCustomer, setAutoPay } from "@/lib/billing/service";

/** The "Automatic payments" switch. ON needs a saved card; OFF leaves due payments PENDING for manual payment. */
export const PATCH = route(async (req: NextRequest) => {
  assertSameOrigin(req);
  const auth = await requireAdmin();
  requirePaymentConfig();
  const { enabled } = await parseBody(req, z.object({ enabled: z.boolean() }));
  const customer = await ensureCustomer(auth.admin);
  const updated = await setAutoPay(customer, enabled, auth.admin.id);
  return ok({ autoPay: updated.autoPay });
});
