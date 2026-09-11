import { describe, expect, it } from "vitest";
import { escapeHtml, formatLeadMessage, pickChatIdFromUpdates } from "@/lib/telegram";

describe("telegram lead notifications", () => {
  it("escapes HTML so customer answers cannot break the message markup", () => {
    expect(escapeHtml("<b>hi & bye</b>")).toBe("&lt;b&gt;hi &amp; bye&lt;/b&gt;");
  });

  it("formats a complete lead card in Uzbek with all fields", () => {
    const msg = formatLeadMessage({
      accountUsername: "sherzod_usmanovv",
      leadName: "Aziz <script>",
      phone: "+998901234567",
      email: "aziz@mail.com",
      source: "landing_page",
      campaignName: null,
      contentCaption: null,
      answers: [
        { question: "Ismingiz nima?", answer: "Aziz" },
        { question: "Qaysi xizmat?", answer: "Konsultatsiya & narx" },
      ],
      submittedAt: "2026-09-11T10:00:00.000Z",
    });
    expect(msg).toContain("Yangi lid!");
    expect(msg).toContain("Aziz &lt;script&gt;");
    expect(msg).toContain("+998901234567");
    expect(msg).toContain("Tugma sahifasi");
    expect(msg).toContain("@sherzod_usmanovv");
    expect(msg).toContain("Konsultatsiya &amp; narx");
    // Tashkent time (UTC+5): 10:00Z → 15:00
    expect(msg).toContain("15:00");
  });

  it("omits empty fields instead of printing dashes", () => {
    const msg = formatLeadMessage({
      accountUsername: "acc",
      leadName: null,
      phone: null,
      email: null,
      source: "instagram_dm",
      campaignName: null,
      contentCaption: null,
      answers: [],
      submittedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(msg).not.toContain("Ism:");
    expect(msg).not.toContain("Telefon:");
    expect(msg).not.toContain("Javoblar:");
    expect(msg).toContain("Instagram DM");
  });

  it("picks the most recent chat id from getUpdates", () => {
    expect(
      pickChatIdFromUpdates([
        { update_id: 1, message: { chat: { id: 111, type: "private" } } },
        { update_id: 2, message: { chat: { id: 222, type: "private" } } },
      ]),
    ).toBe("222");
    expect(pickChatIdFromUpdates([{ update_id: 3 }])).toBeNull();
    expect(pickChatIdFromUpdates([])).toBeNull();
    // my_chat_member (bot added/blocked events) also carries the chat
    expect(pickChatIdFromUpdates([{ update_id: 4, my_chat_member: { chat: { id: 333, type: "private" } } }])).toBe("333");
  });
});
