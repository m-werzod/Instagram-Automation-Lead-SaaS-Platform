import { NextRequest, NextResponse } from "next/server";
import { route } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/guard";
import { buildState, facebookAuthorizeUrl, instagramAuthorizeUrl } from "@/lib/meta/oauth";
import { randomToken } from "@/lib/crypto";
import { coreEnv, isMetaConfigured } from "@/lib/env";
import { createLogger } from "@/lib/logger";

const log = createLogger("meta.oauth.start");

/**
 * Entry point of the Meta authorization flow. This is a BROWSER navigation,
 * so every outcome is a redirect — never a JSON error page.
 *
 *   ?mode=instagram → Instagram's own authorization screen (organic features)
 *   ?mode=facebook  → Facebook Login for Business (adds ads / Instant Forms)
 */
export const GET = route(async (req: NextRequest) => {
  const auth = await requireAdmin();
  const settingsUrl = `${coreEnv().APP_URL}/settings/integrations/instagram`;

  if (!isMetaConfigured()) {
    log.warn("connect attempted before Meta app credentials were configured");
    return NextResponse.redirect(`${settingsUrl}?error=not_configured`);
  }

  const mode = req.nextUrl.searchParams.get("mode") === "facebook" ? "FACEBOOK_LOGIN" : "INSTAGRAM_LOGIN";
  const state = buildState({ mode, adminId: auth.admin.id, nonce: randomToken(8) });
  const target = mode === "FACEBOOK_LOGIN" ? facebookAuthorizeUrl(state) : instagramAuthorizeUrl(state);

  log.info("redirecting admin to Meta authorization", { mode, adminId: auth.admin.id });
  return NextResponse.redirect(target);
});
