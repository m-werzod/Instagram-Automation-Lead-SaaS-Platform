import { prisma } from "@/lib/prisma";
import { route, ok } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/guard";
import { accountIdScope } from "@/lib/auth/access";
import { detectCapabilities } from "@/lib/meta/capabilities";

export const GET = route(async () => {
  const auth = await requireAdmin();
  const accounts = await prisma.instagramAccount.findMany({
    where: await accountIdScope(auth),
    include: { permissions: true, tokens: true, _count: { select: { conversations: true, leads: true, content: true, agents: true } } },
    orderBy: { createdAt: "asc" },
  });

  const data = accounts.map((acc) => {
    const activeToken = acc.tokens.find((t) => t.status === "ACTIVE" && t.kind === (acc.connectionMode === "INSTAGRAM_LOGIN" ? "user" : "page"));
    const userToken = acc.tokens.find((t) => t.status === "ACTIVE" && t.kind === "user");
    return {
      id: acc.id,
      igUserId: acc.igUserId,
      username: acc.username,
      name: acc.name,
      accountType: acc.accountType,
      profilePictureUrl: acc.profilePictureUrl,
      followersCount: acc.followersCount,
      mediaCount: acc.mediaCount,
      connectionMode: acc.connectionMode,
      fbPageId: acc.fbPageId,
      fbPageName: acc.fbPageName,
      adAccountId: acc.adAccountId,
      status: acc.status,
      webhookSubscribed: acc.webhookSubscribed,
      lastSyncAt: acc.lastSyncAt,
      isDemo: acc.isDemo,
      counts: acc._count,
      token: activeToken
        ? {
            status: activeToken.status,
            expiresAt: activeToken.expiresAt ?? userToken?.expiresAt ?? null,
            lastRefreshAt: activeToken.lastRefreshAt,
            scopes: activeToken.scopes,
          }
        : { status: "MISSING", expiresAt: null, lastRefreshAt: null, scopes: [] },
      permissions: acc.permissions.map((p) => ({ permission: p.permission, granted: p.granted })),
      capabilities: detectCapabilities(acc),
    };
  });
  return ok({ accounts: data });
});
