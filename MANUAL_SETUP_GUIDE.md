# Manual setup guide

Everything in this file is work that **cannot** be done from inside the repository: it needs an
account, a dashboard, a card, or a machine. Each section says exactly where to click, what to copy,
where the value goes, and how to verify it actually worked.

Ordered by dependency: sections 1–5 are needed for the Instagram features, 6–7 for advertising,
8 for the AI features, 9–11 for the AI Video Editor, and 12 for deployment.

Where a URL could not be verified from here, it is marked **(confirm this URL)** rather than guessed.

---

## 0. Before anything else — rotate the tokens you shared

A GitHub personal access token and a Vercel token were pasted into a chat during this work. Treat
both as compromised.

- GitHub → https://github.com/settings/tokens → find the token → **Delete**, then generate a new one.
- Vercel → https://vercel.com/account/tokens → find the token → **Delete**, then create a new one.

Neither token was written into this repository.

---

## 1. Meta developer app

**Where:** https://developers.facebook.com/apps

1. **Create app** → choose **Business** → name it → **Create app**.
2. **App settings → Basic**. Copy:
   - **App ID** → `META_APP_ID`
   - **App secret** (click *Show*) → `META_APP_SECRET`
3. Still on Basic, set **App domains** to your deployed domain and save.

**Verify:** open `/api/setup-status` on your deployment while signed in — it lists which variables are
still missing (names only, never values).

---

## 2. Instagram login product (messaging, comments, publishing)

**Where:** App Dashboard → **Products** → **Instagram** → *Set up* → **API setup with Instagram login**

> The Instagram app credentials are **different values** from step 1. Using the Facebook App ID here
> makes Instagram answer `Invalid platform app`.

1. Open **Business login settings**. Copy:
   - **Instagram app ID** → `META_INSTAGRAM_APP_ID`
   - **Instagram app secret** → `META_INSTAGRAM_APP_SECRET`
2. In the same panel, set **Redirect URI** to exactly:
   ```
   https://<your-domain>/api/meta/oauth/callback
   ```
   Character for character, including the scheme. Instagram Login **requires HTTPS**, so
   `http://localhost` is rejected — connect on the deployed site or through an HTTPS tunnel
   (`cloudflared tunnel --url http://localhost:3000`).
3. Set the same value in `META_REDIRECT_URI`.
4. Enable these permissions on the app:
   - `instagram_business_basic`
   - `instagram_business_manage_messages`
   - `instagram_business_manage_comments`
   - `instagram_business_content_publish` — **required to publish anything, including video-editor
     exports**
   - `instagram_business_manage_insights` — for post metrics

   One missing permission makes Instagram reject the whole authorization with `Invalid Scopes`.
   Extras go in `META_INSTAGRAM_EXTRA_SCOPES` (comma separated).

**Verify:** the **Instagram** page in the app shows a configuration checklist and prints the exact
values it expects. After connecting, it shows the permissions Meta actually granted.

---

## 3. Webhooks

**Where:** App Dashboard → **Products** → **Instagram** → **Webhooks** (also under **Webhooks** in the
left sidebar)

1. **Callback URL:**
   ```
   https://<your-domain>/api/webhooks/instagram
   ```
2. **Verify token:** any random string. Put the same value in `META_WEBHOOK_VERIFY_TOKEN`.
   Generate one with `openssl rand -hex 24`.
3. Click **Verify and save**. Meta calls the URL immediately; a failure here means the app is not
   deployed or the token does not match.
4. Subscribe to these fields: `messages`, `comments`, `live_comments`, `message_reactions`,
   `messaging_postbacks`, `messaging_seen`.

**Important:** deliveries for the Instagram Login product are signed with the **Instagram** app
secret, not the Facebook one. The platform now accepts either, so both apps' webhooks work — but if
only `META_APP_SECRET` is set and your traffic comes from the Instagram product, every delivery is
rejected. Set both.

**Verify:** the **Instagram** page shows `webhookSubscribed` per account. Send yourself a DM and watch
it appear under **Messages**.

---

## 4. Development mode and testers

While the app is in **Development Mode**, only Instagram accounts that hold a role on the app can
authorize it. Anyone else gets `access_denied … Insufficient developer role`, and nothing the account
owner does can get past it.

**Where:** App Dashboard → **App roles → Roles** → **Add people** → **Instagram Tester**

The invited person then accepts at: Instagram app → **Settings and privacy → Website permissions →
Tester invites**.

For public access you need **App Review** for each permission in step 2 — expect to supply a screen
recording of the full flow and a privacy policy URL.

