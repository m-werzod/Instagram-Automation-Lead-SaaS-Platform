import { prisma } from "@/lib/prisma";
import { encryptSecret, decryptSecret } from "@/lib/crypto";
import { getGlobalSettings } from "@/lib/settings";
import { createLogger, errorFields } from "@/lib/logger";

const log = createLogger("telegram");

/**
 * Telegram lead notifications — the PRIMARY CRM receiver.
 * Every submitted lead is formatted and pushed to the configured bot chat.
 *
 * Config precedence: GlobalSettings (token encrypted at rest) → env fallback
 * (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID). The chat id is auto-detected from
 * getUpdates the first time it is needed (the owner just presses “Start” on
 * the bot once) and persisted, so no manual id copying is ever required.
 */

export interface TelegramConfig {
  token: string;
  chatId: string | null;
  enabled: boolean;
  source: "db" | "env";
}

export async function telegramConfig(): Promise<TelegramConfig | null> {
  const settings = await getGlobalSettings();
  if (settings.telegramBotToken) {
    try {
      return {
        token: decryptSecret(settings.telegramBotToken),
        chatId: settings.telegramChatId,
        enabled: settings.telegramEnabled,
        source: "db",
      };
    } catch (err) {
      log.error("stored telegram token cannot be decrypted (wrong TOKEN_ENCRYPTION_KEY?)", errorFields(err));
      return null;
    }
  }
  const envToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (envToken) {
    return {
      token: envToken,
      chatId: settings.telegramChatId ?? process.env.TELEGRAM_CHAT_ID?.trim() ?? null,
      enabled: settings.telegramEnabled,
      source: "env",
    };
  }
  return null;
}

export async function saveTelegramSettings(input: { token?: string | null; chatId?: string | null; enabled?: boolean }): Promise<void> {
  const data: Record<string, unknown> = {};
  if (input.token !== undefined) data.telegramBotToken = input.token ? encryptSecret(input.token) : null;
  if (input.chatId !== undefined) data.telegramChatId = input.chatId || null;
  if (input.enabled !== undefined) data.telegramEnabled = input.enabled;
  await prisma.globalSettings.update({ where: { id: 1 }, data });
}

// ---------- Bot API ----------

interface TgResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

async function tgApi<T>(token: string, method: string, body?: Record<string, unknown>): Promise<T> {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }))) as TgResponse<T>;
  if (!json.ok || json.result === undefined) {
    throw new Error(`Telegram ${method} failed: ${json.description ?? `HTTP ${res.status}`}`);
  }
  return json.result;
}

export async function tgGetMe(token: string): Promise<{ username?: string; first_name?: string }> {
  return tgApi(token, "getMe");
}

interface TgUpdate {
  update_id: number;
  message?: { chat?: { id: number; type: string } };
  my_chat_member?: { chat?: { id: number; type: string } };
}

/** Pick the chat id of the most recent update (pure — unit tested). */
export function pickChatIdFromUpdates(updates: TgUpdate[]): string | null {
  for (let i = updates.length - 1; i >= 0; i--) {
    const chat = updates[i]?.message?.chat ?? updates[i]?.my_chat_member?.chat;
    if (chat?.id) return String(chat.id);
  }
  return null;
}

/** Auto-detect the owner's chat: they pressed “Start” on the bot at least once. */
export async function tgDetectChatId(token: string): Promise<string | null> {
  const updates = await tgApi<TgUpdate[]>(token, "getUpdates", { limit: 50 });
  return pickChatIdFromUpdates(updates);
}

export async function tgSendMessage(token: string, chatId: string, html: string): Promise<void> {
  await tgApi(token, "sendMessage", {
    chat_id: chatId,
    text: html,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  });
}

// ---------- lead message ----------

export function escapeHtml(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export interface LeadMessagePayload {
  accountUsername: string;
  leadName: string | null;
  phone: string | null;
  email: string | null;
  source: string;
  campaignName: string | null;
  contentCaption: string | null;
  answers: Array<{ question: string; answer: string }>;
  submittedAt: string;
}

/**
 * Lead.answers is written in two shapes: the flow and landing-page pipelines
 * store a plain array, while lead ads (leadgen.fetch) wrap it as
 * `{ leadgenId, items: [...] }`. Notification builders receive leads from every
 * source, so they normalize here instead of silently dropping ad answers.
 */
export function normalizeLeadAnswers(value: unknown): Array<{ question: string; answer: string }> {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "object" && value !== null && Array.isArray((value as { items?: unknown }).items)
      ? (value as { items: unknown[] }).items
      : [];

  const answers: Array<{ question: string; answer: string }> = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const { question, answer } = item as { question?: unknown; answer?: unknown };
    if (typeof question !== "string" || !question.trim()) continue;
    answers.push({
      question,
      answer: typeof answer === "string" ? answer : answer === null || answer === undefined ? "" : String(answer),
    });
  }
  return answers;
}

