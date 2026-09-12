import { route, ok, type RouteCtx, pathParam } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/guard";
import { assertAccountAccess } from "@/lib/auth/access";
import { prisma } from "@/lib/prisma";
import { notFound, metaUnsupported } from "@/lib/errors";
import { listAdAccounts } from "@/lib/meta/marketing";

export const GET = route(async (_req, ctx: RouteCtx) => {
  const auth = await requireAdmin();
  const id = await pathParam(ctx, "id");
  const account = await prisma.instagramAccount.findUnique({
    where: { id },
    include: { tokens: { where: { kind: "ads", status: "ACTIVE" }, take: 1 } },
  });
  if (!account) throw notFound("Instagram account");
  await assertAccountAccess(auth, account.id);

  // Ads readiness is decided by the advertising authorization, not by how
  // Instagram itself was connected — an Instagram-Login account gains ads once
  // it has an ads token (or was connected via Facebook Login directly).
  const adsConnected = account.tokens.length > 0 || account.connectionMode === "FACEBOOK_LOGIN";
  if (!adsConnected) {
    throw metaUnsupported(
      "Ad accounts",
      "Advertising is not connected for this account yet.",
      "Use 'Connect with Facebook (for ads)' on the Integrations page.",
    );
  }
  const adAccounts = await listAdAccounts(account);
  return ok({ adAccounts });
});