---

## 5. Connect an Instagram account

1. The Instagram account must be a **Business** or **Creator** account (Instagram app → Settings →
   Account type and tools).
2. In this platform: **Instagram → Connect Instagram**. The account owner signs in on instagram.com
   and taps **Allow**.
3. For a second profile use **Add a different account**; to attach advertising use **Connect Facebook
   (for ads)** on that account's own card.

**Verify:** the account card shows *Connected*, the granted permissions, and a per-feature capability
matrix. Anything Meta does not allow is shown as Unavailable **with the reason**.

---

## 6. Meta Business and ad account (advertising)

**Where:** https://business.facebook.com/settings

1. **Accounts → Ad accounts** → add or create one. Note the ID (`act_XXXXXXXXXX`).
2. **Accounts → Pages** → the Facebook Page linked to the Instagram account.
3. **Users → People** → confirm you have admin access to both.

Then in the App Dashboard, add the **Marketing API** product and **Facebook Login for Business**.

**Verify:** in this platform, open an account's card → **Connect Facebook (for ads)** → the ad account
picker lists your real ad accounts.

---

## 7. Paying for advertising

**Meta bills the ad account's own payment method. This platform cannot pay Meta on your behalf, and
does not pretend to.**

**Where:** https://business.facebook.com/settings → **Accounts → Ad accounts** → select → **Payment
methods** → **Add payment method**

The platform shows the ad account's billing status it reads back from Meta, so you can see whether a
method is attached before a campaign is activated. Campaigns are always created **PAUSED**;
activation requires typing the campaign name plus an explicit spend acknowledgement.

Platform service fees (a separate thing from ad spend) use Stripe — section 8b.

---

## 8. AI provider

### 8a. Chat models (agents, video assistant, style analysis)

Any OpenAI-compatible endpoint works, as does Anthropic or Google.

| Provider | Where to get a key | Variables |
| --- | --- | --- |
| Anthropic | https://console.anthropic.com/settings/keys | `AI_PROVIDER=anthropic`, `AI_API_KEY` |
| OpenAI | https://platform.openai.com/api-keys | `AI_PROVIDER=openai`, `AI_API_KEY` |
| Any compatible gateway | that gateway's dashboard | `AI_PROVIDER=openai`, `AI_API_KEY`, `AI_API_BASE_URL` |
| Google | https://aistudio.google.com/apikey | `GOOGLE_AI_API_KEY` |

Set `AI_MODEL` to a model the provider actually lists. The **AI & Automation** page has a test
console that runs the real pipeline and shows tokens, cost and latency.

> **Current state of your deployment:** the Vercel project has no AI key at all, so AI replies, the
> video chat assistant and style analysis cannot work in production until you add one. Your local
> `.env` has a gateway key that works for chat.

### 8b. Stripe (platform service fees only)

**Where:** https://dashboard.stripe.com/apikeys

1. Copy the **Secret key** → `PAYMENT_SECRET_KEY`.
2. **Developers → Webhooks → Add endpoint**: `https://<your-domain>/api/webhooks/stripe`.
   Select events: `checkout.session.completed`, `payment_intent.succeeded`,
   `payment_intent.payment_failed`, `charge.refunded`.
3. Copy the **Signing secret** (`whsec_…`) → `PAYMENT_WEBHOOK_SECRET`.

Card details never reach this application — Stripe's hosted Checkout tokenises them.

---

## 9. Video storage

The editor needs somewhere to put files far larger than a database row. Pick one.

### Option A — Vercel Blob (required if the web app runs on Vercel)

**Where:** https://vercel.com/dashboard → your project → **Storage** → **Create Database** → **Blob**

1. Create the store and connect it to the project.
2. Copy the **read-write token** → `BLOB_READ_WRITE_TOKEN`.
3. Set `STORAGE_DRIVER=vercel-blob` (or leave it unset — the token alone selects Blob).

This is what makes uploads larger than 4.5 MB possible at all: the browser uploads straight to Blob
with a one-time token, so the file never passes through a serverless function.

### Option B — Local disk (a VPS, Railway, Render, or development)

```bash
STORAGE_DRIVER=local
MEDIA_STORAGE_DIR=/var/lib/ig-automation/media   # must be writable and backed up
```

FFmpeg then reads and writes these files directly, which is the fastest arrangement.

**Verify:** the **AI Video Editor** page shows *File storage* as Available, with the driver name and
the size limit.

---

## 10. Video processing worker (FFmpeg)

