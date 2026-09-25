import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InstagramAccount, Lead, LeadFlowQuestion } from "@prisma/client";

/**
 * QA sweep — CRM / Leads / Lead Button.
 *
 * Everything here runs real product code. Prisma is replaced by an in-memory
 * stand-in (same pattern as tests/video-render.test.ts), `fetch` is stubbed and
 * nodemailer's transport is a spy, so lead delivery, CRM edits and the public
 * answer-pattern screen are exercised end to end without a database.
 */

type Row = Record<string, unknown>;

const { store, prismaMock, enqueueMock, sendMailMock, transportConfigs } = vi.hoisted(() => {
  const store = {
    leads: [] as Row[],
    leadEvents: [] as Row[],
    conversations: [] as Row[],
    emailEvents: [] as Row[],
    globalSettings: [] as Row[],
    campaigns: [] as Row[],
    contentItems: [] as Row[],
    accounts: [] as Row[],
    seq: 0,
    reset() {
      store.leads = [];
      store.leadEvents = [];
      store.conversations = [];
      store.emailEvents = [];
      store.globalSettings = [];
      store.campaigns = [];
      store.contentItems = [];
      store.accounts = [];
      store.seq = 0;
    },
  };

  /** Reads a value at a JSON path, the way Prisma's `{ path, equals }` filter does. */
  const atPath = (value: unknown, path: string[]): unknown =>
    path.reduce<unknown>((acc, key) => (acc && typeof acc === "object" ? (acc as Row)[key] : undefined), value);

  const matches = (row: Row, where: Row = {}): boolean =>
    Object.entries(where).every(([key, cond]) => {
      const value = row[key];
      if (cond !== null && typeof cond === "object" && !(cond instanceof Date)) {
        const c = cond as Record<string, unknown>;
        if ("path" in c && "equals" in c) return atPath(value, c.path as string[]) === c.equals;
        if ("in" in c) return (c.in as unknown[]).includes(value);
        if ("not" in c) return value !== c.not;
        if ("lte" in c) return value != null && (value as Date) <= (c.lte as Date);
        return false;
      }
      return value === cond;
    });

  /** Applies Prisma write semantics we actually use: plain sets and `{ increment }`. */
  const applyData = (row: Row, data: Row) => {
    for (const [key, value] of Object.entries(data)) {
      if (value !== null && typeof value === "object" && !(value instanceof Date) && "increment" in (value as Row)) {
        row[key] = ((row[key] as number) ?? 0) + ((value as Row).increment as number);
      } else if (value !== undefined) {
        row[key] = value;
      }
    }
  };

  const table = (rows: () => Row[], prefix: string, defaults: () => Row = () => ({})) => ({
    create: async ({ data }: { data: Row }) => {
      const row: Row = { id: `${prefix}${++store.seq}`, createdAt: new Date(), ...defaults(), ...data };
      rows().push(row);
      return { ...row };
    },
    findUnique: async ({ where }: { where: Row }) => {
      const row = rows().find((r) => matches(r, where));
      return row ? { ...row } : null;
    },
    findFirst: async ({ where }: { where?: Row } = {}) => {
      const row = rows().find((r) => matches(r, where));
      return row ? { ...row } : null;
    },
    findMany: async ({ where, take }: { where?: Row; take?: number } = {}) =>
      rows()
        .filter((r) => matches(r, where))
        .slice(0, take ?? rows().length)
        .map((r) => ({ ...r })),
    update: async ({ where, data }: { where: Row; data: Row }) => {
      const row = rows().find((r) => matches(r, where));
      if (!row) throw new Error("record not found");
      applyData(row, data);
      return { ...row };
    },
    upsert: async ({ where, create, update }: { where: Row; create: Row; update: Row }) => {
      const row = rows().find((r) => matches(r, where));
      if (row) {
        applyData(row, update);
        return { ...row };
      }
      const created: Row = { ...defaults(), ...where, ...create };
      rows().push(created);
      return { ...created };
    },
    count: async ({ where }: { where?: Row } = {}) => rows().filter((r) => matches(r, where)).length,
  });

  const leadTable = table(() => store.leads, "lead", () => ({
    name: null,
    phone: null,
    email: null,
    notes: null,
    answers: [],
    source: "manual",
    status: "NEW",
    tags: [],
    followUpAt: null,
    valueCents: null,
    valueCurrency: null,
    outcomeReason: null,
    campaignId: null,
    contentId: null,
    conversationId: null,
    lastInteractionAt: null,
  }));

  const prismaMock = {
    lead: {
      ...leadTable,
      /** The real delivery path reads a lead with its account/campaign/content joined. */
      findUnique: async ({ where, include }: { where: Row; include?: Row }) => {
        const row = store.leads.find((r) => matches(r, where));
        if (!row) return null;
        const out: Row = { ...row };
        if (include?.account) out.account = store.accounts.find((a) => a.id === row.accountId) ?? null;
        if (include?.campaign) out.campaign = store.campaigns.find((c) => c.id === row.campaignId) ?? null;
        if (include?.content) out.content = store.contentItems.find((c) => c.id === row.contentId) ?? null;
        return out;
      },
    },
    leadEvent: table(() => store.leadEvents, "ev"),
    conversation: table(() => store.conversations, "conv"),
    emailEvent: table(() => store.emailEvents, "em", () => ({ attempts: 0, sentAt: null, lastError: null, leadId: null })),
    campaign: table(() => store.campaigns, "camp"),
    contentItem: table(() => store.contentItems, "cont"),
    instagramAccount: table(() => store.accounts, "acct"),
    globalSettings: table(() => store.globalSettings, "gs", () => ({
      id: 1,
      telegramBotToken: null,
      telegramChatId: null,
      telegramEnabled: false,
    })),
  };

  return {
    store,
    prismaMock,
    enqueueMock: vi.fn(async () => null),
    sendMailMock: vi.fn(async (_options: Record<string, unknown>) => ({ messageId: "ok" })),
    transportConfigs: [] as Row[],
  };
});

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));
vi.mock("@/lib/queue", () => ({ enqueue: enqueueMock, drainNow: vi.fn(async () => undefined) }));
vi.mock("nodemailer", () => ({
  default: {
    createTransport: (cfg: Row) => {
      transportConfigs.push(cfg);
      return { sendMail: sendMailMock };
    },
  },
}));

import {
  applyLeadCrmPatch,
  isQualificationLevel,
  leadCrmChanges,
  normalizeLeadTags,
  parseLeadPage,
  touchLead,
  touchLeadByConversation,
  DEFAULT_LEADS_PAGE_SIZE,
  MAX_LEADS_PAGE_SIZE,
  MAX_LEAD_TAGS,
  MAX_LEAD_TAG_LENGTH,
  MAX_LEAD_VALUE_CENTS,
  type LeadCrmFields,
} from "@/lib/leads";
import {
  buttonSpecSchema,
  compileAnswerPattern,
  leadButtonSaveSchema,
  parseButtonSpec,
  safeQuestionSchema,
  testAnswerPattern,
  validationRegexIssue,
  DEFAULT_BUTTON_SPEC,
  MAX_VALIDATED_ANSWER_LENGTH,
  MAX_VALIDATION_REGEX_LENGTH,
  type ButtonSpec,
} from "@/lib/validation/leadbutton";
import { questionSchema } from "@/lib/validation/leadflow";
import { leadButtonStyle } from "@/lib/leadbutton-style";
import {
  deliverLeadToTelegram,
  escapeHtml,
  formatLeadMessage,
  normalizeLeadAnswers,
  pickChatIdFromUpdates,
  telegramConfig,
} from "@/lib/telegram";
import {
  deliverEmailEvent,
  notifyLeadSubmitted,
  queueAdminAlert,
  queueLeadNotification,
  renderLeadNotification,
  EMAIL_NOT_CONFIGURED_PREFIX,
} from "@/lib/email";
import { encryptSecret } from "@/lib/crypto";
import { validateAnswer } from "@/lib/leadflow/engine";

// ---------------------------------------------------------------- helpers

const SMTP_VARS = {
  EMAIL_HOST: "smtp.test.local",
  EMAIL_PORT: "587",
  EMAIL_USER: "bot@test.local",
  EMAIL_PASSWORD: "hunter2",
  EMAIL_FROM: "bot@test.local",
};

function configureSmtp() {
  for (const [k, v] of Object.entries(SMTP_VARS)) process.env[k] = v;
}
function unconfigureSmtp() {
  for (const k of Object.keys(SMTP_VARS)) delete process.env[k];
}

function fetchOk(payload: unknown) {
  return { ok: true, status: 200, json: async () => payload } as unknown as Response;
}

