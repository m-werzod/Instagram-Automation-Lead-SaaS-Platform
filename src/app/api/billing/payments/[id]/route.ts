import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { route, ok, parseBody, assertSameOrigin, clientIp, type RouteCtx, pathParam } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/guard";
import { isStaff } from "@/lib/auth/access";
import { audit } from "@/lib/audit";
import { forbidden, notFound } from "@/lib/errors";
import { requirePaymentConfig } from "@/lib/billing/config";
import { cancelPayment, collectPayment, syncPaymentFromProvider } from "@/lib/billing/service";

async function loadOwned(id: string, adminId: string, staff: boolean) {
  const payment = await prisma.payment.findUnique({ where: { id }, include: { customer: true, invoice: true } });
  if (!payment) throw notFound("Payment");
  if (!staff && payment.customer.adminId !== adminId) throw forbidden("This payment belongs to another user");
  return payment;
}

export const GET = route(async (_req, ctx: RouteCtx) => {
  const auth = await requireAdmin();
  const id = await pathParam(ctx, "id");
  const payment = await loadOwned(id, auth.admin.id, isStaff(auth));
  const events = await prisma.auditLog.findMany({
    where: { resourceType: "payment", resourceId: id },
    orderBy: { createdAt: "asc" },
    select: { action: true, createdAt: true, success: true, error: true, after: true },
  });
  return ok({ payment, timeline: events });
});

const actionSchema = z.object({ action: z.enum(["pay", "retry", "cancel", "sync"]), returnPath: z.string().startsWith("/").max(200).optional() });

/** pay / retry → collect again (Checkout or off-session); cancel → CANCELED; sync → re-read the provider. */
export const POST = route(async (req: NextRequest, ctx: RouteCtx) => {
  assertSameOrigin(req);
  const auth = await requireAdmin();
  requirePaymentConfig();
  const id = await pathParam(ctx, "id");
  const body = await parseBody(req, actionSchema);
  const payment = await loadOwned(id, auth.admin.id, isStaff(auth));

  if (body.action === "cancel") {
    const updated = await cancelPayment(payment, auth.admin.id);
    return ok({ payment: updated, checkoutUrl: null });
  }
  if (body.action === "sync") {
    const updated = await syncPaymentFromProvider(payment);
    return ok({ payment: updated, checkoutUrl: null });
  }
  const outcome = await collectPayment(payment, payment.customer, { allowOffSession: body.action === "retry", returnPath: body.returnPath ?? "/billing" });
  await audit({ adminId: auth.admin.id, action: body.action === "retry" ? "PAYMENT_RETRIED" : "PAYMENT_COLLECTION_STARTED", resourceType: "payment", resourceId: id, ip: clientIp(req) });
  return ok({ payment: outcome.payment, checkoutUrl: outcome.checkoutUrl });
});
