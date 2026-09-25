# What you must do — exact steps

Everything that could be done inside the code is done, pushed and deployed. This file is only the
work that needs *your* account, your card, or your machine.

**Live now:** https://instagramaileads.vercel.app
**Deployed commit:** `8005aae` · both database migrations applied successfully during the build.

Ordered so that each step makes something visibly work. Do them in order; stop wherever you like —
everything before that point keeps working.

---

## ⚠ STEP 0 — Rotate the two tokens you shared (5 minutes)

You pasted a GitHub token and a Vercel token into our chat. Treat both as public now. Neither was
written into the repository, but both must be replaced.

1. **GitHub** → https://github.com/settings/tokens
   Find the token starting `github_pat_11BUCVWU…` → **Delete**. Generate a new one only if you need
   it (the push is already done and your local git has its own saved credentials).
2. **Vercel** → https://vercel.com/account/tokens
   Find the token starting `vcp_3yw0WG…` → click the **⋯** → **Delete**.

---

## STEP 1 — Turn the AI back on (5 minutes) ⭐ BIGGEST IMPACT

**Right now, in production, no AI feature works** — not DM replies, not comment replies, not the
video assistant. The code is deployed and correct; there is simply no API key in the live project.
Your local `.env` has one; Vercel does not.

**Where:** https://vercel.com/m-werzods-projects/instagramaileads/settings/environment-variables

Click **Add Another**, and add these four. Tick **Production**, **Preview** and **Development** for each.

| Key | Value |
| --- | --- |
| `AI_API_KEY` | the key from your local `.env` (the api.airforce one) |
| `AI_API_BASE_URL` | `https://api.airforce/v1` |
| `AI_PROVIDER` | `openai` — already set, just confirm it says this |
| `AI_MODEL` | `ministral-14b-latest` (or any model that gateway lists) |

Then **Deployments** → newest → **⋯** → **Redeploy**.

**How to check it worked:** sign in → **AI va avtomatika** → open an agent → **Test console** → send
a message. A real reply appears with token counts and cost. If the key is wrong you get the
provider's own error, not a fake reply.

> If you would rather use a mainstream provider: get a key at
> https://console.anthropic.com/settings/keys (then `AI_PROVIDER=anthropic`, `AI_API_KEY=sk-ant-…`,
> `AI_MODEL=claude-sonnet-4-20250514`, and delete `AI_API_BASE_URL`), or
> https://platform.openai.com/api-keys (`AI_PROVIDER=openai`, `AI_MODEL=gpt-4o-mini`, no base URL).

---

## STEP 2 — Add the Google AI key (3 minutes)

This powers sample-video style analysis, and is the fallback for automatic subtitles.
**I already tested your Google key during this work and it is valid** — it reaches Gemini 2.5 Flash,
2.5 Pro and 3 Flash.

**Where to get one (if you need a new one):** https://aistudio.google.com/apikey → **Create API key**

Add in the same Vercel screen:

| Key | Value |
| --- | --- |
| `GOOGLE_AI_API_KEY` | your Google AI Studio key |

---

## STEP 3 — Video storage (10 minutes)

Without this, **no video can be uploaded at all** in production. Vercel's request limit is 4.5 MB;
Blob storage is what lets the browser upload a real video directly.

**Where:** https://vercel.com/m-werzods-projects/instagramaileads/stores

1. Click **Create Database** → choose **Blob** → name it (e.g. `video-media`) → **Create**.
2. Click **Connect to Project** → select `instagramaileads` → **Connect**.
   Vercel adds `BLOB_READ_WRITE_TOKEN` to the project automatically.
3. Redeploy.

**How to check it worked:** **AI Video muharriri** → the capability panel shows **File storage:
Available** with the driver name and the size limit.

---

## STEP 4 — The video processing worker (20 minutes) ⭐ REQUIRED FOR RENDERING

**This is the one thing Vercel cannot do.** Its functions stop after 60 seconds and have a read-only
filesystem; a video render takes minutes. The platform is built for exactly this: video jobs sit in
their own queue lane that only a real worker picks up, and the editor tells you honestly that no
worker is online instead of showing a progress bar that never moves.

Pick any always-on machine. **Railway is the easiest.**

### Option A — Railway (no server admin needed)

1. https://railway.app → sign in with GitHub → **New Project** → **Deploy from GitHub repo**
2. Choose `m-werzod/Instagram-Automation-Lead-SaaS-Platform`
3. **Settings → Build** → set **Custom Start Command** to:
   ```
   npm run worker
   ```