beforeEach(() => {
  store.reset();
  enqueueMock.mockClear();
  sendMailMock.mockClear();
  sendMailMock.mockResolvedValue({ messageId: "ok" });
  transportConfigs.length = 0;
  unconfigureSmtp();
  vi.unstubAllGlobals();
});

afterEach(() => {
  unconfigureSmtp();
  vi.unstubAllGlobals();
});

// ============================================================== lead flow question schema

describe("questionSchema (lead-flow question shape)", () => {
  const good = { title: "Full name", prompt: "What is your name?", type: "TEXT" as const };

  it("accepts a minimal question and fills the documented defaults", () => {
    const parsed = questionSchema.parse(good);
    expect(parsed.required).toBe(true);
    expect(parsed.options).toEqual([]);
    expect(parsed.validationRegex).toBeUndefined();
  });

  it("rejects a missing or empty required answer field", () => {
    expect(questionSchema.safeParse({ prompt: "p", type: "TEXT" }).success).toBe(false);
    expect(questionSchema.safeParse({ title: "t", type: "TEXT" }).success).toBe(false);
    expect(questionSchema.safeParse({ ...good, title: "" }).success).toBe(false);
    expect(questionSchema.safeParse({ ...good, prompt: "" }).success).toBe(false);
  });

  it("rejects over-long values at exactly the documented boundary", () => {
    expect(questionSchema.safeParse({ ...good, title: "t".repeat(120) }).success).toBe(true);
    expect(questionSchema.safeParse({ ...good, title: "t".repeat(121) }).success).toBe(false);
    expect(questionSchema.safeParse({ ...good, prompt: "p".repeat(900) }).success).toBe(true);
    expect(questionSchema.safeParse({ ...good, prompt: "p".repeat(901) }).success).toBe(false);
    expect(questionSchema.safeParse({ ...good, validationRegex: "a".repeat(300) }).success).toBe(true);
    expect(questionSchema.safeParse({ ...good, validationRegex: "a".repeat(301) }).success).toBe(false);
  });

  it("rejects wrong types and unknown enum members", () => {
    expect(questionSchema.safeParse({ ...good, type: "SIGNATURE" }).success).toBe(false);
    expect(questionSchema.safeParse({ ...good, type: "text" }).success).toBe(false);
    expect(questionSchema.safeParse({ ...good, title: 42 }).success).toBe(false);
    expect(questionSchema.safeParse({ ...good, required: "yes" }).success).toBe(false);
    expect(questionSchema.safeParse({ ...good, options: "a,b" }).success).toBe(false);
    expect(questionSchema.safeParse({ ...good, mapTo: "company" }).success).toBe(false);
  });

  it("caps the option list at what a quick-reply keyboard can carry", () => {
    const opts = (n: number) => Array.from({ length: n }, (_, i) => `opt${i}`);
    expect(questionSchema.safeParse({ ...good, options: opts(13) }).success).toBe(true);
    expect(questionSchema.safeParse({ ...good, options: opts(14) }).success).toBe(false);
    expect(questionSchema.safeParse({ ...good, options: [""] }).success).toBe(false);
    expect(questionSchema.safeParse({ ...good, options: ["o".repeat(81)] }).success).toBe(false);
  });

  it("safeQuestionSchema adds the answer-pattern screen on top", () => {
    const safe = safeQuestionSchema.safeParse({ ...good, validationRegex: "^[A-Z]{3}-\\d+$" });
    expect(safe.success).toBe(true);
    const unsafe = safeQuestionSchema.safeParse({ ...good, validationRegex: "(a+)+$" });
    expect(unsafe.success).toBe(false);
    expect(unsafe.success === false && unsafe.error.issues[0]?.message).toMatch(/^Answer pattern /);
    expect(unsafe.success === false && unsafe.error.issues[0]?.path).toEqual(["validationRegex"]);
  });
});

// ============================================================== ButtonSpec

describe("ButtonSpec validation", () => {
  const spec = { label: "Start", bg: "#4f46e5", fg: "#ffffff" };

  it("accepts a minimal spec and applies every documented default", () => {
    const parsed = buttonSpecSchema.parse(spec);
    expect(parsed).toEqual({
      label: "Start",
      helper: "",
      bg: "#4f46e5",
      fg: "#ffffff",
      border: null,
      shape: "rounded",
      size: "md",
      style: "filled",
      position: "bottom",
    });
  });

  it("enforces the label length at the boundary", () => {
    expect(buttonSpecSchema.safeParse({ ...spec, label: "x".repeat(30) }).success).toBe(true);
    expect(buttonSpecSchema.safeParse({ ...spec, label: "x".repeat(31) }).success).toBe(false);
    expect(buttonSpecSchema.safeParse({ ...spec, label: "" }).success).toBe(false);
    expect(buttonSpecSchema.safeParse({ ...spec, label: 5 }).success).toBe(false);
  });

  it("enforces the helper length at the boundary", () => {
    expect(buttonSpecSchema.safeParse({ ...spec, helper: "h".repeat(90) }).success).toBe(true);
    expect(buttonSpecSchema.safeParse({ ...spec, helper: "h".repeat(91) }).success).toBe(false);
  });

  it("accepts only #RRGGBB colours, which is what keeps CSS out of the spec", () => {
    for (const ok of ["#000000", "#FFFFFF", "#aB12eF"]) {
      expect(buttonSpecSchema.safeParse({ ...spec, bg: ok }).success, ok).toBe(true);
    }
    for (const bad of ["#fff", "#ffffff ", "red", "rgb(0,0,0)", "#12345g", "#1234567", "url(x)", ""]) {
      expect(buttonSpecSchema.safeParse({ ...spec, bg: bad }).success, bad).toBe(false);
      expect(buttonSpecSchema.safeParse({ ...spec, fg: bad }).success, bad).toBe(false);
      expect(buttonSpecSchema.safeParse({ ...spec, border: bad }).success, bad).toBe(false);
    }
    // border is the only colour allowed to be null (= no border)
    expect(buttonSpecSchema.safeParse({ ...spec, border: null }).success).toBe(true);
    expect(buttonSpecSchema.safeParse({ ...spec, bg: null }).success).toBe(false);
  });

  it("rejects an unknown shape, size, style or position", () => {
    expect(buttonSpecSchema.safeParse({ ...spec, shape: "circle" }).success).toBe(false);
    expect(buttonSpecSchema.safeParse({ ...spec, size: "xl" }).success).toBe(false);
    expect(buttonSpecSchema.safeParse({ ...spec, style: "ghost" }).success).toBe(false);
    expect(buttonSpecSchema.safeParse({ ...spec, position: "top" }).success).toBe(false);
  });

  it("parseButtonSpec never throws — legacy/garbage rows fall back to the default", () => {
    for (const junk of [null, undefined, 0, "", "{}", [], { label: "only" }, { ...spec, bg: "red" }]) {
      expect(parseButtonSpec(junk)).toEqual(DEFAULT_BUTTON_SPEC);
    }
    expect(parseButtonSpec({ ...spec, shape: "pill", size: "lg" })).toMatchObject({ shape: "pill", size: "lg", label: "Start" });
  });

  it("the shipped default spec is itself valid", () => {
    expect(buttonSpecSchema.safeParse(DEFAULT_BUTTON_SPEC).success).toBe(true);
  });
});

// ============================================================== leadButtonStyle

