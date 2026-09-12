import { NextRequest } from "next/server";
import { z } from "zod";
import { route, ok, parseBody, assertSameOrigin, clientIp } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/guard";
import { audit } from "@/lib/audit";
import { coreEnv } from "@/lib/env";
import { requirePaymentConfig } from "@/lib/billing/config";
import { ensureCustomer, findCustomer, provider, refreshPaymentMethods, removeMethod, setDefaultMethod } from "@/lib/billing/service";
import { notFound } from "@/lib/errors";

/**
 * Saved cards. POST starts Stripe's hosted setup page (the card number is
 * typed there, never here); PATCH sets the default; DELETE detaches.
 */

export const GET = route(async () => {
  const auth = await requireAdmin();
  requirePaymentConfig();
  const customer = await findCustomer(auth.admin.id);
  if (!customer) return ok({ methods: [], defaultPaymentMethodId: null });
  const methods = await refreshPaymentMethods(customer);
  return ok({ methods, defaultPaymentMethodId: customer.defaultPaymentMethodId });
});

export const POST = route(async (req: NextRequest) => {
  assertSameOrigin(req);
  const auth = await requireAdmin();
  requirePaymentConfig();
  const customer = await ensureCustomer(auth.admin);
  const base = coreEnv().APP_URL;
  const session = await provider().createSetupSession({
    customerId: customer.providerCustomerId,
    successUrl: `${base}/api/billing/return?session_id={CHECKOUT_SESSION_ID}&next=${encodeURIComponent("/billing?card=added")}`,
    cancelUrl: `${base}/billing?card=canceled`,
    metadata: { customerId: customer.id, adminId: auth.admin.id },
  });
  await audit({ adminId: auth.admin.id, action: "STARTED_CARD_SETUP", resourceType: "payment_customer", resourceId: customer.id, ip: clientIp(req) });
  return ok({ url: session.url });
});

const patchSchema = z.object({ methodId: z.string().min(1) });

export const PATCH = route(async (req: NextRequest) => {
  assertSameOrigin(req);
  const auth = await requireAdmin();
  requirePaymentConfig();
  const body = await parseBody(req, patchSchema);
  const customer = await findCustomer(auth.admin.id);
  if (!customer) throw notFound("Billing customer");
  await setDefaultMethod(customer, body.methodId);
  await audit({ adminId: auth.admin.id, action: "CHANGED_DEFAULT_PAYMENT_METHOD", resourceType: "payment_method", resourceId: body.methodId, ip: clientIp(req) });
  return ok({ defaultPaymentMethodId: body.methodId });
});

export const DELETE = route(async (req: NextRequest) => {
  assertSameOrigin(req);
  const auth = await requireAdmin();
  requirePaymentConfig();
  const body = await parseBody(req, patchSchema);
  const customer = await findCustomer(auth.admin.id);
  if (!customer) throw notFound("Billing customer");
  await removeMethod(customer, body.methodId);
  await audit({ adminId: auth.admin.id, action: "REMOVED_PAYMENT_METHOD", resourceType: "payment_method", resourceId: body.methodId, ip: clientIp(req) });
  return ok({ removed: true });
});
