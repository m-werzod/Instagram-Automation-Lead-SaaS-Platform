import { route, ok } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/guard";
import { coreEnv } from "@/lib/env";

/**
 * Tells the UI whether this installation can actually start a Meta
 * authorization, and what is missing if it cannot. The Connect button is only
 * offered when the redirect would really work — no dead buttons.
 * Secrets themselves are never returned; only whether they are present.
 */
export const GET = route(async () => {
  await requireAdmin();

  const required = ["META_APP_ID", "META_APP_SECRET", "META_REDIRECT_URI", "META_WEBHOOK_VERIFY_TOKEN"] as const;
  const missing = required.filter((key) => !process.env[key]?.trim());
  const appUrl = coreEnv().APP_URL;

  return ok({
    configured: missing.length === 0,
    missing,
    appId: process.env.META_APP_ID ? `${process.env.META_APP_ID.slice(0, 4)}…${process.env.META_APP_ID.slice(-4)}` : null,
    graphVersion: process.env.META_GRAPH_VERSION ?? "v25.0",
    redirectUri: process.env.META_REDIRECT_URI || `${appUrl}/api/meta/oauth/callback`,
    webhookUrl: `${appUrl}/api/webhooks/instagram`,
  });
});
