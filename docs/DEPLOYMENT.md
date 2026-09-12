# Production deployment

Target shape: one web app + one worker process + PostgreSQL, behind HTTPS. Works on any Node-capable
platform (VPS with PM2/systemd, Railway, Render, Fly.io; Vercel for web + a separate worker host).

## 1. Components

| Component | Command | Notes |
| --- | --- | --- |
| Web (Next.js) | `npm run build && npm start` | serves UI + API + webhook endpoint |
| Worker | `npm run worker` | REQUIRED in production (do not use QUEUE_INLINE) — processes webhooks, AI replies, flows, email, token refresh |
| PostgreSQL | managed (recommended) | UTF-8 encoding required (emoji in captions) |

Multiple worker instances are safe (queue claims use `FOR UPDATE SKIP LOCKED`).

## 2. Environment

Copy `.env.example` and set everything. Production notes:

- `APP_URL` — public HTTPS origin (drives OAuth redirect, webhook URL shown in UI, CSRF origin checks, secure cookies).
- `SESSION_SECRET`, `TOKEN_ENCRYPTION_KEY` — fresh 32-byte values per environment; rotating
  TOKEN_ENCRYPTION_KEY invalidates stored Instagram tokens (admins simply reconnect).
- `DATABASE_URL` — with `?sslmode=require` on managed PG.
- Keep **development / staging / production credentials fully separate** (separate Meta apps recommended;
  at minimum separate webhook verify tokens and DBs). Never reuse the dev encryption key in prod.

## 3. Database

```bash
npx prisma migrate deploy
npx prisma db seed        # first deploy only — creates the OWNER admin
```

Scale-up note: knowledge retrieval ranks embeddings in-process (fine for this platform's size — see
DEVELOPMENT_PLAN.md §3). If knowledge bases grow past ~50k chunks, migrate the `KnowledgeChunk.embedding`
column to pgvector and replace the ranking in `src/lib/knowledge/index.ts#retrieveKnowledge` with a
`<=>` KNN query.

## 4. Meta app configuration (production)

1. App Dashboard → your app:
   - OAuth redirect URI: `https://YOUR_DOMAIN/api/meta/oauth/callback`
   - Webhooks → Instagram topic: callback `https://YOUR_DOMAIN/api/webhooks/instagram`,
     verify token = `META_WEBHOOK_VERIFY_TOKEN`; subscribe fields: `messages`, `messaging_postbacks`,
     `messaging_seen`, `comments`, `mentions` (+ `leadgen` on the Page topic if using lead ads).
2. Switch the app to **Live** mode for webhook delivery.
3. Private-use reminder: accounts owned by app-role holders work without App Review. Public use of
   messaging/comments/publishing requires Advanced Access review + business verification
   (docs/META_API.md §9.8).
4. Ads: development-tier Marketing API access is enough for your own ad accounts; request standard
   access only if scale demands it.

## 5. HTTPS & domain

Terminate TLS at your platform/reverse proxy. `APP_URL=https://...` makes session cookies `Secure`.
Meta requires valid TLS on the webhook endpoint (no self-signed).

## 6. Monitoring

- `GET /api/health` (authenticated → full component matrix: DB latency, queue depth/dead jobs, email
  failures, token issues, last webhook). Wire it to your uptime monitor; unauthenticated calls return a
  bare liveness bit.
- Dashboard → System health shows the same matrix.
- Logs are JSON lines on stdout (`LOG_FILE` appends to a file too) — ship them to your log stack.
- Alerting suggestions: dead jobs > 0, email FAILED > 0, token status ERROR, no webhook events in 24h
  while accounts are connected.

## 7. Backups & retention

- Back up PostgreSQL (all state lives there; uploaded knowledge files are not kept after extraction).
- Retention jobs (automatic): completed queue jobs 7 days, dead jobs 30 days, processed webhook events 30 days.
- Audit logs are never auto-deleted.

## 8. Upgrade / rollback

```bash
git pull
npm ci
npx prisma migrate deploy
npm run build
# restart web + worker
```

Migrations are forward-only; take a DB snapshot before deploying schema changes.

## 9. Deploying to Vercel

Vercel can host the web app and the API, but **not** the worker: `npm run worker` is a permanent
polling loop and Vercel functions are short-lived. Without a scheduler the platform still receives
webhooks, but nothing ever processes them — no AI replies, no lead emails. Plan for this before going live.

### 9.1 Database (do this first)

Vercel has no local database. Create a hosted PostgreSQL — Neon, Supabase and Vercel Postgres all work.
Use the **pooled** connection string, because each serverless invocation opens its own connection:

```
DATABASE_URL=postgresql://user:pass@host/db?sslmode=require&pgbouncer=true&connection_limit=1
```

