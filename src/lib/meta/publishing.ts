import type { InstagramAccount, PublishJob } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { coreEnv } from "@/lib/env";
import { AppError, metaPermissionMissing } from "@/lib/errors";
import { createLogger, errorFields } from "@/lib/logger";
import { enqueue } from "@/lib/queue";
import { graphCall, MetaApiError } from "./client";
import { resolveAccess } from "./tokens";
import { detectCapabilities, type AccountWithAuth } from "./capabilities";

const log = createLogger("meta.publishing");

/**
 * Instagram content publishing (docs/META_API.md §5, verified 2026-09-12):
 *
 *   POST /{ig-user-id}/media            → container (image_url | video_url, media_type, caption …)
 *   GET  /{container-id}?fields=status_code   → IN_PROGRESS | FINISHED | ERROR | EXPIRED | PUBLISHED
 *   POST /{ig-user-id}/media_publish?creation_id=…
 *   GET  /{ig-user-id}/content_publishing_limit   → 100 API posts per rolling 24 h
 *
 * Facts that shape the code: images must be JPEG; media must sit on a PUBLIC
 * URL while Meta processes it; videos take time, so a job polls and re-queues
 * itself; Instagram has NO scheduling API — "schedule" is this platform
 * holding the job until scheduledAt. Everything here is real or fails visibly.
 */

export type PublishMediaType = "IMAGE" | "REELS" | "STORIES" | "CAROUSEL";
export type PublishItemKind = "IMAGE" | "VIDEO";

export interface PublishItem {
  url: string;
  kind: PublishItemKind;
}

export const CAPTION_MAX = 2200;
export const CAROUSEL_MIN = 2;
export const CAROUSEL_MAX = 10;
/** Serverless request bodies are capped at 4.5 MB; keep a margin. */
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
/** How many times a job re-checks a container before giving up (≈ 40 × 20 s). */
export const MAX_POLL_ATTEMPTS = 40;
export const POLL_DELAY_MS = 20_000;

// ---- pure helpers (unit-tested) ----

export function validatePublishInput(input: {
  mediaType: PublishMediaType;
  items: PublishItem[];
  caption?: string | null;
  scheduledAt?: Date | null;
  now?: Date;
}): string | null {
  const { mediaType, items } = input;
  if ((input.caption ?? "").length > CAPTION_MAX) return `Caption is longer than ${CAPTION_MAX} characters`;
  if (mediaType === "CAROUSEL") {
    if (items.length < CAROUSEL_MIN || items.length > CAROUSEL_MAX) {
      return `A carousel needs ${CAROUSEL_MIN}–${CAROUSEL_MAX} items`;
    }
  } else if (items.length !== 1) {
    return "Exactly one media item is required";
  }
  for (const item of items) {
    if (!/^https:\/\//i.test(item.url)) return "Media must be on a public https:// URL";
    if (mediaType === "IMAGE" && item.kind !== "IMAGE") return "A photo post needs an image";
    if (mediaType === "REELS" && item.kind !== "VIDEO") return "A Reel needs a video";
  }
  if (input.scheduledAt) {
    const now = input.now ?? new Date();
    if (input.scheduledAt.getTime() < now.getTime() - 60_000) return "The scheduled time is in the past";
    if (input.scheduledAt.getTime() > now.getTime() + 75 * 86400_000) return "Schedule at most 75 days ahead";
  }
  return null;
}

/** Container parameters — children first (carousel), the main container last. */
export function buildContainerParams(job: {
  mediaType: PublishMediaType;
  items: PublishItem[];
  caption?: string | null;
  shareToFeed?: boolean | null;
  coverUrl?: string | null;
}): { children: Array<Record<string, unknown>>; main: (childIds: string[]) => Record<string, unknown> } {
  const caption = job.caption?.trim() || undefined;
  const first = job.items[0]!;
  switch (job.mediaType) {
    case "IMAGE":
      return { children: [], main: () => ({ image_url: first.url, ...(caption ? { caption } : {}) }) };
    case "REELS":
      return {
        children: [],
        main: () => ({
          media_type: "REELS",
          video_url: first.url,
          ...(caption ? { caption } : {}),
          ...(job.shareToFeed !== null && job.shareToFeed !== undefined ? { share_to_feed: job.shareToFeed } : {}),
          ...(job.coverUrl ? { cover_url: job.coverUrl } : {}),
        }),
      };
    case "STORIES":
      return {
        children: [],
        main: () => ({
          media_type: "STORIES",
          ...(first.kind === "VIDEO" ? { video_url: first.url } : { image_url: first.url }),
        }),
      };
    case "CAROUSEL":
      return {
        children: job.items.map((item) => ({
          is_carousel_item: true,
          ...(item.kind === "VIDEO" ? { media_type: "VIDEO", video_url: item.url } : { image_url: item.url }),
        })),
        main: (childIds) => ({
          media_type: "CAROUSEL",
          children: childIds.join(","),
          ...(caption ? { caption } : {}),
        }),
      };
  }
}

export type ContainerStatusCode = "IN_PROGRESS" | "FINISHED" | "ERROR" | "EXPIRED" | "PUBLISHED" | "UNKNOWN";

export function parseContainerStatus(json: Record<string, unknown>): { code: ContainerStatusCode; message: string | null } {
  const raw = String(json.status_code ?? "").toUpperCase();
  const code: ContainerStatusCode =
    raw === "IN_PROGRESS" || raw === "FINISHED" || raw === "ERROR" || raw === "EXPIRED" || raw === "PUBLISHED" ? raw : "UNKNOWN";
  const message = typeof json.status === "string" && json.status.trim() ? json.status.trim() : null;
  return { code, message };
}

export function parsePublishingLimit(json: Record<string, unknown>): { used: number; quota: number } | null {
  const data = Array.isArray(json.data) ? (json.data[0] as Record<string, unknown> | undefined) : undefined;
  if (!data) return null;
  const used = Number(data.quota_usage);
  const config = (data.config ?? {}) as { quota_total?: number };
  const quota = Number(config.quota_total ?? 100);
  if (!Number.isFinite(used)) return null;
  return { used, quota: Number.isFinite(quota) && quota > 0 ? quota : 100 };
}

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
};

