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