const SOURCE_LABELS: Record<string, string> = {
  instagram_dm: "Instagram DM",
  instagram_comment: "Instagram izoh",
  landing_page: "Tugma sahifasi",
  lead_ad: "Instagram reklama",
  manual: "Qo‘lda qo‘shilgan",
};

/** Uzbek-first lead card for the bot chat (pure — unit tested). */
export function formatLeadMessage(p: LeadMessagePayload): string {
  const lines: string[] = [];
  lines.push("🔥 <b>Yangi lid!</b>");
  lines.push("");
  if (p.leadName) lines.push(`👤 <b>Ism:</b> ${escapeHtml(p.leadName)}`);
  if (p.phone) lines.push(`📞 <b>Telefon:</b> ${escapeHtml(p.phone)}`);
  if (p.email) lines.push(`✉️ <b>Email:</b> ${escapeHtml(p.email)}`);
  lines.push(`📲 <b>Manba:</b> ${escapeHtml(SOURCE_LABELS[p.source] ?? p.source)} (@${escapeHtml(p.accountUsername)})`);
  if (p.campaignName) lines.push(`📣 <b>Reklama:</b> ${escapeHtml(p.campaignName)}`);
  if (p.contentCaption) lines.push(`🎬 <b>Post:</b> ${escapeHtml(p.contentCaption)}`);
  if (p.answers.length) {
    lines.push("");
    lines.push("💬 <b>Javoblar:</b>");
    for (const a of p.answers) {
      lines.push(`▫️ <i>${escapeHtml(a.question)}</i>`);
      lines.push(`    ${escapeHtml(a.answer)}`);
    }
  }
  lines.push("");
  const dt = new Date(p.submittedAt);
  lines.push(`🕒 ${dt.toLocaleString("uz-Latn-UZ", { timeZone: "Asia/Tashkent", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" })}`);
  return lines.join("\n");
}

// ---------- delivery (called from the telegram.send queue job) ----------

/**
 * Send one lead to the bot. Auto-detects and persists the chat id when it is
 * missing. Records a LeadEvent either way so delivery is auditable in the CRM.
 * Throws on failure so the queue retries with backoff.
 */
export async function deliverLeadToTelegram(leadId: string): Promise<void> {
  const cfg = await telegramConfig();
  if (!cfg || !cfg.enabled) {
    log.info("telegram not configured/disabled — skipping", { leadId });
    return;
  }

  let chatId = cfg.chatId;
  if (!chatId) {
    chatId = await tgDetectChatId(cfg.token);
    if (chatId) {
      await saveTelegramSettings({ chatId });
      log.info("telegram chat id auto-detected", { chatId });
    } else {
      throw new Error("Telegram chat not detected yet — open the bot and press Start, then retry.");
    }
  }

  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    include: { account: { select: { username: true } }, campaign: { select: { name: true } }, content: { select: { caption: true } } },
  });
  if (!lead) return;

  const message = formatLeadMessage({
    accountUsername: lead.account.username,
    leadName: lead.name,
    phone: lead.phone,
    email: lead.email,
    source: lead.source,
    campaignName: lead.campaign?.name ?? null,
    contentCaption: lead.content?.caption?.slice(0, 120) ?? null,
    answers: normalizeLeadAnswers(lead.answers),
    submittedAt: lead.createdAt.toISOString(),
  });

  try {
    await tgSendMessage(cfg.token, chatId, message);
    await prisma.leadEvent.create({ data: { leadId, type: "TELEGRAM_SENT", data: { chatId } } }).catch(() => undefined);
    log.info("lead delivered to telegram", { leadId, chatId });
  } catch (err) {
    await prisma.leadEvent
      .create({ data: { leadId, type: "TELEGRAM_FAILED", data: { error: String(err) } } })
      .catch(() => undefined);
    throw err;
  }
}
