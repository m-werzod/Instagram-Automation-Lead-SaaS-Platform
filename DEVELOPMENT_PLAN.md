# DEVELOPMENT PLAN — Private Instagram Automation Platform

> Status: **all 20 phases implemented** (2026-09-10). Quality gates green: `tsc --noEmit` ✓, ESLint ✓,
> 80/80 tests ✓, `next build` ✓. End-to-end verified locally against a real PostgreSQL: admin login →
> simulated inbound DM `"kurs"` → keyword-triggered lead flow → 6 sequential validated questions →
> lead created with mapped name/phone → email notification queued, retried 4× with backoff, failed
> visibly (SMTP intentionally unconfigured) with the lead intact → surfaced on the health dashboard.

## 1. Current architecture (repository inspection result)

The repository was **empty** at project start (no framework, no package manager, no code, not a git repository).
There is therefore no existing architecture to reuse and no technical debt to inherit. All stack decisions
below are greenfield decisions.

Host environment detected:

| Item | Value |
| --- | --- |
| OS | Windows 11 Pro |
| Node.js | v24.x |
| npm | v11.x |
| git | 2.52 |
| Docker | **not installed** |

The absence of Docker on the dev machine directly influenced two infrastructure decisions (queue driver,
vector storage) — see §3 "Deliberate deviations".

## 2. Target architecture

```
                        ┌────────────────────────────────────────┐
                        │  Next.js 15 (App Router, TypeScript)   │
                        │                                        │
  Admin browser ──────▶ │  UI (server components + client forms) │
                        │  /api/* route handlers (REST, zod)     │
                        └───────────────┬────────────────────────┘
                                        │ Prisma
Meta webhooks ─▶ /api/webhooks/instagram│
   (signature check, persist, enqueue)  ▼
                        ┌────────────────────────────────────────┐
                        │  PostgreSQL                            │
                        │  · all domain tables (tenant-scoped)   │
                        │  · job queue table (DB-backed queue)   │
                        │  · webhook_events (idempotency)        │
                        └───────────────┬────────────────────────┘
                                        │ polling (SKIP LOCKED)
                        ┌───────────────▼────────────────────────┐
                        │  Worker process (npm run worker)       │
                        │  · webhook event processing            │
                        │  · AI agent replies (provider abstr.)  │
                        │  · lead flow engine (1 question/step)  │
                        │  · automation engine                   │
                        │  · email notifications (retry/backoff) │
                        │  · token refresh cron, analytics sync  │
                        └───────────────┬────────────────────────┘
                                        ▼
                     Meta Graph APIs (graph.instagram.com / graph.facebook.com)
                     AI providers (Anthropic / OpenAI / Google) — server-side only
                     SMTP (nodemailer)
```

### Stack

- **Framework**: Next.js 15 (App Router) + React 19 + TypeScript `strict`.
- **UI**: Tailwind CSS v4 + hand-rolled shadcn-style components on Radix primitives. Settings-first,
  enterprise control-panel look. No gradients, no animation noise.
- **DB**: PostgreSQL via Prisma. Every tenant-scoped table carries `instagramAccountId`.
- **Queue**: DB-backed job queue (Postgres `FOR UPDATE SKIP LOCKED`, attempts, exponential backoff,
  idempotency keys) behind a `Queue` interface. See §3 for why not Redis/BullMQ *by default*.
- **Auth**: private admin auth (bcryptjs), DB sessions, hashed session tokens, OWNER/ADMIN roles,
  no public registration. Rate-limited login. Audit log on every sensitive action.
- **AI**: `AIProvider` interface with Anthropic / OpenAI / Google implementations (REST, server-side
  keys only), token+cost accounting, tool-calling with a permission-tiered tool registry.
- **Email**: `EmailService` abstraction over SMTP (nodemailer), queued with retries; every attempt
  recorded in `email_events`.
- **Meta**: dual connection modes (see `docs/META_API.md`): Business Login for Instagram
  (`graph.instagram.com`) and Facebook Login for Business (`graph.facebook.com`, required for ads).
  Tokens AES-256-GCM encrypted at rest. Capability detection drives the UI.

