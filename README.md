# Instagram Automation — Lead Platform

Private, admin-only Instagram automation platform built around the **Lead Button**: a visually
configurable button (colors, shape, size, texts) that sends Instagram viewers into an admin-designed
question flow and lands every answer in the built-in CRM. Also: official Meta OAuth account connection,
AI agents (Anthropic / OpenAI / Google) answering DMs, DM keyword lead flows, email notifications,
Marketing-API campaigns with hard spend safeguards, automations, analytics, and a full audit trail.

**UI languages:** O‘zbekcha (default) · English · Русский — switchable from the header; the whole
interface is dictionary-driven (`src/lib/i18n/`).

The Lead Button reaches customers through three honest, API-supported paths (no faked Instagram
features): a hosted landing page (`/f/{slug}`) usable in bio/Stories/anywhere, DM/comment code words
that start the questions inside Instagram, and a real native CTA button under a promoted Reel via the
Marketing API (Instagram renders that button; only its text is configurable).

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

Full click-path with every dashboard field: **[docs/INSTAGRAM_SETUP.md](docs/INSTAGRAM_SETUP.md)**.
The **Instagram** page also detects what is missing and prints the exact values to paste into Meta.

1. Create an app at https://developers.facebook.com/apps → **App settings → Basic** gives
   `META_APP_ID` / `META_APP_SECRET`.
2. Add the **Instagram** product → "API setup with Instagram login" → **Business login settings**.
   Copy the **Instagram app ID/secret** shown there into `META_INSTAGRAM_APP_ID` /
   `META_INSTAGRAM_APP_SECRET` — these are **different values** from step 1, and using the Facebook
   ones makes Instagram answer "Invalid platform app". Add **Facebook Login for Business** +
   Marketing API too if you need Campaigns / native ad CTAs / Instant Forms.
3. Register the OAuth redirect URI: `{APP_URL}/api/meta/oauth/callback` — character for character.
   Instagram Login requires **https**, so `http://localhost` is rejected: connect on the deployed
   site or through an HTTPS tunnel.
4. Enable `instagram_business_basic`, `instagram_business_manage_messages` and
   `instagram_business_manage_comments` on the app. One missing permission makes Instagram reject the
   whole authorization with "Invalid Scopes". Extras go in `META_INSTAGRAM_EXTRA_SCOPES`.
5. Configure webhooks → Instagram: callback `{APP_URL}/api/webhooks/instagram`, verify token =
   `META_WEBHOOK_VERIFY_TOKEN`. Local dev needs a public HTTPS tunnel (e.g. `cloudflared tunnel --url http://localhost:3000`).
6. Fill those variables in `.env`, restart, then **Instagram → Connect Instagram**. The account owner
   signs in on instagram.com and taps Allow; the browser returns here with the account connected.
   Use **Add a different account** for a second profile, and **Connect Facebook (for ads)** on an
   account's own card to attach advertising to that profile.
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
src/lib/auth/access.ts      RBAC — OWNER/ADMIN unrestricted, USER confined to granted accounts
src/lib/meta/*              Graph client, OAuth, tokens, messaging, media, marketing, publishing, webhooks, capabilities
src/lib/agent/*             AI runtime + guardrails (working hours, topics, output gate) + permission-tiered tools
src/lib/ai/*                Provider abstraction — Anthropic / OpenAI-compatible (incl. gateways) / Google
src/lib/billing/*           Stripe client, pricing math, payment/schedule service — platform fees only, never Meta spend
src/lib/leads.ts            CRM cross-cutting helpers (lastInteractionAt, AI qualification types)
src/lib/leadflow/engine.ts  one-question-per-step DM state machine
src/lib/automation/*        trigger → condition → action engine
src/lib/queue/*             DB-backed job queue (SKIP LOCKED) + handlers (webhooks, AI, publishing, billing, campaign sync)
src/lib/knowledge/*         extract → chunk → embed → retrieve
src/lib/email/*             EmailService with queued retries
src/app/api/*               REST surface (zod-validated, audited, RBAC-scoped)
src/app/(dashboard)/*       control-center UI, incl. Target wizard, Billing and the staff-only Admin overview
scripts/worker.ts           worker process
docs/INSTAGRAM_SETUP.md     adding an Instagram account, start to finish
docs/META_API.md            verified Meta capability reference (incl. publishing/targeting/estimate endpoints)
docs/DEPLOYMENT.md          production deployment guide (incl. Stripe webhook + AI gateway setup)
docs/AUDIT_2026-09-12.md    pre-upgrade architecture audit and gap analysis
```