describe("leadButtonStyle — every shape x size combination", () => {
  const base: ButtonSpec = { ...DEFAULT_BUTTON_SPEC, bg: "#112233", fg: "#ffffff" };
  const RADIUS = { pill: "9999px", rounded: "12px", square: "4px" } as const;
  const SIZE = {
    sm: { padding: "8px 16px", fontSize: "13px", minHeight: "36px" },
    md: { padding: "11px 22px", fontSize: "15px", minHeight: "44px" },
    lg: { padding: "14px 28px", fontSize: "17px", minHeight: "52px" },
  } as const;

  it("maps all 9 combinations to the documented radius and metrics", () => {
    const seen = new Set<string>();
    for (const shape of ["pill", "rounded", "square"] as const) {
      for (const size of ["sm", "md", "lg"] as const) {
        const css = leadButtonStyle({ ...base, shape, size });
        expect(css.borderRadius, `${shape}/${size}`).toBe(RADIUS[shape]);
        expect(css.padding, `${shape}/${size}`).toBe(SIZE[size].padding);
        expect(css.fontSize, `${shape}/${size}`).toBe(SIZE[size].fontSize);
        expect(css.minHeight, `${shape}/${size}`).toBe(SIZE[size].minHeight);
        expect(css.width).toBe("100%");
        seen.add(`${shape}/${size}`);
      }
    }
    expect(seen.size).toBe(9);
  });

  it("filled with no border keeps the layout stable with a transparent 2px border", () => {
    const css = leadButtonStyle({ ...base, style: "filled", border: null });
    expect(css.background).toBe("#112233");
    expect(css.color).toBe("#ffffff");
    expect(css.border).toBe("2px solid transparent");
  });

  it("filled with a border draws that border and keeps the fill", () => {
    const css = leadButtonStyle({ ...base, style: "filled", border: "#ff0000" });
    expect(css.background).toBe("#112233");
    expect(css.border).toBe("2px solid #ff0000");
    expect(css.color).toBe("#ffffff");
  });

  it("outline drops the fill and borrows the border colour for text", () => {
    const withBorder = leadButtonStyle({ ...base, style: "outline", border: "#ff0000" });
    expect(withBorder.background).toBe("transparent");
    expect(withBorder.border).toBe("2px solid #ff0000");
    expect(withBorder.color).toBe("#ff0000");

    // no border colour chosen → fall back to bg so the button is never invisible
    const noBorder = leadButtonStyle({ ...base, style: "outline", border: null });
    expect(noBorder.background).toBe("transparent");
    expect(noBorder.border).toBe("2px solid #112233");
    expect(noBorder.color).toBe("#112233");
    expect(noBorder.color).not.toBe(base.fg);
  });

  it("emits no colour value that did not come from the validated spec", () => {
    const css = leadButtonStyle({ ...base, border: "#00ff00", style: "filled" });
    const colours = `${css.background} ${css.color} ${css.border}`;
    for (const token of colours.match(/#[0-9a-fA-F]+/g) ?? []) {
      expect(["#112233", "#ffffff", "#00ff00"]).toContain(token);
    }
  });
});

// ============================================================== full save payload

describe("leadButtonSaveSchema", () => {
  const question = { title: "Name", prompt: "Your name?", type: "TEXT" as const };
  const payload = {
    accountId: "acct1",
    enabled: true,
    headline: "Get started",
    description: null,
    completionMessage: null,
    buttonSpec: { label: "Go", bg: "#000000", fg: "#ffffff" },
    contentId: null,
    ctaType: "SIGN_UP",
    triggerKeywords: ["start"],
    questions: [question],
  };

  it("accepts a complete payload", () => {
    const parsed = leadButtonSaveSchema.safeParse(payload);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.buttonSpec.shape).toBe("rounded");
  });

  it("requires an account, a headline and at least one question", () => {
    expect(leadButtonSaveSchema.safeParse({ ...payload, accountId: "" }).success).toBe(false);
    expect(leadButtonSaveSchema.safeParse({ ...payload, headline: "" }).success).toBe(false);
    expect(leadButtonSaveSchema.safeParse({ ...payload, headline: "h".repeat(121) }).success).toBe(false);
    expect(leadButtonSaveSchema.safeParse({ ...payload, questions: [] }).success).toBe(false);
  });

  it("caps questions, keywords and free text", () => {
    const many = (n: number) => Array.from({ length: n }, () => question);
    expect(leadButtonSaveSchema.safeParse({ ...payload, questions: many(25) }).success).toBe(true);
    expect(leadButtonSaveSchema.safeParse({ ...payload, questions: many(26) }).success).toBe(false);
    expect(leadButtonSaveSchema.safeParse({ ...payload, triggerKeywords: Array(20).fill("k") }).success).toBe(true);
    expect(leadButtonSaveSchema.safeParse({ ...payload, triggerKeywords: Array(21).fill("k") }).success).toBe(false);
    expect(leadButtonSaveSchema.safeParse({ ...payload, triggerKeywords: [""] }).success).toBe(false);
    expect(leadButtonSaveSchema.safeParse({ ...payload, description: "d".repeat(501) }).success).toBe(false);
    expect(leadButtonSaveSchema.safeParse({ ...payload, completionMessage: "c".repeat(901) }).success).toBe(false);
    expect(leadButtonSaveSchema.safeParse({ ...payload, ctaType: "c".repeat(41) }).success).toBe(false);
  });

  it("refuses to store a question whose answer pattern could hang the public page", () => {
    const bad = { ...payload, questions: [{ ...question, validationRegex: "(\\w+\\s?)*$" }] };
    const res = leadButtonSaveSchema.safeParse(bad);
    expect(res.success).toBe(false);
    expect(res.success === false && JSON.stringify(res.error.issues)).toMatch(/Answer pattern/);
  });
});

// ============================================================== answer patterns / ReDoS

describe("admin answer patterns — save-time safety screen", () => {
  const REALISTIC = [
    "^[A-Z]{3}-\\d+$",
    "\\d{4}",
    "^(\\+998|998)?\\d{9}$",
    "(\\d{1,3}\\.){3}\\d{1,3}",
    "[a-z]+@[a-z]+\\.[a-z]{2,}",
    "^[A-Za-z ]{2,60}$",
    "^\\d{9}$",
  ];

  it("keeps accepting the patterns an admin realistically writes", () => {
    for (const p of REALISTIC) expect(validationRegexIssue(p), p).toBeNull();
  });

  it("rejects the classic exponential shapes", () => {
    for (const p of ["(a+)+$", "([a-zA-Z]+)*$", "(\\w+\\s?)*$", "(a|a)+$", "(a?)+$", "(x+x+)+y", "((a)*)*"]) {
      expect(validationRegexIssue(p), p).toMatch(/repeats a group/);
    }
  });

  it("rejects a variable-length group under a BOUNDED repeat — the counted form of the same bomb", () => {
    // `(?:[a-z]+){1,5}` has no unbounded outer quantifier, but on a 512-char
    // answer the engine still has to try C(512,4) splits.
    for (const p of ["(?:[a-z]+){1,5}", "(?:a{1,100}){1,100}", "([0-9]{1,10}){1,10}", "(?:[a-z]*){2}"]) {
      expect(validationRegexIssue(p), p).toMatch(/repeats a group/);
    }
  });

  it("rejects a flat chain of open-ended repeats — polynomial blow-up needs no group at all", () => {
    for (const p of [
      "[a-z]+[a-z]+[a-z]+[a-z]+@",
      "[a-z]*[a-z]*[a-z]*[a-z]*[a-z]*[a-z]*[a-z]*[a-z]*x",
      "\\w{0,50}\\w{0,50}\\w{0,50}\\w{0,50}!",
    ]) {
      expect(validationRegexIssue(p), p).toMatch(/open-ended|repeats/);
    }
  });

  it("rejects patterns that are invalid, unbalanced, oversized or repeat absurdly", () => {
    expect(validationRegexIssue("([")).toBe("is not a valid regular expression");
    expect(validationRegexIssue("a".repeat(MAX_VALIDATION_REGEX_LENGTH + 1))).toMatch(/longer than/);
    expect(validationRegexIssue("^\\d{1,50000}$")).toMatch(/more than 1000 times/);
    expect(validationRegexIssue("a{2000}")).toMatch(/more than 1000 times/);
  });

  it("treats a blank pattern as 'no pattern', not as an error", () => {
    expect(validationRegexIssue("")).toBeNull();
    expect(validationRegexIssue("   ")).toBeNull();
    expect(compileAnswerPattern("  ")).toBeNull();
    expect(testAnswerPattern("", "anything")).toBeNull();
  });

  it("anchors a stored pattern so it must describe the whole answer", () => {
    expect(testAnswerPattern("[A-Z]{3}-\\d+", "ABC-123")).toBe(true);
    expect(testAnswerPattern("[A-Z]{3}-\\d+", "junk ABC-123 junk")).toBe(false);
    expect(testAnswerPattern("[A-Z]{3}-\\d+", "ABC-123\n")).toBe(false);
    // alternation must not escape the anchors: `a|b` becomes `^(?:a|b)$`
    expect(testAnswerPattern("a|b", "b")).toBe(true);
    expect(testAnswerPattern("a|b", "xbx")).toBe(false);
    expect(compileAnswerPattern("^[A-Z]{3}$")!.test("ABC")).toBe(true);
  });

  it("bounds the text a pattern is ever fed", () => {
    expect(testAnswerPattern("[a-z]*", "a".repeat(MAX_VALIDATED_ANSWER_LENGTH))).toBe(true);
    expect(testAnswerPattern("[a-z]*", "a".repeat(MAX_VALIDATED_ANSWER_LENGTH + 1))).toBe(false);
  });

  it("reports an unusable pattern as null so a customer is never blocked by an admin typo", () => {
    expect(testAnswerPattern("([", "anything")).toBeNull();
    expect(testAnswerPattern("(a+)+$", "anything")).toBeNull();
    expect(compileAnswerPattern("(a+)+$")).toBeNull();
  });

  /**
   * The real proof: run the screen's verdict, then actually execute what it
   * allowed against the worst input the public form can deliver.
   */
  it("every pattern the screen accepts completes on a maximal adversarial answer", () => {
    const adversarial = `${"a".repeat(MAX_VALIDATED_ANSWER_LENGTH - 1)}!`;
    const worstAccepted = [...REALISTIC, "[a-z]+[a-z]+[a-z]+@", "[a-z]+.*[a-z]+@", "(?:[a-z]+)?[a-z]+@"].filter(
      (p) => validationRegexIssue(p) === null,
    );
    expect(worstAccepted.length).toBeGreaterThanOrEqual(REALISTIC.length);
    for (const p of worstAccepted) {
      const started = Date.now();
      expect(testAnswerPattern(p, adversarial), p).toBe(false);
      // Measured worst case on this machine: ~0.8 s for a contrived degree-3
      // chain. Before the fix the same list contained patterns that never returned.
      expect(Date.now() - started, `${p} took too long`).toBeLessThan(1200);
    }
  });

  it("reads the pattern's syntax correctly — escapes, classes and group prefixes", () => {
    // metacharacters that are escaped, or live inside a character class, are text
    expect(validationRegexIssue("^\\(\\d{3}\\) \\d{7}$")).toBeNull();
    expect(validationRegexIssue("^[()|*+?]{1,10}$")).toBeNull();
    expect(validationRegexIssue("^[\\]]+$")).toBeNull();
    // non-capturing groups, lookarounds and named groups are all understood
    expect(validationRegexIssue("^(?=.*\\d)[A-Za-z\\d]{8,20}$")).toBeNull();
    expect(validationRegexIssue("^(?<code>[A-Z]{2})-\\d{4}$")).toBeNull();
    expect(validationRegexIssue("^(?:[A-Z]{2})-\\d{4}$")).toBeNull();
    // an unbalanced pattern is refused, whichever check catches it first
    expect(validationRegexIssue("(a")).not.toBeNull();
    expect(validationRegexIssue("a)b")).not.toBeNull();
  });

  it("does not over-reject a FIXED-length body under a repeat — it cannot backtrack", () => {
    for (const p of ["(?:a{3})+", "(?:\\d{3}-){2}\\d{4}", "(?:[A-Z]{2}){1,4}"]) {
      expect(validationRegexIssue(p), p).toBeNull();
      const started = Date.now();
      expect(testAnswerPattern(p, `${"a".repeat(MAX_VALIDATED_ANSWER_LENGTH - 1)}!`), p).toBe(false);
      expect(Date.now() - started, p).toBeLessThan(200);
    }
    // but the moment the body can match the same text two ways, it is refused again
    expect(validationRegexIssue("(?:ab|cd)+")).toMatch(/repeats a group/);
    expect(validationRegexIssue("(?:a{1,3})+")).toMatch(/repeats a group/);
  });

  it("a known ReDoS pattern that slipped into the database still cannot hang a submission", () => {
    const questionWith = (validationRegex: string) =>
      ({
        id: "q1",
        flowId: "f1",
        order: 1,
        title: "Code",
        prompt: "Code?",
        type: "TEXT",
        required: true,
        options: [],
        mapTo: null,
        validationRegex,
      }) as LeadFlowQuestion;

    const adversarial = `${"a".repeat(MAX_VALIDATED_ANSWER_LENGTH - 1)}!`;
    for (const bomb of ["(a+)+$", "(?:[a-z]+){1,5}", "[a-z]+[a-z]+[a-z]+[a-z]+@"]) {
      const started = Date.now();
      const res = validateAnswer(questionWith(bomb), adversarial);
      expect(res.ok, bomb).toBe(true); // unusable pattern → accept rather than block
      expect(Date.now() - started, `${bomb} hung`).toBeLessThan(1000);
    }
  });
});

