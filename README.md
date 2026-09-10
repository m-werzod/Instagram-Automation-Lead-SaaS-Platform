# Instagram Automation Control Center

Private, admin-only Instagram automation platform: official Meta OAuth account connection, AI agents
(Anthropic / OpenAI / Google) answering DMs with a permission-tiered tool system, sequential DM lead flows,
lightweight CRM with email notifications, honest CTA tooling, Marketing-API campaigns with hard spend
safeguards, automations, analytics, and a full audit trail.

**Read first:** [DEVELOPMENT_PLAN.md](DEVELOPMENT_PLAN.md) (architecture & decisions) and
[docs/META_API.md](docs/META_API.md) (verified Meta capabilities **and limitations** — nothing in this
product fakes an unsupported Instagram feature).

---

## 1. Requirements

- Node.js ≥ 20 (tested on 24)
- PostgreSQL ≥ 14 — any of:
  - **zero-setup dev**: `npm run db:dev` (embedded PostgreSQL on port 5433, data in `.pgdata/`).
    Must run in a **normal** (non-Administrator) terminal — PostgreSQL refuses elevated processes.
  - Docker: `docker compose up -d db`
  - your own local/managed PostgreSQL
- A Meta developer app (for real Instagram connection — the seeded demo works without one)

## 2. Setup

```bash
npm install
```

Create `.env` from the template and fill in at least the core section:

```bash
cp .env.example .env
# generate secrets:
node -e "console.log('SESSION_SECRET='+require('crypto').randomBytes(32).toString('hex'))"
node -e "console.log('TOKEN_ENCRYPTION_KEY='+require('crypto').randomBytes(32).toString('hex'))"
```

If you use the embedded dev DB, set:
`DATABASE_URL=postgresql://postgres:postgres@localhost:5433/ig_automation`

## 3. Database

```bash
npm run db:dev        # terminal 1 — embedded PostgreSQL (skip if you have your own)
npm run db:migrate    # apply committed migrations
npm run db:seed       # OWNER admin (from ADMIN_LOGIN/ADMIN_PASSWORD) + clearly-marked DEMO data
```

**Sign-in uses a Login (username), not an email address.** The seed creates the OWNER admin from
`ADMIN_LOGIN` / `ADMIN_PASSWORD` and prints the resulting login. Logins are case-insensitive
(`Admin` == `admin`). Re-running the seed with `ADMIN_PASSWORD` set resets that admin's password, so you
can always recover access.

Demo data (`@demo_driving_school`) is labeled DEMO everywhere and **never calls the Meta API** — it
exists so every module is explorable before connecting a real account.

## 4. Run

```bash
npm run dev           # terminal 2 — web app on http://localhost:3000
npm run worker        # terminal 3 — queue worker (webhooks, AI replies, flows, email)
```

Alternative for quick dev without a third terminal: set `QUEUE_INLINE=true` in `.env` — jobs run inside
the web process (the standalone worker is the production mode).

Sign in at http://localhost:3000/login with the Login/Password from your `.env`
(`ADMIN_LOGIN` / `ADMIN_PASSWORD`). Additional administrators are created by an OWNER under
**Settings → Administrators** — there is no public registration.

**Try the full pipeline with zero external services**: open Conversations → pick the demo conversation →
"Simulate inbound" → type `kurs`. The lead flow asks its questions one by one; answer them and watch the
lead appear in Leads (CRM) with an email notification attempt recorded (it fails visibly-but-safely until
SMTP is configured — the lead is never lost).

### Sign-in troubleshooting

The database must be running before you can sign in — the web app alone is not enough.

| What you see | Cause | Fix |
| --- | --- | --- |
| "Cannot reach the database" | PostgreSQL isn't running (or `DATABASE_URL` is wrong) | Start `npm run db:dev` in a **normal, non-Administrator** terminal |
| "Incorrect login or password" | Wrong credentials, or an admin that doesn't exist in *this* database | `npm run admin:check` — see below |
| "Cross-origin request rejected" | You opened the app at an address that isn't approved for this installation | The message names the address it saw. In development, `localhost`, `127.0.0.1` and LAN IPs are accepted automatically; anywhere else, add it to `TRUSTED_ORIGINS` in `.env` and restart |
| Page won't load at all | Web app not running, or it fell back to port 3001 because 3000 was taken | Check the `npm run dev` output |

