# META / INSTAGRAM API — verified capability reference

> Verified against **current official Meta documentation** on 2026-09-10 (Graph API **v25.0**).
> Sources: developers.facebook.com/docs/instagram-platform, /docs/messenger-platform, /docs/marketing-api.
> Rule enforced across this codebase: **if Meta does not support it, we do not fake it.**
> Every capability below maps to `src/lib/meta/capabilities.ts`, which drives UI availability.

## 1. The two connection modes

Meta currently offers two distinct Instagram API setups. This platform implements **both**, stored as
`connectionMode` on `instagram_accounts`:

| | **A. Instagram API with Instagram Login** | **B. Instagram API with Facebook Login for Business** |
| --- | --- | --- |
| OAuth host | `www.instagram.com/oauth/authorize` | `www.facebook.com/{v}/dialog/oauth` |
| Token exchange | `api.instagram.com/oauth/access_token` (short-lived) → `graph.instagram.com/access_token?grant_type=ig_exchange_token` (long-lived, 60 days) | code → `graph.facebook.com/{v}/oauth/access_token`, then long-lived exchange (`fb_exchange_token`); Page tokens derived from `/me/accounts` |
| API host | `graph.instagram.com` | `graph.facebook.com` |
| Account requirement | Instagram **professional** account (Business or Creator). No Facebook Page needed. | Instagram professional account **linked to a Facebook Page** |
| Token refresh | `graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token` — token must be ≥24 h old and unexpired; refreshed tokens last 60 days | Long-lived user token 60 days; long-lived **Page** tokens do not expire while valid |
| Supports | messaging, publishing, comments, insights, mentions | media, publishing, comments, insights, hashtag search, business discovery, **Marketing API (ads, lead ads)** via linked Page |
| Does NOT support | **ads / Marketing API / lead forms** | — |

**Product consequence**: organic automation (DMs, comments, publishing, insights) uses mode A by default
(simpler eligibility). Anything advertising-related (campaigns, native CTA buttons, Instant Forms)
**requires mode B** — the UI shows Campaigns as Unavailable for mode-A-only accounts, with the reason.

## 2. OAuth scopes (current names)

Scope names were renamed effective **2025-01-27** (old `business_basic` style names are dead):

- Mode A (Instagram Login): `instagram_business_basic`, `instagram_business_manage_messages`,
  `instagram_business_manage_comments`, `instagram_business_content_publish`,
  `instagram_business_manage_insights`.
- Mode B (Facebook Login): `instagram_basic`, `instagram_manage_messages`, `instagram_manage_comments`,
  `instagram_content_publish`, `instagram_manage_insights`, `pages_show_list`, `pages_read_engagement`,
  `pages_manage_metadata`, `business_management`; for ads add `ads_management`, `ads_read`,
  `pages_manage_ads`, `leads_retrieval`.

Granted scopes are read back from the token (`/me/permissions` on FB; scope list returned in the IG
token exchange response / `/me?fields=...` probes) and persisted to `instagram_permissions`.

## 3. Messaging (Instagram DMs) — v25.0, verified

- Endpoint: `POST graph.instagram.com/v25.0/me/messages` (mode A) /
  `POST graph.facebook.com/v25.0/me/messages` with Page token (mode B).
  Body: `{recipient: {id: <IGSID>}, message: {...}}`.
- **24-hour window**: an app may message a user only after the user messages the professional account,
  and must respond within 24 h. Outside the window only the **HUMAN_AGENT** tag (7-day window, requires
  approved advanced permission) is allowed. The send path in `src/lib/meta/messaging.ts` enforces this
  and refuses out-of-window automated sends.
- Payload types supported: text (UTF-8, ≤1000 bytes), image/GIF (PNG/JPEG ≤8 MB), audio (AAC/M4A/WAV/MP4
  ≤25 MB), video (MP4/OGG/AVI/MOV/WEBM ≤25 MB), PDF ≤25 MB, heart sticker, reactions, owned published
  posts, **generic template**, **button template**, **quick replies**.
- Quick replies: max **13** per message, title ≤ 20 chars → our lead-flow engine uses quick replies for
  `SINGLE_SELECT`/`BOOLEAN` questions when ≤13 options, otherwise a numbered text list (documented,
  automatic fallback on send error).
