import { prisma } from "@/lib/prisma";
import { route, ok } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/guard";
import { paymentsConfigured, paymentsInTestMode } from "@/lib/billing/config";
import { ensurePlanSchedule, findCustomer, getPricing, refreshPaymentMethods } from "@/lib/billing/service";
import { computePlanQuote } from "@/lib/billing/pricing";

/**
 * Everything the Billing page shows for the signed-in user. Real rows only:
 * totals are sums over Payment, upcoming items are schedules + pending payments.
 */
export const GET = route(async () => {
  const auth = await requireAdmin();
  const configured = paymentsConfigured();
  const pricing = await getPricing();
  const customer = configured ? await findCustomer(auth.admin.id) : null;

  let methods: Awaited<ReturnType<typeof refreshPaymentMethods>> = [];
  if (customer) {
    await ensurePlanSchedule(customer).catch(() => undefined);
    methods = await refreshPaymentMethods(customer).catch(() =>
      prisma.paymentMethod.findMany({ where: { customerId: customer.id, removedAt: null }, orderBy: { createdAt: "asc" } }),
    );
  }

  const [payments, schedules, agg, failedCount] = customer
    ? await Promise.all([
        prisma.payment.findMany({
          where: { customerId: customer.id },
          orderBy: { createdAt: "desc" },
          take: 100,
          include: { invoice: { select: { number: true, receiptUrl: true } }, campaign: { select: { id: true, name: true } } },
        }),
        prisma.billingSchedule.findMany({ where: { customerId: customer.id, status: { not: "CANCELED" } }, orderBy: { nextBillingAt: "asc" }, include: { campaign: { select: { id: true, name: true } } } }),
        prisma.payment.aggregate({ where: { customerId: customer.id, status: "SUCCEEDED" }, _sum: { amountCents: true } }),
        prisma.payment.count({ where: { customerId: customer.id, status: "FAILED" } }),
      ])
    : [[], [], { _sum: { amountCents: null } }, 0];

  const fresh = customer ? await prisma.paymentCustomer.findUnique({ where: { id: customer.id } }) : null;
  const pending = payments.filter((p) => p.status === "PENDING" || p.status === "FAILED" || p.status === "REQUIRES_ACTION");
  const nextSchedule = schedules.find((s) => s.status === "ACTIVE") ?? null;
  const nextPayment = pending.sort((a, b) => (a.dueAt?.getTime() ?? 0) - (b.dueAt?.getTime() ?? 0))[0] ?? null;

  return ok({
    configured,
    testMode: paymentsInTestMode(),
    role: auth.admin.role,
    pricing,
    plan: computePlanQuote(pricing),
    customer: fresh
      ? { id: fresh.id, autoPay: fresh.autoPay, defaultPaymentMethodId: fresh.defaultPaymentMethodId, currency: fresh.currency, email: fresh.email }
      : null,
    methods,
    totals: { spentCents: agg._sum.amountCents ?? 0, failedCount, currency: fresh?.currency ?? pricing.currency },
    next: {
      schedule: nextSchedule,
      payment: nextPayment,
    },
    schedules,
    payments,
  });
});