**This is the one piece Vercel cannot host.** Vercel functions stop at 60 seconds and have a
read-only filesystem, so a render that takes minutes cannot run there. The platform therefore keeps
video work in a separate queue lane that only a resident worker claims — nothing is silently dropped,
but nothing renders until such a worker exists.

### Install FFmpeg on the worker host

```bash
# Debian / Ubuntu
sudo apt update && sudo apt install -y ffmpeg fonts-dejavu-core
# RHEL / Fedora
sudo dnf install -y ffmpeg dejavu-sans-fonts
# macOS
brew install ffmpeg
```

`fonts-dejavu-core` matters: burned-in subtitles need a font that covers Latin, Cyrillic **and**
Uzbek Latin (oʻ, gʻ). Without it subtitles render as boxes.

Verify: `ffmpeg -version` and `ffprobe -version` both print a version.

### Run the worker

```bash
git clone <your repo> && cd <repo>
npm ci
npm run db:migrate
npm run worker
```

Keep it running with systemd, PM2, or your platform's process manager:

```ini
# /etc/systemd/system/ig-worker.service
[Unit]
Description=Instagram automation worker
After=network.target

[Service]
WorkingDirectory=/opt/ig-automation
ExecStart=/usr/bin/npm run worker
Restart=always
EnvironmentFile=/opt/ig-automation/.env
User=igworker

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now ig-worker
sudo journalctl -u ig-worker -f
```

On startup the log says `video lane enabled` with the FFmpeg version, or `video lane disabled` with
the reason.