export function extensionFor(mimeType: string): string {
  return EXT_BY_MIME[mimeType] ?? "bin";
}

/** Public URL Meta downloads a hosted asset from. */
export function hostedMediaUrl(assetId: string, mimeType: string): string {
  return `${coreEnv().APP_URL}/m/${assetId}.${extensionFor(mimeType)}`;
}

/** JPEG magic number — Meta refuses anything else no matter the extension. */
export function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

export function kindFromUrl(url: string): PublishItemKind {
  return /\.(mp4|mov|m4v)(\?|#|$)/i.test(url) ? "VIDEO" : "IMAGE";
}

/** A friendly, admin-facing line for a failed job — technical detail stays in logs. */
export function describePublishError(err: unknown): string {
  if (err instanceof MetaApiError) {
    const base = err.reason ? `${err.message} — ${err.reason}` : err.message;
    return err.fix ? `${base}. ${err.fix}` : base;
  }
  if (err instanceof AppError) return err.reason ? `${err.message} — ${err.reason}` : err.message;
  return err instanceof Error ? err.message : String(err);
}

// ---- capability + limit ----

export function assertCanPublish(account: AccountWithAuth): void {
  if (account.isDemo) {
    throw new AppError("META_UNSUPPORTED", "Demo account cannot publish", {
      reason: "Demo data never calls the Meta API.",
      fix: "Connect a real Instagram account.",
    });
  }
  const cap = detectCapabilities(account).find((c) => c.key === "publishing");
  if (!cap?.available) {
    const missing = account.connectionMode === "INSTAGRAM_LOGIN" ? "instagram_business_content_publish" : "instagram_content_publish";
    throw metaPermissionMissing(missing);
  }
}

export async function fetchPublishingLimit(account: InstagramAccount): Promise<{ used: number; quota: number } | null> {
  const access = await resolveAccess(account);
  try {
    const json = await graphCall<Record<string, unknown>>({
      host: access.host,
      path: `${account.igUserId}/content_publishing_limit`,
      accessToken: access.accessToken,
      params: { fields: "quota_usage,config" },
    });
    return parsePublishingLimit(json);
  } catch (err) {
    log.warn("content_publishing_limit unavailable", { accountId: account.id, ...errorFields(err) });
    return null;
  }
}

// ---- the job ----

export function publishRunKey(jobId: string, suffix: string): string {
  return `publish.run:${jobId}:${suffix}`;
}

export async function schedulePublishJob(job: Pick<PublishJob, "id" | "scheduledAt">): Promise<void> {
  await enqueue(
    "publish.run",
    { publishJobId: job.id },
    { runAt: job.scheduledAt, idempotencyKey: publishRunKey(job.id, String(job.scheduledAt.getTime())), maxAttempts: 3, priority: 5 },
  );
}

/**
 * One step of the publish state machine. Called by the worker; safe to call
 * repeatedly — each call advances exactly one stage and either finishes or
 * re-queues itself.
 */
export async function runPublishJob(jobId: string): Promise<void> {
  const job = await prisma.publishJob.findUnique({ where: { id: jobId }, include: { account: true } });
  if (!job) return;
  if (job.status === "CANCELLED" || job.status === "PUBLISHED" || job.status === "FAILED") return;
  if (job.status === "SCHEDULED" && job.scheduledAt.getTime() > Date.now() + 1000) {
    // woke up early (e.g. cron drain) — go back to sleep until the scheduled time
    await schedulePublishJob(job);
    return;
  }

  const account = job.account;
  const items = job.items as unknown as PublishItem[];
  const access = await resolveAccess(account);
  const ig = account.igUserId;

  if (job.status !== "PROCESSING") {
    await prisma.publishJob.update({ where: { id: job.id }, data: { status: "PROCESSING", startedAt: new Date(), lastError: null } });
  }

  try {
    let containerId = job.containerId;
    if (!containerId) {
      // Pure/deterministic given the job's own fields — cheap to recompute on
      // every re-entry, so children created on an earlier pass are never lost.
      const params = buildContainerParams({
        mediaType: job.mediaType as PublishMediaType,
        items,
        caption: job.caption,
        shareToFeed: job.shareToFeed,
        coverUrl: job.coverUrl,
      });

      // Reuse children already created on an earlier pass — creating them fresh
      // every poll would spawn a new set each cycle and never converge for a
      // carousel whose items take longer than one poll interval to process.
      let childIds = job.childContainerIds;
      if (childIds.length === 0 && params.children.length > 0) {
        const created: string[] = [];
        for (const child of params.children) {
          const res = await graphCall<{ id: string }>({ host: access.host, method: "POST", path: `${ig}/media`, accessToken: access.accessToken, body: child });
          created.push(res.id);
        }
        childIds = created;
        await prisma.publishJob.update({ where: { id: job.id }, data: { childContainerIds: childIds } });
      }

      if (childIds.length > 0) {
        // children must ALL finish processing before the parent can reference them
        let allFinished = true;
        for (const childId of childIds) {
          const st = parseContainerStatus(
            await graphCall<Record<string, unknown>>({ host: access.host, path: childId, accessToken: access.accessToken, params: { fields: "status_code,status" } }),
          );
          if (st.code === "ERROR" || st.code === "EXPIRED") throw new AppError("META_API_ERROR", `Instagram rejected a carousel item: ${st.message ?? st.code}`);
          if (st.code === "IN_PROGRESS" || st.code === "UNKNOWN") {
            allFinished = false;
            break; // no point polling the rest this pass
          }
        }
        if (!allFinished) {
          const attempts = job.attempts + 1;
          if (attempts > MAX_POLL_ATTEMPTS) {
            await fail(job.id, "Instagram did not finish processing a carousel item in time. Check the files (format, length, size) and retry.");
            return;
          }
          await prisma.publishJob.update({ where: { id: job.id }, data: { attempts } });
          return requeue(job, attempts);
        }
      }

      const main = await graphCall<{ id: string }>({
        host: access.host,
        method: "POST",
        path: `${ig}/media`,
        accessToken: access.accessToken,
        body: params.main(childIds),
      });
      containerId = main.id;
      await prisma.publishJob.update({ where: { id: job.id }, data: { containerId, childContainerIds: childIds } });
    }

    const status = parseContainerStatus(
      await graphCall<Record<string, unknown>>({ host: access.host, path: containerId, accessToken: access.accessToken, params: { fields: "status_code,status" } }),
    );

    if (status.code === "IN_PROGRESS" || status.code === "UNKNOWN") {
      const attempts = job.attempts + 1;
      if (attempts > MAX_POLL_ATTEMPTS) {
        await fail(job.id, "Instagram did not finish processing the media in time. Check the file (format, length, size) and retry.");
        return;
      }
      await prisma.publishJob.update({ where: { id: job.id }, data: { attempts } });
      return requeue(job, attempts);
    }
    if (status.code === "ERROR" || status.code === "EXPIRED") {
      await fail(job.id, status.message ? `Instagram rejected the media: ${status.message}` : `Instagram reported ${status.code} for the media container.`);
      return;
    }

    let mediaId: string | null = null;
    if (status.code === "FINISHED") {
      const published = await graphCall<{ id: string }>({
        host: access.host,
        method: "POST",
        path: `${ig}/media_publish`,
        accessToken: access.accessToken,
        body: { creation_id: containerId },
      });
      mediaId = published.id;
    }

    let permalink: string | null = null;
    if (mediaId) {
      try {
        const media = await graphCall<{
          id: string;
          permalink?: string;
          media_type?: string;
          media_product_type?: string;
          media_url?: string;
          thumbnail_url?: string;
          timestamp?: string;
          caption?: string;
        }>({
          host: access.host,
          path: mediaId,
          accessToken: access.accessToken,
          params: { fields: "id,permalink,media_type,media_product_type,media_url,thumbnail_url,timestamp,caption" },
        });
        permalink = media.permalink ?? null;
        await prisma.contentItem.upsert({
          where: { accountId_mediaId: { accountId: account.id, mediaId } },
          create: {
            accountId: account.id,
            mediaId,
            mediaType: media.media_type ?? (job.mediaType === "CAROUSEL" ? "CAROUSEL_ALBUM" : items[0]?.kind === "VIDEO" ? "VIDEO" : "IMAGE"),
            mediaProductType: media.media_product_type ?? (job.mediaType === "REELS" ? "REELS" : job.mediaType === "STORIES" ? "STORY" : "FEED"),
            caption: media.caption ?? job.caption,
            mediaUrl: media.media_url,
            thumbnailUrl: media.thumbnail_url,
            permalink,
            timestamp: media.timestamp ? new Date(media.timestamp) : new Date(),
          },
          update: { permalink, mediaUrl: media.media_url, thumbnailUrl: media.thumbnail_url, syncedAt: new Date() },
        });
      } catch (err) {
        log.warn("published, but could not read the new media back", { jobId: job.id, ...errorFields(err) });
      }
    }

    await prisma.publishJob.update({
      where: { id: job.id },
      data: { status: "PUBLISHED", publishedAt: new Date(), publishedMediaId: mediaId, permalink, lastError: null },
    });
    log.info("published to Instagram", { jobId: job.id, mediaId, mediaType: job.mediaType });
  } catch (err) {
    if (err instanceof MetaApiError && err.isRateLimit) {
      // Meta asked us to slow down — that is not a failure of the post.
      log.warn("publishing rate-limited, will retry", { jobId: job.id });
      await prisma.publishJob.update({ where: { id: job.id }, data: { attempts: { increment: 1 } } });
      await enqueue("publish.run", { publishJobId: job.id }, { runAt: new Date(Date.now() + 120_000), idempotencyKey: publishRunKey(job.id, `rl:${job.attempts + 1}`) });
      return;
    }
    log.error("publish job failed", { jobId: job.id, ...errorFields(err) });
    await fail(job.id, describePublishError(err));
  }
}

async function requeue(job: PublishJob, attempt: number): Promise<void> {
  await enqueue(
    "publish.run",
    { publishJobId: job.id },
    { runAt: new Date(Date.now() + POLL_DELAY_MS), idempotencyKey: publishRunKey(job.id, `poll:${attempt}`), maxAttempts: 3, priority: 5 },
  );
}

async function fail(jobId: string, message: string): Promise<void> {
  await prisma.publishJob.update({ where: { id: jobId }, data: { status: "FAILED", lastError: message.slice(0, 2000) } });
}