- **No group messaging**. One user per conversation.
- Requests-folder conversations inactive ≥30 days are not returned by the conversations API.
- Private replies: a DM may be sent in reply to a comment (`recipient: {comment_id}`) within 7 days —
  this is how "comment → DM lead flow" automations work.
- Required webhook fields: `messages`, `messaging_postbacks`, `messaging_seen`, `messaging_reactions`,
  `messaging_optins`, `messaging_referrals`, `message_echoes`.
- Icebreakers & persistent menu: supported via the messenger-profile endpoint (optional; not in v1).

## 4. Webhooks — verified

- Verification: Meta GETs the callback with `hub.mode=subscribe`, `hub.verify_token`, `hub.challenge`;
  we compare the verify token (`META_WEBHOOK_VERIFY_TOKEN`) and echo `hub.challenge`.
- Every delivery carries `X-Hub-Signature-256: sha256=<HMAC-SHA256(payload, app_secret)>`. We validate
  with a constant-time compare and reject on mismatch (401). (Meta calls validation "optional but
  recommended" — here it is mandatory.)
- **The Meta app must be Live** (and use valid TLS) to receive production webhooks; in Development Mode
  events are delivered only for app-role users (fine for this private platform — but note `comments` and
  `live_comments` fields require **Advanced Access** to fire for non-role users).
- Delivery is at-least-once and can arrive out of order → `webhook_events` stores a dedupe key
  (message `mid` / event hash) with a unique index; duplicates are acknowledged but not re-processed.
- Mode A subscriptions: `POST graph.instagram.com/{v}/{ig-user-id}/subscribed_apps?subscribed_fields=...`.
  Mode B: `POST /{page-id}/subscribed_apps`.
- Always respond 200 fast; processing is queued (worker), never inline.

## 5. Content publishing — verified

- Two-step: `POST /{ig-user-id}/media` (container; `image_url` **JPEG only**, or `video_url`, `media_type=
  IMAGE|REELS|STORIES|CAROUSEL`, `caption`, etc.) → poll container `status_code` → `POST
  /{ig-user-id}/media_publish?creation_id=...`. Video/image must be on a **publicly reachable URL**
  during processing.
- Carousels: up to 10 children, count as 1 post.
- **Rate limit: 100 API-published posts per rolling 24 h**; check `GET /{ig-user-id}/content_publishing_limit`.
- Scope: `instagram_business_content_publish` (A) / `instagram_content_publish` (B).

## 6. Media & profile retrieval — verified

- `GET /me?fields=user_id,username,name,account_type,profile_picture_url,followers_count,media_count`
  (mode A) or `GET /{ig-user-id}?fields=...` via Page linkage (mode B).
- `GET /{ig-user-id}/media?fields=id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,
  like_count,comments_count,media_product_type` — media_product_type distinguishes `REELS`/`FEED`/`STORY`.
- Comments: `GET/POST /{ig-media-id}/comments`, `POST /{ig-comment-id}/replies`, hide/unhide, delete.

## 7. Insights — verified (2025 metric migration)

- `impressions` is **deprecated** (removed for all versions 2025-04-21). The replacement is `views`
  (`metric_type=total_value`). Never surface an "impressions" number.
- Account metrics available: `views`, `reach`, `accounts_engaged`, `total_interactions`, `likes`,
  `comments`, `shares`, `saves`, `replies`, `reposts`, `follows_and_unfollows`, `profile_links_taps`,
  `engaged_audience_demographics`, `follower_demographics` (`period=day` for interactions,
  `lifetime` for demographics).
- Media insights: per-media `/insights` with type-dependent metrics (reels: `views`, `reach`, `likes`,
  `comments`, `shares`, `saves`, `total_interactions`, `ig_reels_avg_watch_time`, ...).
- Scope: `instagram_business_manage_insights` (A) / `instagram_manage_insights` + `pages_read_engagement` (B).

## 8. Marketing API (campaigns, ads, lead forms) — verified

**Only available in mode B** (Facebook Login + linked Page + ad account + `ads_management`).

- Hierarchy: **Campaign → Ad Set → Ad (references Ad Creative)**.
- Campaign: `name`, `objective` (ODAX: `OUTCOME_LEADS`, `OUTCOME_SALES`, `OUTCOME_TRAFFIC`,
  `OUTCOME_AWARENESS`, `OUTCOME_ENGAGEMENT`, `OUTCOME_APP_PROMOTION`), `status` (`PAUSED`/`ACTIVE`),
  `special_ad_categories` (required, `[]` if none).
- Ad Set: `daily_budget`/`lifetime_budget` (**minor currency units**), `billing_event`,
  `optimization_goal`, `start_time`/`end_time`, `targeting` (`geo_locations`, `age_min`, `age_max`,
  `genders`, `publisher_platforms:["instagram"]`, `instagram_positions:["stream","reels","story","explore"]`),
  `promoted_object`, `destination_type`.
- **Boosting an existing Instagram post/Reel**: create an AdCreative with `instagram_user_id` +
  `source_instagram_media_id` (this supersedes the old `instagram_actor_id` naming; `effective_instagram_
  media_id` is readable back). This is the correct way to "promote a Reel" — the organic post itself is
  never modified.
- Link-ad CTA: `object_story_spec.link_data.call_to_action = {type, value:{link}}`. Valid types include
  `LEARN_MORE`, `SIGN_UP`, `CONTACT_US`, `SUBSCRIBE`, `GET_QUOTE`, `BOOK_NOW`, `APPLY_NOW`, `SHOP_NOW`,
  `BUY_NOW`, `DOWNLOAD`, `MESSAGE_PAGE` (full enum is 100+ values; we expose the vetted subset in
  `src/lib/meta/marketing.ts`).
- **Lead ads (Instant Forms)**: form = `POST /{page-id}/leadgen_forms` (name, questions array of
  built-in types like FULL_NAME/PHONE/EMAIL + CUSTOM); campaign objective `OUTCOME_LEADS`,
  `promoted_object.page_id`, creative referencing `lead_gen_form_id`. Instagram placement supported.
  Lead download needs `leads_retrieval` + `pages_manage_ads`, real-time via `leadgen` webhook. Page must
  accept Lead Ads TOS (`leadgen_tos_accepted`).
- **Access tiers (verified 2026-09-11 against /docs/marketing-api/overview/authorization):**

  | | **Limited Access** (default) | **Full Access** |
  | --- | --- | --- |
  | How to get it | Automatic when the Marketing API product is added — **no App Review** | App Review, plus ≥500 Marketing API calls in the past 15 days and an error rate under 15% |
  | Ad accounts | Unlimited | Unlimited |
  | Rate limits | Heavily rate-limited per ad account | Lightly rate-limited |
  | System users | 1 standard + 1 admin | 10 standard + 1 admin |
  | Data | **Production** — real campaigns, real spend | Production |

  The key point for this platform: calls at **every** access level run against production data, so an
  admin can create and run real ads on their own ad account **without App Review**. Meta labels Limited
  Access "for development", but the constraint is throughput, not capability — and a private tool
  creating a handful of campaigns never approaches those limits. App Review only becomes necessary at
  high call volume or when managing ad accounts belonging to other businesses.

## 9. Honest limitations (things Meta does NOT allow — reflected in product design)

1. **Organic posts/Reels cannot have CTA buttons.** No API adds a SIGN UP button to an organic Reel.
   The legitimate options, all implemented distinctly and labeled in the UI:
   - **NATIVE META CTA (ads)**: promote the Reel via Marketing API; the ad gets a native CTA button.
   - **CREATIVE OVERLAY CTA**: render the CTA visually into the video/creative *before publishing*
     (our overlay spec is stored and labeled as a visual element, not a native button).
   - **EXTERNAL LANDING PAGE CTA**: hosted lead page on this platform (public route `/f/{slug}`)
     linked from bio/caption/DM.
   - **MESSAGING CTA**: comment→DM private replies and DM quick-reply flows.
2. **Native ad CTA position/color/shape is fixed by Meta.** No API field styles or repositions the CTA
   button on an Instagram ad. The UI says exactly this and offers overlay/external alternatives instead
   of fake styling controls.
3. **No DM "forms"**: Instagram has no native in-DM form widget; multi-question capture in DMs is a
   sequence of messages (our lead-flow engine, quick replies where supported). Instant Forms exist only
   as *lead ads* (mode B, paid).
4. **Cannot DM first.** Conversations must be user-initiated; 24 h response window applies (human-agent
   tag = 7 days, requires approval).
5. **Comment webhooks in Development Mode** fire only for app-role users; Advanced Access is required
   for the general public (matters if this app stays in Dev Mode: add the admins' IG accounts as app
   roles — full function for own accounts).
6. **Images: JPEG only** for publishing; videos must be publicly hosted during ingestion.
7. **No follower lists / no scraping**: only aggregate demographics via insights.
8. **App review**: messaging/comments/publishing for accounts other than app-role users' own requires
   Advanced Access review. This private platform (2–3 admins automating *their own* accounts) can run
   fully in Dev Mode with app roles; docs/DEPLOYMENT.md covers the review path if ever needed.

## 10. Token lifecycle implemented

| Mode | Short-lived | Long-lived | Refresh |
| --- | --- | --- | --- |
| A (IG login) | 1 h (exchange immediately) | 60 days | `refresh_access_token` when ≥24 h old; worker job refreshes at <10 days remaining |
| B (FB login) | ~1–2 h | user 60 days (`fb_exchange_token`); Page token long-lived | user token re-auth before expiry; Page token re-derived |

Tokens are stored AES-256-GCM encrypted (`TOKEN_ENCRYPTION_KEY`), never sent to the browser, never logged.
`instagram_tokens.status` + `expiresAt` drive the dashboard token-health card and reconnect prompts.

## 11. Rate limits respected

- Publishing: 100/24 h (checked via `content_publishing_limit` before publish).
- Graph calls: per-user BUC limits — the client (`src/lib/meta/client.ts`) surfaces `X-App-Usage`/
  `X-Business-Use-Case-Usage` headers, backs off on error codes 4/17/32/613, and the worker retries with
  exponential backoff.
- Messaging: platform conversation limits + our own per-conversation reply throttle (agent setting).

## 12. Error codes handled distinctly

`190` invalid/expired token → mark token EXPIRED, surface reconnect. `10`/`200`-class permission errors →
capability marked unavailable with reason. `4`/`17`/`32`/`613` rate limits → backoff+retry. `551` user
unavailable → conversation flagged. `100` invalid param → surfaced to admin with request context (sans
secrets). OAuth `error_reason=user_denied` → friendly abort. Subcode `2018278` outside messaging window →
message dropped with UI notice, never silently retried into policy violation.

## 13. Implemented since the 2026-09-10 baseline (verified 2026-09-12)

Content publishing (§5) and the Marketing API targeting/estimate calls below are now implemented in
`src/lib/meta/publishing.ts` and `src/lib/meta/marketing.ts` — this section records exactly which
endpoints back them, so the capability table above stays honest as code, not just as a plan.

- **Publishing**: `POST /{ig-id}/media` (image/REELS/STORIES/CAROUSEL container) → poll
  `GET /{container-id}?fields=status_code` → `POST /{ig-id}/media_publish`. `GET /{ig-id}/content_publishing_limit`
  is checked before every publish. Meta has **no scheduling endpoint** — "Schedule" in the UI is this
  platform holding a `PublishJob` row until the chosen time, and the label says so.
- **Reach estimate**: `GET /act_{id}/reachestimate?targeting_spec=…` → `users_lower_bound`/`users_upper_bound`,
  or `-1`/`estimate_ready:false` when Meta has nothing yet — surfaced verbatim as "Estimate unavailable
  until Meta processes this audience", never computed locally.
- **Targeting search**: `GET /search?type=adinterest&q=…` (interests, with Meta's own audience-size
  bounds) and `GET /search?type=adgeolocation&location_types=["city"]&q=…` (cities, used with
  `geo_locations.cities[{key,radius,distance_unit}]`, radius 17–80 km / 10–50 mi per Meta's limits).
- **Campaign insights for the Target page**: `GET /{metaCampaignId}/insights?fields=spend,impressions,
  reach,clicks,cpc,ctr,actions` — the `actions` array is matched against the objective's real result type
  (`link_click` for Traffic, `lead` for Leads, `onsite_conversion.messaging_conversation_started_7d` for
  Engagement, `reach` for Awareness) rather than guessed.
- **Ad preview**: `GET /{metaCreativeId}/previews?ad_format=…` returns Meta's own rendered iframe HTML —
  used as-is, never re-implemented visually.
