import { NextRequest, NextResponse } from "next/server";
import { route } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/guard";
import { buildState, facebookAuthorizeUrl, instagramAuthorizeUrl } from "@/lib/meta/oauth";
import { randomToken } from "@/lib/crypto";
import { isMetaConfigured } from "@/lib/env";
import { AppError } from "@/lib/errors";

/**
 * Start the Meta authorization flow.
 *   /api/meta/oauth/start?mode=instagram  → Business Login for Instagram
 *   /api/meta/oauth/start?mode=facebook   → Facebook Login for Business (ads-capable)
 */
export const GET = route(async (req: NextRequest) => {
  const auth = await requireAdmin();
  if (!isMetaConfigured()) {
    throw new AppError("CONFIG_MISSING", "Meta app credentials are not configured", {
      reason: "META_APP_ID / META_APP_SECRET / META_REDIRECT_URI / META_WEBHOOK_VERIFY_TOKEN are missing.",
      fix: "Create a Meta app (developers.facebook.com), add the Instagram product, and fill the META_* variables in .env.",
    });
  }

  const mode = req.nextUrl.searchParams.get("mode") === "facebook" ? "FACEBOOK_LOGIN" : "INSTAGRAM_LOGIN";
  const state = buildState({ mode, adminId: auth.admin.id, nonce: randomToken(8) });
  const url = mode === "FACEBOOK_LOGIN" ? facebookAuthorizeUrl(state) : instagramAuthorizeUrl(state);
  return NextResponse.redirect(url);
});
