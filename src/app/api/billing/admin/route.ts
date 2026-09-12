import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { route, ok } from "@/lib/api";
import { requireStaff } from "@/lib/auth/guard";

/** Cross-user payments for administrators: totals by status plus the latest payments with the paying user. */
export const GET = route(async (req: NextRequest) => {
  await requireStaff();
  const days = Math.min(365, Math.max(1, Number(req.nextUrl.searchParams.get("days") ?? 30)));
  const since = new Date(Date.now() - days * 86400_000);

  const [byStatus, recent, customers, failedOpen, dueSoon] = await Promise.all([
    prisma.payment.groupBy({ by: ["status", "currency"], _sum: { amountCents: true }, _count: true, where: { createdAt: { gte: since } } }),
    prisma.payment.findMany({
      orderBy: { createdAt: "desc" },
      take: 100,
      include: {
        customer: { select: { admin: { select: { id: true, login: true, name: true } }, autoPay: true } },
        campaign: { select: { id: true, name: true } },
        invoice: { select: { number: true, receiptUrl: true } },
      },
    }),
    prisma.paymentCustomer.count(),
    prisma.payment.count({ where: { status: "FAILED" } }),
    prisma.billingSchedule.findMany({
      where: { status: "ACTIVE", nextBillingAt: { lte: new Date(Date.now() + 7 * 86400_000) } },
      include: { customer: { select: { admin: { select: { login: true, name: true } }, autoPay: true } } },
      orderBy: { nextBillingAt: "asc" },
      take: 50,
    }),
  ]);

  return ok({ days, byStatus, recent, customers, failedOpen, dueSoon });
});
