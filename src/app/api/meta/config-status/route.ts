import { route, ok } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/guard";
import { isStaff } from "@/lib/auth/access";
import { coreEnv } from "@/lib/env";
import { IG_OPTIONAL_SCOPES, igLoginScopes } from "@/lib/meta/oauth";

/**
 * Tells the UI whether this installation can actually start a Meta
 * authorization, and what is missing or wrong if it cannot. The Connect button
 * is only offered when the redirect would really work — no dead buttons.
 * Secrets themselves are never returned; only whether they are present.
 *
 * It also reports the two mis-configurations that do NOT look like
 * mis-configurations from inside this app, because they only fail later on
 * Instagram's side with an unhelpful message:
 *   · a non-HTTPS redirect URI (Instagram Login refuses plain http, localhost
 *     included — unlike Facebook Login, which allows it)
 *   · a redirect URI pointing at a different origin than APP_URL, so the
 *     authorization lands on another deployment that has no session
 */
export const GET = route(async () => {
  const auth = await requireAdmin();

  const required = ["META_APP_ID", "META_APP_SECRET", "META_REDIRECT_URI", "META_WEBHOOK_VERIFY_TOKEN"] as const;
  const missing = required.filter((key) => !process.env[key]?.trim());
  const appUrl = coreEnv().APP_URL;

  // Instagram Login needs its OWN app id/secret; the Facebook ones make
  // instagram.com reject the request with "Invalid platform app".
  const instagramMissing = (["META_INSTAGRAM_APP_ID", "META_INSTAGRAM_APP_SECRET"] as const).filter(
    (key) => !process.env[key]?.trim(),
  );

  const redirectUri = process.env.META_REDIRECT_URI?.trim() || `${appUrl}/api/meta/oauth/callback`;
  let redirectUriIsHttps = false;
  let redirectUriMatchesAppUrl = false;
  try {
    const redirect = new URL(redirectUri);
    redirectUriIsHttps = redirect.protocol === "https:";
    redirectUriMatchesAppUrl = redirect.origin === new URL(appUrl).origin;
  } catch {
    /* leave both false — the UI reports it as a broken value */
  }

  return ok({
    configured: missing.length === 0,
    missing,
    instagramLoginReady: instagramMissing.length === 0,
    instagramMissing,
    appId: process.env.META_APP_ID ? `${process.env.META_APP_ID.slice(0, 4)}…${process.env.META_APP_ID.slice(-4)}` : null,
    graphVersion: process.env.META_GRAPH_VERSION ?? "v25.0",
    redirectUri,
    redirectUriIsHttps,
    redirectUriMatchesAppUrl,
    webhookUrl: `${appUrl}/api/webhooks/instagram`,
    // The verify token is a shared secret: anyone holding it can complete Meta's
    // subscription handshake against this deployment. Only OWNER/ADMIN — who do
    // the App Dashboard setup — get the value; a USER sees the rest of the page
    // with the field simply absent.
    verifyToken: isStaff(auth) ? process.env.META_WEBHOOK_VERIFY_TOKEN?.trim() || null : null,
    appUrl,
    // Exactly what the authorization will ask Instagram for. Every one of these
    // must be enabled on the app or Instagram rejects the WHOLE dialog with
    // "Invalid Scopes" — so the admin needs to see the list, not guess it.
    scopes: igLoginScopes(),
    optionalScopes: [...IG_OPTIONAL_SCOPES],
  });
});