**Managed alternatives** (each runs a persistent process, unlike Vercel): Railway
(https://railway.app), Render Background Worker (https://render.com), Fly.io (https://fly.io), or any
VPS. Point it at the same `DATABASE_URL`; multiple workers are safe.

**Verify:** the **AI Video Editor** page shows *Processing worker* as Available. If it says no worker
has reported in, renders will queue rather than run, and the page says so.

### Worker variables

| Variable | Meaning |
| --- | --- |
| `VIDEO_WORKER` | `false` to make a worker skip the video lane (default: claim it when FFmpeg exists) |
| `VIDEO_JOB_TIMEOUT_MS` | Ceiling for one render (default 3600000 = 1 hour) |
| `VIDEO_MAX_UPLOAD_MB` | Largest accepted upload (default 500) |
| `VIDEO_MAX_DURATION_SEC` | Longest accepted video (default 3600) |
| `FFMPEG_PATH` / `FFPROBE_PATH` | Explicit binary paths when they are not on `PATH` |

---

## 11. Speech-to-text (automatic subtitles)

Subtitles can always be typed or imported. **Automatic** subtitles need a transcription provider.

### Option A — an OpenAI-compatible transcription endpoint

Set `AI_API_KEY` (and `AI_API_BASE_URL` for a gateway) and optionally `STT_MODEL=whisper-1`. This is
the preferred route because it returns **word-level timings**, which is what makes the
*Highlighted Words* subtitle preset possible.

> **Checked on your gateway (api.airforce):** the endpoint exists and lists `whisper-1`,
> `gpt-4o-transcribe` and others, but a transcription request returns **402 — the account needs a
> positive balance**. Top up at the gateway's dashboard, or use option B.

### Option B — Google Gemini

Set `GOOGLE_AI_API_KEY` (https://aistudio.google.com/apikey) and `STT_PROVIDER=google`. Your key was
verified working here and reaches `gemini-2.5-flash`, `gemini-2.5-pro` and `gemini-3-flash-preview`.

Gemini returns **cue-level** timings only, so per-word highlighting stays unavailable with it —
the editor disables that control and says why rather than inventing word timings.

**Verify:** the editor shows *Automatic subtitles* as Available with the provider and model named.

---

## 12. Deployment and environment

### Database

Any PostgreSQL 14+. Managed options: Neon (https://neon.tech), Supabase
(https://supabase.com), Railway. Put the connection string in `DATABASE_URL`.

Apply migrations after every deploy:

```bash
npm run db:migrate
```

> **This must be run for the new features to work.** This upgrade adds two migrations: queue lanes
> and worker liveness, then the video editor tables and CRM/campaign columns. No local database was
> reachable during development, so the migrations are written but have not been applied anywhere yet.

### Secrets

```bash
node -e "console.log('SESSION_SECRET='+require('crypto').randomBytes(32).toString('hex'))"
node -e "console.log('TOKEN_ENCRYPTION_KEY='+require('crypto').randomBytes(32).toString('hex'))"
node -e "console.log('CRON_SECRET='+require('crypto').randomBytes(24).toString('hex'))"
```

`TOKEN_ENCRYPTION_KEY` must be exactly 64 hex characters. **Changing it makes every stored Instagram
token unreadable** — every account would have to reconnect.

### Draining the queue in production

The web app does not process jobs on its own. Use one of:

- **A real worker** (best, and required for video): `npm run worker` — section 10.
- **Vercel Cron:** add to `vercel.json`, then set `CRON_SECRET`:
  ```json
  "crons": [{ "path": "/api/cron/worker", "schedule": "* * * * *" }]
  ```
- **GitHub Actions:** `.github/workflows/worker-heartbeat.yml` already does this; set the
  `CRON_SECRET` and `APP_URL` repository secrets.

The cron route only ever claims short jobs. Video renders wait for a real worker by design.

### Vercel environment variables

**Where:** https://vercel.com/dashboard → project → **Settings** → **Environment Variables**

Your production project currently has the Meta variables, `DATABASE_URL`, `SESSION_SECRET`,
`TOKEN_ENCRYPTION_KEY` and `CRON_SECRET`. **Missing, in order of impact:**

| Variable | What stops working without it |
| --- | --- |
| `AI_API_KEY` (+ `AI_PROVIDER`, `AI_API_BASE_URL`, `AI_MODEL`) | Every AI feature: DM replies, comment replies, the video assistant |
| `GOOGLE_AI_API_KEY` | Sample-video style analysis; the Gemini subtitle fallback |
| `BLOB_READ_WRITE_TOKEN` | Video uploads of any size |
| `EMAIL_HOST`, `EMAIL_USER`, `EMAIL_PASSWORD` | Lead notification emails |
| `PAYMENT_SECRET_KEY`, `PAYMENT_WEBHOOK_SECRET` | Platform billing |

### Email (SMTP)

Any SMTP provider. For Gmail you must use an **App Password**
(https://myaccount.google.com/apppasswords) with 2-step verification enabled; a normal password is
refused. Leaving email unconfigured is fine — leads are still captured and the platform reports
notifications as unconfigured rather than failing them.

---

## Verification checklist

Run through this after setup. Each item has a place in the UI that shows the real answer.

| Check | Where | Expected |
| --- | --- | --- |
| Configuration complete | `/api/setup-status` | No missing variables |
| Database migrated | `npm run db:migrate` | "No pending migrations" |
| Instagram connected | **Instagram** page | Account card shows Connected + granted permissions |
| Webhooks arriving | **Messages** page | A DM you send appears |
| AI replies | **AI & Automation** → agent → Test console | A real reply with token counts |
| Publishing allowed | **Posts & Reels** | Publish controls enabled, not "permission missing" |
| Ads connected | Account card → Connect Facebook | Ad account picker lists real accounts |
| Queue draining | `/api/health` | Queue depth low, a drain seen recently |
| Video storage | **AI Video Editor** | *File storage* Available |
| Video worker | **AI Video Editor** | *Processing worker* Available |
| Auto subtitles | **AI Video Editor** | *Automatic subtitles* Available with provider named |
| A real render | Editor → Make preview | Progress advances, preview plays |

---

## Common errors

| Symptom | Cause | Fix |
| --- | --- | --- |
| `Invalid platform app` | Facebook App ID used for Instagram Login | Use `META_INSTAGRAM_APP_ID` from **Business login settings** |
| `Invalid Scopes` | A permission is not enabled on the app | Enable every scope in section 2 |
| `Insufficient developer role` | App in Development Mode, account has no role | Add the account as an Instagram Tester (section 4) |
| Webhook verification fails | Token mismatch, or app not deployed | Check `META_WEBHOOK_VERIFY_TOKEN`; the URL must be publicly reachable |
| Every webhook rejected as bad signature | Only the Facebook secret is set | Also set `META_INSTAGRAM_APP_SECRET` |
| Renders stay queued forever | No worker with FFmpeg | Section 10 — the editor page states this explicitly |
| Subtitles render as empty boxes | Font lacks Cyrillic/Uzbek glyphs | Install `fonts-dejavu-core` on the worker |
| "Cannot publish: URL not public" | Renders served from localhost | Deploy behind a public HTTPS domain, or use Blob storage |
| Transcription returns 402 | Gateway has no balance | Top up, or set `STT_PROVIDER=google` |
| "Cannot reach the database" | PostgreSQL not running or wrong URL | Start it; on Windows `npm run db:dev` must run in a **non-Administrator** terminal |