## 3. Deliberate deviations from the original brief (with reasons)

1. **Queue: Postgres-backed instead of Redis+BullMQ.** The brief allows "Redis + BullMQ **or an
   appropriate production queue**". The dev machine has no Docker/Redis; the platform serves 2–3
   admins and a handful of IG accounts — tens of jobs/minute at peak, far below Postgres queue limits
   (the same design pg-boss/graphile-worker use). The queue is a small interface (`enqueue`, worker
   loop); a BullMQ driver can be added without touching call sites. Fewer moving parts to secure,
   monitor, and deploy.
2. **Vector search: in-process cosine over stored embeddings instead of pgvector.** The brief says
   "PostgreSQL + pgvector **if practical**". pgvector needs a custom PG build/extension (manual on
   Windows, extension privileges on managed PG). Knowledge bases here are small (≤ a few thousand
   chunks). Embeddings are stored as `BYTEA` (Float32Array); retrieval loads the account's chunks and
   ranks in Node — milliseconds at this scale. If no embedding provider is configured, retrieval falls
   back to explicit keyword scoring (clearly labeled in UI). Migration path to pgvector documented in
   `docs/DEPLOYMENT.md`.
3. **No public registration, no multi-customer billing** — per brief (private, admin-only).

## 4. Implementation phases

Mirrors the required order. Each phase ends with typecheck + lint + tests + build.

| Phase | Scope | Key artifacts |
| --- | --- | --- |
| 1 | Repo analysis, Meta research, docs | this file, `docs/META_API.md` |
| 2 | DB schema, auth, admin roles | `prisma/schema.prisma`, migration SQL, `/login`, sessions, audit |
| 3–4 | Meta OAuth, account connection, capabilities | `src/lib/meta/*`, `/settings/integrations/instagram` |
| 5 | Webhooks + queue + worker | `/api/webhooks/instagram`, `src/lib/queue/*`, `scripts/worker.ts` |
| 6 | Content retrieval | `/content`, media sync |
| 7 | AI agents | `/ai-agents`, provider abstraction, agent runtime, tool layer |
| 8 | Conversations | `/conversations`, human handoff |
| 9 | Knowledge base | `/knowledge`, extract→chunk→embed→retrieve |
| 10 | Lead flows | `/crm/lead-flows`, question builder, DM flow engine |
| 11 | CRM | `/leads` kanban |
| 12 | Email notifications | `EmailService`, retry, `email_events` |
| 13 | CTA system | `/content` CTA config, honest native/overlay/external split |
| 14 | Campaigns (Marketing API) | `/campaigns`, drafts, PAUSED-first, safety switch |
| 15 | Automation engine | `/automations`, trigger/condition/action |
| 16 | Analytics | `/analytics` from real DB + insights data |
| 17 | Audit logs | `/audit-logs` |
| 18 | Security hardening | headers, CSRF origin checks, validation sweep |
| 19 | Testing | Vitest unit/integration (Meta mocked) |
| 20 | Deployment docs | `docs/DEPLOYMENT.md`, `README.md` |

## 5. Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Meta app review / Advanced Access delays | Messaging & comment webhooks for non-app-role users blocked until approved | Private platform: add the 2–3 admin IG accounts as app testers/roles → full functionality in Dev Mode for own accounts; document review path |
| Token expiry (60-day long-lived) | Silent automation stop | Scheduled refresh job (>24h-old tokens), status surfaced on dashboard + integrations page, reconnect flow |
| Meta API version drift | Breakage on version sunset | `META_GRAPH_VERSION` env (default v25.0), all endpoints centralized in `src/lib/meta/client.ts` |
| Webhook delivery requires public HTTPS + Live app | No events in local dev | Documented tunneling (cloudflared/ngrok) + webhook simulator endpoint in dev + seed conversations |
| AI cost runaway | Money | Per-agent reply caps/hour, master switch, token+cost ledger in `ai_usage`, no AI spend path to ads (campaign publish is human-gated) |
| Ad spend safety | Money | Campaigns created PAUSED, publish requires typed confirmation + `Automatic Campaign Launch` global toggle default OFF, audit trail |
| Windows dev environment | Native module build pain | Pure-JS deps chosen (bcryptjs, nodemailer, pdf-parse, mammoth), no node-gyp modules |

