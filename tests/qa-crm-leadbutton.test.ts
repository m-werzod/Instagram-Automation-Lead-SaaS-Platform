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

const {
  store,
  prismaMock,
  enqueueMock,
  sendMailMock,
  transportConfigs,
  jobHandlers,
  authState,
  runAutomationsMock,
  graphCallMock,
  getActiveTokenMock,
} = vi.hoisted(() => {
  const store = {
    leads: [] as Row[],
    leadEvents: [] as Row[],
    conversations: [] as Row[],
    emailEvents: [] as Row[],
    globalSettings: [] as Row[],
    campaigns: [] as Row[],
    contentItems: [] as Row[],
    accounts: [] as Row[],
    admins: [] as Row[],
    accountAccess: [] as Row[],
    auditLogs: [] as Row[],
    ctaConfigs: [] as Row[],
    leadFlows: [] as Row[],
    questions: [] as Row[],
    /** LeadAnswer rows — only the questionId matters, for `_count.answers`. */
    leadAnswers: [] as Row[],
    flowSessions: [] as Row[],
    seq: 0,
    reset() {
      store.leadAnswers = [];
      store.flowSessions = [];
      store.leads = [];
      store.leadEvents = [];
      store.conversations = [];
      store.emailEvents = [];
      store.globalSettings = [];
      store.campaigns = [];
      store.contentItems = [];
      store.accounts = [];
      store.admins = [];
      store.accountAccess = [];
      store.auditLogs = [];
      store.ctaConfigs = [];
      store.leadFlows = [];
      store.questions = [];
      store.seq = 0;
    },
  };

  /** Reads a value at a JSON path, the way Prisma's `{ path, equals }` filter does. */
  const atPath = (value: unknown, path: string[]): unknown =>
    path.reduce<unknown>((acc, key) => (acc && typeof acc === "object" ? (acc as Row)[key] : undefined), value);

  /**
   * Relation filters (`{ accountAccess: { some: … } }`) can only be answered by
   * looking in another table, so each one is registered here by
   * `<model field>` and resolved against the store.
   */
  const relationFilters: Record<string, (row: Row, where: Row) => boolean> = {
    accountAccess: (row, where) => store.accountAccess.some((a) => a.adminId === row.id && matches(a, where)),
  };

  const matches = (row: Row, where: Row = {}): boolean =>
    Object.entries(where).every(([key, cond]) => {
      if (cond === undefined) return true;
      if (key === "OR") return (cond as Row[]).some((sub) => matches(row, sub));
      if (key === "AND") return (cond as Row[]).every((sub) => matches(row, sub));
      if (key === "NOT") return !matches(row, cond as Row);
      const value = row[key];
      if (cond !== null && typeof cond === "object" && !(cond instanceof Date)) {
        const c = cond as Record<string, unknown>;
        if ("path" in c && "equals" in c) return atPath(value, c.path as string[]) === c.equals;
        if ("some" in c) {
          const resolve = relationFilters[key];
          if (!resolve) throw new Error(`no relation filter registered for "${key}"`);
          return resolve(row, c.some as Row);
        }
        if ("in" in c) return (c.in as unknown[]).includes(value);
        if ("hasSome" in c)
          return Array.isArray(value) && (c.hasSome as unknown[]).some((needle) => (value as unknown[]).includes(needle));
        if ("contains" in c) {
          if (typeof value !== "string") return false;
          const needle = String(c.contains);
          return c.mode === "insensitive" ? value.toLowerCase().includes(needle.toLowerCase()) : value.includes(needle);
        }
        if ("not" in c) return value !== c.not;
        if ("lte" in c) return value != null && (value as Date) <= (c.lte as Date);
        if ("lt" in c) return value != null && (value as number) < (c.lt as number);
        if ("gte" in c) return value != null && (value as number) >= (c.gte as number);
        if ("gt" in c) return value != null && (value as number) > (c.gt as number);
        if ("equals" in c) return value === c.equals;
        return false;
      }
      return value === cond;
    });

  /** Prisma `orderBy`, single spec or a tie-breaking list. */
  const sortRows = (rows: Row[], orderBy?: Row | Row[]): Row[] => {
    const specs = (Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []) as Array<Record<string, "asc" | "desc">>;
    if (!specs.length) return rows;
    return [...rows].sort((a, b) => {
      for (const spec of specs) {
        for (const [field, dir] of Object.entries(spec)) {
          const av = a[field] as never;
          const bv = b[field] as never;
          if (av === bv) continue;
          if (av === null || av === undefined) return dir === "desc" ? 1 : -1;
          if (bv === null || bv === undefined) return dir === "desc" ? -1 : 1;
          return (av < bv ? -1 : 1) * (dir === "desc" ? -1 : 1);
        }
      }
      return 0;
    });
  };

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
    findMany: async ({
      where,
      take,
      skip,
      orderBy,
    }: { where?: Row; take?: number; skip?: number; orderBy?: Row | Row[] } = {}) => {
      const hits = sortRows(
        rows().filter((r) => matches(r, where)),
        orderBy,
      );
      const from = skip ?? 0;
      return hits.slice(from, from + (take ?? hits.length)).map((r) => ({ ...r }));
    },
    update: async ({ where, data }: { where: Row; data: Row }) => {
      const row = rows().find((r) => matches(r, where));
      if (!row) throw new Error("record not found");
      applyData(row, data);
      return { ...row };
    },
    updateMany: async ({ where, data }: { where?: Row; data: Row }) => {
      const hits = rows().filter((r) => matches(r, where));
      for (const row of hits) applyData(row, data);
      return { count: hits.length };
    },
    deleteMany: async ({ where }: { where?: Row } = {}) => {
      const list = rows();
      let count = 0;
      for (let i = list.length - 1; i >= 0; i--) {
        if (matches(list[i]!, where)) {
          list.splice(i, 1);
          count++;
        }
      }
      return { count };
    },
    aggregate: async ({ where, _max }: { where?: Row; _max?: Record<string, boolean> }) => {
      const hits = rows().filter((r) => matches(r, where));
      const out: Record<string, unknown> = {};
      for (const field of Object.keys(_max ?? {})) {
        const values = hits.map((r) => r[field]).filter((v) => v !== null && v !== undefined) as number[];
        out[field] = values.length ? Math.max(...values) : null;
      }
      return { _max: out };
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
    assignedAdminId: null,
    flowId: null,
    ctaConfigId: null,
  }));

  const questionTable = table(() => store.questions, "q", () => ({
    required: true,
    options: [],
    mapTo: null,
    validationRegex: null,
    order: 0,
  }));

  /** `@@unique([flowId, order])` — the constraint syncFlowQuestions' parking dance exists for. */
  const assertFreeOrder = (flowId: unknown, order: unknown, selfId?: unknown) => {
    if (typeof order !== "number") return;
    if (store.questions.some((q) => q.flowId === flowId && q.order === order && q.id !== selfId)) {
      throw new Error(`Unique constraint failed on the fields: (\`flowId\`,\`order\`) at order ${order}`);
    }
  };

  const joinLead = (row: Row, include?: Row): Row => {
    const out: Row = { ...row };
    if (include?.account) out.account = store.accounts.find((a) => a.id === row.accountId) ?? null;
    if (include?.campaign) out.campaign = store.campaigns.find((c) => c.id === row.campaignId) ?? null;
    if (include?.content) out.content = store.contentItems.find((c) => c.id === row.contentId) ?? null;
    if (include?.flow) out.flow = store.leadFlows.find((f) => f.id === row.flowId) ?? null;
    if (include?.assignedAdmin) out.assignedAdmin = store.admins.find((a) => a.id === row.assignedAdminId) ?? null;
    if (include?.events) out.events = store.leadEvents.filter((e) => e.leadId === row.id).map((e) => ({ ...e }));
    return out;
  };

  const tables = {
    lead: {
      ...leadTable,
      /** The real delivery path reads a lead with its account/campaign/content joined. */
      findUnique: async ({ where, include }: { where: Row; include?: Row }) => {
        const row = store.leads.find((r) => matches(r, where));
        return row ? joinLead(row, include) : null;
      },
      /** The CRM board lists leads with the same joins, ordered and paged. */
      findMany: async ({
        where,
        take,
        skip,
        orderBy,
        include,
      }: { where?: Row; take?: number; skip?: number; orderBy?: Row | Row[]; include?: Row } = {}) => {
        const hits = sortRows(
          store.leads.filter((r) => matches(r, where)),
          orderBy,
        );
        const from = skip ?? 0;
        return hits.slice(from, from + (take ?? hits.length)).map((r) => joinLead(r, include));
      },
    },
    leadEvent: table(() => store.leadEvents, "ev"),
    conversation: table(() => store.conversations, "conv"),
    admin: table(() => store.admins, "adm", () => ({ isActive: true, role: "USER" })),
    accountAccess: table(() => store.accountAccess, "aa"),
    auditLog: table(() => store.auditLogs, "aud"),
    ctaConfig: {
      ...table(() => store.ctaConfigs, "cta", () => ({
        enabled: true,
        leadFlowId: null,
        contentId: null,
        landingSlug: null,
        kind: "EXTERNAL_LINK",
        ctaType: null,
        buttonSpec: null,
      })),
      /** The Lead Button loader joins the chosen Reel and counts captured leads. */
      findFirst: async ({ where, include, orderBy }: { where?: Row; include?: Row; orderBy?: Row } = {}) => {
        const row = sortRows(
          store.ctaConfigs.filter((r) => matches(r, where)),
          orderBy,
        )[0];
        if (!row) return null;
        const out: Row = { ...row };
        if (include?.content) out.content = store.contentItems.find((c) => c.id === row.contentId) ?? null;
        if (include?._count) out._count = { leads: store.leads.filter((l) => l.ctaConfigId === row.id).length };
        return out;
      },
    },
    leadFlowQuestion: {
      ...questionTable,
      /** syncFlowQuestions reads each question with the number of answers attached to it. */
      findMany: async ({ where, orderBy, include }: { where?: Row; orderBy?: Row | Row[]; include?: Row } = {}) =>
        sortRows(
          store.questions.filter((r) => matches(r, where)),
          orderBy,
        ).map((r) => ({
          ...r,
          ...(include?._count ? { _count: { answers: store.leadAnswers.filter((a) => a.questionId === r.id).length } } : {}),
        })),
      create: async ({ data }: { data: Row }) => {
        assertFreeOrder(data.flowId, data.order);
        return questionTable.create({ data });
      },
      update: async ({ where, data }: { where: Row; data: Row }) => {
        const row = store.questions.find((r) => matches(r, where));
        if (!row) throw new Error("record not found");
        if (data.order !== undefined) assertFreeOrder(data.flowId ?? row.flowId, data.order, row.id);
        return questionTable.update({ where, data });
      },
    },
    leadFlowSession: table(() => store.flowSessions, "sess", () => ({ status: "ACTIVE" })),
    leadAnswer: table(() => store.leadAnswers, "ans"),
    leadFlow: {
      ...table(() => store.leadFlows, "flow", () => ({ enabled: true, description: null, completionMessage: null, triggerKeywords: [] })),
      /** The public form loads a flow with its ACTIVE questions in `order`. */
      findUnique: async ({ where, include }: { where: Row; include?: Row }) => {
        const row = store.leadFlows.find((r) => matches(r, where));
        if (!row) return null;
        const out: Row = { ...row };
        const q = include?.questions as { where?: Row } | undefined;
        if (q) {
          out.questions = store.questions
            .filter((question) => question.flowId === row.id && matches(question, q.where))
            .sort((a, b) => (a.order as number) - (b.order as number))
            .map((question) => ({ ...question }));
        }
        if (include?._count) out._count = { leads: store.leads.filter((l) => l.flowId === row.id).length };
        return out;
      },
    },
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

  /**
   * There is a single in-memory store, so an interactive transaction is just
   * the same client — enough to run the Lead Button save's real `$transaction`
   * body (flow upsert → syncFlowQuestions → session cancel → ctaConfig upsert).
   */
  const prismaMock = {
    ...tables,
    $transaction: async <T>(fn: (tx: typeof tables) => Promise<T>): Promise<T> => fn(tables),
  };

  return {
    store,
    prismaMock,
    enqueueMock: vi.fn(async () => null),
    sendMailMock: vi.fn(async (_options: Record<string, unknown>) => ({ messageId: "ok" })),
    transportConfigs: [] as Row[],
    /** Real job handlers, captured from registerHandler instead of a queue table. */
    jobHandlers: new Map<string, (payload: Record<string, unknown>) => Promise<void>>(),
    /** Who the API routes see as the signed-in admin; swapped per test. */
    authState: { current: null as null | { admin: Row; session: Row } },
    runAutomationsMock: vi.fn(async (_trigger: string, _context: Row) => undefined),
    graphCallMock: vi.fn(async () => ({}) as unknown),
    getActiveTokenMock: vi.fn(async () => ({ token: "page-token" }) as unknown),
  };
});

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));
vi.mock("@/lib/queue", () => ({
  enqueue: enqueueMock,
  drainNow: vi.fn(async () => undefined),
  registerHandler: (type: string, handler: (payload: Record<string, unknown>) => Promise<void>) => {
    jobHandlers.set(type, handler);
  },
}));
// `after()` needs a live request scope; the callback only kicks the queue drain.
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<object>()), after: vi.fn() }));
vi.mock("@/lib/auth/guard", () => ({
  requireAdmin: async () => {
    if (!authState.current) {
      const { unauthorized } = await import("@/lib/errors");
      throw unauthorized();
    }
    return authState.current;
  },
}));
vi.mock("@/lib/automation/engine", () => ({ runAutomations: runAutomationsMock }));
vi.mock("@/lib/meta/tokens", () => ({
  getActiveToken: getActiveTokenMock,
  // marketing.ts (pulled in by /api/lead-button for SUPPORTED_CTA_TYPES) imports
  // this; nothing in this suite may reach the Ads API.
  resolveAdsAccess: vi.fn(async () => {
    throw new Error("resolveAdsAccess must not be reached from the Lead Button save");
  }),
}));
vi.mock("@/lib/meta/client", () => ({ graphCall: graphCallMock, MetaApiError: class MetaApiError extends Error {} }));
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
import { ARCHIVED_QUESTION_ORDER, validateAnswer } from "@/lib/leadflow/engine";
import { NextRequest } from "next/server";
import { GET as GET_LEAD, PATCH as PATCH_LEAD } from "@/app/api/leads/[id]/route";
import { POST as SUBMIT_PUBLIC_LEAD } from "@/app/api/leads/public/route";
import { GET as LIST_LEADS, POST as CREATE_LEAD } from "@/app/api/leads/route";
import { GET as LIST_ASSIGNEES } from "@/app/api/leads/assignees/route";
import { GET as READ_LEAD_BUTTON, PUT as SAVE_LEAD_BUTTON } from "@/app/api/lead-button/route";
// Side-effect import: registers the real job handlers into `jobHandlers`.
import "@/lib/queue/handlers";

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

