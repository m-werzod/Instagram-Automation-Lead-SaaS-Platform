import { NextRequest, after } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { route, ok, parseBody, assertSameOrigin, clientIp } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/guard";
import { accountScope, assertAccountAccess } from "@/lib/auth/access";
import { audit, AuditActions } from "@/lib/audit";
import { notFound } from "@/lib/errors";
import { enqueue, drainNow } from "@/lib/queue";

const STATUSES = ["NEW", "CONTACTED", "QUALIFIED", "IN_PROGRESS", "WON", "LOST"] as const;

export const GET = route(async (req: NextRequest) => {
  const auth = await requireAdmin();
  const sp = req.nextUrl.searchParams;
  const accountId = sp.get("accountId") ?? undefined;
  const status = sp.get("status") ?? undefined;
  const q = sp.get("q") ?? undefined;

  const leads = await prisma.lead.findMany({
    where: {
      ...(await accountScope(auth, accountId)),
      ...(status && STATUSES.includes(status as (typeof STATUSES)[number]) ? { status: status as (typeof STATUSES)[number] } : {}),
      ...(q
        ? {
            OR: [
              { name: { contains: q, mode: "insensitive" } },
              { phone: { contains: q } },
              { email: { contains: q, mode: "insensitive" } },
            ],
          }
        : {}),
    },
    include: {
      account: { select: { username: true } },
      campaign: { select: { id: true, name: true } },
      flow: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 500,
  });
  return ok({ leads });
});

const createSchema = z.object({
  accountId: z.string().min(1),
  name: z.string().max(200).optional(),
  phone: z.string().max(40).optional(),
  email: z.string().email().optional(),
  notes: z.string().max(2000).optional(),
  status: z.enum(STATUSES).default("NEW"),
  notify: z.boolean().default(false),
});

export const POST = route(async (req: NextRequest) => {
  assertSameOrigin(req);
  const auth = await requireAdmin();
  const body = await parseBody(req, createSchema);

  const account = await prisma.instagramAccount.findUnique({ where: { id: body.accountId } });
  if (!account) throw notFound("Instagram account");
  await assertAccountAccess(auth, account.id);

  const lead = await prisma.lead.create({
    data: {
      accountId: body.accountId,
      name: body.name ?? null,
      phone: body.phone ?? null,
      email: body.email ?? null,
      notes: body.notes ?? null,
      status: body.status,
      source: "manual",
    },
  });
  await prisma.leadEvent.create({ data: { leadId: lead.id, type: "CREATED", adminId: auth.admin.id, data: { manual: true } } });
  if (body.notify) {
    await enqueue("lead.process", { leadId: lead.id }, { idempotencyKey: `lead.process:${lead.id}` });
    after(() => drainNow());
  }
  await audit({
    adminId: auth.admin.id,
    action: AuditActions.CREATED_LEAD,
    resourceType: "lead",
    resourceId: lead.id,
    after: { name: lead.name, status: lead.status },
    ip: clientIp(req),
  });
  return ok({ lead });
});