## 6. Meta API dependencies

Full detail in `docs/META_API.md`. Summary of what each product feature depends on:

- **Account connect**: Business Login for Instagram (professional account) or FB Login for Business (IG linked to FB Page).
- **DMs / AI replies**: `instagram_business_manage_messages` (IG login) — 24h window, human-agent tag beyond.
- **Comments**: `instagram_business_manage_comments`; comment webhooks need Advanced Access for non-role users.
- **Publishing**: `instagram_business_content_publish`, 100 posts/24h.
- **Insights**: `instagram_business_manage_insights` (`views` metric era; `impressions` deprecated 2025).
- **Ads / native CTA / lead forms**: Marketing API via FB Login only (`ads_management`, `pages_manage_ads`,
  `leads_retrieval`, ad account + Page). Native CTA styling/position is NOT customizable — see META_API.md §9.

## 7. Environment variables

See `.env.example` (authoritative). Groups: core (`APP_URL`, `SESSION_SECRET`, `TOKEN_ENCRYPTION_KEY`,
`DATABASE_URL`), Meta (`META_APP_ID`, `META_APP_SECRET`, `META_REDIRECT_URI`, `META_WEBHOOK_VERIFY_TOKEN`,
`META_GRAPH_VERSION`), AI (`AI_PROVIDER`, `AI_API_KEY`, per-provider overrides), email (`EMAIL_HOST`,
`EMAIL_PORT`, `EMAIL_USER`, `EMAIL_PASSWORD`, `EMAIL_FROM`, `LEAD_NOTIFICATION_EMAIL`), bootstrap
(`ADMIN_EMAIL`, `ADMIN_PASSWORD` for seeding), worker (`WORKER_POLL_MS`).

## 8. Testing strategy

- **Unit (Vitest)**: crypto (AES-GCM round-trip), webhook signature validation, lead-flow engine
  (ordering, validation, completion), capability detection, automation condition matching, AI provider
  request/response mapping (fetch mocked), queue backoff math, email retry scheduling, RBAC guards.
- **Integration-style**: API route handlers invoked directly with mocked Prisma/Meta fetch — OAuth
  callback (state mismatch, token exchange), webhook POST (bad signature → 401, duplicate event →
  single job), lead submission → email job enqueued even if SMTP fails.
- **Never** depends on a live Instagram account, live Meta app, or network. All Meta/AI/SMTP calls are
  mocked at the fetch/transport boundary.
- Type safety: `tsc --noEmit` in CI script; ESLint (next/core-web-vitals) clean; `next build` green.

## 9. Definition of done

The 27-point acceptance list in the product brief, verified manually against seed data plus unit/integration
suite green. Anything Meta does not support is visibly labeled Unavailable with the reason, never faked.

---

## 10. AI Video Editor — architecture decisions (2026-09-24)

Added in the seven-functionality upgrade. Every decision below was forced by a verified constraint,
not a preference; the constraint is stated with each one.

### 10.1 Why video work runs in its own queue lane

**Constraint (measured, not assumed):** Vercel functions cap at `maxDuration` 60s, the cron drain
stops claiming at ~52s, and the filesystem is read-only apart from an ephemeral `/tmp`. A render of a
60-second Reel takes minutes. FFmpeg therefore *cannot* run on the web tier at all.

**Decision:** `Job.lane` (`default` | `video`). The serverless drain claims `default` only; the
`video` lane is claimed only by a resident worker that has proved FFmpeg starts (`ffmpegAvailability`
at boot). A render can never be picked up by a process that would be killed halfway through it.

**Consequence accepted:** deployments without a worker cannot render. Rather than hide that, the
editor reads `WorkerHeartbeat` and reports *Processing worker: Unavailable* with the reason and the
fix. Jobs still queue and run later — nothing is lost — but no progress bar moves against nothing.

