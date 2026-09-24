import { describe, expect, it } from "vitest";
import type { LeadFlowQuestion, Prisma } from "@prisma/client";
import {
  applyLeadCrmPatch,
  isQualificationLevel,
  leadCrmChanges,
  normalizeLeadTags,
  parseLeadPage,
  DEFAULT_LEADS_PAGE_SIZE,
  MAX_LEADS_PAGE_SIZE,
  MAX_LEAD_TAGS,
  MAX_LEAD_VALUE_CENTS,
  type LeadCrmFields,
} from "@/lib/leads";
import { normalizeLeadAnswers } from "@/lib/telegram";
import {
  ARCHIVED_QUESTION_ORDER,
  syncFlowQuestions,
  validateAnswer,
  type FlowQuestionInput,
} from "@/lib/leadflow/engine";
import { compileAnswerPattern, testAnswerPattern, validationRegexIssue, MAX_VALIDATED_ANSWER_LENGTH } from "@/lib/validation/leadbutton";

describe("isQualificationLevel", () => {
  it("accepts exactly the three AI qualification scores", () => {
    expect(isQualificationLevel("LOW")).toBe(true);
    expect(isQualificationLevel("MEDIUM")).toBe(true);
    expect(isQualificationLevel("HIGH")).toBe(true);
  });
  it("rejects anything else, including lowercase and unrelated values", () => {
    expect(isQualificationLevel("low")).toBe(false);
    expect(isQualificationLevel("URGENT")).toBe(false);
    expect(isQualificationLevel(null)).toBe(false);
    expect(isQualificationLevel(undefined)).toBe(false);
    expect(isQualificationLevel(1)).toBe(false);
  });
});

describe("lead answer shapes", () => {
  it("reads the flow/landing shape (a plain array)", () => {
    expect(normalizeLeadAnswers([{ question: "Ism?", answer: "Aziz" }])).toEqual([{ question: "Ism?", answer: "Aziz" }]);
  });

  it("reads the lead-ad shape so Instant Form answers are not dropped from notifications", () => {
    const stored = { leadgenId: "123", items: [{ question: "full_name", answer: "Aziz" }, { question: "phone_number", answer: "+998901234567" }] };
    expect(normalizeLeadAnswers(stored)).toEqual([
      { question: "full_name", answer: "Aziz" },
      { question: "phone_number", answer: "+998901234567" },
    ]);
  });

  it("returns an empty list for anything else and skips unusable entries", () => {
    expect(normalizeLeadAnswers(null)).toEqual([]);
    expect(normalizeLeadAnswers({ leadgenId: "123" })).toEqual([]);
    expect(normalizeLeadAnswers("nonsense")).toEqual([]);
    expect(normalizeLeadAnswers([null, { answer: "orphan" }, { question: "  " }, { question: "Ok", answer: 7 }])).toEqual([
      { question: "Ok", answer: "7" },
    ]);
  });
});

describe("admin answer patterns", () => {
  it("accepts the patterns an admin realistically writes", () => {
    for (const pattern of ["^[A-Z]{3}-\\d+$", "\\d{4}", "^(\\+998|998)?\\d{9}$", "(\\d{1,3}\\.){3}\\d{1,3}", "[a-z]+@[a-z]+\\.[a-z]{2,}"]) {
      expect(validationRegexIssue(pattern), pattern).toBeNull();
    }
  });

  it("refuses catastrophic backtracking before it can ever run on public input", () => {
    for (const pattern of ["(a+)+$", "([a-zA-Z]+)*$", "(\\w+\\s?)*$", "(a|a)+$", "(a?)+$"]) {
      expect(validationRegexIssue(pattern), pattern).toMatch(/repeats a group/);
    }
  });

  it("refuses patterns that are invalid, oversized or repeat absurdly", () => {
    expect(validationRegexIssue("([")).toBe("is not a valid regular expression");
    expect(validationRegexIssue("a".repeat(201))).toMatch(/longer than/);
    expect(validationRegexIssue("^\\d{1,50000}$")).toMatch(/more than 1000 times/);
  });

  it("anchors the pattern so it must describe the whole answer", () => {
    expect(testAnswerPattern("[A-Z]{3}-\\d+", "ABC-123")).toBe(true);
    expect(testAnswerPattern("[A-Z]{3}-\\d+", "junk ABC-123 junk")).toBe(false);
    // an already-anchored pattern keeps working
    expect(compileAnswerPattern("^[A-Z]{3}$")!.test("ABC")).toBe(true);
  });

  it("bounds the input a pattern ever sees", () => {
    expect(testAnswerPattern("[a-z]*", "a".repeat(MAX_VALIDATED_ANSWER_LENGTH))).toBe(true);
    expect(testAnswerPattern("[a-z]*", "a".repeat(MAX_VALIDATED_ANSWER_LENGTH + 1))).toBe(false);
  });

  it("reports an unusable pattern as null rather than blocking the customer", () => {
    expect(testAnswerPattern("([", "anything")).toBeNull();
    expect(testAnswerPattern("(a+)+$", "anything")).toBeNull();
  });
});

