import { NextRequest } from "next/server";
import { route, ok, assertSameOrigin, enforceRateLimit, pathParam } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/guard";
import { analyzeContent } from "@/lib/content/analysis";
import { LIMITS } from "@/lib/rate-limit";
import type { RouteCtx } from "@/lib/api";

export const POST = route(async (req: NextRequest, ctx: RouteCtx) => {
  assertSameOrigin(req);
  const auth = await requireAdmin();
  enforceRateLimit(`ai:${auth.admin.id}`, LIMITS.AI.limit, LIMITS.AI.windowMs);
  const id = await pathParam(ctx, "id");
  const analysis = await analyzeContent(id);
  return ok({ analysis });
});
