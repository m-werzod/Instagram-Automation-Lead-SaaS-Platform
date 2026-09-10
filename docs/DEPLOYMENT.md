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

## 9. docker-compose (optional infra)

`docker-compose.yml` in the repo root provides a UTF-8 PostgreSQL for teams that prefer Docker:

```bash
docker compose up -d db
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/ig_automation
```