// ============================================================== CRM: tags

describe("lead tags", () => {
  it("trims, collapses inner whitespace, drops blanks and de-duplicates case-insensitively", () => {
    expect(normalizeLeadTags(["  vip ", "VIP", "", "   ", "hot   lead", "Hot Lead"])).toEqual(["vip", "hot lead"]);
  });

  it("keeps the first spelling of a duplicate", () => {
    expect(normalizeLeadTags(["Tashkent", "tashkent", "TASHKENT"])).toEqual(["Tashkent"]);
  });

  it("caps the list length", () => {
    const many = Array.from({ length: MAX_LEAD_TAGS + 5 }, (_, i) => `t${i}`);
    expect(normalizeLeadTags(many)).toHaveLength(MAX_LEAD_TAGS);
    expect(normalizeLeadTags(many)[MAX_LEAD_TAGS - 1]).toBe(`t${MAX_LEAD_TAGS - 1}`);
  });

  it("truncates an over-long tag without leaving a ragged trailing space", () => {
    const [tag] = normalizeLeadTags([`${"a".repeat(MAX_LEAD_TAG_LENGTH - 1)} beta`]);
    expect(tag).toHaveLength(MAX_LEAD_TAG_LENGTH - 1);
    expect(tag).toBe("a".repeat(MAX_LEAD_TAG_LENGTH - 1));
    expect(tag!.endsWith(" ")).toBe(false);
    // and the trimmed form must not then read as a *different* tag from the same word
    expect(normalizeLeadTags([`${"a".repeat(MAX_LEAD_TAG_LENGTH - 1)} beta`, "a".repeat(MAX_LEAD_TAG_LENGTH - 1)])).toHaveLength(1);
  });

  it("is idempotent — normalizing twice changes nothing", () => {
    const once = normalizeLeadTags(["  VIP  ", "vip", "hot   lead", `${"z".repeat(60)}`]);
    expect(normalizeLeadTags(once)).toEqual(once);
  });
});

// ============================================================== CRM: patch rules

describe("applyLeadCrmPatch", () => {
  const empty: LeadCrmFields = { tags: [], followUpAt: null, valueCents: null, valueCurrency: null, outcomeReason: null };

  it("refuses a deal value with no currency", () => {
    const res = applyLeadCrmPatch(empty, { valueCents: 500000 }, "NEW");
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/currency/i);
  });

  it("accepts a value with a currency and round-trips both", () => {
    const res = applyLeadCrmPatch(empty, { valueCents: 500000, valueCurrency: "UZS" }, "NEW");
    expect(res.ok).toBe(true);
    expect(res.ok && res.fields).toMatchObject({ valueCents: 500000, valueCurrency: "UZS" });
  });

  it("keeps the stored currency when only the amount moves", () => {
    const current = { ...empty, valueCents: 100, valueCurrency: "USD" };
    const res = applyLeadCrmPatch(current, { valueCents: 900 }, "NEW");
    expect(res.ok && res.fields.valueCurrency).toBe("USD");
    expect(res.ok && res.fields.valueCents).toBe(900);
  });

  it("clears the currency when the amount is cleared, so no orphan currency is stored", () => {
    const current = { ...empty, valueCents: 100, valueCurrency: "USD" };
    const res = applyLeadCrmPatch(current, { valueCents: null }, "NEW");
    expect(res.ok && res.fields).toMatchObject({ valueCents: null, valueCurrency: null });
  });

  it("refuses an amount the INTEGER column cannot hold, instead of letting Postgres 500", () => {
    const ok = applyLeadCrmPatch(empty, { valueCents: MAX_LEAD_VALUE_CENTS, valueCurrency: "UZS" }, "NEW");
    expect(ok.ok).toBe(true);
    const tooBig = applyLeadCrmPatch(empty, { valueCents: MAX_LEAD_VALUE_CENTS + 1, valueCurrency: "UZS" }, "NEW");
    expect(tooBig.ok).toBe(false);
    expect(tooBig.ok === false && tooBig.error).toMatch(/too large/i);
  });

  it("only allows an outcome reason on a lead that is being won or lost", () => {
    expect(applyLeadCrmPatch(empty, { outcomeReason: "budget" }, "IN_PROGRESS").ok).toBe(false);
    expect(applyLeadCrmPatch(empty, { outcomeReason: "budget" }, "WON").ok).toBe(true);
    expect(applyLeadCrmPatch(empty, { outcomeReason: "budget" }, "LOST").ok).toBe(true);
  });

  it("judges the submitted edit, never the stored row — a won lead can be dragged back", () => {
    const won = { ...empty, outcomeReason: "signed", valueCents: 100, valueCurrency: null };
    const res = applyLeadCrmPatch(won, { tags: ["follow-up"] }, "IN_PROGRESS");
    expect(res.ok).toBe(true);
    expect(res.ok && res.fields.outcomeReason).toBe("signed");
  });

  it("lets an outcome reason be cleared on any status", () => {
    const lost = { ...empty, outcomeReason: "price" };
    expect(applyLeadCrmPatch(lost, { outcomeReason: null }, "NEW").ok).toBe(true);
    expect(applyLeadCrmPatch(lost, { outcomeReason: "" }, "NEW").ok).toBe(true);
  });

  it("normalizes tags on the way in", () => {
    const res = applyLeadCrmPatch(empty, { tags: [" VIP ", "vip", ""] }, "NEW");
    expect(res.ok && res.fields.tags).toEqual(["VIP"]);
  });

  it("leaves untouched fields exactly as they were", () => {
    const current: LeadCrmFields = {
      tags: ["a"],
      followUpAt: new Date("2026-01-01T00:00:00.000Z"),
      valueCents: 10,
      valueCurrency: "EUR",
      outcomeReason: "x",
    };
    const res = applyLeadCrmPatch(current, {}, "WON");
    expect(res.ok && res.fields).toEqual(current);
  });
});

