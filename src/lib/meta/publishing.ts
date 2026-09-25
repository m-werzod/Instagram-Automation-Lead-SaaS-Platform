import { randomUUID } from "node:crypto";
import type { InstagramAccount, Prisma, PublishJob } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { coreEnv } from "@/lib/env";
import { AppError, metaPermissionMissing } from "@/lib/errors";
import { createLogger, errorFields } from "@/lib/logger";
import { currentJobSignal, enqueue } from "@/lib/queue";
import { graphCall, MetaApiError } from "./client";
import { resolveAccess, type ResolvedAccess } from "./tokens";
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
/**
 * Meta error code 9 on a publish call = this account's rolling 24 h publishing
 * quota is spent. It means "not now", not "never": the window frees itself, so
 * the job waits instead of throwing away a scheduled publication.
 */
export const PUBLISH_QUOTA_ERROR_CODE = 9;
export const QUOTA_RETRY_DELAY_MS = 30 * 60_000;
export const RATE_LIMIT_RETRY_DELAY_MS = 120_000;

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

const VIDEO_URL_EXTENSIONS = new Set(["mp4", "mov", "m4v"]);
const IMAGE_URL_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "heic", "heif", "gif"]);

/**
 * What a media URL says about itself, or null when it says nothing — a signed
 * CDN link ends in an opaque id, and there is no honest guess to make from it.
 */
