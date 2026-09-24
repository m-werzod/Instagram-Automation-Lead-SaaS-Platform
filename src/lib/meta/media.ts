import type { InstagramAccount } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { AppError } from "@/lib/errors";
import { createLogger, errorFields } from "@/lib/logger";
import { graphCall, graphCallPaged } from "./client";
import { resolveAccess } from "./tokens";

const log = createLogger("meta.media");

/**
 * Media retrieval + insights (docs/META_API.md §6–7).
 * NOTE: `impressions` is deprecated — the `views` era metrics only.
 */

interface GraphMedia {
  id: string;
  caption?: string;
  media_type: string;
  media_product_type?: string;
  media_url?: string;
  thumbnail_url?: string;
  permalink?: string;
  timestamp?: string;
  like_count?: number;
  comments_count?: number;
}

const MEDIA_FIELDS =
  "id,caption,media_type,media_product_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count";

export async function syncMedia(account: InstagramAccount, maxItems = 100): Promise<number> {
  const access = await resolveAccess(account);
  const items = await graphCallPaged<GraphMedia>(
    {
      host: access.host,
      path: `${account.igUserId}/media`,
      accessToken: access.accessToken,
      params: { fields: MEDIA_FIELDS, limit: 50 },
    },
    maxItems,
  );

  for (const m of items) {
    await prisma.contentItem.upsert({
      where: { accountId_mediaId: { accountId: account.id, mediaId: m.id } },
      create: {
        accountId: account.id,
        mediaId: m.id,
        mediaType: m.media_type,
        mediaProductType: m.media_product_type,
        caption: m.caption,
        mediaUrl: m.media_url,
        thumbnailUrl: m.thumbnail_url,
        permalink: m.permalink,
        timestamp: m.timestamp ? new Date(m.timestamp) : null,
        likeCount: m.like_count,
        commentsCount: m.comments_count,
      },
      update: {
        caption: m.caption,
        mediaUrl: m.media_url,
        thumbnailUrl: m.thumbnail_url,
        permalink: m.permalink,
        likeCount: m.like_count,
        commentsCount: m.comments_count,
        syncedAt: new Date(),
      },
    });
  }

  await prisma.instagramAccount.update({ where: { id: account.id }, data: { lastSyncAt: new Date() } });
  return items.length;
}

/**
 * Metric set per media product type. Meta rejects the WHOLE request when a
 * single metric does not apply to the media, which is why stories — asked for
 * likes, comments and saves they do not have — never returned any insights at
 * all. A story has replies instead (docs/META_API.md §7).
 */
export function insightMetricsFor(mediaProductType?: string | null): string {
  switch ((mediaProductType ?? "").toUpperCase()) {
    case "REELS":
      return "views,reach,likes,comments,shares,saved,total_interactions";
    case "STORY":
    case "STORIES":
      return "views,reach,replies,total_interactions";
    default:
      return "views,reach,likes,comments,shares,saved";
  }
}

/** Insights either exist or they do not — never a silent empty success. */
export type MediaInsightsResult =
  | { ok: true; metrics: Record<string, number> }
  | { ok: false; reason: string; error: unknown };

/** Media-level insights; metric set depends on media product type. */
export async function fetchMediaInsights(
  account: InstagramAccount,
  mediaId: string,
  mediaProductType?: string | null,
): Promise<MediaInsightsResult> {
  const access = await resolveAccess(account);
  try {
    const res = await graphCall<{ data: Array<{ name: string; values?: Array<{ value: number }>; total_value?: { value: number } }> }>({
      host: access.host,
      path: `${mediaId}/insights`,
      accessToken: access.accessToken,
      params: { metric: insightMetricsFor(mediaProductType) },
    });
    const out: Record<string, number> = {};
    for (const m of res.data ?? []) {
      out[m.name] = m.total_value?.value ?? m.values?.[0]?.value ?? 0;
    }
    if (Object.keys(out).length === 0) {
      // Meta answers 200 with an empty data array for media it keeps no insights
      // for (a story past its 24 h window, media from before the account became
      // a Business account). Storing {} would show the admin a zeroed post.
      return { ok: false, reason: "Instagram returned no insight metrics for this post.", error: null };
    }
    return { ok: true, metrics: out };
  } catch (err) {
    log.warn("media insights unavailable", { mediaId, mediaProductType, ...errorFields(err) });
    return { ok: false, reason: describeInsightsError(err), error: err };
  }
}

function describeInsightsError(err: unknown): string {
  if (err instanceof AppError) return err.reason ? `${err.message} — ${err.reason}` : err.message;
  return err instanceof Error ? err.message : String(err);
}

/** Account-level insights for the analytics page (views era). */
export async function fetchAccountInsights(account: InstagramAccount, sinceDays = 7) {
  const access = await resolveAccess(account);
  const since = Math.floor((Date.now() - sinceDays * 86400_000) / 1000);
  const until = Math.floor(Date.now() / 1000);
  try {
    const res = await graphCall<{
      data: Array<{ name: string; total_value?: { value: number }; values?: Array<{ value: number; end_time?: string }> }>;
    }>({
      host: access.host,
      path: `${account.igUserId}/insights`,
      accessToken: access.accessToken,
      params: {
        metric: "views,reach,accounts_engaged,total_interactions,profile_links_taps",
        period: "day",
        metric_type: "total_value",
        since,
        until,
      },
    });
    const out: Record<string, number> = {};
    for (const m of res.data ?? []) {
      out[m.name] = m.total_value?.value ?? (m.values ?? []).reduce((s, v) => s + (v.value ?? 0), 0);
    }
    return out;
  } catch (err) {
    log.warn("account insights unavailable", { accountId: account.id, ...errorFields(err) });
    return null;
  }
}
