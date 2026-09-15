import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { route, ok, parseBody, assertSameOrigin, clientIp } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/guard";
import { accountScope, assertAccountAccess } from "@/lib/auth/access";
import { audit, AuditActions } from "@/lib/audit";
import { notFound, validationError } from "@/lib/errors";
import { conditionSchema, actionSchema, cooldownSecSchema } from "@/lib/validation/automation";
import type { Prisma } from "@prisma/client";

export const GET = route(async (req: NextRequest) => {
  const auth = await requireAdmin();
  const accountId = req.nextUrl.searchParams.get("accountId") ?? undefined;
  const automations = await prisma.automation.findMany({
    where: await accountScope(auth, accountId),
    include: {
      account: { select: { username: true } },
      content: { select: { id: true, caption: true, mediaProductType: true, thumbnailUrl: true } },
      _count: { select: { runs: true } },
    },
    orderBy: { createdAt: "asc" },
  });
  return ok({ automations });
});

const createSchema = z.object({
  accountId: z.string().min(1),
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  trigger: z.enum(["MESSAGE_RECEIVED", "COMMENT_RECEIVED", "LEAD_SUBMITTED", "LEAD_STATUS_CHANGED", "CONVERSATION_HANDOFF"]),
  /** Scopes a COMMENT_RECEIVED rule to one post/reel; omitted/null = every post on the account. */
  contentId: z.string().min(1).nullable().optional(),
  conditions: z.array(conditionSchema).max(10).default([]),
  actions: z.array(actionSchema).min(1).max(10),
  enabled: z.boolean().default(false),
  cooldownSec: cooldownSecSchema,
});

export const POST = route(async (req: NextRequest) => {
  assertSameOrigin(req);
  const auth = await requireAdmin();
  const body = await parseBody(req, createSchema);

  const account = await prisma.instagramAccount.findUnique({ where: { id: body.accountId } });
  if (!account) throw notFound("Instagram account");
  await assertAccountAccess(auth, account.id);

  if (body.contentId) {
    const content = await prisma.contentItem.findFirst({ where: { id: body.contentId, accountId: account.id } });
    if (!content) throw validationError("Selected post/reel does not belong to this account");
  }
  for (const action of body.actions) {
    if (action.type !== "SEND_COMMENT_RESOURCE") continue;
    if (action.params.resourceId) {
      const resource = await prisma.commentResource.findFirst({ where: { id: action.params.resourceId, accountId: account.id } });
      if (!resource) throw validationError("Selected resource does not belong to this account");
    }
    if (action.params.agentId) {
      const agent = await prisma.aIAgent.findFirst({ where: { id: action.params.agentId, accountId: account.id } });
      if (!agent) throw validationError("Selected agent does not belong to this account");
    }
  }

  const automation = await prisma.automation.create({
    data: {
      accountId: body.accountId,
      name: body.name,
      description: body.description,
      trigger: body.trigger,
      contentId: body.contentId ?? null,
      conditions: body.conditions as unknown as Prisma.InputJsonValue,
      actions: body.actions as unknown as Prisma.InputJsonValue,
      enabled: body.enabled,
      cooldownSec: body.cooldownSec ?? null,
    },
  });
  await audit({
    adminId: auth.admin.id,
    action: AuditActions.CREATED_AUTOMATION,
    resourceType: "automation",
    resourceId: automation.id,
    after: { name: automation.name, trigger: automation.trigger, enabled: automation.enabled },
    ip: clientIp(req),
  });
  return ok({ automation });
});
