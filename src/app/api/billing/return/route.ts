import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { coreEnv } from "@/lib/env";
import { getAuth } from "@/lib/auth/session";
import { paymentConfig } from "@/lib/billing/config";
import { applyIntent, findCustomer, provider, refreshPaymentMethods } from "@/lib/billing/service";
import { createLogger, errorFields } from "@/lib/logger";

const log = createLogger("billing.return");

/**
 * Where Stripe Checkout sends the browser back. The webhook is the source of
 * truth, but it can lag by seconds — so the session is read here too and the
 * payment/card state is brought up to date before the page renders. Browser
 * navigation: every outcome is a redirect.
 */
export async function GET(req: NextRequest) {
  const base = coreEnv().APP_URL;
  const next = req.nextUrl.searchParams.get("next") ?? "/billing";
  const safeNext = next.startsWith("/") && !next.startsWith("//") ? next : "/billing";
  const sessionId = req.nextUrl.searchParams.get("session_id");
  const auth = await getAuth();
  if (!auth || !sessionId || !paymentConfig()) return NextResponse.redirect(`${base}${safeNext}`);

  try {
    const session = await provider().retrieveCheckoutSession(sessionId);
    const customer = await findCustomer(auth.admin.id);
    if (customer && customer.providerCustomerId === session.customerId) {
      if (session.mode === "payment" && session.paymentIntentId) {
        const payment = await prisma.payment.findFirst({
          where: { OR: [{ providerCheckoutSessionId: session.id }, { providerPaymentIntentId: session.paymentIntentId }], customerId: customer.id },
        });
        if (payment) {
          await prisma.payment.update({ where: { id: payment.id }, data: { providerPaymentIntentId: session.paymentIntentId } });
          const summary = await provider().retrieveIntent(session.paymentIntentId);
          await applyIntent(payment.id, summary, { source: "return" });
        }
      }
      await refreshPaymentMethods(customer).catch(() => undefined);
    }
  } catch (err) {
    log.warn("could not sync checkout session on return", errorFields(err));
  }
  const sep = safeNext.includes("?") ? "&" : "?";
  return NextResponse.redirect(`${base}${safeNext}${sep}returned=1`);
}
