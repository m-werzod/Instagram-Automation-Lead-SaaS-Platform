# Adding an Instagram account — start to finish

Everything needed to turn an empty installation into one where an admin can press
**Connect Instagram**, the account owner approves on instagram.com, and messages
start arriving. Capability details live in [META_API.md](META_API.md); this file
is the click-path.

The same information is shown **inside the app** on `/instagram` — the page
detects what is missing and prints the exact values to paste. Use this document
when setting up for the first time, and the app when checking your work.

---

## 0. What you need before you start

| Requirement | Why |
| --- | --- |
| Instagram **Business or Creator** account | Instagram Login refuses Personal accounts. Convert in the Instagram app: *Settings → Account type and tools → Switch to professional account*. |
| A Meta developer account | developers.facebook.com, free. |
| An **https://** address for this app | Instagram Login rejects plain `http://` redirect URIs, `http://localhost` included. See §5. |

> Nothing here asks for the Instagram password. The password is only ever typed
> on instagram.com's own screen; this platform receives a token, never a credential.

---

## 1. Create the Meta app

1. developers.facebook.com → **My Apps → Create App**.
2. Use case: **Other** → type: **Business**.
3. Open **App settings → Basic** and copy:
   - **App ID** → `META_APP_ID`
   - **App secret** → `META_APP_SECRET`

These two are the *Facebook* app credentials. They are **not** what Instagram
Login authenticates with — that trips up almost everyone, see §2.

---

## 2. Add the Instagram product and get its OWN credentials

1. In the app, add the product **Instagram** → *API setup with Instagram login*.
2. Open **Business login settings**.
3. Copy the **Instagram app ID** and **Instagram app secret** shown there:
   - **Instagram app ID** → `META_INSTAGRAM_APP_ID`
   - **Instagram app secret** → `META_INSTAGRAM_APP_SECRET`

> **These are different numbers from §1.** Passing the Facebook app ID to
> `www.instagram.com/oauth/authorize` makes Instagram answer
> **"Invalid platform app"** before the account owner ever sees a consent screen.
> This is the single most common reason a connect attempt dies.

Still on **Business login settings**, set:

- **OAuth redirect URI** → `{APP_URL}/api/meta/oauth/callback`

It must match `META_REDIRECT_URI` **character for character** — Meta compares the
whole string, so a trailing slash or `www.` difference is a rejection.

---

## 3. Enable the permissions the app will request

Under **Instagram → Permissions and features**, make sure these three are
available to the app:

```
instagram_business_basic
instagram_business_manage_messages
instagram_business_manage_comments
```

> Instagram rejects the **entire** authorization with **"Invalid Scopes"** if even
> one requested permission is not enabled on the app. That is why the code asks
> only for these three by default.

Optional extras — enable them on the app **first**, then list them in
`META_INSTAGRAM_EXTRA_SCOPES` (comma-separated):

```
instagram_business_content_publish     # publish posts/Reels from the platform
instagram_business_manage_insights     # read statistics
```

Anything not granted simply shows as unavailable in the capability matrix on the
account card — nothing breaks.

---

## 4. Point webhooks at this app

**Instagram → Webhooks**:

- **Callback URL** → `{APP_URL}/api/webhooks/instagram`
- **Verify token** → the same string you put in `META_WEBHOOK_VERIFY_TOKEN`
- Subscribe to the fields: `messages`, `messaging_postbacks`, `messaging_seen`,
  `comments`, `mentions`

Meta calls the callback URL once to verify it, so **the app must already be
deployed and reachable** when you press Verify.

Without this, a connection can look perfectly healthy while no DM ever arrives.
The account card shows *Event delivery is not active* and offers a one-click
retry when that happens.

---

## 5. Why localhost does not work for this

Instagram Login requires an **HTTPS** redirect URI and will not accept
`http://localhost:3000/...`. Facebook Login is more permissive, which is why the
ads flow can be exercised locally but the Instagram flow cannot.

Options, in order of preference:

