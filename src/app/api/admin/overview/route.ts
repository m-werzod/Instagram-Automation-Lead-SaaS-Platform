import { prisma } from "@/lib/prisma";
import { route, ok } from "@/lib/api";
import { requireStaff } from "@/lib/auth/guard";

/**
 * Cross-account admin dashboard (spec §20). Every number is a real DB count or
 * a sum over Meta's own insight snapshots — never invented. Ad spend in
 * particular is the sum of Campaign.insightsSnapshot.spend, which is only
 * ever written by src/lib/meta/marketing.ts#syncCampaignFromMeta from a real
 * Meta Insights response.
 */
export const GET = route(async () => {
  await requireStaff();
  const since24h = new Date(Date.now() - 24 * 3600_000);
  const since7d = new Date(Date.now() - 7 * 86400_000);

  const [
    totalUsers,
    usersByRole,
    connectedAccounts,
    totalAccounts,
    activeCampaigns,
    totalCampaigns,
    activeAgents,
    totalAgents,
    totalLeads,
    qualifiedLeads,
    wonLeads,
    leadsLast7d,
    deadJobs,
    failedWebhooks,
    tokenIssues,
    recentAudit,
    recentFailures,
    campaignsWithSpend,
  ] = await Promise.all([
    prisma.admin.count(),
    prisma.admin.groupBy({ by: ["role"], _count: true }),
    prisma.instagramAccount.count({ where: { status: "CONNECTED", isDemo: false } }),
    prisma.instagramAccount.count({ where: { isDemo: false } }),
    prisma.campaign.count({ where: { status: "ACTIVE" } }),
    prisma.campaign.count(),
    prisma.aIAgent.count({ where: { enabled: true } }),
    prisma.aIAgent.count(),
    prisma.lead.count(),
    prisma.lead.count({ where: { status: { in: ["QUALIFIED", "IN_PROGRESS"] } } }),
    prisma.lead.count({ where: { status: "WON" } }),
    prisma.lead.count({ where: { createdAt: { gte: since7d } } }),
    prisma.job.count({ where: { status: "DEAD" } }),
    prisma.webhookEvent.count({ where: { status: "FAILED" } }),
    prisma.instagramToken.count({ where: { status: { in: ["EXPIRED", "REVOKED"] }, account: { status: { not: "DISCONNECTED" }, isDemo: false } } }),
    prisma.auditLog.findMany({
      orderBy: { createdAt: "desc" },
      take: 20,
      include: { admin: { select: { login: true, name: true } } },
    }),
    prisma.auditLog.count({ where: { success: false, createdAt: { gte: since24h } } }),
    prisma.campaign.findMany({
      where: { insightsSnapshot: { not: undefined }, isDemo: false },
      select: { insightsSnapshot: true, currency: true },
    }),
  ]);

  // Ad spend is Meta's own money, summed per currency from real insight snapshots — never estimated.
  const spendByCurrency = new Map<string, number>();
  for (const c of campaignsWithSpend) {
    const snap = c.insightsSnapshot as { spend?: number; currency?: string } | null;
    if (!snap || typeof snap.spend !== "number") continue;
    const currency = snap.currency ?? c.currency;
    spendByCurrency.set(currency, (spendByCurrency.get(currency) ?? 0) + snap.spend);
  }

  // billing (best-effort — the module works even with no payment provider configured)
  let billing: { spentCents: number; currency: string; failedCount: number } | null = null;
  try {
    const [agg, failedCount] = await Promise.all([
      prisma.payment.aggregate({ where: { status: "SUCCEEDED" }, _sum: { amountCents: true } }),
      prisma.payment.count({ where: { status: "FAILED" } }),
    ]);
    billing = { spentCents: agg._sum.amountCents ?? 0, currency: "USD", failedCount };
  } catch {
    billing = null;
  }

  return ok({
    users: { total: totalUsers, byRole: Object.fromEntries(usersByRole.map((r) => [r.role, r._count])) },
    accounts: { connected: connectedAccounts, total: totalAccounts },
    campaigns: { active: activeCampaigns, total: totalCampaigns },
    agents: { active: activeAgents, total: totalAgents },
    leads: { total: totalLeads, qualified: qualifiedLeads, won: wonLeads, last7d: leadsLast7d },
    adSpend: Object.fromEntries(spendByCurrency),
    billing,
    system: { deadJobs, failedWebhooks, tokenIssues, recentFailures24h: recentFailures },
    recentActivity: recentAudit,
  });
});
