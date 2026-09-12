import { NextRequest, NextResponse } from "next/server";
import { coreEnv } from "@/lib/env";
import { verifyState } from "@/lib/meta/oauth";
import { finalizeFacebookLogin, finalizeInstagramLogin } from "@/lib/meta/accounts";
import { checkInvite, markInviteUsed } from "@/lib/meta/invites";
import { prisma } from "@/lib/prisma";
import { getAuth } from "@/lib/auth/session";
import { audit, AuditActions } from "@/lib/audit";
import { clientIp } from "@/lib/api";
import { createLogger, errorFields } from "@/lib/logger";
import { AppError } from "@/lib/errors";

const log = createLogger("meta.oauth.callback");

/**
 * OAuth redirect target, shared by both ways an account can arrive:
 *
 *  · an ADMIN authorizing in their own browser — lands back on /instagram
 *  · the account OWNER following an invitation link, who has no account here
 *    at all — lands on the public /connect/done page
 *
 * Which one it was is decided by the HMAC-signed state, never by anything in
 * the query string.
 */
export async function GET(req: NextRequest) {
  const base = coreEnv().APP_URL;
  const done = (params: Record<string, string>) =>
    NextResponse.redirect(`${base}/instagram?${new URLSearchParams(params)}`);
  const publicDone = (params: Record<string, string>) =>
    NextResponse.redirect(`${base}/connect/done?${new URLSearchParams(params)}`);

  const search = req.nextUrl.searchParams;
  const stateRaw = search.get("state");

  // Where an error should land depends on WHO is holding the browser, so the
  // state is read (cheaply, signature-checked) before anything else.
  let invitedFlow = false;
  let state: ReturnType<typeof verifyState> | null = null;
  try {
    if (stateRaw) {
      state = verifyState(stateRaw);
      invitedFlow = Boolean(state.inviteId);
    }
  } catch {
    /* fall through — handled as a normal failure below */
  }
  const land = (params: Record<string, string>) => (invitedFlow ? publicDone(params) : done(params));

  const error = search.get("error") ?? search.get("error_reason");
  if (error) {
    log.warn("oauth denied", { error, description: search.get("error_description") });
    return land({ error: error === "user_denied" || error === "access_denied" ? "denied" : "meta_error" });
  }

  const code = search.get("code");
  if (!code || !stateRaw) return land({ error: "missing_params" });
  if (!state) return land({ error: "connect_failed" });

  try {
    let inviteId: string | null = null;

    if (state.inviteId) {
      // INVITED FLOW — there is no admin session to check, and demanding one
      // would defeat the whole point. The invitation is the authorisation, so
      // it is re-validated here: it may have been revoked, used or expired
      // during the round trip to Instagram.
      const invite = await prisma.connectInvite.findUnique({ where: { id: state.inviteId } });
      if (!invite) return publicDone({ error: "invalid_link" });
      const check = checkInvite(invite);
      if (!check.ok) return publicDone({ error: check.reason });
      inviteId = invite.id;
    } else {
      // ADMIN FLOW — the browser finishing must hold a valid admin session AND
      // be the admin who started it (state is HMAC-signed server-side).
      const auth = await getAuth();
      if (!auth || auth.admin.id !== state.adminId) {
        return done({ error: "session_mismatch" });
      }
    }

    const result =
      state.mode === "FACEBOOK_LOGIN"
        ? await finalizeFacebookLogin(code, state.accountId)
        : await finalizeInstagramLogin(code);

    for (const account of result.accounts) {
      await audit({
        adminId: state.adminId || undefined,
        action: AuditActions.CONNECTED_INSTAGRAM,
        resourceType: "instagram_account",
        resourceId: account.id,
        after: { username: account.username, mode: account.connectionMode, viaInvite: Boolean(inviteId) },
        ip: clientIp(req),
      });
    }

    if (inviteId) {
      const account = result.accounts[0];
      // Consumed only on success, and conditionally, so two people opening the
      // same link at once cannot both connect an account from it.
      if (account) await markInviteUsed(inviteId, account.id);
      return publicDone({
        connected: "1",
        ...(account ? { username: account.username } : {}),
        ...(result.warnings.length > 0 ? { warnings: result.warnings.join(" | ").slice(0, 300) } : {}),
      });
    }

    return done({
      connected: String(result.accounts.length),
      ...(result.warnings.length > 0 ? { warnings: result.warnings.join(" | ").slice(0, 500) } : {}),
    });
  } catch (err) {
    log.error("oauth callback failed", errorFields(err));
    await audit({
      adminId: state.adminId || undefined,
      action: AuditActions.CONNECTED_INSTAGRAM,
      success: false,
      error: err instanceof Error ? err.message : String(err),
      ip: clientIp(req),
    });
    const message = err instanceof AppError ? err.message : "connection_failed";
    return land({ error: "connect_failed", detail: message.slice(0, 300) });
  }
}