4. **Settings → Variables** → add the same values your Vercel project has. At minimum:
   `DATABASE_URL`, `SESSION_SECRET`, `TOKEN_ENCRYPTION_KEY`, `APP_URL`, `META_*`, `AI_*`,
   `GOOGLE_AI_API_KEY`, `BLOB_READ_WRITE_TOKEN`.
5. FFmpeg: add a file named `nixpacks.toml` in the repo root containing:
   ```toml
   [phases.setup]
   nixPkgs = ["nodejs_20", "ffmpeg", "dejavu_fonts"]
   ```
   (Tell me and I will add and push this file for you.)
6. Deploy. The logs should print `video lane enabled` with the FFmpeg version.

### Option B — A VPS you own (Ubuntu)

```bash
sudo apt update && sudo apt install -y ffmpeg fonts-dejavu-core nodejs npm git
git clone https://github.com/m-werzod/Instagram-Automation-Lead-SaaS-Platform.git
cd Instagram-Automation-Lead-SaaS-Platform
npm ci
# create .env with the same values as Vercel, then:
npm run worker
```

Keep it alive with systemd:

```bash
sudo tee /etc/systemd/system/ig-worker.service > /dev/null <<'EOF'
[Unit]
Description=Instagram automation worker
After=network.target
[Service]
WorkingDirectory=/root/Instagram-Automation-Lead-SaaS-Platform
ExecStart=/usr/bin/npm run worker
Restart=always
EnvironmentFile=/root/Instagram-Automation-Lead-SaaS-Platform/.env
[Install]
WantedBy=multi-user.target
EOF
sudo systemctl enable --now ig-worker
sudo journalctl -u ig-worker -f
```

`fonts-dejavu-core` matters: without it, burned-in subtitles render as empty boxes for Uzbek (oʻ, gʻ)
and Russian characters.

**How to check it worked:** **AI Video muharriri** → **Processing worker: Available**. Then upload a
video and press **Ko‘rib chiqish tayyorlash** — the progress bar moves and a preview plays.

---

## STEP 5 — Automatic subtitles (2 minutes)

Subtitles can always be typed or imported. *Automatic* ones need a transcription provider.

**I tested your gateway during this work: the transcription endpoint exists and lists `whisper-1`,
but it returns `402 — the account needs a positive balance`.** Two ways forward:

- **Top up the gateway** at https://api.airforce/dashboard — this is the better option, because it
  returns **word-level timings**, which is what makes the *So‘zlar ajratilgan* (highlighted words)
  subtitle preset possible.
- **Or use Gemini instead** — add `STT_PROVIDER=google` in Vercel. Free with your Google key, but it
  returns sentence-level timings only, so per-word highlighting stays switched off (the editor
  disables that control and says why).

---

## STEP 6 — Lead notification emails (10 minutes)

Leads are captured and stored whether or not this is configured — email is only the notification.

**Gmail:** a normal password will not work. You need an App Password.

1. Enable 2-Step Verification: https://myaccount.google.com/signinoptions/two-step-verification
2. Create the App Password: https://myaccount.google.com/apppasswords → select **Mail** → copy the
   16-character code.

Add in Vercel:

| Key | Value |
| --- | --- |
| `EMAIL_HOST` | `smtp.gmail.com` |
| `EMAIL_PORT` | `587` (already set) |
| `EMAIL_USER` | `sherzodusmonjonov734@gmail.com` |
| `EMAIL_PASSWORD` | the 16-character app password, no spaces |

**How to check it worked:** **Sozlamalar** → **Send test email**.

---

## STEP 7 — Platform billing: NOT NEEDED (skip)

You said you are not charging other people to use the platform. Nothing needs doing here.

Stripe is already inert: every price in the configuration defaults to zero, so a campaign fee is
never required and the platform never asks anyone to pay it. There is no gate in front of creating,
launching or managing a campaign. Leave `PAYMENT_SECRET_KEY` unset and the Billing page simply stays
empty.

If you ever do decide to charge clients for using the platform, tell me and I will walk you through
enabling it. Until then, ignore it.

---

## STEP 8 — Paying Meta for ads (20 minutes, once) ⭐ THE ONE THING THAT HAPPENS AT META

This is the step that answers "everything must be payable through the platform". Here is the exact
truth, so you can plan around it rather than discover it later.

### What Meta allows, and what it does not

Meta bills **the ad account's own payment method**. There is no Marketing API endpoint that lets
another platform add a card, or charge a card and pay Meta on an advertiser's behalf — I checked the
current API reference while building this, not from memory. Adding a payment method happens on
Meta's own page, for the same reason your bank will not let a third-party app type in your card
number: Meta keeps that inside its own compliance boundary.