function question(partial: Partial<LeadFlowQuestion>): LeadFlowQuestion {
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

describe("validateAnswer with admin patterns", () => {
  it("enforces a safe pattern, anchored", () => {
    const q = question({ validationRegex: "[A-Z]{3}-\\d+" });
    expect(validateAnswer(q, "ABC-123").ok).toBe(true);
    expect(validateAnswer(q, "look ABC-123 here").ok).toBe(false);
  });

  it("accepts the answer when the stored pattern is unusable, and returns promptly", () => {
    const q = question({ validationRegex: "(a+)+$" });
    const started = Date.now();
    expect(validateAnswer(q, `${"a".repeat(40)}!`).ok).toBe(true);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

// ---------- question list maintenance ----------

interface FakeQuestionRow {
  id: string;
  flowId: string;
  order: number;
  title: string;
  prompt: string;
  type: string;
  required: boolean;
  options: string[];
  mapTo: string | null;
  validationRegex: string | null;
  answers: number;
}

function row(partial: Partial<FakeQuestionRow> & { id: string; order: number; title: string }): FakeQuestionRow {
  return {
    flowId: "f1",
    prompt: `${partial.title}?`,
    type: "TEXT",
    required: true,
    options: [],
    mapTo: null,
    validationRegex: null,
    answers: 0,
    ...partial,
  };
}

function input(title: string, extra: Partial<FlowQuestionInput> = {}): FlowQuestionInput {
  return { title, prompt: `${title}?`, type: "TEXT", required: true, options: [], mapTo: null, validationRegex: null, ...extra };
}

/** In-memory LeadFlowQuestion table, including the [flowId, order] unique index. */
function fakeTx(rows: FakeQuestionRow[]) {
  const store = rows.map((r) => ({ ...r }));
  const calls = { update: 0, create: 0, deleteMany: 0 };
  let created = 0;

  function assertFreeOrder(flowId: string, order: number, selfId?: string) {
    if (store.some((r) => r.flowId === flowId && r.order === order && r.id !== selfId)) {
      throw new Error(`unique constraint [flowId, order] violated at order ${order}`);
    }
  }

  const client = {
    leadFlowQuestion: {
      findMany: async ({ where }: { where: { flowId: string; order?: { lt?: number } } }) =>
        store
          .filter((r) => r.flowId === where.flowId && (where.order?.lt === undefined || r.order < where.order.lt))
          .sort((a, b) => a.order - b.order)
          .map((r) => ({ ...r, _count: { answers: r.answers } })),
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        calls.update++;
        const found = store.find((r) => r.id === where.id);
        if (!found) throw new Error(`no row ${where.id}`);
        if (typeof data.order === "number") assertFreeOrder(found.flowId, data.order, found.id);
        Object.assign(found, data);
        return found;
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        calls.create++;
        const fresh = row({ id: `new-${++created}`, order: data.order as number, title: data.title as string, ...data });
        assertFreeOrder(fresh.flowId, fresh.order);
        store.push(fresh);
        return fresh;
      },
      deleteMany: async ({ where }: { where: { id: { in: string[] } } }) => {
        calls.deleteMany++;
        const ids = new Set(where.id.in);
        for (let i = store.length - 1; i >= 0; i--) if (ids.has(store[i]!.id)) store.splice(i, 1);
        return { count: ids.size };
      },
      aggregate: async ({ where }: { where: { flowId: string; order: { gte: number } } }) => {
        const orders = store.filter((r) => r.flowId === where.flowId && r.order >= where.order.gte).map((r) => r.order);
        return { _max: { order: orders.length ? Math.max(...orders) : null } };
      },
    },
  };

  const live = () => store.filter((r) => r.order < ARCHIVED_QUESTION_ORDER).sort((a, b) => a.order - b.order);
  const archived = () => store.filter((r) => r.order >= ARCHIVED_QUESTION_ORDER).sort((a, b) => a.order - b.order);
  return { tx: client as unknown as Prisma.TransactionClient, store, live, archived, calls };
}

describe("syncFlowQuestions", () => {
  it("does nothing when the list is unchanged", async () => {
    const db = fakeTx([row({ id: "a", order: 1, title: "Name" }), row({ id: "b", order: 2, title: "Phone" })]);
    const result = await syncFlowQuestions(db.tx, "f1", [input("Name"), input("Phone")]);
    expect(result).toEqual({ changed: false, archived: 0, deleted: 0 });
    expect(db.live().map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("reorders by reusing the same rows, so answers stay attached", async () => {
    const db = fakeTx([row({ id: "a", order: 1, title: "Name", answers: 3 }), row({ id: "b", order: 2, title: "Phone", answers: 3 })]);
    const result = await syncFlowQuestions(db.tx, "f1", [input("Phone"), input("Name")]);
    expect(result.changed).toBe(true);
    expect(result.deleted).toBe(0);
    expect(result.archived).toBe(0);
    expect(db.live().map((r) => r.id)).toEqual(["b", "a"]);
  });

  it("keeps the answers of a removed question by archiving it instead of deleting it", async () => {
    const db = fakeTx([row({ id: "a", order: 1, title: "Name" }), row({ id: "b", order: 2, title: "Budget", answers: 2 })]);
    const result = await syncFlowQuestions(db.tx, "f1", [input("Name")]);
    expect(result).toEqual({ changed: true, archived: 1, deleted: 0 });
    expect(db.live().map((r) => r.id)).toEqual(["a"]);
    const archived = db.archived();
    expect(archived.map((r) => r.id)).toEqual(["b"]);
    expect(archived[0]!.order).toBeGreaterThanOrEqual(ARCHIVED_QUESTION_ORDER);
  });

  it("deletes a removed question that nobody ever answered", async () => {
    const db = fakeTx([row({ id: "a", order: 1, title: "Name" }), row({ id: "b", order: 2, title: "Budget" })]);
    const result = await syncFlowQuestions(db.tx, "f1", [input("Name")]);
    expect(result).toEqual({ changed: true, archived: 0, deleted: 1 });
    expect(db.store.map((r) => r.id)).toEqual(["a"]);
  });

  it("archives the old wording when an answered question is rewritten", async () => {
    const db = fakeTx([row({ id: "a", order: 1, title: "Budget", answers: 5 })]);
    const result = await syncFlowQuestions(db.tx, "f1", [input("Budget", { prompt: "What is your budget?" })]);
    expect(result).toEqual({ changed: true, archived: 1, deleted: 0 });
    expect(db.archived().map((r) => r.prompt)).toEqual(["Budget?"]);
    expect(db.live()).toHaveLength(1);
    expect(db.live()[0]!.prompt).toBe("What is your budget?");
    expect(db.live()[0]!.id).not.toBe("a"); // the history row keeps its own identity
  });

  it("rewrites an unanswered question in place rather than churning rows", async () => {
    const db = fakeTx([row({ id: "a", order: 1, title: "Budget" })]);
    await syncFlowQuestions(db.tx, "f1", [input("Budget", { prompt: "What is your budget?" })]);
    expect(db.store).toHaveLength(1);
    expect(db.store[0]!.id).toBe("a");
    expect(db.store[0]!.prompt).toBe("What is your budget?");
  });

  it("stacks archived rows without colliding with earlier ones", async () => {
    const db = fakeTx([
      row({ id: "old", order: ARCHIVED_QUESTION_ORDER, title: "Gone", answers: 1 }),
      row({ id: "a", order: 1, title: "Budget", answers: 1 }),
    ]);
    await syncFlowQuestions(db.tx, "f1", [input("Name")]);
    expect(db.archived().map((r) => r.id)).toEqual(["old", "a"]);
    expect(db.archived()[1]!.order).toBe(ARCHIVED_QUESTION_ORDER + 1);
    expect(db.live().map((r) => r.title)).toEqual(["Name"]);
  });

  it("writes only the row a save actually changed", async () => {
    const db = fakeTx([
      row({ id: "a", order: 1, title: "Name" }),
      row({ id: "b", order: 2, title: "Phone" }),
      row({ id: "c", order: 3, title: "City" }),
    ]);
    await syncFlowQuestions(db.tx, "f1", [input("Name"), input("Phone"), input("City", { prompt: "Which city?" })]);
    expect(db.calls).toMatchObject({ update: 1, create: 0, deleteMany: 0 });
    expect(db.live().map((r) => r.prompt)).toEqual(["Name?", "Phone?", "Which city?"]);
  });

  it("inserts a question in front of an answered one without colliding on [flowId, order]", async () => {
    const db = fakeTx([row({ id: "a", order: 1, title: "Name", answers: 4 })]);
    const result = await syncFlowQuestions(db.tx, "f1", [input("Email"), input("Name")]);
    expect(result).toMatchObject({ changed: true, archived: 0, deleted: 0 });
    expect(db.live().map((r) => r.title)).toEqual(["Email", "Name"]);
    expect(db.live()[1]!.id).toBe("a"); // the answered row moved, it was not re-created
  });

  it("swaps two answered rows whose wording also changed", async () => {
    const db = fakeTx([
      row({ id: "a", order: 1, title: "Name", answers: 1 }),
      row({ id: "b", order: 2, title: "Phone", answers: 1 }),
    ]);
    await syncFlowQuestions(db.tx, "f1", [input("Phone", { prompt: "Your phone?" }), input("Name")]);
    expect(db.live().map((r) => r.title)).toEqual(["Phone", "Name"]);
    expect(db.live()[1]!.id).toBe("a");
    expect(db.archived().map((r) => r.id)).toEqual(["b"]); // the old wording keeps its answers
  });

  it("creates the first question list for a brand-new flow", async () => {
    const db = fakeTx([]);
    const result = await syncFlowQuestions(db.tx, "f1", [input("Name"), input("Phone")]);
    expect(result.changed).toBe(true);
    expect(db.live().map((r) => r.title)).toEqual(["Name", "Phone"]);
  });
});

// ---------- CRM board ----------

describe("lead paging", () => {
  it("defaults to the full board page", () => {
    expect(parseLeadPage(null, null)).toEqual({ limit: DEFAULT_LEADS_PAGE_SIZE, offset: 0 });
    expect(parseLeadPage("abc", "-4")).toEqual({ limit: DEFAULT_LEADS_PAGE_SIZE, offset: 0 });
  });

  it("clamps the page size and accepts an offset", () => {
    expect(parseLeadPage("50", "100")).toEqual({ limit: 50, offset: 100 });
    expect(parseLeadPage("0", null).limit).toBe(1);
    expect(parseLeadPage("100000", null).limit).toBe(MAX_LEADS_PAGE_SIZE);
  });
});

describe("lead tags", () => {
  it("trims, drops blanks and de-duplicates case-insensitively", () => {
    expect(normalizeLeadTags([" VIP ", "vip", "", "   ", "Qayta  aloqa"])).toEqual(["VIP", "Qayta aloqa"]);
  });

  it("caps the number of tags", () => {
    expect(normalizeLeadTags(Array.from({ length: 40 }, (_, i) => `t${i}`))).toHaveLength(MAX_LEAD_TAGS);
  });
});

const emptyCrm: LeadCrmFields = { tags: [], followUpAt: null, valueCents: null, valueCurrency: null, outcomeReason: null };

describe("lead CRM patch rules", () => {
  it("refuses a deal value with no currency", () => {
    const res = applyLeadCrmPatch(emptyCrm, { valueCents: 5_000_00 }, "QUALIFIED");
    expect(res.ok).toBe(false);
  });

  it("keeps the stored currency when only the amount changes", () => {
    const current = { ...emptyCrm, valueCents: 100, valueCurrency: "UZS" };
    const res = applyLeadCrmPatch(current, { valueCents: 200 }, "WON");
    expect(res.ok && res.fields.valueCurrency).toBe("UZS");
  });

  it("clears the currency when the value is cleared", () => {
    const current = { ...emptyCrm, valueCents: 100, valueCurrency: "UZS" };
    const res = applyLeadCrmPatch(current, { valueCents: null }, "LOST");
    expect(res.ok && res.fields).toMatchObject({ valueCents: null, valueCurrency: null });
  });

  it("only allows an outcome reason on a won or lost lead", () => {
    expect(applyLeadCrmPatch(emptyCrm, { outcomeReason: "Narx qimmat" }, "NEW").ok).toBe(false);
    expect(applyLeadCrmPatch(emptyCrm, { outcomeReason: "Narx qimmat" }, "LOST").ok).toBe(true);
  });

  it("still lets a lost lead be reopened while its reason stays on file", () => {
    const lost: LeadCrmFields = { ...emptyCrm, outcomeReason: "Narx qimmat" };
    const res = applyLeadCrmPatch(lost, {}, "IN_PROGRESS");
    expect(res.ok && res.fields.outcomeReason).toBe("Narx qimmat");
  });

  it("does not block an unrelated edit on a lead whose stored value has no currency", () => {
    const legacy: LeadCrmFields = { ...emptyCrm, valueCents: 100, valueCurrency: null };
    expect(applyLeadCrmPatch(legacy, { tags: ["VIP"] }, "NEW").ok).toBe(true);
  });

  it("refuses an amount the integer column cannot hold instead of letting Postgres 500", () => {
    expect(MAX_LEAD_VALUE_CENTS).toBe(2 ** 31 - 1);
    const res = applyLeadCrmPatch(emptyCrm, { valueCents: MAX_LEAD_VALUE_CENTS + 1, valueCurrency: "UZS" }, "WON");
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/too large/);
    expect(applyLeadCrmPatch(emptyCrm, { valueCents: MAX_LEAD_VALUE_CENTS, valueCurrency: "UZS" }, "WON").ok).toBe(true);
  });

  it("normalizes tags on the way in", () => {
    const res = applyLeadCrmPatch(emptyCrm, { tags: ["VIP", "vip", " "] }, "NEW");
    expect(res.ok && res.fields.tags).toEqual(["VIP"]);
  });
});

describe("lead CRM change log", () => {
  it("writes nothing when nothing moved", () => {
    expect(leadCrmChanges(emptyCrm, { ...emptyCrm })).toEqual({ data: {}, events: [] });
  });

  it("records added and removed tags", () => {
    const after = { ...emptyCrm, tags: ["VIP", "Sotuv"] };
    const { data, events } = leadCrmChanges({ ...emptyCrm, tags: ["Sotuv", "Eski"] }, after);
    expect(data.tags).toEqual(["VIP", "Sotuv"]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "TAGS_CHANGED", data: { added: ["VIP"], removed: ["Eski"] } });
  });

  it("records a follow-up date as ISO strings", () => {
    const followUpAt = new Date("2026-10-01T09:00:00.000Z");
    const { data, events } = leadCrmChanges(emptyCrm, { ...emptyCrm, followUpAt });
    expect(data.followUpAt).toBe(followUpAt);
    expect(events[0]).toMatchObject({ type: "FOLLOW_UP_CHANGED", data: { from: null, to: "2026-10-01T09:00:00.000Z" } });
  });

  it("records value and outcome separately", () => {
    const { data, events } = leadCrmChanges(emptyCrm, {
      ...emptyCrm,
      valueCents: 1_500_000,
      valueCurrency: "UZS",
      outcomeReason: "Shartnoma imzolandi",
    });
    expect(data).toMatchObject({ valueCents: 1_500_000, valueCurrency: "UZS", outcomeReason: "Shartnoma imzolandi" });
    expect(events.map((e) => e.type)).toEqual(["VALUE_CHANGED", "OUTCOME_CHANGED"]);
    expect(events[0]!.data).toMatchObject({ from: null, to: { cents: 1_500_000, currency: "UZS" } });
  });

  it("treats an unchanged follow-up date as unchanged even across Date instances", () => {
    const at = new Date("2026-10-01T09:00:00.000Z");
    expect(leadCrmChanges({ ...emptyCrm, followUpAt: at }, { ...emptyCrm, followUpAt: new Date(at) }).events).toEqual([]);
  });
});
