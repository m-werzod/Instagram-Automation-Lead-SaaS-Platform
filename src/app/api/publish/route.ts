import { NextRequest, after } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { route, ok, parseBody, assertSameOrigin, clientIp } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/guard";
import { accountScope, assertAccountAccess } from "@/lib/auth/access";
import { audit } from "@/lib/audit";
import { AppError, notFound, validationError } from "@/lib/errors";
import { drainNow } from "@/lib/queue";
import {
  assertCanPublish,
  fetchPublishingLimit,
  hostedMediaUrl,
  isLocalMediaUrl,
  resolveItemKind,
  schedulePublishJob,
  validatePublishInput,
  type PublishItem,
} from "@/lib/meta/publishing";
import type { Prisma } from "@prisma/client";

export const GET = route(async (req: NextRequest) => {
  const auth = await requireAdmin();
  const accountId = req.nextUrl.searchParams.get("accountId") ?? undefined;
  const jobs = await prisma.publishJob.findMany({
    where: await accountScope(auth, accountId),
    orderBy: [{ scheduledAt: "desc" }],
    take: 50,
    include: { account: { select: { username: true } } },
  });
  return ok({ jobs });
});

const itemSchema = z
  .object({
    assetId: z.string().min(1).optional(),
    url: z.string().url().optional(),
    kind: z.enum(["IMAGE", "VIDEO"]).optional(),
  })
  .refine((i) => Boolean(i.assetId) !== Boolean(i.url), "Each item needs either an uploaded asset or a URL");

const createSchema = z.object({
  accountId: z.string().min(1),
  mediaType: z.enum(["IMAGE", "REELS", "STORIES", "CAROUSEL"]),
  caption: z.string().max(2200).optional(),
  items: z.array(itemSchema).min(1).max(10),
  shareToFeed: z.boolean().optional(),
  coverUrl: z.string().url().optional(),
  /** ISO datetime; omitted = publish now */
  scheduledAt: z.string().datetime().optional(),
});

export const POST = route(async (req: NextRequest) => {
  assertSameOrigin(req);
  const auth = await requireAdmin();
  const body = await parseBody(req, createSchema);

  const account = await prisma.instagramAccount.findUnique({
    where: { id: body.accountId },
    include: { permissions: true, tokens: true },
  });
  if (!account) throw notFound("Instagram account");
  await assertAccountAccess(auth, account.id);
  assertCanPublish(account);

  // Resolve uploaded assets into the public URLs Meta will fetch.
  const items: PublishItem[] = [];
  for (const item of body.items) {
    if (item.assetId) {
      const asset = await prisma.mediaAsset.findFirst({ where: { id: item.assetId, accountId: account.id } });
      if (!asset) throw validationError("Uploaded media not found for this account");
      items.push({ url: asset.externalUrl ?? hostedMediaUrl(asset.id, asset.mimeType), kind: asset.kind === "VIDEO" ? "VIDEO" : "IMAGE" });
    } else if (item.url) {
      items.push({ url: item.url, kind: resolveItemKind(body.mediaType, item.url, item.kind) });
    }
  }

  const scheduledAt = body.scheduledAt ? new Date(body.scheduledAt) : new Date();
  const problem = validatePublishInput({ mediaType: body.mediaType, items, caption: body.caption, scheduledAt: body.scheduledAt ? scheduledAt : null });
  if (problem) throw validationError(problem);

  // Hosted media on a non-public address can never be fetched by Meta.
  if (items.some((i) => isLocalMediaUrl(i.url))) {
    throw validationError("Meta cannot download media from a local address", {
      hint: "Publish from the deployed (public https) site, or paste a public URL for the media.",
    });
  }

  // Real quota check — Instagram allows 100 API posts per rolling 24 h.
  const limit = await fetchPublishingLimit(account);
  if (limit && limit.used >= limit.quota) {
    throw new AppError("META_RATE_LIMITED", "Instagram's publishing limit is reached", {
      reason: `${limit.used}/${limit.quota} API posts were published in the last 24 hours.`,
      fix: "Schedule the post for later, or publish from the Instagram app.",
    });
  }

  const job = await prisma.publishJob.create({
    data: {
      accountId: account.id,
      mediaType: body.mediaType,
      caption: body.caption?.trim() || null,
      items: items as unknown as Prisma.InputJsonValue,
      shareToFeed: body.mediaType === "REELS" ? (body.shareToFeed ?? true) : null,
      coverUrl: body.coverUrl ?? null,
      status: "SCHEDULED",
      scheduledAt,
      createdByAdminId: auth.admin.id,
    },
  });
  await schedulePublishJob(job);
  if (!body.scheduledAt) after(() => drainNow());

  await audit({
    adminId: auth.admin.id,
    action: "CREATED_PUBLISH_JOB",
    resourceType: "publish_job",
    resourceId: job.id,
    after: { mediaType: job.mediaType, items: items.length, scheduledAt: job.scheduledAt.toISOString() },
    ip: clientIp(req),
  });
  return ok({ job, limit });
});
