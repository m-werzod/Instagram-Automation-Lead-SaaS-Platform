import { NextRequest, after } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { route, ok, parseBody, assertSameOrigin, clientIp } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/guard";
import { accountScope, assertAccountAccess } from "@/lib/auth/access";
import { audit, AuditActions } from "@/lib/audit";
import { notFound } from "@/lib/errors";
import { enqueue, drainNow } from "@/lib/queue";
import { normalizeLeadTags, parseLeadPage } from "@/lib/leads";
import type { Prisma } from "@prisma/client";

const STATUSES = ["NEW", "CONTACTED", "QUALIFIED", "IN_PROGRESS", "WON", "LOST"] as const;

/** `followUp` board filters: overdue = due now or earlier, scheduled = has a date, none = has none. */
function followUpWhere(mode: string | null): Prisma.LeadWhereInput {
  switch (mode) {
    case "overdue":
      return { followUpAt: { lte: new Date() } };
    case "scheduled":
      return { followUpAt: { not: null } };
    case "none":
      return { followUpAt: null };
    default:
      return {};
  }
}

export const GET = route(async (req: NextRequest) => {
  const auth = await requireAdmin();
  const sp = req.nextUrl.searchParams;
  const accountId = sp.get("accountId") ?? undefined;
  const status = sp.get("status") ?? undefined;
  const q = sp.get("q") ?? undefined;
  const tags = normalizeLeadTags((sp.get("tags") ?? "").split(","));
  const { limit, offset } = parseLeadPage(sp.get("limit"), sp.get("offset"));

  const where: Prisma.LeadWhereInput = {
    ...(await accountScope(auth, accountId)),
    ...(status && STATUSES.includes(status as (typeof STATUSES)[number]) ? { status: status as (typeof STATUSES)[number] } : {}),
    ...(tags.length ? { tags: { hasSome: tags } } : {}),
    ...followUpWhere(sp.get("followUp")),
    ...(q
      ? {
          OR: [
            { name: { contains: q, mode: "insensitive" } },
            { phone: { contains: q } },
            { email: { contains: q, mode: "insensitive" } },
            { outcomeReason: { contains: q, mode: "insensitive" } },
          ],
        }
      : {}),
  };

  // `total` is what makes the truncation visible: the board can say "showing
  // 500 of 1 240" instead of quietly losing the older half.
  const [total, leads] = await Promise.all([
    prisma.lead.count({ where }),
    prisma.lead.findMany({
      where,
      include: {
        account: { select: { username: true } },
        campaign: { select: { id: true, name: true } },
        flow: { select: { id: true, name: true } },
        assignedAdmin: { select: { id: true, name: true, login: true } },
      },
      // id breaks ties so a lead can never be skipped or repeated between pages
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: offset,
      take: limit,
    }),
  ]);

  return ok({ leads, total, limit, offset, hasMore: offset + leads.length < total });
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