describe("leadCrmChanges", () => {
  const empty: LeadCrmFields = { tags: [], followUpAt: null, valueCents: null, valueCurrency: null, outcomeReason: null };

  it("writes nothing and logs nothing when nothing moved", () => {
    const res = leadCrmChanges(empty, { ...empty });
    expect(res.data).toEqual({});
    expect(res.events).toEqual([]);
  });

  it("records exactly which tags were added and removed", () => {
    const res = leadCrmChanges({ ...empty, tags: ["a", "b"] }, { ...empty, tags: ["B", "c"] });
    expect(res.data.tags).toEqual(["B", "c"]);
    expect(res.events).toHaveLength(1);
    expect(res.events[0]).toMatchObject({ type: "TAGS_CHANGED", data: { added: ["c"], removed: ["a"] } });
  });

  it("records a follow-up move as ISO strings, and ignores a same-instant re-set", () => {
    const at = new Date("2026-03-01T10:00:00.000Z");
    const moved = leadCrmChanges(empty, { ...empty, followUpAt: at });
    expect(moved.events[0]).toMatchObject({ type: "FOLLOW_UP_CHANGED", data: { from: null, to: at.toISOString() } });
    const unchanged = leadCrmChanges({ ...empty, followUpAt: at }, { ...empty, followUpAt: new Date(at.getTime()) });
    expect(unchanged.events).toEqual([]);
    expect(unchanged.data).toEqual({});
  });

  it("records value and outcome as separate events", () => {
    const res = leadCrmChanges(empty, { ...empty, valueCents: 1200, valueCurrency: "UZS", outcomeReason: "won it" });
    expect(res.events.map((e) => e.type)).toEqual(["VALUE_CHANGED", "OUTCOME_CHANGED"]);
    expect(res.events[0]!.data).toEqual({ from: null, to: { cents: 1200, currency: "UZS" } });
    expect(res.data).toMatchObject({ valueCents: 1200, valueCurrency: "UZS", outcomeReason: "won it" });
  });

  it("notices a currency-only change even though the amount is identical", () => {
    const before = { ...empty, valueCents: 100, valueCurrency: "USD" };
    const after = { ...empty, valueCents: 100, valueCurrency: "EUR" };
    const res = leadCrmChanges(before, after);
    expect(res.data).toMatchObject({ valueCents: 100, valueCurrency: "EUR" });
    expect(res.events.map((e) => e.type)).toEqual(["VALUE_CHANGED"]);
  });
});

// ============================================================== CRM round-trip through Prisma

describe("CRM fields round-trip through a stored lead", () => {
  it("applies a patch, writes only what moved, and settles on the second save", async () => {
    const lead = await prismaMock.lead.create({ data: { accountId: "acct1" } });
    const current: LeadCrmFields = {
      tags: lead.tags as string[],
      followUpAt: lead.followUpAt as Date | null,
      valueCents: lead.valueCents as number | null,
      valueCurrency: lead.valueCurrency as string | null,
      outcomeReason: lead.outcomeReason as string | null,
    };

    const followUpAt = new Date("2026-05-05T09:00:00.000Z");
    const patched = applyLeadCrmPatch(
      current,
      { tags: [" VIP ", "vip", "tashkent"], followUpAt, valueCents: 25_000_00, valueCurrency: "UZS", outcomeReason: "signed" },
      "WON",
    );
    expect(patched.ok).toBe(true);
    if (!patched.ok) return;

    const changes = leadCrmChanges(current, patched.fields);
    const saved = await prismaMock.lead.update({ where: { id: lead.id }, data: changes.data as Row });
    for (const ev of changes.events) {
      await prismaMock.leadEvent.create({ data: { leadId: lead.id, type: ev.type, data: ev.data } });
    }

    expect(saved.tags).toEqual(["VIP", "tashkent"]);
    expect(saved.followUpAt).toEqual(followUpAt);
    expect(saved.valueCents).toBe(2_500_000);
    expect(saved.valueCurrency).toBe("UZS");
    expect(saved.outcomeReason).toBe("signed");
    expect(store.leadEvents.map((e) => e.type)).toEqual([
      "TAGS_CHANGED",
      "FOLLOW_UP_CHANGED",
      "VALUE_CHANGED",
      "OUTCOME_CHANGED",
    ]);

    // re-submitting the identical form must be a no-op, not a second event storm
    const stored = await prismaMock.lead.findUnique({ where: { id: lead.id } });
    const reloaded: LeadCrmFields = {
      tags: stored!.tags as string[],
      followUpAt: stored!.followUpAt as Date | null,
      valueCents: stored!.valueCents as number | null,
      valueCurrency: stored!.valueCurrency as string | null,
      outcomeReason: stored!.outcomeReason as string | null,
    };
    const again = applyLeadCrmPatch(reloaded, { tags: ["VIP", "tashkent"], followUpAt, valueCents: 2_500_000, valueCurrency: "UZS" }, "WON");
    expect(again.ok).toBe(true);
    expect(again.ok && leadCrmChanges(reloaded, again.fields)).toEqual({ data: {}, events: [] });
  });
});

// ============================================================== paging

describe("parseLeadPage", () => {
  it("defaults to the full board page", () => {
    expect(parseLeadPage(null, null)).toEqual({ limit: DEFAULT_LEADS_PAGE_SIZE, offset: 0 });
    expect(parseLeadPage("not-a-number", "junk")).toEqual({ limit: DEFAULT_LEADS_PAGE_SIZE, offset: 0 });
  });

  it("clamps the page size into [1, MAX] and never returns a negative offset", () => {
    expect(parseLeadPage("9999", "0").limit).toBe(MAX_LEADS_PAGE_SIZE);
    expect(parseLeadPage("0", null).limit).toBe(1);
    expect(parseLeadPage("-10", "-5")).toEqual({ limit: 1, offset: 0 });
    expect(parseLeadPage("50", "100")).toEqual({ limit: 50, offset: 100 });
  });
});

describe("isQualificationLevel", () => {
  it("accepts exactly the three scores and nothing else", () => {
    for (const ok of ["LOW", "MEDIUM", "HIGH"]) expect(isQualificationLevel(ok)).toBe(true);
    for (const bad of ["low", "URGENT", "", null, undefined, 1, {}]) expect(isQualificationLevel(bad)).toBe(false);
  });
});

// ============================================================== lastInteractionAt

describe("lastInteractionAt maintenance", () => {
  it("stamps the lead when an interaction arrives", async () => {
    const lead = await prismaMock.lead.create({ data: { accountId: "a1" } });
    expect(lead.lastInteractionAt).toBeNull();
    const before = Date.now();
    await touchLead(lead.id as string);
    const after = await prismaMock.lead.findUnique({ where: { id: lead.id } });
    expect(after!.lastInteractionAt).toBeInstanceOf(Date);
    expect((after!.lastInteractionAt as Date).getTime()).toBeGreaterThanOrEqual(before);
  });

  it("is a no-op for a missing id and never throws", async () => {
    await expect(touchLead(null)).resolves.toBeUndefined();
    await expect(touchLead(undefined)).resolves.toBeUndefined();
    await expect(touchLead("")).resolves.toBeUndefined();
    expect(store.leads).toHaveLength(0);
  });

  it("swallows a write against a lead that no longer exists — bookkeeping never breaks the main path", async () => {
    await expect(touchLead("deleted-lead")).resolves.toBeUndefined();
  });

  it("resolves the lead from a conversation", async () => {
    const lead = await prismaMock.lead.create({ data: { accountId: "a1" } });
    await prismaMock.conversation.create({ data: { id: "c1", leadId: lead.id } });
    await touchLeadByConversation("c1");
    const after = await prismaMock.lead.findUnique({ where: { id: lead.id } });
    expect(after!.lastInteractionAt).toBeInstanceOf(Date);
  });

  it("does nothing for a conversation with no lead, or no conversation at all", async () => {
    await prismaMock.conversation.create({ data: { id: "c2", leadId: null } });
    await expect(touchLeadByConversation("c2")).resolves.toBeUndefined();
    await expect(touchLeadByConversation("missing")).resolves.toBeUndefined();
  });

  it("moves the stamp forward on a later interaction", async () => {
    const lead = await prismaMock.lead.create({ data: { accountId: "a1" } });
    await touchLead(lead.id as string);
    const first = (await prismaMock.lead.findUnique({ where: { id: lead.id } }))!.lastInteractionAt as Date;
    vi.setSystemTime(new Date(first.getTime() + 60_000));
    await touchLead(lead.id as string);
    const second = (await prismaMock.lead.findUnique({ where: { id: lead.id } }))!.lastInteractionAt as Date;
    expect(second.getTime()).toBeGreaterThan(first.getTime());
    vi.useRealTimers();
  });
});

