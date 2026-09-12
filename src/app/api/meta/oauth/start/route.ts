import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { route } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/guard";
import { assertAccountAccess } from "@/lib/auth/access";
import { buildState, facebookAuthorizeUrl, instagramAuthorizeUrl } from "@/lib/meta/oauth";
import { randomToken } from "@/lib/crypto";
import { coreEnv, isInstagramLoginConfigured, isMetaConfigured } from "@/lib/env";
import { createLogger } from "@/lib/logger";

const log = createLogger("meta.oauth.start");

/**
 * Entry point of the Meta authorization flow. This is a BROWSER navigation,
 * so every outcome is a redirect — never a JSON error page.
 *
 *   ?mode=instagram            → Instagram's own authorization screen (organic features)
 *   ?mode=instagram&switch=1   → same, but Instagram re-asks which account to use
 *   ?mode=facebook&account=ID  → Facebook Login for Business, adding ads to that account
 */
export const GET = route(async (req: NextRequest) => {
  const auth = await requireAdmin();
  const settingsUrl = `${coreEnv().APP_URL}/instagram`;

  if (!isMetaConfigured()) {
    log.warn("connect attempted before Meta app credentials were configured");
    return NextResponse.redirect(`${settingsUrl}?error=not_configured`);
  }

  const params = req.nextUrl.searchParams;
  const mode = params.get("mode") === "facebook" ? "FACEBOOK_LOGIN" : "INSTAGRAM_LOGIN";

  // Instagram Login needs its own app credentials. Redirect back with an
  // explanation rather than sending the admin to an "Invalid platform app" page.
  if (mode === "INSTAGRAM_LOGIN" && !isInstagramLoginConfigured()) {
    log.warn("Instagram connect attempted without Instagram app credentials");
    return NextResponse.redirect(`${settingsUrl}?error=instagram_app_missing`);
  }

  // Which Instagram account the advertising authorization is for. Verified here,
  // while we can still explain the problem, rather than after a Facebook round
  // trip — and never trusted from the query string on the way back (it travels
  // inside the HMAC-signed state instead).
  let accountId: string | undefined;
  if (mode === "FACEBOOK_LOGIN") {
    const requested = params.get("account");
    if (requested) {
      const exists = await prisma.instagramAccount.findUnique({
        where: { id: requested },
        select: { id: true },
      });
      if (!exists) return NextResponse.redirect(`${settingsUrl}?error=account_not_found`);
      await assertAccountAccess(auth, exists.id);
      accountId = exists.id;
    }
  }

  const state = buildState({ mode, adminId: auth.admin.id, nonce: randomToken(8), accountId });
  const target =
    mode === "FACEBOOK_LOGIN"
      ? facebookAuthorizeUrl(state)
      : instagramAuthorizeUrl(state, params.get("switch") === "1");

  log.info("redirecting admin to Meta authorization", { mode, adminId: auth.admin.id, accountId });
  return NextResponse.redirect(target);
});