This forced three queue repairs that the audit had independently flagged: lock **leases** renewed by
a heartbeat (a 20-minute render was previously declared stale at 5 minutes and re-executed),
**dead-lettering** on recovery (a job killed by OOM retried forever at full speed), and a **per-job
timeout** (no outbound call in the codebase set its own deadline).

### 10.2 Why media bytes left Postgres

**Constraint:** `MediaAsset.data` is `bytea` capped at 4 MB because the serverless request body limit
is 4.5 MB, and `/m/[id]` loads the whole buffer per request with no HTTP Range support.

**Decision:** a driver interface (`src/lib/storage/`) with two implementations — `local` (a directory
the worker and FFmpeg read directly, no copy) and `vercel-blob` (browser uploads straight to Blob
with a one-time token, so the file never transits a function). Selected by `STORAGE_DRIVER`, or
inferred from `BLOB_READ_WRITE_TOKEN`.

The publishing pipeline's existing `MediaAsset` path is untouched: images under 4 MB still work
exactly as before. Only video uses the new layer.

### 10.3 How natural-language editing is made safe

**Threat:** the product accepts editing instructions in three languages and turns them into FFmpeg
invocations. A model that could emit a command, a filtergraph, or a path would be a remote code
execution primitive.

**Decision — three separate barriers, each sufficient on its own:**

1. **The model only proposes data.** `runAssistantTurn` exposes two tools: `propose_edit` (a partial
   parameter patch) and `explain_unsupported`. Neither executes. The patch is parsed by a strict zod
   schema (`params.ts`), merged, re-validated, and shown to the operator as a field-by-field diff.
   Applying it is a separate authenticated request.
2. **FFmpeg is never given a string.** `src/lib/video/ffmpeg.ts` is the only place in the product that
   spawns a binary, always with an argv **array** and `shell: false`. There is no command string
   anywhere for a quote or semicolon to escape from.
3. **Text reaches FFmpeg only as a file.** Subtitles are written to a generated `.ass` file and
   referenced by path; caption text is never interpolated into a filtergraph. Brace and backslash
   sequences are neutralised when the file is written, so caption text cannot become ASS markup.

Verified by rendering caption text containing quotes, semicolons, braces, backslashes, Windows paths
and filtergraph fragments: it encodes as literal text.

### 10.4 Why "copy this video's style" promises less than it could

**Constraint:** most of what makes an edit recognisable (motion graphics, tracked overlays,
beat-synced cutting) cannot be reconstructed from an arbitrary video by any pipeline we can run.

**Decision:** the analysis is split into `measured` (FFmpeg facts: scene cuts, cadence, loudness,
framing, speech/silence windows — reproducible and checkable) and `observed` (a vision model's
reading — labelled as opinion). The plan they produce tags **every** item `reproducible`,
`approximate`, or `unsupported`; only the first two carry an applicable patch, and the API refuses to
apply an `unsupported` op even if a client asks. Re-cutting to a sample's rhythm is deliberately
`unsupported` rather than approximated badly.

The system never states that a sample was reproduced.

### 10.5 Why per-word subtitle highlighting is conditional

Word-level highlighting needs word-level timings. An OpenAI-compatible transcription endpoint returns
them; Gemini returns cue-level timings only. Rather than interpolating word positions — which drifts
visibly from the speech — the control is disabled when the track has no word timings, with the reason
shown. `buildAssFile` also falls back to a single cue line if asked to highlight without them.

### 10.6 Why "Upload to Instagram" does not upload

Instagram's publishing API **fetches** media from a URL; it does not accept an upload. So the export
screen prepares that URL, verifies it is genuinely reachable from the internet (a render served from
`localhost` cannot be published, however finished it is), checks the account's publish permission,
lists Meta's own size/duration/aspect constraints, and hands the composer a prefilled draft. The
existing `PublishJob` state machine then does the real work, after the operator confirms.

Local-driver renders are exposed at `/v/{token}` — an HMAC over the asset id plus an expiry, serving
only `EXPORT` and `THUMBNAIL` assets, so a source video or an uploaded music track never becomes
publicly reachable.