// ============================================================== duplicate detection

describe("duplicate detection", () => {
  /**
   * Lead ads are re-delivered by Meta; the guard is a findFirst on the JSON
   * path `answers.leadgenId`. This proves the stored shape and the guard's
   * query agree — the pair is what actually prevents a double lead.
   */
  const dedupeWhere = (accountId: string, leadgenId: string) => ({
    accountId,
    source: "lead_ad",
    answers: { path: ["leadgenId"], equals: leadgenId },
  });

  it("finds an already-ingested lead ad by its leadgen id", async () => {
    await prismaMock.lead.create({
      data: { accountId: "a1", source: "lead_ad", answers: { leadgenId: "LG-1", items: [{ question: "Name", answer: "Ali" }] } },
    });
    expect(await prismaMock.lead.findFirst({ where: dedupeWhere("a1", "LG-1") })).not.toBeNull();
    expect(await prismaMock.lead.findFirst({ where: dedupeWhere("a1", "LG-2") })).toBeNull();
    expect(await prismaMock.lead.findFirst({ where: dedupeWhere("other", "LG-1") })).toBeNull();
  });

  it("does not confuse a landing-page lead whose answers are a plain array", async () => {
    await prismaMock.lead.create({ data: { accountId: "a1", source: "landing_page", answers: [{ question: "Name", answer: "Ali" }] } });
    expect(await prismaMock.lead.findFirst({ where: dedupeWhere("a1", "LG-1") })).toBeNull();
  });

  it("tag de-duplication is case-insensitive, which is what stops the board filling with near-duplicates", () => {
    expect(normalizeLeadTags(["VIP", "Vip", "vIp"])).toEqual(["VIP"]);
  });
});

// ============================================================== answer shapes

describe("normalizeLeadAnswers — the two shapes a Lead.answers column holds", () => {
  it("reads the flow / landing-page shape (a plain array)", () => {
    expect(normalizeLeadAnswers([{ question: "Ism", answer: "Ali" }])).toEqual([{ question: "Ism", answer: "Ali" }]);
  });

  it("reads the lead-ad shape so Instant Form answers are not dropped", () => {
    expect(normalizeLeadAnswers({ leadgenId: "LG-1", items: [{ question: "full_name", answer: "Ali" }] })).toEqual([
      { question: "full_name", answer: "Ali" },
    ]);
  });

  it("coerces non-string answers rather than crashing the renderer", () => {
    expect(normalizeLeadAnswers([{ question: "Age", answer: 30 }, { question: "Ok", answer: null }])).toEqual([
      { question: "Age", answer: "30" },
      { question: "Ok", answer: "" },
    ]);
  });

  it("skips entries with no usable question and returns [] for anything else", () => {
    expect(normalizeLeadAnswers([{ answer: "orphan" }, { question: "  " }, null, "x", 5])).toEqual([]);
    expect(normalizeLeadAnswers(null)).toEqual([]);
    expect(normalizeLeadAnswers("nope")).toEqual([]);
    expect(normalizeLeadAnswers({ leadgenId: "LG", items: "not-an-array" })).toEqual([]);
    expect(normalizeLeadAnswers({})).toEqual([]);
  });
});

// ============================================================== Telegram builders

describe("Telegram lead card", () => {
  const base = {
    accountUsername: "shop",
    leadName: "Ali",
    phone: "+998901234567",
    email: "ali@example.com",
    source: "landing_page",
    campaignName: null,
    contentCaption: null,
    answers: [] as Array<{ question: string; answer: string }>,
    submittedAt: "2026-02-01T09:30:00.000Z",
  };

  it("escapes the three characters that would break Telegram's HTML parse mode", () => {
    expect(escapeHtml("<b>&</b>")).toBe("&lt;b&gt;&amp;&lt;/b&gt;");
    const msg = formatLeadMessage({ ...base, leadName: "<script>alert(1)</script>" });
    expect(msg).not.toContain("<script>");
    expect(msg).toContain("&lt;script&gt;");
  });

  it("prints every supplied field and omits the empty ones instead of dashes", () => {
    const full = formatLeadMessage({ ...base, campaignName: "Bahor", contentCaption: "Reel", answers: [{ question: "Ism", answer: "Ali" }] });
    expect(full).toContain("Ali");
    expect(full).toContain("+998901234567");
    expect(full).toContain("Bahor");
    expect(full).toContain("Ism");

    const sparse = formatLeadMessage({ ...base, leadName: null, phone: null, email: null });
    expect(sparse).not.toContain("Ism:");
    expect(sparse).not.toContain("—");
    expect(sparse).toContain("@shop");
  });

  it("labels every known source and falls back to the raw value for an unknown one", () => {
    for (const [source, label] of [
      ["instagram_dm", "Instagram DM"],
      ["instagram_comment", "Instagram izoh"],
      ["landing_page", "Tugma sahifasi"],
      ["lead_ad", "Instagram reklama"],
      ["manual", "Qo‘lda qo‘shilgan"],
    ] as const) {
      expect(formatLeadMessage({ ...base, source })).toContain(label);
    }
    expect(formatLeadMessage({ ...base, source: "carrier_pigeon" })).toContain("carrier_pigeon");
  });

  it("renders lead-ad answers identically to flow answers once normalized", () => {
    const fromFlow = formatLeadMessage({ ...base, answers: normalizeLeadAnswers([{ question: "Ism", answer: "Ali" }]) });
    const fromAd = formatLeadMessage({ ...base, answers: normalizeLeadAnswers({ leadgenId: "LG", items: [{ question: "Ism", answer: "Ali" }] }) });
    expect(fromAd).toBe(fromFlow);
    expect(fromAd).toContain("Javoblar");
  });

  it("picks the most recent chat id out of getUpdates, from either update kind", () => {
    expect(pickChatIdFromUpdates([{ update_id: 1, message: { chat: { id: 111, type: "private" } } }])).toBe("111");
    expect(
      pickChatIdFromUpdates([
        { update_id: 1, message: { chat: { id: 111, type: "private" } } },
        { update_id: 2, my_chat_member: { chat: { id: 222, type: "private" } } },
      ]),
    ).toBe("222");
    expect(pickChatIdFromUpdates([])).toBeNull();
    expect(pickChatIdFromUpdates([{ update_id: 1 }])).toBeNull();
  });
});

// ============================================================== Telegram config + delivery

describe("telegramConfig", () => {
  it("prefers the encrypted database token", async () => {
    await prismaMock.globalSettings.create({
      data: { id: 1, telegramBotToken: encryptSecret("db-token"), telegramChatId: "42", telegramEnabled: true },
    });
    const cfg = await telegramConfig();
    expect(cfg).toMatchObject({ token: "db-token", chatId: "42", enabled: true, source: "db" });
  });

  it("falls back to the env token when nothing is stored", async () => {
    await prismaMock.globalSettings.create({ data: { id: 1, telegramEnabled: true } });
    process.env.TELEGRAM_BOT_TOKEN = "env-token";
    process.env.TELEGRAM_CHAT_ID = "77";
    try {
      const cfg = await telegramConfig();
      expect(cfg).toMatchObject({ token: "env-token", chatId: "77", source: "env" });
    } finally {
      delete process.env.TELEGRAM_BOT_TOKEN;
      delete process.env.TELEGRAM_CHAT_ID;
    }
  });

  it("returns null (rather than a broken token) when the stored secret cannot be decrypted", async () => {
    await prismaMock.globalSettings.create({ data: { id: 1, telegramBotToken: "not-a-real-ciphertext", telegramEnabled: true } });
    expect(await telegramConfig()).toBeNull();
  });

  it("returns null when nothing is configured at all", async () => {
    await prismaMock.globalSettings.create({ data: { id: 1 } });
    expect(await telegramConfig()).toBeNull();
  });
});