So any tool that claims to "pay Meta from inside our dashboard" is either taking your money into
*their* account and running the ads on *their* ad account, or it is not telling you the truth. This
platform does not pretend.

### What that means in practice — and it is better than it sounds

**The card is a one-time setup, not a per-campaign step.** You attach it once to the ad account.
After that, Meta charges it automatically as spend accrues, and **every single thing a targetolog
does is inside this platform**: choose the Reel, set the audience, country, age, gender, interests,
budget, schedule, placements, launch, pause, resume, stop, watch spend and results, and set a hard
spend ceiling. Nobody opens Ads Manager again in normal work.

### The agency setup you want

Because you are running this for clients as an SMM/targeting service, use **one ad account that you
own**, with **your** card on it:

1. **Business Manager:** https://business.facebook.com/settings
   - **Accounts → Ad accounts** → create one (or use yours). Note the id, `act_…`.
   - **Accounts → Pages** → add each client's Facebook Page (they grant you partner access; they
     never give you their card).
   - **Users → Partners** → clients share their Page and Instagram with your Business Manager.
2. **Add your card, once:** **Accounts → Ad accounts** → select yours → **Payment methods** →
   **Add payment method**.
   Direct link: https://business.facebook.com/billing_hub/payment_settings
3. **In this platform:** **Instagram** → the account card → **Connect Facebook (for ads)**, and pick
   that ad account.

You then bill your clients however you already do — cash, transfer, invoice. That is between you and
them; the platform does not need to be involved, which is exactly what you asked for.

### What you now control from inside the platform

The **Target** page shows a live **Advertising money** panel, read straight from Meta:

| Shown | Meaning |
| --- | --- |
| Payment method | The card Meta holds, e.g. "Visa ****4242" |
| Spent so far | What Meta has already charged |
| Outstanding balance | What is currently owed |
| Spend cap | A hard ceiling — **and you can set, change, restart or remove it from here** |
| Account status | Meta's own words, including any payment problem |

The spend cap is a real stop, not a reminder: when spending reaches it, Meta pauses every campaign on
that ad account. It is the one money control Meta exposes to the API, and it is wired into the
platform so you never have to leave to protect a budget.

**How to check it worked:** open **Target**. The panel names your ad account and shows the card. If
Meta reports a payment problem it says so in Meta's own words, with a link to the one page that fixes
it.

---

## STEP 9 — Instagram permissions for video publishing (5 minutes)

To publish anything — including a finished video from the editor — the Meta app needs the publishing
permission. Your other Instagram permissions are already configured.

**Where:** https://developers.facebook.com/apps → your app → **Instagram** → **API setup with
Instagram login**

Enable, in addition to what you already have:

- `instagram_business_content_publish` — **required to publish**
- `instagram_business_manage_insights` — post metrics

Then reconnect the account in **Instagram → Connect Instagram** so the new permission is granted.

**How to check it worked:** the account's capability matrix shows **Publishing: Available** instead of
a missing-permission reason.

---

## The order I would actually do it in

| Priority | Step | Unlocks |
| --- | --- | --- |
| 1 | Step 0 | Closes an exposed-credential risk |
| 2 | Step 1 | Every AI feature — the biggest single gap |
| 3 | Step 3 + 4 | Video upload and rendering (the new premium feature) |
| 4 | Step 9 | Publishing the result to Instagram |
| 5 | Step 2 + 5 | Style analysis and automatic subtitles |
| 6 | Step 6 | Lead emails |
| 7 | Step 8 | Advertising — the one-time card setup at Meta |
| — | Step 7 | Skip: you are not charging your users |

---

## Things I could not verify, and will not claim

- **No Instagram account has ever been connected from here.** The OAuth flow, webhooks and messaging
  are implemented and unit-tested against mocked Meta responses, but nothing has been exercised
  against a real Instagram account. That first connection is yours to make (step 9), and I would
  expect small surprises — tell me what Meta says and I will fix them.
- **No video has been rendered in production**, because no worker exists yet. The pipeline is
  verified by running real FFmpeg on this machine, including audio mixing, subtitle burn-in and
  injection-resistant caption text.
- **No payment has been taken**, in test mode or otherwise.
- **The comment-keyword lead path is not implemented.** Three strings in the interface promise that a
  code word in a comment starts the question flow. No code does it. I left it visible rather than
  quietly building something adjacent and calling it done — tell me and I will either build it or
  remove the promise.

## If something does not work

Send me the exact message you see. Every error in this platform is written to say what happened, why,
and what to do about it, so the text itself usually identifies the cause. `docs/` and
`MANUAL_SETUP_GUIDE.md` hold the longer reference, including a table of common Meta errors.
