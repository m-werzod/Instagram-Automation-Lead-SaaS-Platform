import { NextRequest } from "next/server";
import { route, ok, assertSameOrigin } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/guard";
import { AppError } from "@/lib/errors";
import { telegramConfig, saveTelegramSettings, tgDetectChatId, tgSendMessage } from "@/lib/telegram";

/** Send a real test message to the configured bot chat (auto-detects the chat first). */
export const POST = route(async (req: NextRequest) => {
  assertSameOrigin(req);
  await requireAdmin();

  const cfg = await telegramConfig();
  if (!cfg) {
    throw new AppError("VALIDATION", "Telegram is not configured", {
      reason: "No bot token is saved.",
      fix: "Save the bot token first.",
    });
  }

  let chatId = cfg.chatId;
  if (!chatId) {
    chatId = await tgDetectChatId(cfg.token);
    if (chatId) await saveTelegramSettings({ chatId });
  }
  if (!chatId) {
    throw new AppError("VALIDATION", "Telegram chat not detected", {
      reason: "The bot has no conversation to deliver to yet.",
      fix: "Open the bot in Telegram, press Start, then try again.",
    });
  }

  await tgSendMessage(
    cfg.token,
    chatId,
    "✅ <b>Test</b> — Lid bildirishnomalari ishlayapti!\nYangi lidlar shu chatga keladi. 🚀",
  );
  return ok({ sent: true, chatId });
});