/** A signed-in admin for the API routes. */
function signIn(admin: Partial<Row> & { id: string; role: string }) {
  authState.current = {
    admin: { login: `${admin.id}-login`, email: null, name: admin.id, ...admin },
    session: { id: "sess1", expiresAt: new Date(Date.now() + 60_000) },
  };
  return admin;
}

/** A PATCH to /api/leads/[id] with a same-origin header, as the browser sends it. */
function patchLead(id: string, body: unknown, origin = "http://localhost:3000") {
  const req = new NextRequest(`http://localhost:3000/api/leads/${id}`, {
    method: "PATCH",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return PATCH_LEAD(req, { params: Promise.resolve({ id }) });
}

/** A landing-page submission. Each test uses its own IP so the rate limiter stays per-test. */
let publicIp = 0;
function submitPublic(body: unknown, ip = `10.0.0.${++publicIp % 250}`) {
  const req = new NextRequest("http://localhost:3000/api/leads/public", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });
  return SUBMIT_PUBLIC_LEAD(req, { params: Promise.resolve({}) });
}

async function readJson(res: Response): Promise<{ ok: boolean; data?: Row; error?: Row }> {
  return (await res.json()) as { ok: boolean; data?: Row; error?: Row };
}

const NO_PARAMS = { params: Promise.resolve({} as Record<string, string>) };

/** A signed-in GET, the way the dashboard issues it. */
function get(handler: (req: NextRequest, ctx: typeof NO_PARAMS) => Promise<Response>, url: string) {
  return handler(new NextRequest(`http://localhost:3000${url}`), NO_PARAMS);
}

/** A signed-in mutating request with the browser's same-origin header. */
function send(
  handler: (req: NextRequest, ctx: typeof NO_PARAMS) => Promise<Response>,
  method: "POST" | "PUT",
  url: string,
  body: unknown,
  origin = "http://localhost:3000",
) {
  const req = new NextRequest(`http://localhost:3000${url}`, {
    method,
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return handler(req, NO_PARAMS);
}

beforeEach(() => {
  store.reset();
  enqueueMock.mockClear();
  sendMailMock.mockClear();
  sendMailMock.mockResolvedValue({ messageId: "ok" });
  transportConfigs.length = 0;
  runAutomationsMock.mockClear();
  graphCallMock.mockClear();
  getActiveTokenMock.mockClear();
  getActiveTokenMock.mockResolvedValue({ token: "page-token" });
  authState.current = null;
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

describe("duplicate detection — the real leadgen.fetch ingestion path", () => {
  /**
   * Meta re-delivers leadgen webhooks, so the SAME Instant Form lead arrives
   * more than once. The guard is a findFirst on the JSON path
   * `answers.leadgenId`. These tests run the registered job handler itself, so
   * the stored shape and the guard's query are proven to agree — a guard that
   * looked at the wrong path would create a second lead here.
   */
  const runLeadgen = async (payload: Record<string, unknown>) => {
    const handler = jobHandlers.get("leadgen.fetch");
    if (!handler) throw new Error("leadgen.fetch handler was never registered");
    await handler(payload);
  };

  const graphLead = (leadgenId: string, extra: Record<string, unknown> = {}) => ({
    id: leadgenId,
    created_time: "2026-09-01T10:00:00+0000",
    field_data: [
      { name: "full_name", values: ["Ali Valiyev"] },
      { name: "phone_number", values: ["+998901234567"] },
      { name: "email", values: ["ali@example.com"] },
      { name: "interests", values: ["SMM", "Ads"] },
    ],
    ...extra,
  });

  beforeEach(async () => {
    await prismaMock.instagramAccount.create({ data: { id: "acct-1", fbPageId: "PAGE-1", status: "CONNECTED" } });
  });

  it("ingests an Instant Form lead, mapping the standard fields and storing the leadgen id", async () => {
    graphCallMock.mockResolvedValue(graphLead("LG-1"));
    await runLeadgen({ pageId: "PAGE-1", leadgenId: "LG-1" });

    expect(store.leads).toHaveLength(1);
    const lead = store.leads[0]!;
    expect(lead.accountId).toBe("acct-1");
    expect(lead.source).toBe("lead_ad");
    expect(lead.name).toBe("Ali Valiyev");
    expect(lead.phone).toBe("+998901234567");
    expect(lead.email).toBe("ali@example.com");
    // The lead-ad shape: an object carrying the id plus the answer items.
    expect(lead.answers).toEqual({
      leadgenId: "LG-1",
      items: [
        { question: "full_name", answer: "Ali Valiyev" },
        { question: "phone_number", answer: "+998901234567" },
        { question: "email", answer: "ali@example.com" },
        // a multi-value field is joined rather than truncated to the first value
        { question: "interests", answer: "SMM, Ads" },
      ],
    });
    expect(store.leadEvents.filter((e) => e.type === "CREATED")).toHaveLength(1);
    expect(enqueueMock).toHaveBeenCalledWith("lead.process", { leadId: lead.id }, { idempotencyKey: `lead.process:${lead.id}` });
  });

  it("a re-delivered webhook for the same leadgen id creates no second lead and queues no second job", async () => {
    graphCallMock.mockResolvedValue(graphLead("LG-1"));
    await runLeadgen({ pageId: "PAGE-1", leadgenId: "LG-1" });
    enqueueMock.mockClear();

    await runLeadgen({ pageId: "PAGE-1", leadgenId: "LG-1" });
    await runLeadgen({ pageId: "PAGE-1", leadgenId: "LG-1" });

    expect(store.leads).toHaveLength(1);
    expect(store.leadEvents.filter((e) => e.type === "CREATED")).toHaveLength(1);
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("a different leadgen id on the same account is a genuinely new lead", async () => {
    graphCallMock.mockResolvedValue(graphLead("LG-1"));
    await runLeadgen({ pageId: "PAGE-1", leadgenId: "LG-1" });
    graphCallMock.mockResolvedValue(graphLead("LG-2"));
    await runLeadgen({ pageId: "PAGE-1", leadgenId: "LG-2" });

    expect(store.leads).toHaveLength(2);
    expect(store.leads.map((l) => (l.answers as Row).leadgenId)).toEqual(["LG-1", "LG-2"]);
  });

  it("scopes the guard to the account — the same id under another page is not a duplicate", async () => {
    await prismaMock.instagramAccount.create({ data: { id: "acct-2", fbPageId: "PAGE-2", status: "CONNECTED" } });
    graphCallMock.mockResolvedValue(graphLead("LG-1"));
    await runLeadgen({ pageId: "PAGE-1", leadgenId: "LG-1" });
    await runLeadgen({ pageId: "PAGE-2", leadgenId: "LG-1" });

    expect(store.leads).toHaveLength(2);
    expect(store.leads.map((l) => l.accountId)).toEqual(["acct-1", "acct-2"]);
  });

  it("a landing-page lead whose answers are a plain array never shadows the guard", async () => {
    // The JSON-path lookup must not match (or crash on) the array shape.
    await prismaMock.lead.create({
      data: { accountId: "acct-1", source: "landing_page", answers: [{ question: "Name", answer: "Ali" }] },
    });
    graphCallMock.mockResolvedValue(graphLead("LG-1"));
    await runLeadgen({ pageId: "PAGE-1", leadgenId: "LG-1" });

    expect(store.leads).toHaveLength(2);
    expect(store.leads[1]!.source).toBe("lead_ad");
  });

  it("does nothing for an unknown page or a missing leadgen id, without spending a token", async () => {
    await runLeadgen({ pageId: "PAGE-UNKNOWN", leadgenId: "LG-1" });
    await runLeadgen({ pageId: "PAGE-1", leadgenId: "" });

    expect(store.leads).toHaveLength(0);
    expect(getActiveTokenMock).not.toHaveBeenCalled();
    expect(graphCallMock).not.toHaveBeenCalled();
  });

  it("throws when the page token is missing, so the job retries instead of losing the lead", async () => {
    getActiveTokenMock.mockResolvedValue(null);
    await expect(runLeadgen({ pageId: "PAGE-1", leadgenId: "LG-1" })).rejects.toThrow(/token missing/i);
    expect(store.leads).toHaveLength(0);
  });

  it("attributes the lead to the local campaign behind the Meta campaign id", async () => {
    await prismaMock.campaign.create({ data: { id: "camp-local", metaCampaignId: "META-9" } });
    graphCallMock.mockResolvedValue(graphLead("LG-1", { campaign_id: "META-9" }));
    await runLeadgen({ pageId: "PAGE-1", leadgenId: "LG-1" });

    expect(store.leads[0]!.campaignId).toBe("camp-local");
  });

  it("leaves the campaign unset when Meta's campaign is not one we track", async () => {
    graphCallMock.mockResolvedValue(graphLead("LG-1", { campaign_id: "META-UNKNOWN" }));
    await runLeadgen({ pageId: "PAGE-1", leadgenId: "LG-1" });

    expect(store.leads[0]!.campaignId).toBeNull();
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

// ============================================================== CRM edit API (PATCH /api/leads/[id])

describe("PATCH /api/leads/[id] — the CRM edit endpoint", () => {
  /**
   * The route is where the CRM rules meet real staff input: an empty <select>
   * posting "", a USER who may not hold the account, and the new tag /
   * follow-up / value / outcome columns. Everything below runs the real
   * handler — guard, zod schema, applyLeadCrmPatch, LeadEvents and audit.
   */
  const OWNER = { id: "owner-1", role: "OWNER" as const };

  async function seedLead(overrides: Partial<Row> = {}) {
    await prismaMock.instagramAccount.create({ data: { id: "acct-1", username: "shop" } });
    return prismaMock.lead.create({ data: { accountId: "acct-1", name: "Ali", status: "NEW", ...overrides } });
  }

  const eventsOfType = (type: string) => store.leadEvents.filter((e) => e.type === type);

  beforeEach(() => {
    signIn(OWNER);
  });

  // ---------- assignee, including the empty-string case ----------

  it("treats an empty-string assignee as unassign, not as a lookup of an admin whose id is blank", async () => {
    const lead = await seedLead({ assignedAdminId: "adm-9" });
    await prismaMock.admin.create({ data: { id: "adm-9", role: "ADMIN", isActive: true } });

    const res = await patchLead(lead.id as string, { assignedAdminId: "" });
    const body = await readJson(res);

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(store.leads[0]!.assignedAdminId).toBeNull();
    // and the unassignment is recorded, so the history shows who dropped it
    expect(eventsOfType("ASSIGNED")).toHaveLength(1);
    expect((eventsOfType("ASSIGNED")[0]!.data as Row).assignedAdminId).toBeNull();
  });

  it("assigns an active admin and records the assignment once", async () => {
    const lead = await seedLead();
    await prismaMock.admin.create({ data: { id: "adm-1", role: "ADMIN", isActive: true } });

    await patchLead(lead.id as string, { assignedAdminId: "adm-1" });

    expect(store.leads[0]!.assignedAdminId).toBe("adm-1");
    expect(eventsOfType("ASSIGNED")).toHaveLength(1);
  });

  it("re-posting the same assignee writes no second ASSIGNED event", async () => {
    const lead = await seedLead();
    await prismaMock.admin.create({ data: { id: "adm-1", role: "ADMIN", isActive: true } });

    await patchLead(lead.id as string, { assignedAdminId: "adm-1" });
    await patchLead(lead.id as string, { assignedAdminId: "adm-1" });

    expect(eventsOfType("ASSIGNED")).toHaveLength(1);
  });

  it("refuses a deactivated admin — a disabled account must not keep receiving leads", async () => {
    const lead = await seedLead();
    await prismaMock.admin.create({ data: { id: "adm-off", role: "ADMIN", isActive: false } });

    const res = await patchLead(lead.id as string, { assignedAdminId: "adm-off" });

    expect(res.status).toBe(404);
    expect(store.leads[0]!.assignedAdminId).toBeNull();
  });

  it("refuses an assignee that does not exist at all", async () => {
    const lead = await seedLead();
    const res = await patchLead(lead.id as string, { assignedAdminId: "ghost" });
    expect(res.status).toBe(404);
  });

  it("refuses a USER who does not hold the account, and names the fix", async () => {
    const lead = await seedLead();
    await prismaMock.admin.create({ data: { id: "user-1", role: "USER", isActive: true } });

    const res = await patchLead(lead.id as string, { assignedAdminId: "user-1" });
    const body = await readJson(res);

    expect(res.status).toBe(400);
    expect(String(body.error!.message)).toMatch(/does not have access/i);
    expect(store.leads[0]!.assignedAdminId).toBeNull();
  });

  it("accepts the same USER once the account has been granted", async () => {
    const lead = await seedLead();
    await prismaMock.admin.create({ data: { id: "user-1", role: "USER", isActive: true } });
    await prismaMock.accountAccess.create({ data: { adminId: "user-1", accountId: "acct-1" } });

    const res = await patchLead(lead.id as string, { assignedAdminId: "user-1" });

    expect(res.status).toBe(200);
    expect(store.leads[0]!.assignedAdminId).toBe("user-1");
  });

  it("leaves the assignment alone when the field is not submitted", async () => {
    const lead = await seedLead({ assignedAdminId: "adm-1" });
    await patchLead(lead.id as string, { status: "CONTACTED" });

    expect(store.leads[0]!.assignedAdminId).toBe("adm-1");
    expect(eventsOfType("ASSIGNED")).toHaveLength(0);
  });

  // ---------- the CRM columns, through the real endpoint ----------

  it("round-trips every new CRM field in one edit and logs one event per field that moved", async () => {
    const lead = await seedLead();

    const res = await patchLead(lead.id as string, {
      status: "WON",
      tags: ["  VIP  ", "vip", "warm   lead", ""],
      followUpAt: "2026-10-01T09:00:00.000Z",
      valueCents: 1_250_000,
      valueCurrency: "uzs",
      outcomeReason: "  Signed the annual plan  ",
    });
    const body = await readJson(res);
    expect(res.status).toBe(200);

    const row = store.leads[0]!;
    expect(row.tags).toEqual(["VIP", "warm lead"]); // trimmed, collapsed, de-duped
    expect((row.followUpAt as Date).toISOString()).toBe("2026-10-01T09:00:00.000Z");
    expect(row.valueCents).toBe(1_250_000);
    expect(row.valueCurrency).toBe("UZS"); // the schema upper-cases it
    expect(row.outcomeReason).toBe("Signed the annual plan"); // trimmed
    expect(row.status).toBe("WON");
    expect(body.ok).toBe(true);

    expect(eventsOfType("TAGS_CHANGED")).toHaveLength(1);
    expect(eventsOfType("FOLLOW_UP_CHANGED")).toHaveLength(1);
    expect(eventsOfType("VALUE_CHANGED")).toHaveLength(1);
    expect(eventsOfType("OUTCOME_CHANGED")).toHaveLength(1);
    expect(eventsOfType("STATUS_CHANGED")).toHaveLength(1);
    expect((eventsOfType("TAGS_CHANGED")[0]!.data as Row).added).toEqual(["VIP", "warm lead"]);
  });

  it("settles: re-submitting the identical edit writes no further events", async () => {
    const lead = await seedLead();
    const edit = {
      tags: ["vip"],
      followUpAt: "2026-10-01T09:00:00.000Z",
      valueCents: 500,
      valueCurrency: "USD",
    };
    await patchLead(lead.id as string, edit);
    const afterFirst = store.leadEvents.length;

    await patchLead(lead.id as string, edit);

    expect(store.leadEvents.length).toBe(afterFirst);
  });

  it("records only the field that actually moved", async () => {
    const lead = await seedLead({ tags: ["vip"], valueCents: 500, valueCurrency: "USD" });
    await patchLead(lead.id as string, { tags: ["vip"], valueCents: 900, valueCurrency: "USD" });

    expect(eventsOfType("TAGS_CHANGED")).toHaveLength(0);
    expect(eventsOfType("VALUE_CHANGED")).toHaveLength(1);
    expect((eventsOfType("VALUE_CHANGED")[0]!.data as Row).to).toEqual({ cents: 900, currency: "USD" });
  });

  it("clearing the follow-up date is a real change, not a no-op", async () => {
    const lead = await seedLead({ followUpAt: new Date("2026-10-01T09:00:00.000Z") });
    await patchLead(lead.id as string, { followUpAt: null });

    expect(store.leads[0]!.followUpAt).toBeNull();
    expect((eventsOfType("FOLLOW_UP_CHANGED")[0]!.data as Row).to).toBeNull();
  });

  it("refuses a deal value with no currency, with a message the admin can act on", async () => {
    const lead = await seedLead();
    const res = await patchLead(lead.id as string, { valueCents: 1000 });
    const body = await readJson(res);

    expect(res.status).toBe(400);
    expect(String(body.error!.message)).toMatch(/currency/i);
    expect(store.leads[0]!.valueCents).toBeNull();
  });

  it("refuses an amount larger than the INTEGER column, instead of a Postgres 500", async () => {
    const lead = await seedLead();
    // Passes the schema's own 1e12 ceiling, so only the domain rule can catch it.
    const res = await patchLead(lead.id as string, { valueCents: MAX_LEAD_VALUE_CENTS + 1, valueCurrency: "USD" });
    const body = await readJson(res);

    expect(res.status).toBe(400);
    expect(String(body.error!.message)).toMatch(/too large/i);
    expect(store.leads[0]!.valueCents).toBeNull();
  });

  it("refuses an outcome reason on a lead that is neither Won nor Lost", async () => {
    const lead = await seedLead({ status: "IN_PROGRESS" });
    const res = await patchLead(lead.id as string, { outcomeReason: "Budget" });

    expect(res.status).toBe(400);
    expect(store.leads[0]!.outcomeReason).toBeNull();
  });

  it("lets a won lead be dragged back to In progress even though it still carries an outcome reason", async () => {
    // The regression the rule is written against: the check must judge the
    // submitted edit, not the stored row, or a status-only PATCH would 400.
    const lead = await seedLead({ status: "WON", outcomeReason: "Signed" });
    const res = await patchLead(lead.id as string, { status: "IN_PROGRESS" });

    expect(res.status).toBe(200);
    expect(store.leads[0]!.status).toBe("IN_PROGRESS");
    expect(store.leads[0]!.outcomeReason).toBe("Signed");
  });

  it("accepts an outcome reason in the same PATCH that marks the lead Lost", async () => {
    const lead = await seedLead({ status: "IN_PROGRESS" });
    const res = await patchLead(lead.id as string, { status: "LOST", outcomeReason: "Chose a competitor" });

    expect(res.status).toBe(200);
    expect(store.leads[0]!.outcomeReason).toBe("Chose a competitor");
  });

  it("treats a whitespace-only outcome reason as clearing it", async () => {
    const lead = await seedLead({ status: "WON", outcomeReason: "Signed" });
    await patchLead(lead.id as string, { status: "WON", outcomeReason: "   " });

    expect(store.leads[0]!.outcomeReason).toBeNull();
  });

  // ---------- schema rejections ----------

  const badBodies: Array<[string, Record<string, unknown>]> = [
    ["an unknown status", { status: "ARCHIVED" }],
    ["a negative deal value", { valueCents: -1, valueCurrency: "USD" }],
    ["a fractional deal value", { valueCents: 10.5, valueCurrency: "USD" }],
    ["a deal value sent as a string", { valueCents: "1000", valueCurrency: "USD" }],
    ["a two-letter currency", { valueCents: 1000, valueCurrency: "US" }],
    ["a currency with digits", { valueCents: 1000, valueCurrency: "US1" }],
    ["a malformed email", { email: "not-an-email" }],
    ["a name past 200 characters", { name: "x".repeat(201) }],
    ["a phone past 40 characters", { phone: "9".repeat(41) }],
    ["notes past 4000 characters", { notes: "x".repeat(4001) }],
    ["an outcome reason past 300 characters", { outcomeReason: "x".repeat(301) }],
    ["more tags than the cap", { tags: Array.from({ length: MAX_LEAD_TAGS + 1 }, (_, i) => `t${i}`) }],
    ["a tag past the length cap", { tags: ["x".repeat(MAX_LEAD_TAG_LENGTH + 1)] }],
    ["tags that are not strings", { tags: [123] }],
    ["an unparseable follow-up date", { followUpAt: "next tuesday-ish" }],
  ];

  it.each(badBodies)("rejects %s with a 400 and changes nothing", async (_label, body) => {
    const lead = await seedLead();
    const before = JSON.stringify(store.leads[0]);

    const res = await patchLead(lead.id as string, body);

    expect(res.status).toBe(400);
    expect((await readJson(res)).ok).toBe(false);
    expect(JSON.stringify(store.leads[0])).toBe(before);
    expect(store.leadEvents).toHaveLength(0);
  });

  it("accepts the documented good shapes: null clears, a date-only string parses, an email is stored", async () => {
    const lead = await seedLead({ name: "Ali", email: "old@example.com" });

    const res = await patchLead(lead.id as string, {
      name: null,
      email: "new@example.com",
      followUpAt: "2026-10-01",
      notes: "Called twice",
    });

    expect(res.status).toBe(200);
    expect(store.leads[0]!.name).toBeNull();
    expect(store.leads[0]!.email).toBe("new@example.com");
    expect((store.leads[0]!.followUpAt as Date).toISOString()).toBe("2026-10-01T00:00:00.000Z");
  });

  // ---------- events, automations, audit and access ----------

  it("fires the LEAD_STATUS_CHANGED automation exactly once, and only on a real move", async () => {
    const lead = await seedLead({ status: "NEW" });

    await patchLead(lead.id as string, { status: "QUALIFIED" });
    expect(runAutomationsMock).toHaveBeenCalledTimes(1);
    expect(runAutomationsMock.mock.calls[0]![0]).toBe("LEAD_STATUS_CHANGED");
    expect((runAutomationsMock.mock.calls[0]![1] as Row).leadStatus).toBe("QUALIFIED");

    runAutomationsMock.mockClear();
    await patchLead(lead.id as string, { status: "QUALIFIED" }); // same status again
    expect(runAutomationsMock).not.toHaveBeenCalled();
    expect(eventsOfType("STATUS_CHANGED")).toHaveLength(1);
  });

  it("records NOTE_ADDED only when the note text actually changed", async () => {
    const lead = await seedLead({ notes: "first" });

    await patchLead(lead.id as string, { notes: "first" });
    expect(eventsOfType("NOTE_ADDED")).toHaveLength(0);

    await patchLead(lead.id as string, { notes: "second" });
    expect(eventsOfType("NOTE_ADDED")).toHaveLength(1);
  });

  it("writes an audit entry naming the CRM fields that changed", async () => {
    const lead = await seedLead();
    await patchLead(lead.id as string, { status: "WON", tags: ["vip"] });

    expect(store.auditLogs).toHaveLength(1);
    const entry = store.auditLogs[0]!;
    expect(entry.action).toBe("UPDATED_LEAD");
    expect(entry.resourceId).toBe(lead.id);
    expect((entry.after as Row).crm).toEqual(["TAGS_CHANGED"]);
    expect((entry.before as Row).status).toBe("NEW");
  });

  it("404s an unknown lead", async () => {
    await seedLead();
    const res = await patchLead("no-such-lead", { status: "WON" });
    expect(res.status).toBe(404);
  });

  it("401s when nobody is signed in, before touching the row", async () => {
    const lead = await seedLead();
    authState.current = null;

    const res = await patchLead(lead.id as string, { status: "WON" });

    expect(res.status).toBe(401);
    expect(store.leads[0]!.status).toBe("NEW");
  });

  it("403s a USER editing a lead on an account they were never granted", async () => {
    const lead = await seedLead();
    signIn({ id: "user-2", role: "USER" });

    const res = await patchLead(lead.id as string, { status: "WON" });

    expect(res.status).toBe(403);
    expect(store.leads[0]!.status).toBe("NEW");
  });

  it("lets a granted USER edit the lead", async () => {
    const lead = await seedLead();
    signIn({ id: "user-2", role: "USER" });
    await prismaMock.accountAccess.create({ data: { adminId: "user-2", accountId: "acct-1" } });

    const res = await patchLead(lead.id as string, { status: "WON" });

    expect(res.status).toBe(200);
    expect(store.leads[0]!.status).toBe("WON");
  });

  it("rejects a cross-origin edit — the CSRF defence is live on this route", async () => {
    const lead = await seedLead();
    const res = await patchLead(lead.id as string, { status: "WON" }, "https://evil.example.com");

    expect(res.status).toBe(403);
    expect(store.leads[0]!.status).toBe("NEW");
  });
});

// ============================================================== public landing-page submission

describe("POST /api/leads/public — the hosted form behind the Lead Button", () => {
  /**
   * The one endpoint an anonymous visitor can reach. It runs the SAME
   * validateAnswer rules as the DM engine, so this is also where the
   * admin-supplied answer pattern meets untrusted input: the anchoring and the
   * length bound have to hold here or nowhere.
   */
  async function seedForm(questions: Array<Partial<Row>>, opts: Partial<Row> = {}) {
    await prismaMock.instagramAccount.create({ data: { id: "acct-1", username: "shop" } });
    const flow = await prismaMock.leadFlow.create({ data: { name: "Signup", enabled: true, ...(opts.flow as Row) } });
    const cta = await prismaMock.ctaConfig.create({
      data: {
        accountId: "acct-1",
        landingSlug: "my-form",
        enabled: true,
        leadFlowId: flow.id,
        contentId: null,
        ...(opts.cta as Row),
      },
    });
    const created: Row[] = [];
    for (const [i, q] of questions.entries()) {
      created.push(
        await prismaMock.leadFlowQuestion.create({
          data: { flowId: flow.id, title: `Q${i + 1}`, prompt: `Q${i + 1}?`, type: "TEXT", order: i, ...q },
        }),
      );
    }
    return { flow, cta, questions: created };
  }

  it("creates the lead, maps the mapped fields into columns and queues processing", async () => {
    const { flow, cta, questions } = await seedForm([
      { title: "Ism", type: "TEXT", mapTo: "name" },
      { title: "Telefon", type: "PHONE", mapTo: "phone" },
      { title: "Email", type: "EMAIL", mapTo: "email" },
    ]);

    const res = await submitPublic({
      slug: "my-form",
      answers: {
        [questions[0]!.id as string]: "  Ali Valiyev ",
        [questions[1]!.id as string]: "+998 90 123-45-67",
        [questions[2]!.id as string]: "Ali@Example.COM",
      },
    });

    expect(res.status).toBe(200);
    expect((await readJson(res)).data).toEqual({ submitted: true });

    expect(store.leads).toHaveLength(1);
    const lead = store.leads[0]!;
    expect(lead.name).toBe("Ali Valiyev"); // trimmed by the engine
    expect(lead.phone).toBe("+998901234567"); // punctuation stripped
    expect(lead.email).toBe("ali@example.com"); // lower-cased
    expect(lead.source).toBe("landing_page");
    expect(lead.accountId).toBe("acct-1");
    expect(lead.flowId).toBe(flow.id);
    expect(lead.ctaConfigId).toBe(cta.id); // attribution back to the Lead Button
    expect(lead.status).toBe("NEW");
    // the flow/landing answer shape is the plain array
    expect(lead.answers).toEqual([
      { question: "Ism", answer: "Ali Valiyev" },
      { question: "Telefon", answer: "+998901234567" },
      { question: "Email", answer: "ali@example.com" },
    ]);

    expect(store.leadEvents.filter((e) => e.type === "CREATED")).toHaveLength(1);
    expect(enqueueMock).toHaveBeenCalledWith("lead.process", { leadId: lead.id }, { idempotencyKey: `lead.process:${lead.id}` });
  });

  it("silently drops a bot that fills the honeypot — no lead, no queue, no 400 that would teach it", async () => {
    const { questions } = await seedForm([{ title: "Ism", mapTo: "name" }]);

    const res = await submitPublic({
      slug: "my-form",
      answers: { [questions[0]!.id as string]: "Ali" },
      website: "http://spam.example.com",
    });

    expect(res.status).toBe(200);
    expect((await readJson(res)).data).toEqual({ submitted: true });
    expect(store.leads).toHaveLength(0);
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("404s an unknown slug, a disabled button, a button with no flow, and a disabled flow", async () => {
    await seedForm([{ title: "Ism" }]);

    expect((await submitPublic({ slug: "no-such-form", answers: {} })).status).toBe(404);

    store.ctaConfigs[0]!.enabled = false;
    expect((await submitPublic({ slug: "my-form", answers: {} })).status).toBe(404);

    store.ctaConfigs[0]!.enabled = true;
    store.ctaConfigs[0]!.leadFlowId = null;
    expect((await submitPublic({ slug: "my-form", answers: {} })).status).toBe(404);

    store.ctaConfigs[0]!.leadFlowId = store.leadFlows[0]!.id;
    store.leadFlows[0]!.enabled = false;
    expect((await submitPublic({ slug: "my-form", answers: {} })).status).toBe(404);

    expect(store.leads).toHaveLength(0);
  });

  it("names the question when a required answer is missing", async () => {
    const { questions } = await seedForm([
      { title: "Ism", required: true },
      { title: "Telefon", required: true, type: "PHONE" },
    ]);

    const res = await submitPublic({ slug: "my-form", answers: { [questions[0]!.id as string]: "Ali" } });
    const body = await readJson(res);

    expect(res.status).toBe(400);
    expect(String(body.error!.message)).toContain("Telefon");
    expect(store.leads).toHaveLength(0);
  });

  it("skips an unanswered optional question instead of storing an empty row", async () => {
    const { questions } = await seedForm([
      { title: "Ism", required: true },
      { title: "Izoh", required: false },
    ]);

    const res = await submitPublic({ slug: "my-form", answers: { [questions[0]!.id as string]: "Ali" } });

    expect(res.status).toBe(200);
    expect(store.leads[0]!.answers).toEqual([{ question: "Ism", answer: "Ali" }]);
  });

  it("ignores archived questions, so removing a question does not break the live form", async () => {
    const { questions } = await seedForm([
      { title: "Ism", order: 0 },
      { title: "Eski savol", order: ARCHIVED_QUESTION_ORDER, required: true },
    ]);

    const res = await submitPublic({ slug: "my-form", answers: { [questions[0]!.id as string]: "Ali" } });

    expect(res.status).toBe(200);
    expect(store.leads[0]!.answers).toEqual([{ question: "Ism", answer: "Ali" }]);
  });

  it("rejects an entirely empty submission rather than creating a blank lead", async () => {
    await seedForm([{ title: "Izoh", required: false }]);

    const res = await submitPublic({ slug: "my-form", answers: {} });
    const body = await readJson(res);

    expect(res.status).toBe(400);
    expect(String(body.error!.message)).toMatch(/empty/i);
    expect(store.leads).toHaveLength(0);
  });

  it("enforces the answer pattern as an ANCHORED whole-answer match on the public path", async () => {
    const { questions } = await seedForm([{ title: "Kod", type: "TEXT", validationRegex: "[A-Z]{3}-\\d+" }]);
    const qid = questions[0]!.id as string;

    const buried = await submitPublic({ slug: "my-form", answers: { [qid]: "junk ABC-1 junk" } });
    expect(buried.status).toBe(400);
    expect(store.leads).toHaveLength(0);

    const exact = await submitPublic({ slug: "my-form", answers: { [qid]: "ABC-1" } });
    expect(exact.status).toBe(200);
    expect(store.leads).toHaveLength(1);
  });

  it("bounds the text a pattern is fed — an answer past the cap is refused, never handed to the regex", async () => {
    const { questions } = await seedForm([{ title: "Kod", type: "TEXT", validationRegex: "[a-z]+" }]);
    const qid = questions[0]!.id as string;

    const atCap = await submitPublic({ slug: "my-form", answers: { [qid]: "a".repeat(MAX_VALIDATED_ANSWER_LENGTH) } });
    expect(atCap.status).toBe(200);

    const pastCap = await submitPublic({ slug: "my-form", answers: { [qid]: "a".repeat(MAX_VALIDATED_ANSWER_LENGTH + 1) } });
    expect(pastCap.status).toBe(400);
    expect(store.leads).toHaveLength(1);
  });

  it("a catastrophic pattern already sitting in the database cannot hang a submission", async () => {
    // The classic bomb. It must never have been storable, but if a row predates
    // the screen the public page still has to answer — the pattern is treated as
    // unusable and the answer is accepted rather than blocking a real customer.
    const { questions } = await seedForm([{ title: "Kod", type: "TEXT", validationRegex: "(a+)+$" }]);
    const qid = questions[0]!.id as string;
    const adversarial = `${"a".repeat(400)}!`;

    const started = Date.now();
    const res = await submitPublic({ slug: "my-form", answers: { [qid]: adversarial } });
    const elapsed = Date.now() - started;

    expect(res.status).toBe(200);
    expect(elapsed).toBeLessThan(1000);
    expect(store.leads).toHaveLength(1);
    expect(store.leads[0]!.answers).toEqual([{ question: "Kod", answer: adversarial }]);
  });

  it("the same bomb is refused at save time, which is why it can only ever be a legacy row", () => {
    expect(validationRegexIssue("(a+)+$")).not.toBeNull();
    expect(compileAnswerPattern("(a+)+$")).toBeNull();
    expect(testAnswerPattern("(a+)+$", "aaaaaaaaaaaaaaaaaaaaaaaaaaaa!")).toBeNull();
  });

  it("rate-limits one IP to 10 submissions per window", async () => {
    const { questions } = await seedForm([{ title: "Ism", mapTo: "name" }]);
    const body = { slug: "my-form", answers: { [questions[0]!.id as string]: "Ali" } };
    const ip = "203.0.113.77";

    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await submitPublic(body, ip)).status);

    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(200));
    expect(statuses[10]).toBe(429);
    expect(store.leads).toHaveLength(10);
  });

  it("rejects an oversized or overstuffed answer map before any question is read", async () => {
    const { questions } = await seedForm([{ title: "Ism" }]);
    const qid = questions[0]!.id as string;

    const tooLong = await submitPublic({ slug: "my-form", answers: { [qid]: "x".repeat(2001) } });
    expect(tooLong.status).toBe(400);

    const tooMany: Record<string, string> = {};
    for (let i = 0; i < 31; i++) tooMany[`q${i}`] = "x";
    const overstuffed = await submitPublic({ slug: "my-form", answers: tooMany });
    expect(overstuffed.status).toBe(400);

    expect(store.leads).toHaveLength(0);
  });

  it("rejects a malformed slug without looking anything up", async () => {
    await seedForm([{ title: "Ism" }]);
    expect((await submitPublic({ slug: "ab", answers: {} })).status).toBe(400);
    expect((await submitPublic({ slug: "x".repeat(41), answers: {} })).status).toBe(400);
  });

  it("applies every typed question rule the DM engine applies", async () => {
    const { questions } = await seedForm([
      { title: "Yosh", type: "NUMBER" },
      { title: "Sana", type: "DATE" },
      { title: "Vaqt", type: "TIME" },
      { title: "Rozimisiz", type: "BOOLEAN" },
      { title: "Xizmat", type: "SINGLE_SELECT", options: ["SMM", "Ads"] },
    ]);
    const id = (i: number) => questions[i]!.id as string;

    const bad = await submitPublic({
      slug: "my-form",
      answers: { [id(0)]: "abc", [id(1)]: "2026-01-01", [id(2)]: "14:30", [id(3)]: "ha", [id(4)]: "1" },
    });
    expect(bad.status).toBe(400);
    expect(String((await readJson(bad)).error!.message)).toContain("Yosh");

    const good = await submitPublic({
      slug: "my-form",
      answers: { [id(0)]: "25", [id(1)]: "15.09.2026", [id(2)]: "14:30", [id(3)]: "ha", [id(4)]: "1" },
    });
    expect(good.status).toBe(200);
    expect(store.leads[0]!.answers).toEqual([
      { question: "Yosh", answer: "25" },
      { question: "Sana", answer: "2026-09-15" }, // normalized
      { question: "Vaqt", answer: "14:30" },
      { question: "Rozimisiz", answer: "Yes" }, // "ha" understood
      { question: "Xizmat", answer: "SMM" }, // chosen by its number
    ]);
  });
});

// ============================================================== tag truncation is Unicode-safe

describe("lead tags — truncation must not invent a broken character", () => {
  const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

  /**
   * `String.slice` counts UTF-16 units. Cutting at unit 40 lands in the middle
   * of a 4-byte character whenever the preceding text is an odd number of
   * units, and the leftover half is a lone surrogate — which PostgreSQL rejects
   * as invalid UTF-8. The board's tag filter (GET /api/leads?tags=…) has no
   * length guard of its own, so it feeds this straight into a Prisma `hasSome`.
   */
  const overLong: Array<[string, string]> = [
    ["an odd-length prefix before emoji", `a${"\u{1F600}".repeat(25)}`],
    ["emoji landing exactly on the boundary", `${"x".repeat(39)}\u{1F600}${"y".repeat(10)}`],
    ["pure emoji", "\u{1F600}".repeat(25)],
    ["a regional-indicator flag run", "\u{1F1FA}\u{1F1FF}".repeat(15)],
    ["astral script (Gothic)", "\u{10330}".repeat(30)],
  ];

  it.each(overLong)("never emits a half character when clipping %s", (_label, input) => {
    const [tag] = normalizeLeadTags([input]);

    expect(tag).toBeDefined();
    expect(LONE_SURROGATE.test(tag!), `lone surrogate in ${JSON.stringify(tag)}`).toBe(false);
    // round-trips through UTF-8 unchanged, which is what the database requires
    expect(Buffer.from(tag!, "utf8").toString("utf8")).toBe(tag);
  });

  it("caps at 40 characters as a person counts them, not 40 UTF-16 units", () => {
    const [tag] = normalizeLeadTags(["\u{1F600}".repeat(60)]);
    expect([...tag!]).toHaveLength(MAX_LEAD_TAG_LENGTH);
  });

  it("still clips plain ASCII at exactly the documented length", () => {
    expect(normalizeLeadTags(["x".repeat(MAX_LEAD_TAG_LENGTH + 5)])).toEqual(["x".repeat(MAX_LEAD_TAG_LENGTH)]);
    expect(normalizeLeadTags(["x".repeat(MAX_LEAD_TAG_LENGTH)])).toEqual(["x".repeat(MAX_LEAD_TAG_LENGTH)]);
  });

  it("is still idempotent once a multi-byte tag has been clipped", () => {
    const once = normalizeLeadTags([`a${"\u{1F600}".repeat(25)}`]);
    expect(normalizeLeadTags(once)).toEqual(once);
  });

  it("keeps the earlier guarantees: no ragged trailing space, case-insensitive de-duplication", () => {
    // the cut lands exactly on the space, which must not survive as "xxx… "
    expect(normalizeLeadTags([`${"x".repeat(39)} yz`])).toEqual([`${"x".repeat(39)}`]);
    expect(normalizeLeadTags(["VIP", "vip "])).toEqual(["VIP"]);
  });
});

// ============================================================== known gaps (proved, not papered over)

describe("known gaps — behaviour recorded so it is not mistaken for correct", () => {
  const OWNER = { id: "owner-1", role: "OWNER" as const };

  async function seedLead(overrides: Partial<Row> = {}) {
    await prismaMock.instagramAccount.create({ data: { id: "acct-1", username: "shop" } });
    return prismaMock.lead.create({ data: { accountId: "acct-1", name: "Ali", status: "NEW", ...overrides } });
  }

  /**
   * FIXED during the audit. `z.coerce.date()` runs `new Date(input)` on
   * anything: `new Date(true)` is the epoch plus a millisecond, so a malformed
   * client used to get a 200 and a reminder dated 1970-01-01 instead of a 400.
   * The schema now coerces only from a string (or a Date), and these tests are
   * the regression fence.
   */
  it.each([
    ["a boolean true", true],
    ["a boolean false", false],
    ["a raw epoch number", 0],
    ["a millisecond timestamp", 1_760_000_000_000],
    ["an object", { year: 2026 }],
    ["an array", ["2026-10-01"]],
  ])("rejects followUpAt sent as %s, instead of silently dating the reminder 1970", async (_label, value) => {
    signIn(OWNER);
    const lead = await seedLead();

    const res = await patchLead(lead.id as string, { followUpAt: value });

    expect(res.status).toBe(400);
    expect((await readJson(res)).ok).toBe(false);
    expect(store.leads[0]!.followUpAt).toBeNull();
    expect(store.leadEvents).toHaveLength(0);
  });

  it("still accepts the shapes the CRM actually posts: an ISO instant, a date-only string and null", async () => {
    signIn(OWNER);
    const lead = await seedLead({ followUpAt: new Date("2026-01-01T00:00:00.000Z") });

    expect((await patchLead(lead.id as string, { followUpAt: "2026-10-01T09:00:00.000Z" })).status).toBe(200);
    expect((store.leads[0]!.followUpAt as Date).toISOString()).toBe("2026-10-01T09:00:00.000Z");

    expect((await patchLead(lead.id as string, { followUpAt: "2026-11-02" })).status).toBe(200);
    expect((store.leads[0]!.followUpAt as Date).toISOString()).toBe("2026-11-02T00:00:00.000Z");

    expect((await patchLead(lead.id as string, { followUpAt: null })).status).toBe(200);
    expect(store.leads[0]!.followUpAt).toBeNull();
  });

  it("GAP: a landing-page form has no duplicate guard, so a double submit creates two leads", async () => {
    await prismaMock.instagramAccount.create({ data: { id: "acct-1", username: "shop" } });
    const flow = await prismaMock.leadFlow.create({ data: { name: "Signup", enabled: true } });
    await prismaMock.ctaConfig.create({
      data: { accountId: "acct-1", landingSlug: "dup-form", enabled: true, leadFlowId: flow.id, contentId: null },
    });
    const q = await prismaMock.leadFlowQuestion.create({
      data: { flowId: flow.id, title: "Telefon", prompt: "?", type: "PHONE", mapTo: "phone", order: 0 },
    });
    const body = { slug: "dup-form", answers: { [q.id as string]: "+998901234567" } };

    await submitPublic(body, "198.51.100.9");
    await submitPublic(body, "198.51.100.9");

    // Lead ads are de-duplicated by leadgenId; the landing page has no equivalent,
    // so the same phone number arrives twice and the board shows it twice.
    expect(store.leads).toHaveLength(2);
    expect(store.leads[0]!.phone).toBe(store.leads[1]!.phone);
    expect(enqueueMock).toHaveBeenCalledTimes(2);
  });

  it("GAP: a TEXT answer between 1000 and 2000 characters is silently truncated on the way in", async () => {
    // The public schema accepts 2000 characters; validateAnswer stores 1000.
    // Nothing tells the visitor their answer was cut.
    await prismaMock.instagramAccount.create({ data: { id: "acct-1", username: "shop" } });
    const flow = await prismaMock.leadFlow.create({ data: { name: "Signup", enabled: true } });
    await prismaMock.ctaConfig.create({
      data: { accountId: "acct-1", landingSlug: "long-form", enabled: true, leadFlowId: flow.id, contentId: null },
    });
    const q = await prismaMock.leadFlowQuestion.create({
      data: { flowId: flow.id, title: "Izoh", prompt: "?", type: "TEXT", order: 0 },
    });

    const res = await submitPublic({ slug: "long-form", answers: { [q.id as string]: "x".repeat(1500) } });

    expect(res.status).toBe(200);
    const stored = (store.leads[0]!.answers as Array<{ answer: string }>)[0]!.answer;
    expect(stored).toHaveLength(1000); // 500 characters lost without a word to the visitor
  });
});

// ==========================================================================
// AUDIT ADDITIONS — paths the first sweep left unexercised, plus the specific
// evidence its report claimed but did not have a test for.
// ==========================================================================

// ---------------------------------------------------------------- ReDoS: the shapes the report named

describe("answer-pattern screen — the catalogue the report claimed, actually run", () => {
  /**
   * The first sweep's report listed patterns (`(a*)*$`, `(.*a){20}$`,
   * "backreference-under-repeat forms") and a timing sweep at n=32..512 that no
   * test in the file actually performed. Both are done here for real.
   */
  const MUST_REJECT = [
    "(a*)*$",
    "(.*a){20}$",
    "(a|ab)+$",
    "(a+)*b",
    "([a-z]+)+$",
    "(\\d+)+$",
    "(a|b|ab)*c",
    "^(?:\\w+\\.?)*@",
    "(\\s*\\w+)*$",
    "^(([a-z])+.)+[A-Z]([a-z])+$",
    "(a{2,})+$",
    "([^,]*,){10}$",
    "^(a|a?)+$",
    "(\\w|\\d)+$",
    "^([a-zA-Z0-9]+[._-]?)*@",
    "(.*){10}x",
    "([a-z]|[a-z])+$",
    "(?:a|a)*$",
    "^(\\d+,?)+$",
    "(a?){20}a{20}",
    "^(.*?,){11}P",
    "(\\d|\\d\\d)+$",
    "((ab)*)*c",
    "(a+|b)+$",
    "(\\w+)(\\w+)(\\w+)(\\w+)x",
    "^[\\s\\S]*[\\s\\S]*[\\s\\S]*[\\s\\S]*!$",
    "\\w*\\w*\\w*\\w*!",
  ];

  it.each(MUST_REJECT)("refuses %s at save time", (pattern) => {
    expect(validationRegexIssue(pattern), pattern).not.toBeNull();
    // and the refusal is total: nothing downstream will ever run it
    expect(compileAnswerPattern(pattern), pattern).toBeNull();
    expect(
      safeQuestionSchema.safeParse({ title: "t", prompt: "p", type: "TEXT", validationRegex: pattern }).success,
      pattern,
    ).toBe(false);
  });

  /**
   * Backreferences survive the screen (no group is repeated, and a chain of
   * three open-ended repeats is within budget). The report asserted they are
   * fast without measuring; measure them, growing the answer towards the cap.
   */
  const BACKREFERENCE_SURVIVORS = ["(\\w+)\\1+$", "^(a+)\\1+$", "(\\w+)\\1{1,10}$"];

  it.each(BACKREFERENCE_SURVIVORS)("%s survives the screen and stays fast from n=32 up to the answer cap", (pattern) => {
    expect(validationRegexIssue(pattern), pattern).toBeNull();
    const re = compileAnswerPattern(pattern);
    expect(re).not.toBeNull();

    let worst = 0;
    for (let n = 32; n <= MAX_VALIDATED_ANSWER_LENGTH; n *= 2) {
      const adversarial = `${"a".repeat(n - 1)}!`; // matches the prefix, fails at the very end
      const started = process.hrtime.bigint();
      expect(re!.test(adversarial)).toBe(false);
      worst = Math.max(worst, Number(process.hrtime.bigint() - started) / 1e6);
    }
    expect(worst, `${pattern} worst case ${worst.toFixed(2)}ms`).toBeLessThan(50);
  });

  it("an accepted degree-3 chain is the screen's real worst case, and it is bounded", () => {
    // Documented cost, not a hidden one: three overlapping open-ended repeats
    // are allowed, and on a maximal answer they are the slowest thing the
    // public form can be made to run. Measured so a regression that raises
    // MAX_OPEN_ENDED_REPEATS or MAX_VALIDATED_ANSWER_LENGTH shows up here.
    const pattern = "[a-z]+[a-z]+[a-z]+x";
    expect(validationRegexIssue(pattern)).toBeNull();
    const started = Date.now();
    expect(testAnswerPattern(pattern, `${"a".repeat(MAX_VALIDATED_ANSWER_LENGTH - 1)}!`)).toBe(false);
    const elapsed = Date.now() - started;
    expect(elapsed, `degree-3 chain took ${elapsed}ms`).toBeLessThan(1500);
    // a fourth repeat crosses the budget and is refused outright
    expect(validationRegexIssue("[a-z]+[a-z]+[a-z]+[a-z]+x")).toMatch(/open-ended/);
  });
});

// ---------------------------------------------------------------- PUT /api/lead-button

describe("PUT /api/lead-button — saving the Lead Button itself", () => {
  /**
   * The group's namesake endpoint, and the one the first sweep never called:
   * it only parsed `leadButtonSaveSchema`. Everything here runs the real route —
   * account guard, CSRF, the interactive transaction (flow upsert →
   * syncFlowQuestions → session cancellation → CtaConfig upsert) and the audit
   * entry — against the in-memory Prisma.
   */
  const OWNER = { id: "owner-1", role: "OWNER" as const };

  const payload = (over: Record<string, unknown> = {}) => ({
    accountId: "acct-1",
    enabled: true,
    headline: "Bepul konsultatsiya",
    description: "Formani to'ldiring",
    completionMessage: "Rahmat!",
    buttonSpec: { label: "Boshlash", bg: "#4f46e5", fg: "#ffffff", shape: "pill", size: "lg" },
    contentId: null,
    ctaType: "SIGN_UP",
    triggerKeywords: ["  START ", "start", "Narx"],
    questions: [
      { title: "Ism", prompt: "Ismingiz?", type: "TEXT", mapTo: "name" },
      { title: "Telefon", prompt: "Telefoningiz?", type: "PHONE", mapTo: "phone" },
    ],
    ...over,
  });

  const save = (body: unknown, origin?: string) => send(SAVE_LEAD_BUTTON, "PUT", "/api/lead-button", body, origin);

  beforeEach(async () => {
    signIn(OWNER);
    await prismaMock.instagramAccount.create({ data: { id: "acct-1", username: "shop", adAccountId: null } });
  });

  it("creates the flow, the questions and the hosted page — and the slug it mints really serves the form", async () => {
    const res = await save(payload());
    const body = await readJson(res);
    expect(res.status).toBe(200);

    const button = body.data!.leadButton as Row;
    expect(button).not.toBeNull();
    expect(button.headline).toBe("Bepul konsultatsiya");
    expect(button.enabled).toBe(true);
    expect(button.buttonSpec).toMatchObject({ shape: "pill", size: "lg", label: "Boshlash" });
    // keywords are trimmed, lower-cased and de-duplicated on the way in
    expect(store.leadFlows[0]!.triggerKeywords).toEqual(["start", "narx"]);
    // questions are stored 1-based, in the order the builder listed them
    expect(store.questions.map((q) => [q.order, q.title])).toEqual([
      [1, "Ism"],
      [2, "Telefon"],
    ]);
    expect(store.ctaConfigs).toHaveLength(1);
    const slug = store.ctaConfigs[0]!.landingSlug as string;
    expect(slug).toMatch(/^[a-z0-9]{3,10}$/);
    expect(button.landingUrl).toBe(`http://localhost:3000/f/${slug}`);
    expect(store.auditLogs.map((a) => a.action)).toEqual(["SAVED_LEAD_BUTTON"]);

    // THE proof that the two halves of this group agree: post the form the
    // save just created, through the real public endpoint, using its own slug.
    const [ism, telefon] = store.questions;
    const submitted = await submitPublic({
      slug,
      answers: { [ism!.id as string]: " Ali Valiyev ", [telefon!.id as string]: "+998 90 123 45 67" },
    });
    expect(submitted.status).toBe(200);
    expect(store.leads).toHaveLength(1);
    expect(store.leads[0]).toMatchObject({
      name: "Ali Valiyev",
      phone: "+998901234567",
      source: "landing_page",
      accountId: "acct-1",
      ctaConfigId: store.ctaConfigs[0]!.id,
      flowId: store.leadFlows[0]!.id,
    });
  });

  it("re-saving edits the SAME button in place — the slug and the leads already captured survive", async () => {
    await save(payload());
    const configId = store.ctaConfigs[0]!.id;
    const slug = store.ctaConfigs[0]!.landingSlug;
    const flowId = store.leadFlows[0]!.id;
    await prismaMock.lead.create({ data: { accountId: "acct-1", ctaConfigId: configId, flowId, source: "landing_page" } });

    const res = await save(
      payload({ headline: "Yangi sarlavha", buttonSpec: { label: "Yozilish", bg: "#000000", fg: "#ffffff" } }),
    );
    const button = (await readJson(res)).data!.leadButton as Row;

    expect(res.status).toBe(200);
    expect(store.ctaConfigs).toHaveLength(1);
    expect(store.ctaConfigs[0]!.id).toBe(configId);
    expect(store.ctaConfigs[0]!.landingSlug).toBe(slug); // a new slug would orphan every printed link
    expect(store.leadFlows).toHaveLength(1);
    expect(store.leadFlows[0]!.id).toBe(flowId);
    expect(button.headline).toBe("Yangi sarlavha");
    expect(button.leadsCount).toBe(1);
  });

  it("a colour-only re-save leaves a customer mid-form alone; changing a question cancels the session", async () => {
    await save(payload());
    const flowId = store.leadFlows[0]!.id;
    await prismaMock.leadFlowSession.create({ data: { flowId, accountId: "acct-1", conversationId: "c1", status: "ACTIVE" } });

    await save(payload({ buttonSpec: { label: "Boshlash", bg: "#ff0000", fg: "#ffffff", shape: "square" } }));
    expect(store.flowSessions[0]!.status).toBe("ACTIVE");

    await save(
      payload({
        questions: [
          { title: "Ism", prompt: "Ismingiz?", type: "TEXT", mapTo: "name" },
          { title: "Telefon", prompt: "Telefon raqamingiz?", type: "PHONE", mapTo: "phone" },
        ],
      }),
    );
    expect(store.flowSessions[0]!.status).toBe("CANCELLED");
  });

  it("refuses a question whose answer pattern could hang the public page, and writes nothing at all", async () => {
    const res = await save(payload({ questions: [{ title: "Kod", prompt: "Kod?", type: "TEXT", validationRegex: "(a+)+$" }] }));
    const body = await readJson(res);

    expect(res.status).toBe(400);
    expect(JSON.stringify(body.error)).toMatch(/Answer pattern/);
    expect(store.leadFlows).toHaveLength(0);
    expect(store.ctaConfigs).toHaveLength(0);
    expect(store.questions).toHaveLength(0);
    expect(store.auditLogs).toHaveLength(0);
  });

  it("refuses an unsupported native CTA type instead of sending Meta a value it will reject", async () => {
    const res = await save(payload({ ctaType: "BUY_TICKETS" }));
    expect(res.status).toBe(400);
    expect(String((await readJson(res)).error!.message)).toMatch(/Unsupported native CTA type/i);
    expect(store.ctaConfigs).toHaveLength(0);

    expect((await save(payload({ ctaType: null }))).status).toBe(200); // "no native CTA" is allowed
  });

  it("refuses a Reel that belongs to a different Instagram account", async () => {
    await prismaMock.instagramAccount.create({ data: { id: "acct-2", username: "other" } });
    await prismaMock.contentItem.create({ data: { id: "cont-x", accountId: "acct-2" } });

    const res = await save(payload({ contentId: "cont-x" }));

    expect(res.status).toBe(400);
    expect(String((await readJson(res)).error!.message)).toMatch(/does not belong/i);
    expect(store.ctaConfigs).toHaveLength(0);
  });

  it("targets a Reel on the same account", async () => {
    await prismaMock.contentItem.create({ data: { id: "cont-1", accountId: "acct-1", caption: "Reel" } });
    const res = await save(payload({ contentId: "cont-1" }));
    expect(res.status).toBe(200);
    expect(store.ctaConfigs[0]!.contentId).toBe("cont-1");
  });

  it("repairs a Lead Button whose flow was deleted underneath it, keeping the slug and the leads", async () => {
    await save(payload());
    const configId = store.ctaConfigs[0]!.id;
    const slug = store.ctaConfigs[0]!.landingSlug;
    await prismaMock.lead.create({ data: { accountId: "acct-1", ctaConfigId: configId, source: "landing_page" } });
    // the flow row disappears (a manual delete, a cascade); leadFlowId carries no FK
    store.leadFlows.length = 0;
    store.questions.length = 0;

    const res = await save(payload());

    expect(res.status).toBe(200);
    expect(store.ctaConfigs).toHaveLength(1);
    expect(store.ctaConfigs[0]!.id).toBe(configId);
    expect(store.ctaConfigs[0]!.landingSlug).toBe(slug);
    expect(store.leadFlows).toHaveLength(1);
    expect(store.ctaConfigs[0]!.leadFlowId).toBe(store.leadFlows[0]!.id);
    expect(((await readJson(res)).data!.leadButton as Row).leadsCount).toBe(1);
  });

  it("404s an account that does not exist and never starts the transaction", async () => {
    const res = await save(payload({ accountId: "nope" }));
    expect(res.status).toBe(404);
    expect(store.leadFlows).toHaveLength(0);
  });

  it("enforces sign-in, account access and the same-origin check", async () => {
    authState.current = null;
    expect((await save(payload())).status).toBe(401);

    signIn({ id: "user-1", role: "USER" });
    expect((await save(payload())).status).toBe(403);
    expect(store.ctaConfigs).toHaveLength(0);

    await prismaMock.accountAccess.create({ data: { adminId: "user-1", accountId: "acct-1" } });
    expect((await save(payload())).status).toBe(200);

    signIn(OWNER);
    expect((await save(payload(), "https://evil.example.com")).status).toBe(403);
  });

  it("GET reads the saved button back, and a garbage stored spec falls back to the shipped default", async () => {
    await save(payload());
    store.ctaConfigs[0]!.buttonSpec = "not-json-at-all";

    const res = await get(READ_LEAD_BUTTON, "/api/lead-button?accountId=acct-1");
    const data = (await readJson(res)).data!;

    expect(res.status).toBe(200);
    expect((data.leadButton as Row).buttonSpec).toEqual(DEFAULT_BUTTON_SPEC);
    expect((data.leadButton as Row).questions).toHaveLength(2);
    expect((data.nativeCtaTypes as Array<{ value: string }>).map((c) => c.value)).toContain("SIGN_UP");
    expect(data.adsReady).toBe(false); // no ad account connected yet
  });

  it("GET reports 'not set up yet' rather than a half-broken button when the flow is gone", async () => {
    await save(payload());
    store.leadFlows.length = 0;

    const res = await get(READ_LEAD_BUTTON, "/api/lead-button?accountId=acct-1");

    expect(res.status).toBe(200);
    expect((await readJson(res)).data!.leadButton).toBeNull();
  });

  it("GET requires an accountId and refuses an unknown one", async () => {
    expect((await get(READ_LEAD_BUTTON, "/api/lead-button")).status).toBe(400);
    expect((await get(READ_LEAD_BUTTON, "/api/lead-button?accountId=ghost")).status).toBe(404);
  });
});

// ---------------------------------------------------------------- GET /api/leads (the board)

describe("GET /api/leads — the CRM board query", () => {
  const OWNER = { id: "owner-1", role: "OWNER" as const };
  const at = (iso: string) => new Date(iso);

  async function seedBoard() {
    await prismaMock.instagramAccount.create({ data: { id: "acct-1", username: "shop" } });
    await prismaMock.instagramAccount.create({ data: { id: "acct-2", username: "other" } });
    await prismaMock.lead.create({
      data: {
        id: "L1",
        accountId: "acct-1",
        name: "Ali Valiyev",
        phone: "+998901234567",
        email: "ali@example.com",
        status: "NEW",
        tags: ["VIP"],
        followUpAt: at("2020-01-01T00:00:00.000Z"),
        createdAt: at("2026-01-03T00:00:00.000Z"),
      },
    });
    await prismaMock.lead.create({
      data: {
        id: "L2",
        accountId: "acct-1",
        name: "Bobur",
        status: "WON",
        tags: ["hot lead"],
        outcomeReason: "Signed the annual plan",
        followUpAt: at("2099-01-01T00:00:00.000Z"),
        createdAt: at("2026-01-02T00:00:00.000Z"),
      },
    });
    await prismaMock.lead.create({
      data: { id: "L3", accountId: "acct-2", name: "Dilnoza", status: "NEW", tags: [], createdAt: at("2026-01-01T00:00:00.000Z") },
    });
  }

  const ids = async (res: Response) => ((await readJson(res)).data!.leads as Row[]).map((l) => l.id);

  beforeEach(async () => {
    signIn(OWNER);
    await seedBoard();
  });

  it("returns every account's leads newest first for staff, with the total", async () => {
    const res = await get(LIST_LEADS, "/api/leads");
    const data = (await readJson(res)).data!;

    expect(res.status).toBe(200);
    expect((data.leads as Row[]).map((l) => l.id)).toEqual(["L1", "L2", "L3"]);
    expect(data.total).toBe(3);
    expect(data.hasMore).toBe(false);
    // the joins the board renders are really loaded, not left undefined
    expect(((data.leads as Row[])[0]!.account as Row).username).toBe("shop");
  });

  it("breaks a createdAt tie on id so paging can never skip or repeat a lead", async () => {
    const same = at("2026-02-02T00:00:00.000Z");
    await prismaMock.lead.create({ data: { id: "Za", accountId: "acct-1", createdAt: same } });
    await prismaMock.lead.create({ data: { id: "Zb", accountId: "acct-1", createdAt: same } });

    const page1 = await ids(await get(LIST_LEADS, "/api/leads?limit=1&offset=0"));
    const page2 = await ids(await get(LIST_LEADS, "/api/leads?limit=1&offset=1"));

    expect(page1).toEqual(["Zb"]); // id desc breaks the tie
    expect(page2).toEqual(["Za"]);
  });

  it("pages, and reports hasMore honestly at each end", async () => {
    const first = await readJson(await get(LIST_LEADS, "/api/leads?limit=2&offset=0"));
    expect((first.data!.leads as Row[]).map((l) => l.id)).toEqual(["L1", "L2"]);
    expect(first.data!.total).toBe(3);
    expect(first.data!.hasMore).toBe(true);

    const last = await readJson(await get(LIST_LEADS, "/api/leads?limit=2&offset=2"));
    expect((last.data!.leads as Row[]).map((l) => l.id)).toEqual(["L3"]);
    expect(last.data!.hasMore).toBe(false);
  });

  it("filters by status, and ignores a status that is not one of ours instead of 400ing the board", async () => {
    expect(await ids(await get(LIST_LEADS, "/api/leads?status=WON"))).toEqual(["L2"]);
    const junk = await get(LIST_LEADS, "/api/leads?status=ARCHIVED");
    expect(junk.status).toBe(200);
    expect(await ids(junk)).toEqual(["L1", "L2", "L3"]);
  });

  it("filters by tag, normalizing the comma-separated string the board sends", async () => {
    expect(await ids(await get(LIST_LEADS, "/api/leads?tags=%20VIP%20,vip,"))).toEqual(["L1"]);
    expect(await ids(await get(LIST_LEADS, "/api/leads?tags=hot%20%20%20lead"))).toEqual(["L2"]);
    expect(await ids(await get(LIST_LEADS, "/api/leads?tags=VIP,hot%20lead"))).toEqual(["L1", "L2"]);
    // an empty tags param must not filter everything away
    expect(await ids(await get(LIST_LEADS, "/api/leads?tags="))).toEqual(["L1", "L2", "L3"]);
  });

  it("GAP: the tag filter is case-sensitive even though tag de-duplication is not", async () => {
    // normalizeLeadTags de-duplicates case-insensitively but keeps the FIRST
    // spelling, so two leads can legitimately hold "VIP" and "vip". The filter
    // is a Postgres `hasSome` on the array, which compares exactly — so
    // searching one spelling silently hides the other.
    await prismaMock.lead.create({ data: { id: "L4", accountId: "acct-1", tags: ["vip"], createdAt: at("2026-01-04T00:00:00.000Z") } });

    expect(await ids(await get(LIST_LEADS, "/api/leads?tags=VIP"))).toEqual(["L1"]);
    expect(await ids(await get(LIST_LEADS, "/api/leads?tags=vip"))).toEqual(["L4"]);
  });

  it("filters by follow-up state", async () => {
    expect(await ids(await get(LIST_LEADS, "/api/leads?followUp=overdue"))).toEqual(["L1"]);
    expect(await ids(await get(LIST_LEADS, "/api/leads?followUp=scheduled"))).toEqual(["L1", "L2"]);
    expect(await ids(await get(LIST_LEADS, "/api/leads?followUp=none"))).toEqual(["L3"]);
    expect(await ids(await get(LIST_LEADS, "/api/leads?followUp=nonsense"))).toEqual(["L1", "L2", "L3"]);
  });

  it("searches name, email and the outcome reason case-insensitively, and the phone exactly", async () => {
    expect(await ids(await get(LIST_LEADS, "/api/leads?q=ali%20valiyev"))).toEqual(["L1"]);
    expect(await ids(await get(LIST_LEADS, "/api/leads?q=ALI@EXAMPLE.COM"))).toEqual(["L1"]);
    expect(await ids(await get(LIST_LEADS, "/api/leads?q=annual"))).toEqual(["L2"]);
    expect(await ids(await get(LIST_LEADS, "/api/leads?q=9012345"))).toEqual(["L1"]);
    expect(await ids(await get(LIST_LEADS, "/api/leads?q=nobody"))).toEqual([]);
  });

  it("scopes a USER to the accounts they hold, and refuses one they do not", async () => {
    signIn({ id: "user-1", role: "USER" });
    await prismaMock.accountAccess.create({ data: { adminId: "user-1", accountId: "acct-1" } });

    expect(await ids(await get(LIST_LEADS, "/api/leads"))).toEqual(["L1", "L2"]);
    expect(await ids(await get(LIST_LEADS, "/api/leads?accountId=acct-1"))).toEqual(["L1", "L2"]);

    const refused = await get(LIST_LEADS, "/api/leads?accountId=acct-2");
    expect(refused.status).toBe(403);
  });

  it("401s when nobody is signed in", async () => {
    authState.current = null;
    expect((await get(LIST_LEADS, "/api/leads")).status).toBe(401);
  });
});

// ---------------------------------------------------------------- POST /api/leads (manual entry)

describe("POST /api/leads — a lead typed in by hand", () => {
  const OWNER = { id: "owner-1", role: "OWNER" as const };
  const create = (body: unknown, origin?: string) => send(CREATE_LEAD, "POST", "/api/leads", body, origin);

  beforeEach(async () => {
    signIn(OWNER);
    await prismaMock.instagramAccount.create({ data: { id: "acct-1", username: "shop" } });
  });

  it("stores the lead as a manual one, records who created it, and audits it", async () => {
    const res = await create({ accountId: "acct-1", name: "Ali", phone: "+998901234567", notes: "walked in" });
    const body = await readJson(res);

    expect(res.status).toBe(200);
    expect(store.leads).toHaveLength(1);
    expect(store.leads[0]).toMatchObject({ name: "Ali", source: "manual", status: "NEW", accountId: "acct-1" });
    expect(body.data!.lead).toMatchObject({ name: "Ali" });
    expect(store.leadEvents).toHaveLength(1);
    expect(store.leadEvents[0]).toMatchObject({ type: "CREATED", adminId: "owner-1", data: { manual: true } });
    expect(store.auditLogs[0]).toMatchObject({ action: "CREATED_LEAD", resourceId: store.leads[0]!.id });
    expect(enqueueMock).not.toHaveBeenCalled(); // notify defaults to off
  });

  it("only queues the notification when the admin asked for one, and idempotently", async () => {
    await create({ accountId: "acct-1", name: "Ali", notify: true });
    expect(enqueueMock).toHaveBeenCalledWith(
      "lead.process",
      { leadId: store.leads[0]!.id },
      { idempotencyKey: `lead.process:${store.leads[0]!.id}` },
    );
  });

  it("rejects a bad body without creating anything", async () => {
    for (const bad of [
      { accountId: "acct-1", email: "not-an-email" },
      { accountId: "", name: "Ali" },
      { accountId: "acct-1", status: "ARCHIVED" },
      { accountId: "acct-1", notes: "x".repeat(2001) },
    ]) {
      expect((await create(bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect(store.leads).toHaveLength(0);
  });

  it("404s an unknown account, and enforces access and same-origin", async () => {
    expect((await create({ accountId: "ghost", name: "Ali" })).status).toBe(404);

    signIn({ id: "user-1", role: "USER" });
    expect((await create({ accountId: "acct-1", name: "Ali" })).status).toBe(403);
    await prismaMock.accountAccess.create({ data: { adminId: "user-1", accountId: "acct-1" } });
    expect((await create({ accountId: "acct-1", name: "Ali" })).status).toBe(200);

    signIn(OWNER);
    expect((await create({ accountId: "acct-1", name: "Ali" }, "https://evil.example.com")).status).toBe(403);

    authState.current = null;
    expect((await create({ accountId: "acct-1", name: "Ali" })).status).toBe(401);
    expect(store.leads).toHaveLength(1); // only the granted USER's lead exists
  });
});

// ---------------------------------------------------------------- GET /api/leads/[id]

describe("GET /api/leads/[id] — the lead detail drawer", () => {
  const OWNER = { id: "owner-1", role: "OWNER" as const };
  const read = (id: string) =>
    GET_LEAD(new NextRequest(`http://localhost:3000/api/leads/${id}`), { params: Promise.resolve({ id }) });

  beforeEach(async () => {
    signIn(OWNER);
    await prismaMock.instagramAccount.create({ data: { id: "acct-1", username: "shop" } });
  });

  it("returns the lead with its history and its email notifications", async () => {
    const lead = await prismaMock.lead.create({ data: { accountId: "acct-1", name: "Ali" } });
    await prismaMock.leadEvent.create({ data: { leadId: lead.id, type: "CREATED" } });
    await prismaMock.emailEvent.create({ data: { leadId: lead.id, to: "boss@test.local", subject: "New lead", status: "SENT" } });

    const res = await read(lead.id as string);
    const data = (await readJson(res)).data!;

    expect(res.status).toBe(200);
    expect((data.lead as Row).name).toBe("Ali");
    expect(((data.lead as Row).account as Row).username).toBe("shop");
    expect((data.lead as Row).events).toHaveLength(1);
    expect((data.emails as Row[]).map((e) => e.subject)).toEqual(["New lead"]);
  });

  it("404s an unknown lead and 403s an account the signed-in USER does not hold", async () => {
    const lead = await prismaMock.lead.create({ data: { accountId: "acct-1" } });
    expect((await read("no-such-lead")).status).toBe(404);

    signIn({ id: "user-1", role: "USER" });
    expect((await read(lead.id as string)).status).toBe(403);

    await prismaMock.accountAccess.create({ data: { adminId: "user-1", accountId: "acct-1" } });
    expect((await read(lead.id as string)).status).toBe(200);

    authState.current = null;
    expect((await read(lead.id as string)).status).toBe(401);
  });
});

// ---------------------------------------------------------------- GET /api/leads/assignees

describe("GET /api/leads/assignees — who a lead may be handed to", () => {
  const OWNER = { id: "owner-1", role: "OWNER" as const };

  beforeEach(async () => {
    signIn(OWNER);
    await prismaMock.instagramAccount.create({ data: { id: "acct-1", username: "shop" } });
    await prismaMock.instagramAccount.create({ data: { id: "acct-2", username: "other" } });
    await prismaMock.admin.create({ data: { id: "a-owner", name: "Anvar", role: "OWNER", isActive: true } });
    await prismaMock.admin.create({ data: { id: "a-admin", name: "Bek", role: "ADMIN", isActive: true } });
    await prismaMock.admin.create({ data: { id: "a-off", name: "Cholpon", role: "ADMIN", isActive: false } });
    await prismaMock.admin.create({ data: { id: "a-granted", name: "Dilnoza", role: "USER", isActive: true } });
    await prismaMock.admin.create({ data: { id: "a-other", name: "Elyor", role: "USER", isActive: true } });
    await prismaMock.accountAccess.create({ data: { adminId: "a-granted", accountId: "acct-1" } });
    await prismaMock.accountAccess.create({ data: { adminId: "a-other", accountId: "acct-2" } });
  });

  it("lists staff plus the USERs granted THIS account, in name order, and nobody deactivated", async () => {
    const res = await get(LIST_ASSIGNEES, "/api/leads/assignees?accountId=acct-1");
    const admins = (await readJson(res)).data!.admins as Row[];

    expect(res.status).toBe(200);
    expect(admins.map((a) => a.name)).toEqual(["Anvar", "Bek", "Dilnoza"]);
    expect(admins.map((a) => a.id)).toEqual(["a-owner", "a-admin", "a-granted"]);
  });

  it("swaps the USER when the account changes", async () => {
    const admins = (
      (await readJson(await get(LIST_ASSIGNEES, "/api/leads/assignees?accountId=acct-2"))).data!.admins as Row[]
    ).map((a) => a.id);
    expect(admins).toEqual(["a-owner", "a-admin", "a-other"]);
  });

  it("requires an accountId and enforces access on it", async () => {
    expect((await get(LIST_ASSIGNEES, "/api/leads/assignees")).status).toBe(400);

    signIn({ id: "a-granted", role: "USER" });
    expect((await get(LIST_ASSIGNEES, "/api/leads/assignees?accountId=acct-2")).status).toBe(403);
    expect((await get(LIST_ASSIGNEES, "/api/leads/assignees?accountId=acct-1")).status).toBe(200);

    authState.current = null;
    expect((await get(LIST_ASSIGNEES, "/api/leads/assignees?accountId=acct-1")).status).toBe(401);
  });

  it("the assignee list and the PATCH guard agree — everyone offered can actually be assigned", async () => {
    const admins = (
      (await readJson(await get(LIST_ASSIGNEES, "/api/leads/assignees?accountId=acct-1"))).data!.admins as Row[]
    ).map((a) => a.id as string);
    const lead = await prismaMock.lead.create({ data: { accountId: "acct-1" } });

    for (const id of admins) {
      const res = await patchLead(lead.id as string, { assignedAdminId: id });
      expect(res.status, `assigning ${id}`).toBe(200);
      expect(store.leads[0]!.assignedAdminId).toBe(id);
    }
    // and the two it left out really are refused
    expect((await patchLead(lead.id as string, { assignedAdminId: "a-other" })).status).toBe(400);
    expect((await patchLead(lead.id as string, { assignedAdminId: "a-off" })).status).toBe(404);
  });
});

// ---------------------------------------------------------------- remaining public-form rules

describe("POST /api/leads/public — rules the first sweep left out", () => {
  async function seedForm(questions: Array<Partial<Row>>) {
    await prismaMock.instagramAccount.create({ data: { id: "acct-1", username: "shop" } });
    const flow = await prismaMock.leadFlow.create({ data: { name: "Signup", enabled: true } });
    await prismaMock.ctaConfig.create({
      data: { accountId: "acct-1", landingSlug: "extra-form", enabled: true, leadFlowId: flow.id, contentId: null },
    });
    const created: Row[] = [];
    for (const [i, q] of questions.entries()) {
      created.push(
        await prismaMock.leadFlowQuestion.create({
          data: { flowId: flow.id, title: `Q${i + 1}`, prompt: `Q${i + 1}?`, type: "TEXT", order: i, ...q },
        }),
      );
    }
    return created;
  }

  it("handles MULTI_SELECT the way the DM engine does — numbers, names, commas, de-duplication", async () => {
    const [q] = await seedForm([{ title: "Xizmatlar", type: "MULTI_SELECT", options: ["SMM", "Ads", "Video"] }]);

    const res = await submitPublic({ slug: "extra-form", answers: { [q!.id as string]: "1, 3, Ads, ads" } });

    expect(res.status).toBe(200);
    expect(store.leads[0]!.answers).toEqual([{ question: "Xizmatlar", answer: "SMM, Video, Ads" }]);
  });

  it("refuses a MULTI_SELECT answer that matches nothing on offer", async () => {
    const [q] = await seedForm([{ title: "Xizmatlar", type: "MULTI_SELECT", options: ["SMM", "Ads"] }]);
    const res = await submitPublic({ slug: "extra-form", answers: { [q!.id as string]: "Catering" } });

    expect(res.status).toBe(400);
    expect(String((await readJson(res)).error!.message)).toContain("Xizmatlar");
    expect(store.leads).toHaveLength(0);
  });

  it("a whitespace-only answer to a required question is a missing answer, not an empty one", async () => {
    const [q] = await seedForm([{ title: "Ism", required: true, mapTo: "name" }]);
    const res = await submitPublic({ slug: "extra-form", answers: { [q!.id as string]: "     " } });

    expect(res.status).toBe(400);
    expect(String((await readJson(res)).error!.message)).toContain("Ism");
    expect(store.leads).toHaveLength(0);
  });

  it("a whitespace-only answer to an OPTIONAL question is stored as an empty answer, not skipped", async () => {
    // `if (!raw && !q.required) continue` tests the RAW string, so "   " is
    // truthy and the question is kept — validateAnswer then returns "".
    const [ism, izoh] = await seedForm([
      { title: "Ism", required: true, mapTo: "name" },
      { title: "Izoh", required: false },
    ]);
    const res = await submitPublic({
      slug: "extra-form",
      answers: { [ism!.id as string]: "Ali", [izoh!.id as string]: "   " },
    });

    expect(res.status).toBe(200);
    expect(store.leads[0]!.answers).toEqual([
      { question: "Ism", answer: "Ali" },
      { question: "Izoh", answer: "" },
    ]);
  });

  it("a mapped question that fails validation never half-writes a lead column", async () => {
    const [ism, tel] = await seedForm([
      { title: "Ism", mapTo: "name" },
      { title: "Telefon", type: "PHONE", mapTo: "phone" },
    ]);
    const res = await submitPublic({
      slug: "extra-form",
      answers: { [ism!.id as string]: "Ali", [tel!.id as string]: "12" },
    });

    expect(res.status).toBe(400);
    expect(store.leads).toHaveLength(0);
    expect(store.leadEvents).toHaveLength(0);
    expect(enqueueMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------- tag length semantics

describe("tag length — the route and the normalizer count differently", () => {
  const OWNER = { id: "owner-1", role: "OWNER" as const };

  beforeEach(async () => {
    signIn(OWNER);
    await prismaMock.instagramAccount.create({ data: { id: "acct-1", username: "shop" } });
  });

  it("GAP: the PATCH schema measures a tag in UTF-16 units, so a 21-emoji tag is refused as 'too long'", async () => {
    // normalizeLeadTags caps at 40 CHARACTERS (Array.from), but the route's
    // zod guard is z.string().max(40), which counts UTF-16 code units. Every
    // emoji costs two, so a tag a person reads as 21 characters is rejected
    // before the normalizer that would happily have kept 40 of them.
    const lead = await prismaMock.lead.create({ data: { accountId: "acct-1" } });
    const tag = "\u{1F600}".repeat(21); // 21 characters, 42 UTF-16 units

    expect([...tag]).toHaveLength(21);
    expect(normalizeLeadTags([tag])).toEqual([tag]); // the normalizer is happy with it

    const res = await patchLead(lead.id as string, { tags: [tag] });

    expect(res.status).toBe(400); // <-- the route disagrees with its own normalizer
    expect(store.leads[0]!.tags).toEqual([]);
  });

  it("the board's tag FILTER has no such guard — it clips instead, which is what clipTag is for", async () => {
    // GET /api/leads feeds the raw query string to normalizeLeadTags, so an
    // over-long multi-byte tag really does reach the clipper there.
    await prismaMock.lead.create({ data: { accountId: "acct-1", tags: ["\u{1F600}".repeat(40)] } });

    const res = await get(LIST_LEADS, `/api/leads?tags=${encodeURIComponent("\u{1F600}".repeat(60))}`);

    expect(res.status).toBe(200);
    expect(((await readJson(res)).data!.leads as Row[]).map((l) => l.id)).toEqual([store.leads[0]!.id]);
  });
});
