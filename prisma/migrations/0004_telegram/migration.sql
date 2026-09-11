-- Telegram lead notifications (primary CRM receiver)
ALTER TABLE "GlobalSettings" ADD COLUMN "telegramBotToken" TEXT;
ALTER TABLE "GlobalSettings" ADD COLUMN "telegramChatId" TEXT;
ALTER TABLE "GlobalSettings" ADD COLUMN "telegramEnabled" BOOLEAN NOT NULL DEFAULT true;
