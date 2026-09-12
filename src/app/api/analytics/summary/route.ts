import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { route, ok } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/guard";
import { accountScope } from "@/lib/auth/access";
import { fetchAccountInsights } from "@/lib/meta/media";

/**
 * Analytics from REAL data only (spec §28): platform counters come from our
 * DB; account reach/views come from the Insights API when available. Nothing
 * is fabricated — unavailable sections return null with a reason.
 */
export const GET = route(async (req: NextRequest) => {
  const auth = await requireAdmin();
  const sp = req.nextUrl.searchParams;
  const accountId = sp.get("accountId") ?? undefined;
  const days = Math.min(90, Math.max(1, Number(sp.get("days") ?? 7)));
  const since = new Date(Date.now() - days * 86400_000);
  const acc = await accountScope(auth, accountId);

  const [
    inboundMessages,
    aiReplies,
    humanReplies,
    activeConversations,
    leadsTotal,
    leadsQualified,
    leadsWon,
    flowsCompleted,
    aiUsageAgg,
    aiFailures,
    campaigns,
    emailAgg,
  ] = await Promise.all([
    prisma.message.count({ where: { direction: "IN", createdAt: { gte: since }, conversation: acc } }),
    prisma.message.count({ where: { sender: "AI", createdAt: { gte: since }, conversation: acc } }),
    prisma.message.count({ where: { sender: "ADMIN", direction: "OUT", createdAt: { gte: since }, conversation: acc } }),
    prisma.conversation.count({ where: { ...acc, lastMessageAt: { gte: since } } }),
    prisma.lead.count({ where: { ...acc, createdAt: { gte: since } } }),
    prisma.lead.count({ where: { ...acc, createdAt: { gte: since }, status: { in: ["QUALIFIED", "IN_PROGRESS", "WON"] } } }),
    prisma.lead.count({ where: { ...acc, createdAt: { gte: since }, status: "WON" } }),
    prisma.leadFlowSession.count({ where: { ...acc, status: "COMPLETED", completedAt: { gte: since } } }),
    prisma.aIUsage.aggregate({
      where: { ...(await accountScope(auth, accountId)), createdAt: { gte: since } },
      _sum: { inputTokens: true, outputTokens: true, costUsd: true },
      _avg: { latencyMs: true },
      _count: true,
    }),
    prisma.aIUsage.count({ where: { ...(await accountScope(auth, accountId)), createdAt: { gte: since }, success: false } }),
    prisma.campaign.findMany({
      where: { ...acc },
      select: { id: true, name: true, status: true, dailyBudgetCents: true, currency: true, createdByAi: true },
    }),
    prisma.emailEvent.groupBy({ by: ["status"], _count: true, where: { createdAt: { gte: since } } }),
  ]);

  // avg first-response time: inbound → next outbound in same conversation
  const responsePairs = await prisma.$queryRaw<Array<{ avg_ms: number | null }>>`
    SELECT AVG(EXTRACT(EPOCH FROM (o."createdAt" - i."createdAt")) * 1000) AS avg_ms
    FROM "Message" i
    JOIN LATERAL (
      SELECT o."createdAt" FROM "Message" o
      WHERE o."conversationId" = i."conversationId"
        AND o.direction = 'OUT' AND o."createdAt" > i."createdAt"
      ORDER BY o."createdAt" ASC LIMIT 1
    ) o ON TRUE
    WHERE i.direction = 'IN' AND i."createdAt" >= ${since}`;

  // Instagram-side insights (only when a real connected account is selected)
  let instagramInsights: Record<string, number> | null = null;
  let insightsUnavailableReason: string | null = null;
  if (accountId) {
    const account = await prisma.instagramAccount.findUnique({ where: { id: accountId } });
    if (account && !account.isDemo && account.status === "CONNECTED") {
      instagramInsights = await fetchAccountInsights(account, days);
      if (!instagramInsights) insightsUnavailableReason = "Insights API returned no data (permission missing or token issue).";
    } else {
      insightsUnavailableReason = account?.isDemo
        ? "Demo account — Meta insights are not fabricated for demo data."
        : "Account is not connected.";
    }
  } else {
    insightsUnavailableReason = "Select a single Instagram account to load Meta insights.";
  }

  return ok({
    days,
    messages: { inbound: inboundMessages, aiReplies, humanReplies },
    conversations: { active: activeConversations },
    leads: { total: leadsTotal, qualified: leadsQualified, won: leadsWon, flowCompletions: flowsCompleted },
    ai: {
      calls: aiUsageAgg._count,
      failures: aiFailures,
      inputTokens: aiUsageAgg._sum.inputTokens ?? 0,
      outputTokens: aiUsageAgg._sum.outputTokens ?? 0,
      estimatedCostUsd: aiUsageAgg._sum.costUsd ?? 0,
      avgLatencyMs: aiUsageAgg._avg.latencyMs ? Math.round(aiUsageAgg._avg.latencyMs) : null,
    },
    responseTime: { avgFirstReplyMs: responsePairs[0]?.avg_ms ? Math.round(Number(responsePairs[0].avg_ms)) : null },
    campaigns: {
      total: campaigns.length,
      active: campaigns.filter((c) => c.status === "ACTIVE").length,
      drafts: campaigns.filter((c) => c.status === "DRAFT" || c.status === "READY").length,
      aiDrafted: campaigns.filter((c) => c.createdByAi).length,
    },
    email: Object.fromEntries(emailAgg.map((e) => [e.status, e._count])),
    instagramInsights,
    insightsUnavailableReason,
  });
});
