import { NextRequest, NextResponse } from "next/server";
import { coreEnv } from "@/lib/env";
import { verifyState } from "@/lib/meta/oauth";
import { finalizeFacebookLogin, finalizeInstagramLogin } from "@/lib/meta/accounts";
import { getAuth } from "@/lib/auth/session";
import { audit, AuditActions } from "@/lib/audit";
import { clientIp } from "@/lib/api";
import { createLogger, errorFields } from "@/lib/logger";
import { AppError } from "@/lib/errors";

const log = createLogger("meta.oauth.callback");

/** OAuth redirect target. Always lands the admin back on the integrations page. */
export async function GET(req: NextRequest) {
  const base = coreEnv().APP_URL;
  const done = (params: Record<string, string>) =>
    NextResponse.redirect(`${base}/instagram?${new URLSearchParams(params)}`);

  const search = req.nextUrl.searchParams;
  const error = search.get("error") ?? search.get("error_reason");
  if (error) {
    log.warn("oauth denied", { error, description: search.get("error_description") });
    return done({ error: error === "user_denied" || error === "access_denied" ? "denied" : "meta_error" });
  }

  const code = search.get("code");
  const stateRaw = search.get("state");
  if (!code || !stateRaw) return done({ error: "missing_params" });

  try {
    const state = verifyState(stateRaw);

    // The browser completing the flow must hold a valid admin session AND be
    // the admin who started it (state is HMAC-signed server-side).
    const auth = await getAuth();
    if (!auth || auth.admin.id !== state.adminId) {
      return done({ error: "session_mismatch" });
    }

    const result =
      state.mode === "FACEBOOK_LOGIN"
        ? await finalizeFacebookLogin(code, state.accountId)
        : await finalizeInstagramLogin(code);

    for (const account of result.accounts) {
      await audit({
        adminId: auth.admin.id,
        action: AuditActions.CONNECTED_INSTAGRAM,
        resourceType: "instagram_account",
        resourceId: account.id,
        after: { username: account.username, mode: account.connectionMode },
        ip: clientIp(req),
      });
    }

    return done({
      connected: String(result.accounts.length),
      ...(result.warnings.length > 0 ? { warnings: result.warnings.join(" | ").slice(0, 500) } : {}),
    });
  } catch (err) {
    log.error("oauth callback failed", errorFields(err));
    await audit({
      action: AuditActions.CONNECTED_INSTAGRAM,
      success: false,
      error: err instanceof Error ? err.message : String(err),
      ip: clientIp(req),
    });
    const message = err instanceof AppError ? err.message : "connection_failed";
    return done({ error: "connect_failed", detail: message.slice(0, 300) });
  }
}