describe("deliverLeadToTelegram", () => {
  async function seedLead(overrides: Row = {}) {
    await prismaMock.instagramAccount.create({ data: { id: "a1", username: "shop" } });
    return prismaMock.lead.create({
      data: {
        accountId: "a1",
        name: "Ali",
        phone: "+998901234567",
        source: "landing_page",
        answers: [{ question: "Ism", answer: "Ali" }],
        ...overrides,
      },
    });
  }

  it("sends the card, records TELEGRAM_SENT, and posts to the right bot endpoint", async () => {
    await prismaMock.globalSettings.create({
      data: { id: 1, telegramBotToken: encryptSecret("tok"), telegramChatId: "42", telegramEnabled: true },
    });
    const lead = await seedLead();
    const fetchMock = vi.fn(async () => fetchOk({ ok: true, result: { message_id: 1 } }));
    vi.stubGlobal("fetch", fetchMock);

    await deliverLeadToTelegram(lead.id as string);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.telegram.org/bottok/sendMessage");
    const body = JSON.parse(String(init.body)) as { chat_id: string; text: string; parse_mode: string };
    expect(body.chat_id).toBe("42");
    expect(body.parse_mode).toBe("HTML");
    expect(body.text).toContain("Ali");
    expect(body.text).toContain("Ism");
    expect(store.leadEvents.map((e) => e.type)).toEqual(["TELEGRAM_SENT"]);
  });

  it("carries lead-ad answers into the card — the shape mismatch that used to drop them", async () => {
    await prismaMock.globalSettings.create({
      data: { id: 1, telegramBotToken: encryptSecret("tok"), telegramChatId: "42", telegramEnabled: true },
    });
    const lead = await seedLead({
      source: "lead_ad",
      answers: { leadgenId: "LG-9", items: [{ question: "Byudjet", answer: "10 mln" }] },
    });
    const fetchMock = vi.fn(async () => fetchOk({ ok: true, result: { message_id: 1 } }));
    vi.stubGlobal("fetch", fetchMock);

    await deliverLeadToTelegram(lead.id as string);
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body)) as { text: string };
    expect(body.text).toContain("Byudjet");
    expect(body.text).toContain("10 mln");
  });

  it("auto-detects and persists the chat id when it has never been set", async () => {
    await prismaMock.globalSettings.create({ data: { id: 1, telegramBotToken: encryptSecret("tok"), telegramChatId: null, telegramEnabled: true } });
    const lead = await seedLead();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(fetchOk({ ok: true, result: [{ update_id: 1, message: { chat: { id: 555, type: "private" } } }] }))
      .mockResolvedValueOnce(fetchOk({ ok: true, result: { message_id: 1 } }));
    vi.stubGlobal("fetch", fetchMock);

    await deliverLeadToTelegram(lead.id as string);

    expect(String((fetchMock.mock.calls[0] as unknown as [string])[0])).toContain("/getUpdates");
    expect(store.globalSettings[0]!.telegramChatId).toBe("555");
    expect(store.leadEvents.map((e) => e.type)).toEqual(["TELEGRAM_SENT"]);
  });

  it("throws (so the queue retries) when the owner has never pressed Start", async () => {
    await prismaMock.globalSettings.create({ data: { id: 1, telegramBotToken: encryptSecret("tok"), telegramChatId: null, telegramEnabled: true } });
    const lead = await seedLead();
    vi.stubGlobal("fetch", vi.fn(async () => fetchOk({ ok: true, result: [] })));
    await expect(deliverLeadToTelegram(lead.id as string)).rejects.toThrow(/press Start/i);
  });

  it("records TELEGRAM_FAILED and rethrows when the Bot API refuses", async () => {
    await prismaMock.globalSettings.create({
      data: { id: 1, telegramBotToken: encryptSecret("tok"), telegramChatId: "42", telegramEnabled: true },
    });
    const lead = await seedLead();
    vi.stubGlobal("fetch", vi.fn(async () => fetchOk({ ok: false, description: "chat not found" })));

    await expect(deliverLeadToTelegram(lead.id as string)).rejects.toThrow(/chat not found/);
    expect(store.leadEvents.map((e) => e.type)).toEqual(["TELEGRAM_FAILED"]);
    expect(String((store.leadEvents[0]!.data as Row).error)).toContain("chat not found");
  });

  it("reports the HTTP status when Telegram answers with something that is not JSON", async () => {
    await prismaMock.globalSettings.create({
      data: { id: 1, telegramBotToken: encryptSecret("tok"), telegramChatId: "42", telegramEnabled: true },
    });
    const lead = await seedLead();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 502, json: async () => { throw new Error("not json"); } }) as unknown as Response),
    );
    await expect(deliverLeadToTelegram(lead.id as string)).rejects.toThrow(/HTTP 502/);
  });

  it("does nothing at all when Telegram is switched off", async () => {
    await prismaMock.globalSettings.create({
      data: { id: 1, telegramBotToken: encryptSecret("tok"), telegramChatId: "42", telegramEnabled: false },
    });
    const lead = await seedLead();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await deliverLeadToTelegram(lead.id as string);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.leadEvents).toHaveLength(0);
  });

  it("returns quietly when the lead has been deleted between queueing and delivery", async () => {
    await prismaMock.globalSettings.create({
      data: { id: 1, telegramBotToken: encryptSecret("tok"), telegramChatId: "42", telegramEnabled: true },
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(deliverLeadToTelegram("gone")).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ============================================================== Email

describe("renderLeadNotification", () => {
  const payload = {
    leadId: "l1",
    accountUsername: "shop",
    leadName: "Ali",
    phone: null,
    email: null,
    campaignName: null,
    contentCaption: null,
    answers: [{ question: "Ism", answer: "Ali" }],
    source: "landing_page",
    submittedAt: "2026-02-01T09:30:00.000Z",
  };

  it("renders both a text and an HTML body with the lead's details", () => {
    const { text, html } = renderLeadNotification(payload);
    expect(text).toContain("@shop");
    expect(text).toContain("Ism → Ali");
    expect(html).toContain("<h2");
    expect(html).toContain("Answers");
    expect(html).toContain("Ism");
  });

  it("uses a dash for every missing field rather than printing null", () => {
    const { text, html } = renderLeadNotification({ ...payload, leadName: null, answers: [] });
    expect(text).not.toContain("null");
    expect(text).toContain("Lead name: —");
    expect(html).not.toContain(">Answers<");
  });

  it("escapes customer text so an answer cannot inject markup into the email", () => {
    const { html } = renderLeadNotification({ ...payload, leadName: "<img src=x onerror=1>", answers: [{ question: "<b>q</b>", answer: "a&b" }] });
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
    expect(html).toContain("a&amp;b");
  });

  it("renders the lead-ad answer shape instead of silently dropping it", () => {
    const adShape = { leadgenId: "LG-1", items: [{ question: "Byudjet", answer: "10 mln" }] };
    const { text, html } = renderLeadNotification({ ...payload, answers: adShape as never });
    expect(text).toContain("Byudjet → 10 mln");
    expect(html).toContain("Byudjet");
  });

  it("survives a malformed stored payload rather than throwing mid-send", () => {
    const junk = [{ question: "Age", answer: 30 }, { answer: "orphan" }, null] as never;
    expect(() => renderLeadNotification({ ...payload, answers: junk })).not.toThrow();
    expect(renderLeadNotification({ ...payload, answers: junk }).text).toContain("Age → 30");
  });
});

describe("email 'not configured' vs 'configured but failing'", () => {
  it("records the notification and skips the queue entirely when SMTP is absent", async () => {
    const id = await queueLeadNotification({
      leadId: "l1",
      accountUsername: "shop",
      leadName: "Ali",
      phone: null,
      email: null,
      campaignName: null,
      contentCaption: null,
      answers: [],
      source: "manual",
      submittedAt: new Date().toISOString(),
    });
    const row = store.emailEvents.find((e) => e.id === id)!;
    expect(row.status).toBe("FAILED");
    expect(String(row.lastError)).toMatch(new RegExp(`^${EMAIL_NOT_CONFIGURED_PREFIX}`));
    expect(enqueueMock).not.toHaveBeenCalled();
    expect(store.leadEvents.map((e) => e.type)).toEqual(["EMAIL_FAILED"]);
  });

  it("queues a real job when SMTP is configured", async () => {
    configureSmtp();
    const id = await queueLeadNotification({
      leadId: "l1",
      accountUsername: "shop",
      leadName: "Ali",
      phone: null,
      email: null,
      campaignName: null,
      contentCaption: null,
      answers: [],
      source: "manual",
      submittedAt: new Date().toISOString(),
    });
    expect(store.emailEvents.find((e) => e.id === id)!.status).toBe("PENDING");
    expect(enqueueMock).toHaveBeenCalledWith("email.send", { emailEventId: id }, { maxAttempts: 4 });
  });

  it("deliverEmailEvent does NOT throw on a missing configuration — it must not burn retries", async () => {
    const event = await prismaMock.emailEvent.create({
      data: { to: "unconfigured", subject: "s", template: "lead_notification", payload: {}, status: "PENDING", leadId: "l1" },
    });
    await expect(deliverEmailEvent(event.id as string)).resolves.toBeUndefined();
    const row = store.emailEvents[0]!;
    expect(row.status).toBe("FAILED");
    expect(String(row.lastError).startsWith(EMAIL_NOT_CONFIGURED_PREFIX)).toBe(true);
    expect(row.attempts).toBe(0); // no attempt was made, so none is counted
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it("a configured-but-failing send is distinguishable, counted, and retried", async () => {
    configureSmtp();
    sendMailMock.mockRejectedValueOnce(new Error("535 auth failed"));
    const event = await prismaMock.emailEvent.create({
      data: { to: "boss@test.local", subject: "s", template: "lead_notification", payload: { answers: [] }, status: "PENDING", leadId: "l1" },
    });

    await expect(deliverEmailEvent(event.id as string)).rejects.toThrow(/535 auth failed/);
    const row = store.emailEvents[0]!;
    expect(row.status).toBe("FAILED");
    expect(String(row.lastError)).toBe("535 auth failed");
    expect(String(row.lastError).startsWith(EMAIL_NOT_CONFIGURED_PREFIX)).toBe(false);
    expect(row.attempts).toBe(1);
    expect(store.leadEvents.map((e) => e.type)).toEqual(["EMAIL_FAILED"]);
  });

  it("a successful send marks SENT, stamps sentAt, clears the error and logs EMAIL_SENT", async () => {
    configureSmtp();
    const event = await prismaMock.emailEvent.create({
      data: {
        to: "boss@test.local",
        subject: "New lead",
        template: "lead_notification",
        payload: { accountUsername: "shop", leadName: "Ali", answers: [{ question: "Ism", answer: "Ali" }] },
        status: "PENDING",
        leadId: "l1",
        lastError: "previous failure",
      },
    });

    await deliverEmailEvent(event.id as string);

    const row = store.emailEvents[0]!;
    expect(row.status).toBe("SENT");
    expect(row.sentAt).toBeInstanceOf(Date);
    expect(row.lastError).toBeNull();
    expect(row.attempts).toBe(1);
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    const mail = sendMailMock.mock.calls[0]![0] as unknown as { to: string; text: string; html: string };
    expect(mail.to).toBe("boss@test.local");
    expect(mail.text).toContain("Ism → Ali");
    expect(store.leadEvents.map((e) => e.type)).toEqual(["EMAIL_SENT"]);
  });

  it("is idempotent: an already-SENT event is never sent twice", async () => {
    configureSmtp();
    const event = await prismaMock.emailEvent.create({
      data: { to: "boss@test.local", subject: "s", template: "admin_alert", payload: { text: "hi" }, status: "SENT" },
    });
    await deliverEmailEvent(event.id as string);
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it("returns quietly for an email event that no longer exists", async () => {
    configureSmtp();
    await expect(deliverEmailEvent("gone")).resolves.toBeUndefined();
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it("substitutes the configured recipient for a row stored before SMTP existed", async () => {
    configureSmtp();
    const event = await prismaMock.emailEvent.create({
      data: { to: "unconfigured", subject: "s", template: "admin_alert", payload: { text: "hello" }, status: "PENDING" },
    });
    await deliverEmailEvent(event.id as string);
    const mail = sendMailMock.mock.calls[0]![0] as unknown as { to: string; text: string };
    expect(mail.to).toBe(process.env.LEAD_NOTIFICATION_EMAIL);
    expect(mail.text).toBe("hello");
  });

  it("uses implicit TLS on port 465 even when EMAIL_SECURE was never set", async () => {
    configureSmtp();
    process.env.EMAIL_PORT = "465";
    const event = await prismaMock.emailEvent.create({
      data: { to: "boss@test.local", subject: "s", template: "admin_alert", payload: { text: "x" }, status: "PENDING" },
    });
    await deliverEmailEvent(event.id as string);
    expect(transportConfigs[0]).toMatchObject({ port: 465, secure: true });
  });

  it("queueAdminAlert follows the same configured / not-configured split", async () => {
    await queueAdminAlert("Down", "the worker stopped");
    expect(store.emailEvents[0]!.status).toBe("FAILED");
    expect(enqueueMock).not.toHaveBeenCalled();

    configureSmtp();
    await queueAdminAlert("Down again", "still down");
    expect(store.emailEvents[1]!.status).toBe("PENDING");
    expect(enqueueMock).toHaveBeenCalledWith("email.send", { emailEventId: store.emailEvents[1]!.id }, { maxAttempts: 3 });
  });
});

describe("notifyLeadSubmitted", () => {
  const account = { id: "a1", username: "shop" } as InstagramAccount;

  function lead(answers: unknown, extra: Row = {}): Lead {
    return {
      id: "l1",
      accountId: "a1",
      name: "Ali",
      phone: "+998901234567",
      email: null,
      campaignId: null,
      contentId: null,
      answers,
      source: "landing_page",
      createdAt: new Date("2026-02-01T09:30:00.000Z"),
      ...extra,
    } as unknown as Lead;
  }

  it("carries flow answers into the queued payload", async () => {
    configureSmtp();
    await notifyLeadSubmitted(lead([{ question: "Ism", answer: "Ali" }]), account);
    const stored = store.emailEvents[0]!.payload as { answers: Array<{ question: string }> };
    expect(stored.answers).toEqual([{ question: "Ism", answer: "Ali" }]);
  });

  it("carries LEAD-AD answers too — the object shape must not be silently dropped", async () => {
    configureSmtp();
    await notifyLeadSubmitted(lead({ leadgenId: "LG-1", items: [{ question: "Byudjet", answer: "10 mln" }] }, { source: "lead_ad" }), account);
    const stored = store.emailEvents[0]!.payload as { answers: Array<{ question: string; answer: string }> };
    expect(stored.answers).toEqual([{ question: "Byudjet", answer: "10 mln" }]);
  });

  it("joins campaign and content when the lead points at them", async () => {
    configureSmtp();
    await prismaMock.campaign.create({ data: { id: "c1", name: "Bahor" } });
    await prismaMock.contentItem.create({ data: { id: "ct1", caption: "x".repeat(200) } });
    await notifyLeadSubmitted(lead([], { campaignId: "c1", contentId: "ct1" }), account);
    const stored = store.emailEvents[0]!.payload as { campaignName: string; contentCaption: string };
    expect(stored.campaignName).toBe("Bahor");
    expect(stored.contentCaption).toHaveLength(120);
  });

  it("still records the notification when SMTP is off — a lead is never lost to a missing mailer", async () => {
    await notifyLeadSubmitted(lead([{ question: "Ism", answer: "Ali" }]), account);
    expect(store.emailEvents).toHaveLength(1);
    expect(store.emailEvents[0]!.status).toBe("FAILED");
    expect(String(store.emailEvents[0]!.lastError)).toContain(EMAIL_NOT_CONFIGURED_PREFIX);
  });
});

// ============================================================== notification parity

describe("Telegram and email agree on what a lead's answers are", () => {
  const answerShapes: Array<[string, unknown]> = [
    ["flow array", [{ question: "Ism", answer: "Ali" }]],
    ["lead-ad object", { leadgenId: "LG-1", items: [{ question: "Ism", answer: "Ali" }] }],
  ];

  it.each(answerShapes)("%s reaches both channels", async (_name, answers) => {
    configureSmtp();
    await prismaMock.instagramAccount.create({ data: { id: "a1", username: "shop" } });
    await prismaMock.globalSettings.create({
      data: { id: 1, telegramBotToken: encryptSecret("tok"), telegramChatId: "42", telegramEnabled: true },
    });
    const row = await prismaMock.lead.create({ data: { accountId: "a1", name: "Ali", answers, source: "lead_ad" } });

    const fetchMock = vi.fn(async () => fetchOk({ ok: true, result: { message_id: 1 } }));
    vi.stubGlobal("fetch", fetchMock);
    await deliverLeadToTelegram(row.id as string);
    const tgText = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body)) as { text: string };

    await notifyLeadSubmitted(row as unknown as Lead, { id: "a1", username: "shop" } as InstagramAccount);
    const emailPayload = store.emailEvents[0]!.payload as { answers: Array<{ question: string; answer: string }> };

    expect(tgText.text).toContain("Ism");
    expect(emailPayload.answers).toEqual([{ question: "Ism", answer: "Ali" }]);
  });
});
