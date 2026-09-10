import { route, ok, type RouteCtx } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/guard";
import { prisma } from "@/lib/prisma";
import { notFound, metaUnsupported } from "@/lib/errors";
import { listAdAccounts } from "@/lib/meta/marketing";

export const GET = route(async (_req, ctx: RouteCtx) => {
  await requireAdmin();
  const { id } = await ctx.params;
  const account = await prisma.instagramAccount.findUnique({ where: { id } });
  if (!account) throw notFound("Instagram account");
  if (account.connectionMode !== "FACEBOOK_LOGIN") {
    throw metaUnsupported(
      "Ad accounts",
      "Listing ad accounts requires the Facebook Login connection mode.",
      "Reconnect via 'Connect with Facebook (ads)'.",
    );
  }
  const adAccounts = await listAdAccounts(account);
  return ok({ adAccounts });
});
