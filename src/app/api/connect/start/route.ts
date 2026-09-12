import { NextRequest, NextResponse } from "next/server";
import { buildState, instagramAuthorizeUrl } from "@/lib/meta/oauth";
import { checkInviteToken } from "@/lib/meta/invites";
import { randomToken } from "@/lib/crypto";
import { coreEnv, isInstagramLoginConfigured, isMetaConfigured } from "@/lib/env";
import { rateLimit } from "@/lib/rate-limit";
import { clientIp } from "@/lib/api";
import { createLogger, errorFields } from "@/lib/logger";

const log = createLogger("connect.start");

/**
 * PUBLIC entry point of the invitation flow.
 *
 * The person hitting this is the Instagram account OWNER, who has no account on
 * this platform — so unlike /api/meta/oauth/start there is deliberately no
 * requireAdmin() here. The invitation token is the whole authorisation, which is
 * why it is single-use, expiring, revocable and grants nothing but this.
 *
 * Like the admin entry point this is a browser navigation, so every outcome is
 * a redirect to a page a non-technical person can read — never a JSON error.
 */
export async function GET(req: NextRequest) {
  const base = coreEnv().APP_URL;
  const fail = (reason: string, detail?: string) =>
    NextResponse.redirect(`${base}/connect/done?${new URLSearchParams({ error: reason, ...(detail ? { detail } : {}) })}`);

  const token = req.nextUrl.searchParams.get("token");
  if (!token) return fail("invalid_link");

  // Guessing a 32-byte token is not feasible, but the limiter keeps a flood of
  // attempts from becoming free database lookups.
  const limit = rateLimit(`connect-start:${clientIp(req)}`, 20, 10 * 60_000);
  if (!limit.allowed) return fail("rate_limited");

  if (!isMetaConfigured() || !isInstagramLoginConfigured()) {
    // The owner cannot act on this; it is the operator's problem.
    log.error("invite opened but this installation cannot authorize");
    return fail("not_configured");
  }

  try {
    const check = await checkInviteToken(token);
    if (!check.ok) return fail(check.reason);
    const invite = check.invite;

    const state = buildState({
      mode: "INSTAGRAM_LOGIN",
      adminId: invite.createdById ?? "",
      nonce: randomToken(8),
      inviteId: invite.id,
    });

    // force_reauth so Instagram asks who is signing in. The owner may already
    // be logged into a personal account in this browser, and silently
    // authorizing that one is exactly the wrong outcome.
    const target = instagramAuthorizeUrl(state, true);
    log.info("invite handing off to Instagram", { inviteId: invite.id });
    return NextResponse.redirect(target);
  } catch (err) {
    log.error("invite could not be started", errorFields(err));
    return fail("failed");
  }
}
