import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { route, ok, parseBody, assertSameOrigin, clientIp } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/guard";
import { audit, AuditActions } from "@/lib/audit";
import { notFound } from "@/lib/errors";
import { questionSchema } from "@/lib/validation/leadflow";

export const GET = route(async (req: NextRequest) => {
  await requireAdmin();
  const accountId = req.nextUrl.searchParams.get("accountId") ?? undefined;
  const flows = await prisma.leadFlow.findMany({
    where: accountId ? { accountId } : {},
    include: {
      questions: { orderBy: { order: "asc" } },
      account: { select: { username: true } },
      _count: { select: { sessions: true, leads: true } },
    },
    orderBy: { createdAt: "asc" },
  });
  return ok({ flows });
});

const createSchema = z.object({
  accountId: z.string().min(1),
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  triggerKeywords: z.array(z.string().min(1).max(60)).max(20).default([]),
  completionMessage: z.string().max(900).optional(),
  questions: z.array(questionSchema).min(1).max(25),
});

export const POST = route(async (req: NextRequest) => {
  assertSameOrigin(req);
  const auth = await requireAdmin();
  const body = await parseBody(req, createSchema);

  const account = await prisma.instagramAccount.findUnique({ where: { id: body.accountId } });
  if (!account) throw notFound("Instagram account");

  const flow = await prisma.leadFlow.create({
    data: {
      accountId: body.accountId,
      name: body.name,
      description: body.description,
      triggerKeywords: body.triggerKeywords,
      completionMessage: body.completionMessage,
      questions: {
        create: body.questions.map((q, i) => ({
          order: i + 1,
          title: q.title,
          prompt: q.prompt,
          type: q.type,
          required: q.required,
          options: q.options,
          mapTo: q.mapTo ?? null,
          validationRegex: q.validationRegex ?? null,
        })),
      },
    },
    include: { questions: { orderBy: { order: "asc" } } },
  });

  await audit({
    adminId: auth.admin.id,
    action: AuditActions.CREATED_LEAD_FLOW,
    resourceType: "lead_flow",
    resourceId: flow.id,
    after: { name: flow.name, questions: flow.questions.length },
    ip: clientIp(req),
  });
  return ok({ flow });
});