Inspect exactly which accounts exist and whether a password is accepted:

```bash
npm run admin:check -- YourPasswordHere
```

It prints the database it read, every admin Login, whether the account is active, and whether the supplied
password matches. To reset access, set `ADMIN_LOGIN` / `ADMIN_PASSWORD` in `.env` and re-run `npm run db:seed`.

Note: passwords are **not** trimmed, so a trailing space from copy-paste will be rejected.

## 5. Tests / quality gates

```bash
npm test              # 80 unit/integration tests (Meta & AI fully mocked — no network, no real accounts)
npm run typecheck     # tsc --noEmit (strict)
npm run lint
npm run build         # production build
```

## 6. Connecting a real Instagram account

1. Create an app at https://developers.facebook.com/apps.
2. Add the **Instagram** product → "API setup with Instagram login" (organic automation), and/or
   **Facebook Login for Business** + Marketing API (required for Campaigns / native ad CTAs / Instant Forms).
3. Register the OAuth redirect URI: `{APP_URL}/api/meta/oauth/callback`.
4. Configure webhooks → Instagram: callback `{APP_URL}/api/webhooks/instagram`, verify token =
   `META_WEBHOOK_VERIFY_TOKEN`. Local dev needs a public HTTPS tunnel (e.g. `cloudflared tunnel --url http://localhost:3000`).
5. Fill `META_APP_ID`, `META_APP_SECRET` in `.env`, restart.
6. Settings → Integrations → Instagram → **Connect Instagram** (or **Connect with Facebook (ads)**).
7. The page shows the real granted permissions and a per-feature capability matrix; anything Meta doesn't
   allow for your account/mode is shown as Unavailable **with the reason**.

While the Meta app is in Development Mode, everything works for Instagram accounts whose owners hold a
role on the app (admin/developer/tester) — the intended setup for this private 2–3 admin platform. See
docs/META_API.md §9 for App Review requirements if you ever need public access.

## 7. Safety model (important)

- **Master Automation Switch** (Settings): instantly stops all AI replies and outbound automations.
- Campaigns are created in Meta **PAUSED**; activation requires typing the campaign name + explicit
  spend acknowledgement; AI-drafted campaigns additionally require the global "Automatic Campaign
  Launch" toggle (default OFF). The AI has **no** code path that can spend money or publish content.
- Instagram tokens are AES-256-GCM encrypted at rest and never reach the browser.
- Every sensitive action is audit-logged with before/after snapshots (including failed sign-ins).
- Passwords are bcrypt-hashed (cost 12); sign-in responses are identical for unknown login, wrong
  password and disabled account, so the form cannot be used to enumerate valid logins.
- Meta's 24-hour DM window is enforced locally — the platform refuses out-of-policy sends.

## 8. Project map

```
prisma/schema.prisma        relational schema (tenant-isolated per Instagram account)
src/lib/meta/*              Graph client, OAuth, tokens, messaging, media, marketing, webhooks, capabilities
src/lib/agent/*             AI runtime + permission-tiered tool registry
src/lib/leadflow/engine.ts  one-question-per-step DM state machine
src/lib/automation/*        trigger → condition → action engine
src/lib/queue/*             DB-backed job queue (SKIP LOCKED) + handlers
src/lib/knowledge/*         extract → chunk → embed → retrieve
src/lib/email/*             EmailService with queued retries
src/app/api/*               REST surface (zod-validated, audited)
src/app/(dashboard)/*       control-center UI
scripts/worker.ts           worker process
docs/META_API.md            verified Meta capability reference
docs/DEPLOYMENT.md          production deployment guide
```
