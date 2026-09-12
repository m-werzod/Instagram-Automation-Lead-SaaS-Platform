import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { route, ok, parseBody, assertSameOrigin, enforceRateLimit, type RouteCtx, pathParam } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/guard";
import { assertAccountAccess } from "@/lib/auth/access";
import { notFound } from "@/lib/errors";
import { generateTestReply } from "@/lib/agent/runtime";

/**
 * Test console: talk to the assistant exactly as a customer would, through the
 * real pipeline (prompt, knowledge, tools, guardrails, provider) — but with no
 * Instagram conversation behind it, so WRITE tools only describe what they
 * would do. Usage is recorded with purpose "test" so it shows in the numbers.
 */

const schema = z.object({
  message: z.string().min(1).max(900),
  history: z
    .array(z.object({ role: z.enum(["user", "assistant"]), text: z.string().max(2000) }))
    .max(20)
    .default([]),
});

export const POST = route(async (req: NextRequest, ctx: RouteCtx) => {
  assertSameOrigin(req);
  const auth = await requireAdmin();
  // The gateway's own limits are stricter than this on free tiers — errors from
  // it are surfaced verbatim, this only stops accidental hammering.
  enforceRateLimit(`ai-test:${auth.admin.id}`, 10, 60_000);
  const id = await pathParam(ctx, "id");
  const body = await parseBody(req, schema);

  const agent = await prisma.aIAgent.findUnique({ where: { id }, include: { account: true } });
  if (!agent) throw notFound("Agent");
  await assertAccountAccess(auth, agent.accountId);

  const result = await generateTestReply(agent, body.message, body.history);
  return ok({ result });
});
