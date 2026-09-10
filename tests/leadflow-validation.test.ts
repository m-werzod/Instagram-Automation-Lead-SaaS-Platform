import { describe, expect, it } from "vitest";
import type { LeadFlowQuestion } from "@prisma/client";
import { numberedOptions, renderQuestion, validateAnswer, OPTION_PAYLOAD_PREFIX } from "@/lib/leadflow/engine";

function q(partial: Partial<LeadFlowQuestion>): LeadFlowQuestion {
  return {
    id: "q1",
    flowId: "f1",
    order: 1,
    title: "T",
    prompt: "P?",
    type: "TEXT",
    required: true,
    options: [],
    mapTo: null,
    validationRegex: null,
    ...partial,
  } as LeadFlowQuestion;
}

describe("lead flow answer validation", () => {
  it("TEXT accepts non-empty and trims", () => {
    expect(validateAnswer(q({}), "  John Doe  ")).toEqual({ ok: true, value: "John Doe" });
  });

  it("required TEXT rejects empty", () => {
    const res = validateAnswer(q({}), "   ");
    expect(res.ok).toBe(false);
  });

  it("optional question accepts empty", () => {
    expect(validateAnswer(q({ required: false }), "").ok).toBe(true);
  });

  it("PHONE normalizes and validates", () => {
    expect(validateAnswer(q({ type: "PHONE" }), "+998 90 123-45-67")).toEqual({ ok: true, value: "+998901234567" });
    expect(validateAnswer(q({ type: "PHONE" }), "abc").ok).toBe(false);
    expect(validateAnswer(q({ type: "PHONE" }), "123").ok).toBe(false);
  });

  it("EMAIL validates and lowercases", () => {
    expect(validateAnswer(q({ type: "EMAIL" }), "USER@Example.COM")).toEqual({ ok: true, value: "user@example.com" });
    expect(validateAnswer(q({ type: "EMAIL" }), "nope").ok).toBe(false);
  });

  it("NUMBER parses comma decimals", () => {
    expect(validateAnswer(q({ type: "NUMBER" }), "3,5")).toEqual({ ok: true, value: "3.5" });
    expect(validateAnswer(q({ type: "NUMBER" }), "abc").ok).toBe(false);
  });

  it("DATE accepts ISO and European formats", () => {
    expect(validateAnswer(q({ type: "DATE" }), "2026-09-15")).toEqual({ ok: true, value: "2026-09-15" });
    expect(validateAnswer(q({ type: "DATE" }), "15.09.2026")).toEqual({ ok: true, value: "2026-09-15" });
    expect(validateAnswer(q({ type: "DATE" }), "2026-13-40").ok).toBe(false);
  });

  it("TIME normalizes", () => {
    expect(validateAnswer(q({ type: "TIME" }), "9:30")).toEqual({ ok: true, value: "09:30" });
    expect(validateAnswer(q({ type: "TIME" }), "25:00").ok).toBe(false);
  });

  it("BOOLEAN understands multilingual yes/no", () => {
    expect(validateAnswer(q({ type: "BOOLEAN" }), "ha")).toEqual({ ok: true, value: "Yes" });
    expect(validateAnswer(q({ type: "BOOLEAN" }), "yo'q")).toEqual({ ok: true, value: "No" });
    expect(validateAnswer(q({ type: "BOOLEAN" }), "maybe").ok).toBe(false);
  });

  const select = q({ type: "SINGLE_SELECT", options: ["B toifa", "BC toifa", "A toifa"] });

  it("SINGLE_SELECT accepts numeric choice", () => {
    expect(validateAnswer(select, "2")).toEqual({ ok: true, value: "BC toifa" });
  });

  it("SINGLE_SELECT accepts exact and unique-prefix text", () => {
    expect(validateAnswer(select, "b toifa")).toEqual({ ok: true, value: "B toifa" });
    expect(validateAnswer(select, "bc")).toEqual({ ok: true, value: "BC toifa" });
  });

  it("SINGLE_SELECT accepts quick-reply payloads", () => {
    expect(validateAnswer(select, "whatever", `${OPTION_PAYLOAD_PREFIX}2`)).toEqual({ ok: true, value: "A toifa" });
  });

  it("SINGLE_SELECT rejects out-of-range and ambiguous input", () => {
    expect(validateAnswer(select, "7").ok).toBe(false);
    expect(validateAnswer(select, "toifa").ok).toBe(false);
  });

  it("MULTI_SELECT accepts comma-separated numbers", () => {
    const multi = q({ type: "MULTI_SELECT", options: ["A", "B", "C"] });
    expect(validateAnswer(multi, "1, 3")).toEqual({ ok: true, value: "A, C" });
  });

  it("TEXT honors admin validationRegex", () => {
    const regexQ = q({ validationRegex: "^[A-Z]{3}-\\d+$" });
    expect(validateAnswer(regexQ, "ABC-123").ok).toBe(true);
    expect(validateAnswer(regexQ, "nope").ok).toBe(false);
  });
});

describe("question rendering", () => {
  it("uses quick replies for small selects", () => {
    const rendered = renderQuestion(q({ type: "SINGLE_SELECT", options: ["One", "Two"] }));
    expect(rendered.quickReplies).toHaveLength(2);
    expect(rendered.quickReplies![0]).toEqual({ title: "One", payload: `${OPTION_PAYLOAD_PREFIX}0` });
  });

  it("falls back to numbered list when options exceed quick-reply limits", () => {
    const many = Array.from({ length: 14 }, (_, i) => `Option ${i + 1}`);
    const rendered = renderQuestion(q({ type: "SINGLE_SELECT", options: many }));
    expect(rendered.quickReplies).toBeUndefined();
    expect(rendered.text).toContain("14. Option 14");
  });

  it("falls back when any option title exceeds 20 chars", () => {
    const rendered = renderQuestion(q({ type: "SINGLE_SELECT", options: ["Short", "This option title is way too long"] }));
    expect(rendered.quickReplies).toBeUndefined();
  });

  it("BOOLEAN renders Yes/No quick replies", () => {
    const rendered = renderQuestion(q({ type: "BOOLEAN" }));
    expect(rendered.quickReplies?.map((r) => r.title)).toEqual(["Yes", "No"]);
  });

  it("numberedOptions formats correctly", () => {
    expect(numberedOptions(["A", "B"])).toBe("1. A\n2. B");
  });
});