export function kindFromUrlOrNull(url: string): PublishItemKind | null {
  const ext = /\.([a-z0-9]{1,5})$/i.exec(url.split(/[?#]/, 1)[0] ?? "")?.[1]?.toLowerCase();
  if (!ext) return null;
  if (VIDEO_URL_EXTENSIONS.has(ext)) return "VIDEO";
  if (IMAGE_URL_EXTENSIONS.has(ext)) return "IMAGE";
  return null;
}

/** Extension heuristic. A fallback only — see resolveItemKind. */
export function kindFromUrl(url: string): PublishItemKind {
  return kindFromUrlOrNull(url) === "VIDEO" ? "VIDEO" : "IMAGE";
}

/**
 * Kind of a pasted media URL. Only one kind is legal for a Reel or a photo post,
 * so the chosen media type fills in for a link that names no format — that is
 * what makes an extension-less signed CDN link publishable at all. A link that
 * does name a contradicting format is reported as it is, so validatePublishInput
 * refuses it here and now instead of the admin being told the post was queued
 * and the job dying at Meta minutes later. Stories and carousels take either
 * kind, so there a caller-supplied kind wins and the heuristic is a last resort.
 */
export function resolveItemKind(mediaType: PublishMediaType, url: string, explicit?: PublishItemKind | null): PublishItemKind {
  if (mediaType === "REELS") return kindFromUrlOrNull(url) ?? "VIDEO";
  if (mediaType === "IMAGE") return kindFromUrlOrNull(url) ?? "IMAGE";
  return explicit ?? kindFromUrl(url);
}

/**
 * How long to wait before trying a failed publish call again, or null when the
 * error is final for this post. Rate limits and a spent publishing quota are
 * both "come back later" answers; everything else fails the job visibly.
 */
export function retryDelayForPublishError(err: unknown): number | null {
  if (!(err instanceof MetaApiError)) return null;
  if (err.metaCode === PUBLISH_QUOTA_ERROR_CODE) return QUOTA_RETRY_DELAY_MS;
  if (err.isRateLimit) return RATE_LIMIT_RETRY_DELAY_MS;
  return null;
}

/**
 * A friendly, admin-facing line for a failed job — technical detail stays in logs.
 *
 * The `fix` line is the whole point of the sentence for the failures an admin
 * can actually act on, and the most common one of those — an expired or revoked
 * token (AppError, not MetaApiError: resolveAccess throws before any Graph call)
 * — was losing it, so the failed post said what went wrong and never said that
 * reconnecting the account in Settings fixes it. MetaApiError extends AppError,
 * so one branch covers both.
 */
export function describePublishError(err: unknown): string {
  if (err instanceof AppError) {
    const base = err.reason ? `${err.message} — ${err.reason}` : err.message;
    return err.fix ? `${base}. ${err.fix}` : base;
  }
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

export async function fetchPublishingLimit(
  account: InstagramAccount,
  known?: ResolvedAccess,
): Promise<{ used: number; quota: number } | null> {
  const access = known ?? (await resolveAccess(account));
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

/** Key of the queue row that carries a job to its scheduled time. */
export function scheduleKey(job: Pick<PublishJob, "id" | "scheduledAt">): string {
  return publishRunKey(job.id, String(job.scheduledAt.getTime()));
}

/**
 * Key for the "go back to sleep" row. Every key this file re-queues under must
 * differ from scheduleKey: the row that woke early still owns that one, so a
 * re-queue under it is swallowed as a duplicate and the post never goes out.
 * The minute bucket still collapses two workers waking the same job at once.
 *
 * `now` must be the clock the bucket is meant to track — the database's (see
 * databaseNow). Deriving the bucket from this process's clock while the database
 * decides when the parked row becomes runnable is what made the bucket collide
 * with itself under skew, and a collision here is a post that never goes out.
 */
export function wakeKey(job: Pick<PublishJob, "id" | "scheduledAt">, now: number = Date.now()): string {
  return publishRunKey(job.id, `wake:${job.scheduledAt.getTime()}:${Math.floor(now / 60_000)}`);
}

/**
 * Slack added to an early wake-up, and the reason wakeKey's minute bucket holds.
 *
 * A pass only wakes early when the row was already runnable, and a drain is a
 * tight claim loop: parked at its own scheduledAt, the new row comes straight
 * back round inside the same minute — under the same key, which enqueue drops as
 * a duplicate. Waiting past the bucket makes the next sleep a different row. The
 * margin and the bucket must be measured on the SAME clock as runAt, or the wait
 * is not a wait at all: two minutes of a clock two minutes behind is no time.
 */
export const EARLY_WAKE_MARGIN_MS = 2 * 60_000;

export function wakeRunAt(scheduledAt: Date, now: number = Date.now()): Date {
  const earliest = now + EARLY_WAKE_MARGIN_MS;
  return scheduledAt.getTime() > earliest ? scheduledAt : new Date(earliest);
}

/**
 * The clock that decides when a queue row runs: claimNextJob compares runAt to
 * the database's NOW(), not to this process's. Every wake-up decision here is
 * made on that clock so a worker whose own clock is a minute or two off still
 * parks the job for a real interval and still lands in a later key bucket.
 * Falls back to the local clock rather than failing a publication over it.
 */
export async function databaseNow(): Promise<number> {
  try {
    const rows = await prisma.$queryRaw<Array<{ now: Date }>>`SELECT NOW() AS now`;
    const now = rows[0]?.now;
    if (now instanceof Date && Number.isFinite(now.getTime())) return now.getTime();
  } catch (err) {
    log.warn("could not read the database clock — using this process's", errorFields(err));
  }
  return Date.now();
}

/**
 * Queue the next pass of a publish job. enqueue() drops a duplicate
 * idempotencyKey, which is exactly what collapses two workers parking the same
 * job at the same instant — but only while the row holding that key is still
 * going to run. When the key collides with a spent row (the very row this pass
 * is executing under), dropping it leaves NOTHING queued and the post sits in
 * SCHEDULED forever. So a dropped enqueue is checked, and re-queued under a
 * distinct key when the key's owner will never run again.
 */
async function parkPublishPass(publishJobId: string, runAt: Date, key: string): Promise<void> {
  const opts = { runAt, maxAttempts: 3, priority: 5 };
  if (await enqueue("publish.run", { publishJobId }, { ...opts, idempotencyKey: key })) return;

  const holder = await prisma.job.findUnique({
    where: { idempotencyKey: key },
    select: { status: true, attempts: true, maxAttempts: true },
  });
  const willRun = holder !== null && (holder.status === "PENDING" || holder.status === "FAILED") && holder.attempts < holder.maxAttempts;
  if (willRun) return;

  await enqueue("publish.run", { publishJobId }, { ...opts, idempotencyKey: `${key}:${randomUUID()}` });
  log.warn("publish re-queue key was already spent — queued under a fresh one", {
    publishJobId,
    key,
    holder: holder?.status ?? "missing",
  });
}

export async function schedulePublishJob(job: Pick<PublishJob, "id" | "scheduledAt">): Promise<void> {
  await parkPublishPass(job.id, job.scheduledAt, scheduleKey(job));
}

/**
 * ---- one pass at a time ----
 *
 * Every irreversible step here (creating a media container, media_publish) is a
 * Meta call with no idempotency key of its own, so the ONLY thing standing
 * between a retry and a double publish is that two passes never run at once.
 * The queue's timeout cannot promise that on its own: it abandons the await
 * while the handler keeps running (see processJob), and more than one queue row
 * can point at the same publish job (the schedule row, an early-wake row, a poll
 * row). So the publish job itself carries the lock.
 *
 * `startedAt` IS that lock: it is the instant the pass that currently owns this
 * job claimed it, and null between passes. Claiming is one conditional update —
 * whoever wins it owns the job — and every write a pass makes afterwards carries
 * that same instant as a fence, so a pass that lost the lock (its lease lapsed
 * and a later pass took over) writes nothing and stops at its next checkpoint
 * instead of publishing behind the pass that replaced it.
 */
export const PUBLISH_PASS_LEASE_MS = 15 * 60_000;

/** The fence: the exact `startedAt` this pass claimed the job with. */
interface PassLease {
  heldSince: Date;
}

async function claimPass(job: PublishJob, now: number): Promise<PassLease | null> {
  const heldSince = new Date(now);
  const claimed = await prisma.publishJob.updateMany({
    where: {
      id: job.id,
      // Guarded like the terminal writes below. Unconditional, this claim wrote
      // PROCESSING over a cancel that landed after the read above — losing it
      // entirely, so the later guards saw a live job and the post still went out.
      status: { notIn: ["CANCELLED", "PUBLISHED", "FAILED"] },
      OR: [{ startedAt: null }, { startedAt: { lt: new Date(now - PUBLISH_PASS_LEASE_MS) } }],
    },
    data: {
      status: "PROCESSING",
      startedAt: heldSince,
      // Keep the note a parked pass left ("waiting for the publishing quota")
      // until this pass has something truer to say about it.
      ...(job.status === "PROCESSING" ? {} : { lastError: null }),
    },
  });
  return claimed.count > 0 ? { heldSince } : null;
}

/** Write to the job only while this pass still owns it. `false` = it does not. */
async function writeOwned(jobId: string, lease: PassLease, data: Prisma.PublishJobUpdateManyMutationInput): Promise<boolean> {
  const res = await prisma.publishJob.updateMany({
    where: { id: jobId, startedAt: lease.heldSince, status: { not: "CANCELLED" } },
    data,
  });
  return res.count > 0;
}

type PassLoss = "cancelled" | "taken over" | "abandoned" | "deleted";

/**
 * Why this pass may no longer act, or null. Re-read immediately before anything
 * Instagram cannot undo: between two Meta calls the admin can cancel, the queue
 * can abandon this pass (its budget expired and the job is already being run
 * again), or a later pass can have taken the lease over. Acting anyway is
 * exactly how one scheduled post becomes two.
 */
async function passLost(jobId: string, lease: PassLease, signal?: AbortSignal): Promise<PassLoss | null> {
  if (signal?.aborted) return "abandoned";
  const row = await prisma.publishJob.findUnique({ where: { id: jobId }, select: { status: true, startedAt: true } });
  if (!row) return "deleted";
  if (row.status === "CANCELLED") return "cancelled";
  if (row.startedAt === null || row.startedAt.getTime() !== lease.heldSince.getTime()) return "taken over";
  return null;
}

/**
 * One step of the publish state machine. Called by the worker; safe to call
 * repeatedly — each call advances exactly one stage and either finishes or
 * re-queues itself. Two calls never advance it at the same time (see the lease
 * above), which is what keeps a retry from publishing a second copy.
 */
export async function runPublishJob(jobId: string, signal: AbortSignal | undefined = currentJobSignal()): Promise<void> {
  const job = await prisma.publishJob.findUnique({ where: { id: jobId }, include: { account: true } });
  if (!job) return;
  if (job.status === "CANCELLED" || job.status === "PUBLISHED" || job.status === "FAILED") return;

  // The database's clock throughout: it is the one that decided this row was
  // runnable, and the one that decides when the row parked below will be.
  const now = await databaseNow();

  if (job.status === "SCHEDULED" && job.scheduledAt.getTime() > now + 1000) {
    // Woke up early (a cron drain claims every runnable row). The queue row
    // executing right now already holds schedulePublishJob's idempotency key, so
    // re-using it would be swallowed as a duplicate and the post would never go
    // out — the wake-up time in the key makes this an actual new sleep, and
    // wakeRunAt keeps the new row out of the minute that key buckets on.
    await parkPublishPass(job.id, wakeRunAt(job.scheduledAt, now), wakeKey(job, now));
    return;
  }

  const lease = await claimPass(job, now);
  if (!lease) {
    const held = await prisma.publishJob.findUnique({ where: { id: job.id }, select: { status: true, startedAt: true } });
    if (!held || held.status === "CANCELLED" || held.status === "PUBLISHED" || held.status === "FAILED") {
      log.info("publish job settled before this pass started", { jobId: job.id, status: held?.status ?? "deleted" });
      return;
    }
    // Another pass holds it. Come back when its lease can be taken over, so a
    // holder that turns out to be dead cannot strand the post with nothing queued.
    const leaseEnds = (held.startedAt?.getTime() ?? now) + PUBLISH_PASS_LEASE_MS;
    await parkPublishPass(job.id, new Date(leaseEnds), publishRunKey(job.id, `lease:${leaseEnds}`));
    log.info("another pass owns this publish job — parked behind its lease", { jobId: job.id, leaseEnds: new Date(leaseEnds).toISOString() });
    return;
  }

  const account = job.account;
  const items = job.items as unknown as PublishItem[];
  const ig = account.igUserId;

  try {
    // Inside the try deliberately: an expired or revoked token throws here, and
    // a throw from outside it left the job stuck in SCHEDULED with no lastError.
    const access = await resolveAccess(account);

    let containerId = job.containerId;
    if (!containerId) {
      // The quota is also checked when the post is created, but a scheduled post
      // can sit for days — by the time it runs the 24 h window may be full. Only
      // on the pass that actually creates containers, not on every poll after it.
      const limit = job.childContainerIds.length === 0 ? await fetchPublishingLimit(account, access) : null;
      if (limit && limit.used >= limit.quota) {
        await retryLater(
          job,
          lease,
          now,
          QUOTA_RETRY_DELAY_MS,
          "quota",
          `Instagram's publishing limit is full (${limit.used}/${limit.quota} API posts in the last 24 hours). Waiting for it to free up.`,
        );
        return;
      }

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
        const lost = await passLost(job.id, lease, signal);
        if (lost) return dropPass(job.id, lease, now, lost, "creating carousel items");
        const created: string[] = [];
        for (const child of params.children) {
          const res = await graphCall<{ id: string }>({ host: access.host, method: "POST", path: `${ig}/media`, accessToken: access.accessToken, body: child });
          created.push(res.id);
        }
        childIds = created;
        if (!(await writeOwned(job.id, lease, { childContainerIds: childIds }))) {
          // Someone else owns the job now; these containers belong to nobody and
          // expire on their own in 24 h. Named in the log so they are traceable.
          log.warn("lost the pass while creating carousel items — orphaned them", { jobId: job.id, childIds });
          return;
        }
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
            await fail(job.id, lease, "Instagram did not finish processing a carousel item in time. Check the files (format, length, size) and retry.");
            return;
          }
          return requeue(job, lease, now, attempts);
        }
      }

      // The container is the post: create a second one and Instagram gets a
      // second copy. Last check before the point of no return.
      const lost = await passLost(job.id, lease, signal);
      if (lost) return dropPass(job.id, lease, now, lost, "creating the media container");
      const main = await graphCall<{ id: string }>({
        host: access.host,
        method: "POST",
        path: `${ig}/media`,
        accessToken: access.accessToken,
        body: params.main(childIds),
      });
      containerId = main.id;
      if (!(await writeOwned(job.id, lease, { containerId, childContainerIds: childIds }))) {
        log.warn("lost the pass while creating the media container — orphaned it", { jobId: job.id, containerId });
        return;
      }
    }

    const status = parseContainerStatus(
      await graphCall<Record<string, unknown>>({ host: access.host, path: containerId, accessToken: access.accessToken, params: { fields: "status_code,status" } }),
    );

    if (status.code === "IN_PROGRESS" || status.code === "UNKNOWN") {
      const attempts = job.attempts + 1;
      if (attempts > MAX_POLL_ATTEMPTS) {
        await fail(job.id, lease, "Instagram did not finish processing the media in time. Check the file (format, length, size) and retry.");
        return;
      }
      return requeue(job, lease, now, attempts);
    }
    if (status.code === "ERROR" || status.code === "EXPIRED") {
      await fail(job.id, lease, status.message ? `Instagram rejected the media: ${status.message}` : `Instagram reported ${status.code} for the media container.`);
      return;
    }
    if (status.code === "PUBLISHED") {
      // Meta says this container is already live: an earlier pass published it
      // and did not get to write the result down. Republishing it is refused by
      // Meta anyway, and the honest record is "published, media id unknown".
      log.warn("container was already published by an earlier pass", { jobId: job.id, containerId });
    }

    let mediaId: string | null = null;
    if (status.code === "FINISHED") {
      // media_publish cannot be undone, so ownership and the cancel flag are
      // re-read as late as possible — an admin can cancel while this very pass is
      // in flight, and a pass the queue abandoned must not publish behind the one
      // that replaced it.
      const lost = await passLost(job.id, lease, signal);
      if (lost) return dropPass(job.id, lease, now, lost, "publishing");
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

    // Conditional on the cancel flag only, deliberately NOT on the pass lease:
    // once Instagram has the post, recording it matters more than which pass
    // owns the row. A cancel that landed while this pass ran must still not be
    // overwritten by a PUBLISHED status it never chose.
    const written = await prisma.publishJob.updateMany({
      where: { id: job.id, status: { not: "CANCELLED" } },
      data: { status: "PUBLISHED", publishedAt: new Date(), publishedMediaId: mediaId, permalink, lastError: null },
    });
    if (written.count === 0) {
      // Cancelled in the moments after media_publish went through. The post IS
      // live on Instagram and nothing here can take it down, so the row says so
      // instead of pretending the cancel worked.
      await prisma.publishJob.update({
        where: { id: job.id },
        data: {
          publishedMediaId: mediaId,
          permalink,
          lastError:
            "Cancelled too late — Instagram had already published this post. Delete it in the Instagram app if it should not be live.",
        },
      });
      log.warn("publish cancelled after Instagram accepted it", { jobId: job.id, mediaId });
      return;
    }
    log.info("published to Instagram", { jobId: job.id, mediaId, mediaType: job.mediaType });
  } catch (err) {
    const delayMs = retryDelayForPublishError(err);
    if (delayMs !== null) {
      const quotaSpent = err instanceof MetaApiError && err.metaCode === PUBLISH_QUOTA_ERROR_CODE;
      await retryLater(
        job,
        lease,
        now,
        delayMs,
        quotaSpent ? "quota" : "rl",
        quotaSpent
          ? `Instagram's 24-hour publishing limit is full — waiting for room. ${describePublishError(err)}`
          : `Meta asked us to slow down — retrying. ${describePublishError(err)}`,
      );
      return;
    }
    log.error("publish job failed", { jobId: job.id, ...errorFields(err) });
    await fail(job.id, lease, describePublishError(err));
  }
}

/**
 * Stop this pass. For every loss but one, that means touching nothing: whoever
 * owns the job now (the admin who cancelled it, or the pass that took the lease
 * over) decides what happens next, and writing anything here — a failure
 * especially — would be this pass overruling them.
 *
 * "abandoned" is the exception, and it is the one loss with no successor. The
 * queue stopped waiting for this handler, but it did NOT re-queue the job: the
 * row is left RUNNING on its lease precisely so a retry cannot overlap the pass
 * still in flight (see processJob). Returning quietly here ends that pass — and
 * the queue then records the handler's clean return by COMPLETING the very row
 * recovery would have revived, so nothing anywhere would ever run the job again
 * and the post sticks in PROCESSING, which neither retry nor delete will accept.
 * Nothing irreversible happened before this checkpoint, so the safe hand-over is
 * the same one a poll makes: release the lease and queue the next pass.
 */
async function dropPass(jobId: string, lease: PassLease, now: number, reason: PassLoss, stage: string): Promise<void> {
  log.info("publish pass stopped", { jobId, reason, stage });
  if (reason !== "abandoned") return;
  if (!(await writeOwned(jobId, lease, { startedAt: null }))) return;
  await parkPublishPass(jobId, new Date(now), publishRunKey(jobId, `abandoned:${lease.heldSince.getTime()}`));
}

/**
 * Hand the job to its next pass: release the lease FIRST (a queued pass that
 * starts immediately must find the job free), then queue that pass. Every delay
 * here is measured on the database's clock, the one that decides when the queued
 * row actually runs — a 20-second poll by a clock 20 seconds behind is no poll
 * interval at all, and forty of those burn the job's attempts in a moment.
 */
async function requeue(job: PublishJob, lease: PassLease, now: number, attempt: number): Promise<void> {
  if (!(await writeOwned(job.id, lease, { attempts: attempt, startedAt: null }))) return;
  await parkPublishPass(job.id, new Date(now + POLL_DELAY_MS), publishRunKey(job.id, `poll:${attempt}`));
}

/**
 * Meta said "not now" — a rate limit, or a spent 24 h publishing quota. Park the
 * post and come back for it; failing a publication over a condition that clears
 * by itself loses the post. The note is what the admin sees while it waits.
 */
async function retryLater(job: PublishJob, lease: PassLease, now: number, delayMs: number, tag: string, note: string): Promise<void> {
  const attempts = job.attempts + 1;
  if (attempts > MAX_POLL_ATTEMPTS) {
    await fail(job.id, lease, `${note} Gave up after ${MAX_POLL_ATTEMPTS} attempts.`);
    return;
  }
  const parked = await writeOwned(job.id, lease, { attempts, lastError: note.slice(0, 2000), startedAt: null });
  if (!parked) return;
  await parkPublishPass(job.id, new Date(now + delayMs), publishRunKey(job.id, `${tag}:${attempts}`));
  log.warn("publish deferred, will retry", { jobId: job.id, tag, attempts, delayMs });
}

/**
 * Guarded like the PUBLISHED write — a job cancelled mid-pass stays CANCELLED —
 * and guarded by the lease too: only the pass that owns the job may declare it
 * failed. An abandoned pass that fails it here would leave the post FAILED while
 * the pass that replaced it was still working, and the next pass returns early
 * on a FAILED row.
 */
async function fail(jobId: string, lease: PassLease, message: string): Promise<void> {
  await writeOwned(jobId, lease, { status: "FAILED", lastError: message.slice(0, 2000) });
}