`vercel.json` runs `prisma migrate deploy` during the build, so the schema is created on first deploy.
Afterwards seed the first admin once, from your machine, pointed at the same database:

```bash
DATABASE_URL="<the same URL>" ADMIN_LOGIN=YourLogin ADMIN_PASSWORD='<a long unique password>' npm run db:seed
```

### 9.2 Import the repository

In Vercel: **Add New → Project → Import Git Repository**, pick this repo, framework auto-detects as
Next.js. Do not deploy yet — set the environment variables first.

### 9.3 Environment variables

Set these under **Settings → Environment Variables** (Production, and Preview if you use it):

| Variable | Value |
| --- | --- |
| `APP_URL` | `https://<your-app>.vercel.app` — must match the real domain exactly, or sign-in is refused |
| `DATABASE_URL` | pooled connection string from 9.1 |
| `SESSION_SECRET` | `openssl rand -hex 32` |
| `TOKEN_ENCRYPTION_KEY` | `openssl rand -hex 32` (64 hex chars) |
| `CRON_SECRET` | `openssl rand -hex 24` — protects `/api/cron/worker` |
| `META_APP_ID` / `META_APP_SECRET` | from your Meta app |
| `META_REDIRECT_URI` | `https://<your-app>.vercel.app/api/meta/oauth/callback` |
| `META_WEBHOOK_VERIFY_TOKEN` | any random string, also entered in the Meta dashboard |
| `AI_PROVIDER` + key | `anthropic` + `ANTHROPIC_API_KEY`, or `openai` + `AI_API_KEY` for an OpenAI-compatible gateway |
| `AI_API_BASE_URL` | only for `AI_PROVIDER=openai` against a gateway other than api.openai.com (e.g. `https://api.airforce/v1`) |
| `AI_MODEL` | pins the model new agents use — required on gateways whose plan only includes specific models |
| `EMAIL_*`, `LEAD_NOTIFICATION_EMAIL` | SMTP settings for lead notifications |
| `PAYMENT_SECRET_KEY` | Stripe secret key (`sk_test_…` / `sk_live_…`) — omit to run with billing off |
| `PAYMENT_WEBHOOK_SECRET` | from the Stripe webhook endpoint below (`whsec_…`) — required if `PAYMENT_SECRET_KEY` is set |
| `PAYMENT_PUBLISHABLE_KEY` | optional; not required by the hosted-Checkout flow this app uses |

Then **Deploy**. Afterwards, register the deployed URLs in the Meta app dashboard (redirect URI and the
webhook callback `https://<your-app>.vercel.app/api/webhooks/instagram`), and — if billing is enabled —
add a Stripe webhook endpoint at `https://<your-app>.vercel.app/api/webhooks/stripe` subscribed to
`checkout.session.completed`, `payment_intent.succeeded`, `payment_intent.payment_failed`,
`payment_intent.canceled`, `payment_intent.processing`, `charge.refunded`, `payment_method.attached`,
`payment_method.detached`, `payment_method.updated`, `customer.updated`; copy its signing secret into
`PAYMENT_WEBHOOK_SECRET` and redeploy.

### 9.4 Processing the queue (required)

Pick one:

**A — GitHub Actions (any Vercel plan).** `.github/workflows/worker-heartbeat.yml` calls the drain
endpoint every 5 minutes. Add repository secrets `APP_URL` and `CRON_SECRET`. Simplest option; replies
arrive within a few minutes.

**B — Vercel Cron (Pro plan).** Add to `vercel.json` and redeploy:

```json
"crons": [{ "path": "/api/cron/worker", "schedule": "* * * * *" }]
```

Vercel sends `Authorization: Bearer $CRON_SECRET` automatically. **Hobby plans only allow one cron run
per day** — do not use this option there.

**C — A real worker (best responsiveness).** Run `npm run worker` on any always-on host (Railway,
Render, Fly.io, a small VPS) with the same `DATABASE_URL`. Replies go out in seconds. Safe to combine
with A or B: job claiming uses `FOR UPDATE SKIP LOCKED`, so a job is never processed twice.

Verify whichever you chose:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" https://<your-app>.vercel.app/api/cron/worker
```

### 9.5 Before exposing it publicly

A Vercel URL is reachable by anyone who learns it. Sign-in is rate-limited and audit-logged, but the
account is only as strong as its password — set a long, unique `ADMIN_PASSWORD` when seeding, never a
memorable default. Uploaded knowledge files are parsed in memory and not persisted to disk, so Vercel's
read-only filesystem is not a problem.

## 10. docker-compose (optional infra)

`docker-compose.yml` in the repo root provides a UTF-8 PostgreSQL for teams that prefer Docker:

```bash
docker compose up -d db
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/ig_automation
```
