import { NextRequest } from "next/server";
import { z } from "zod";
import { route, ok, parseBody, assertSameOrigin } from "@/lib/api";
import { requireStaff } from "@/lib/auth/guard";
import { audit, AuditActions } from "@/lib/audit";
import { telegramConfig, saveTelegramSettings, tgGetMe, tgDetectChatId } from "@/lib/telegram";

/**
 * Telegram lead-notification settings.
 * GET  → connection status (never returns the token itself)
 * PUT  → save token / enabled flag; verifies the token against getMe and
 *        auto-detects the chat id when possible.
 */

export const GET = route(async () => {
  await requireStaff();
  const cfg = await telegramConfig();
  if (!cfg) return ok({ telegram: { configured: false, enabled: false, botUsername: null, chatId: null, source: null } });

  let botUsername: string | null = null;
  try {
    const me = await tgGetMe(cfg.token);
    botUsername = me.username ?? null;
  } catch {
    /* token present but invalid/unreachable — surfaced as botUsername null */
  }
  return ok({
    telegram: {
      configured: true,
      enabled: cfg.enabled,
      botUsername,
      chatId: cfg.chatId,
      source: cfg.source,
    },
  });
});

const putSchema = z.object({
  token: z.string().trim().max(200).nullable().optional(),
  enabled: z.boolean().optional(),
});

export const PUT = route(async (req: NextRequest) => {
  assertSameOrigin(req);
  const auth = await requireStaff();
  const body = await parseBody(req, putSchema);

  let botUsername: string | null = null;
  let chatId: string | null | undefined = undefined;

  if (body.token) {
    // Validate before storing — a broken token should fail loudly here, not
    // silently at the first lead.
    const me = await tgGetMe(body.token);
    botUsername = me.username ?? null;
    chatId = await tgDetectChatId(body.token).catch(() => null);
  }

  await saveTelegramSettings({
    token: body.token,
    enabled: body.enabled,
    ...(chatId !== undefined && chatId !== null ? { chatId } : body.token === null ? { chatId: null } : {}),
  });

  await audit({
    adminId: auth.admin.id,
    action: AuditActions.CHANGED_GLOBAL_SETTINGS,
    resourceType: "telegram_settings",
    after: { tokenSet: body.token !== undefined ? Boolean(body.token) : undefined, enabled: body.enabled, botUsername },
  });

  const cfg = await telegramConfig();
  return ok({
    telegram: {
      configured: Boolean(cfg),
      enabled: cfg?.enabled ?? false,
      botUsername,
      chatId: cfg?.chatId ?? null,
      source: cfg?.source ?? null,
    },
  });
});