1. **Connect on the deployed site.** Everything else — the dashboard, Lead
   Button, CRM, webhook simulator — works locally; only the Instagram
   authorization needs the live domain.
2. **An HTTPS tunnel** (ngrok, Cloudflare Tunnel). Set `APP_URL` and
   `META_REDIRECT_URI` to the tunnel address and register that URI in the App
   Dashboard. The URL changes on every restart unless it is a reserved domain.

The `/instagram` page warns about this automatically whenever the configured
redirect is not HTTPS.

---

## 6. Set the environment variables

```bash
META_APP_ID=                    # §1
META_APP_SECRET=                # §1
META_INSTAGRAM_APP_ID=          # §2 — DIFFERENT from META_APP_ID
META_INSTAGRAM_APP_SECRET=      # §2
META_REDIRECT_URI=https://your-domain/api/meta/oauth/callback
META_WEBHOOK_VERIFY_TOKEN=      # any random string, 8+ chars, same value as §4
META_GRAPH_VERSION=v25.0
META_INSTAGRAM_EXTRA_SCOPES=    # optional, see §3
```

- **Local**: edit `.env`, then restart the app.
- **Vercel**: *Settings → Environment Variables*, then **Redeploy** — variables
  are only read by a new deployment.

---

## 7. Connect the account

1. Sign in to the platform and open **Instagram** in the sidebar.
2. If anything from §1–§6 is still missing, the page says exactly what, with copy
   buttons for the values Meta needs. Fix, then press **Check again**.
3. Press **Connect Instagram**. From here:
   - instagram.com opens and asks for the account's username and password;
   - Instagram lists what the app may do and asks to **Allow** — every permission
     must be left on, because anything declined stays switched off in the
     platform;
   - the browser returns to `/instagram` and the account card appears.
4. Press **Test connection** to confirm, and check that *Event delivery* is on.

**Start and finish in the same browser.** The callback checks that the admin
session completing the flow is the one that started it; finishing in a different
browser fails with an explicit "sign in here and start again" message.

### Adding a second account

Use **Add a different account**. It sends `force_reauth=true`, so Instagram asks
which account to authorize instead of silently re-approving the one already
signed in in that browser — without it, a second attempt just re-connects the
first account and appears to do nothing.

---

## 8. Adding advertising (optional, separate authorization)

Ads need a **Facebook** authorization, because the Marketing API does not exist
on `graph.instagram.com`. On the account card use **Connect Facebook (for ads)**.

Start it **from the card of the account it belongs to** — the target travels
inside the signed OAuth state, so the ad account lands on that profile and not on
every connected one. With several accounts connected, an authorization that did
not name one is refused rather than guessed at, because an ad account is a
billing relationship.

Requirements: an ad account with a payment method (business.facebook.com →
Settings → Ad accounts), and `ads_management` left enabled on the Facebook
consent screen.

---

## 9. When it fails

Every failure lands back on `/instagram` as a panel that explains the cause in
plain language and stays until dismissed. The mapping:

| What you see | Cause | Fix |
| --- | --- | --- |
| "Invalid platform app" on instagram.com | `META_INSTAGRAM_APP_ID` holds the Facebook app ID | §2 |
| "Invalid Scopes" on instagram.com | a requested permission is not enabled on the app | §3 |
| "URL blocked" / redirect mismatch | `META_REDIRECT_URI` ≠ the URI registered in the dashboard | §2 |
| Panel: *no Meta app credentials yet* | `META_APP_*` unset | §1, §6 |
| Panel: *Instagram app ID and secret are missing* | `META_INSTAGRAM_APP_*` unset | §2, §6 |
| Panel: *you were signed out, or finished in a different browser* | the admin session did not survive the round trip | start and finish in one browser |
| Panel: *you cancelled, or left a permission switched off* | Allow was declined | retry with every permission on |
| Card: *Event delivery is not active* | webhook subscription failed | press **Turn on event delivery**; if it fails again, §4 |

While the app is in **Development mode**, only accounts added as app testers
(*App roles → Roles*) can complete the flow. Submit for App Review and switch to
**Live** before connecting a client's account.
