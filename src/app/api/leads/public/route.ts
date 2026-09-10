import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { route, ok, parseBody, clientIp, enforceRateLimit } from "@/lib/api";
import { notFound, validationError } from "@/lib/errors";
import { validateAnswer } from "@/lib/leadflow/engine";
import { enqueue } from "@/lib/queue";
import type { Prisma } from "@prisma/client";

/**
 * PUBLIC endpoint: hosted landing-page form submission (/f/{slug}).
 * No session — protected by slug secrecy + rate limiting + validation.
 */

const submitSchema = z.object({
  slug: z.string().min(3).max(40),
  answers: z.record(z.string().max(2000)).refine((r) => Object.keys(r).length <= 30, "too many answers"),
  // honeypot — bots fill it, humans never see it
  website: z.string().max(0).optional(),
});

export const POST = route(async (req: NextRequest) => {
  const ip = clientIp(req);
  enforceRateLimit(`public-lead:${ip}`, 10, 10 * 60_000);

  const body = await parseBody(req, submitSchema);
  if (body.website && body.website.length > 0) return ok({ submitted: true }); // silently drop bots

  const cta = await prisma.ctaConfig.findUnique({ where: { landingSlug: body.slug } });
  if (!cta || !cta.enabled || !cta.leadFlowId) throw notFound("Form");

  const flow = await prisma.leadFlow.findUnique({
    where: { id: cta.leadFlowId },
    include: { questions: { orderBy: { order: "asc" } } },
  });
  if (!flow || !flow.enabled) throw notFound("Form");

  // validate every answer through the SAME rules the DM engine uses
  const mapped: Record<string, string> = {};
  const answersJson: Array<{ question: string; answer: string }> = [];
  for (const q of flow.questions) {
    const raw = body.answers[q.id] ?? "";
    if (!raw && !q.required) continue;
    const result = validateAnswer(q, raw);
    if (!result.ok) {
      throw validationError(`"${q.title}": ${result.error ?? "invalid value"}`, { questionId: q.id });
    }
    if (q.mapTo && ["name", "phone", "email"].includes(q.mapTo)) mapped[q.mapTo] = result.value ?? "";
    answersJson.push({ question: q.title, answer: result.value ?? "" });
  }
  if (answersJson.length === 0) throw validationError("The form is empty");

  const lead = await prisma.lead.create({
    data: {
      accountId: cta.accountId,
      name: mapped.name ?? null,
      phone: mapped.phone ?? null,
      email: mapped.email ?? null,
      answers: answersJson as unknown as Prisma.InputJsonValue,
      source: "landing_page",
      contentId: cta.contentId,
      flowId: flow.id,
      status: "NEW",
    },
  });
  await prisma.leadEvent.create({ data: { leadId: lead.id, type: "CREATED", data: { via: "landing_page", slug: body.slug } } });
  await enqueue("lead.process", { leadId: lead.id }, { idempotencyKey: `lead.process:${lead.id}` });

  return ok({ submitted: true });
});
