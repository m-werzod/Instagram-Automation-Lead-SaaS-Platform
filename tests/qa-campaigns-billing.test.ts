import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Campaign, InstagramAccount } from "@prisma/client";

/**
 * QA suite — CAMPAIGNS + BILLING, end to end against in-memory stand-ins.
 *
 * Nothing here talks to Postgres, Stripe or Meta: Prisma is a small in-memory
 * table implementation (same pattern as tests/video-render.test.ts), the Graph
 * client is a recorder, and Stripe is a fake that behaves like the real one in
 * the single way that matters for money — an idempotency key it has already
 * seen replays its first answer instead of charging again.
 *
 * What is under test is the PRODUCT logic: what gets sent to Meta, what is
 * charged, and what happens when an answer never comes back.
 */

type Row = Record<string, unknown>;

const {
  BASE_TIME,
  store,
  prismaMock,
  graphMock,
  resolveAdsAccessMock,
  FakeStripeProvider,
  alertMock,
} = vi.hoisted(() => {
  // billing/config.ts reads these at call time; set before any module loads.
  process.env.PAYMENT_SECRET_KEY = "sk_test_qa_campaigns_billing";
  process.env.PAYMENT_WEBHOOK_SECRET = "whsec_qa_campaigns_billing";

  // Anchored an hour before the run so rows are inside the windows the service
  // measures against the real clock (Stripe's 24h idempotency window, the event
  // replay window), while every assertion stays a fixed offset from it.
  const BASE_TIME = Date.now() - 3600_000;

  interface StripeChargeInput {
    customerId: string;
    paymentMethodId: string;
    amountCents: number;
    currency: string;
    description: string;
    metadata: Record<string, string>;
    idempotencyKey: string;
  }
  interface IntentSummary {
    id: string;
    status: string;
    chargeId: string | null;
    receiptUrl: string | null;
    failureCode: string | null;
    failureMessage: string | null;
    amount: number;
    currency: string;
  }

  const store = {
    seq: 0,
    tables: {} as Record<string, Row[]>,
    /** Graph API: every call the code made, and what the fake answers. */
    graphCalls: [] as Array<{ host: string; method: string; path: string; body?: Row; params?: Row }>,
    graph: (async () => ({}) as unknown) as (opts: { path: string; method?: string }) => Promise<unknown>,
    /** Stripe fake. */
    stripe: {
      /** key → the charge Stripe made under it. A repeat of the key is a replay. */
      charges: new Map<string, { input: StripeChargeInput; summary: IntentSummary }>(),
      replays: [] as string[],
      calls: [] as Array<{ method: string; args: unknown }>,
      /** next off-session outcome; default: it succeeds */
      outcome: "succeeded" as string,
      /** simulate a response that never came back (Stripe DID charge) */
      loseNextResponse: false,
      intents: new Map<string, IntentSummary>(),
      sessions: new Map<string, Record<string, unknown>>(),
      cards: [] as Array<{ id: string; brand: string | null; last4: string | null; expMonth: number | null; expYear: number | null }>,
      failNextRetrieveIntent: false,
    },
    /** Hook that lets a test stage a create/find race. */
    onPaymentFindUnique: null as null | ((where: Row) => void),
  };

  const rowsOf = (name: string): Row[] => (store.tables[name] ??= []);

  const same = (a: unknown, b: unknown): boolean =>
    a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b;

  const matches = (row: Row, where: Row = {}): boolean =>
    Object.entries(where).every(([key, cond]) => {
      if (key === "OR") return (cond as Row[]).some((c) => matches(row, c));
      if (key === "AND") return (cond as Row[]).every((c) => matches(row, c));
      // relation filter (payment.customer in retryFailedPayments)
      if (key === "customer") {
        const cust = rowsOf("paymentCustomer").find((c) => c.id === row.customerId);
        return cust ? matches(cust, cond as Row) : false;
      }
      const value = row[key];
      if (cond !== null && cond !== undefined && typeof cond === "object" && !(cond instanceof Date)) {
        const c = cond as Row;
        if ("in" in c) return (c.in as unknown[]).some((v) => same(v, value));
        if ("notIn" in c) return !(c.notIn as unknown[]).some((v) => same(v, value));
        if ("not" in c) return !same(value, c.not);
        if ("lt" in c) return value instanceof Date && value.getTime() < (c.lt as Date).getTime();
        if ("lte" in c) return value instanceof Date && value.getTime() <= (c.lte as Date).getTime();
        if ("gt" in c) return value instanceof Date && value.getTime() > (c.gt as Date).getTime();
        if ("gte" in c) return value instanceof Date && value.getTime() >= (c.gte as Date).getTime();
        if ("startsWith" in c) return typeof value === "string" && value.startsWith(c.startsWith as string);
        return false;
      }
      return same(value, cond);
    });

  const applyData = (row: Row, data: Row): void => {
    for (const [k, v] of Object.entries(data)) {
      if (v === undefined) continue;
      if (v !== null && typeof v === "object" && !(v instanceof Date) && "increment" in (v as Row)) {
        row[k] = ((row[k] as number) ?? 0) + ((v as { increment: number }).increment ?? 0);
      } else {
        row[k] = v;
      }
    }
  };

  const uniqueError = (field: string): Error => {
    const err = new Error(`Unique constraint failed on the fields: (\`${field}\`)`) as Error & { code: string };
    err.code = "P2002";
    return err;
  };

  interface TableOpts {
    unique?: string[];
    defaults?: Row;
    onFindUnique?: () => ((where: Row) => void) | null;
  }

  const table = (name: string, opts: TableOpts = {}) => {
    const rows = rowsOf(name);

    const project = (row: Row, args?: { include?: Row; select?: Row }): Row => {
      let out: Row = { ...row };
      if (args?.include?.customer) {
        const cust = rowsOf("paymentCustomer").find((c) => c.id === row.customerId);
        out.customer = cust ? { ...cust } : null;
      }
      if (args?.select) {
        const keys = Object.entries(args.select).filter(([, v]) => v).map(([k]) => k);
        out = Object.fromEntries(keys.map((k) => [k, row[k]]));
      }
      return out;
    };

    const checkUnique = (candidate: Row, ignore?: Row): void => {
      for (const field of opts.unique ?? []) {
        const v = candidate[field];
        if (v === null || v === undefined) continue;
        if (rows.some((r) => r !== ignore && same(r[field], v))) throw uniqueError(field);
      }
    };

    const sortRows = (list: Row[], orderBy?: Row): Row[] => {
      if (!orderBy) return list;
      const [key, dir] = Object.entries(orderBy)[0] ?? [];
      if (!key) return list;
      return [...list].sort((a, b) => {
        const av = a[key];
        const bv = b[key];
        const an = av instanceof Date ? av.getTime() : typeof av === "number" ? av : String(av ?? "");
        const bn = bv instanceof Date ? bv.getTime() : typeof bv === "number" ? bv : String(bv ?? "");
        const cmp = an < bn ? -1 : an > bn ? 1 : 0;
        return dir === "desc" ? -cmp : cmp;
      });
    };

    const api = {
      create: async (args: { data: Row; include?: Row; select?: Row }) => {
        const n = ++store.seq;
        const row: Row = {
          id: `${name}_${n}`,
          createdAt: new Date(BASE_TIME + n),
          updatedAt: new Date(BASE_TIME + n),
          ...(opts.defaults ?? {}),
          ...args.data,
        };
        checkUnique(row);
        rows.push(row);
        return project(row, args);
      },
      findUnique: async (args: { where: Row; include?: Row; select?: Row }) => {
        const row = rows.find((r) => matches(r, args.where));
        const result = row ? project(row, args) : null;
        opts.onFindUnique?.()?.(args.where);
        return result;
      },
      findUniqueOrThrow: async (args: { where: Row; include?: Row; select?: Row }) => {
        const row = rows.find((r) => matches(r, args.where));
        if (!row) throw new Error(`${name} not found`);
        return project(row, args);
      },
      findFirst: async (args: { where?: Row; orderBy?: Row; include?: Row; select?: Row } = {}) => {
        const hit = sortRows(rows.filter((r) => matches(r, args.where)), args.orderBy)[0];
        return hit ? project(hit, args) : null;
      },
      findMany: async (args: { where?: Row; orderBy?: Row; take?: number; include?: Row; select?: Row } = {}) => {
        const hits = sortRows(rows.filter((r) => matches(r, args.where)), args.orderBy);
        return hits.slice(0, args.take ?? hits.length).map((r) => project(r, args));
      },
      count: async (args: { where?: Row } = {}) => rows.filter((r) => matches(r, args.where)).length,
      update: async (args: { where: Row; data: Row; include?: Row; select?: Row }) => {
        const row = rows.find((r) => matches(r, args.where));
        if (!row) throw new Error(`${name} record to update not found`);
        const candidate = { ...row };
        applyData(candidate, args.data);
        checkUnique(candidate, row);
        applyData(row, args.data);
        row.updatedAt = new Date(BASE_TIME + ++store.seq);
        return project(row, args);
      },
      updateMany: async (args: { where?: Row; data: Row }) => {
        const hits = rows.filter((r) => matches(r, args.where));
        for (const row of hits) {
          applyData(row, args.data);
          row.updatedAt = new Date(BASE_TIME + ++store.seq);
        }
        return { count: hits.length };
      },
      upsert: async (args: { where: Row; create: Row; update: Row; include?: Row; select?: Row }) => {
        const row = rows.find((r) => matches(r, args.where));
        if (row) {
          applyData(row, args.update);
          row.updatedAt = new Date(BASE_TIME + ++store.seq);
          return project(row, args);
        }
        return api.create({ data: { ...args.where, ...args.create }, include: args.include, select: args.select });
      },
      delete: async (args: { where: Row }) => {
        const i = rows.findIndex((r) => matches(r, args.where));
        if (i === -1) throw new Error(`${name} record to delete not found`);
        return rows.splice(i, 1)[0] as Row;
      },
    };
    return api;
  };

  const prismaMock = {
    pricingConfig: table("pricingConfig", {
      defaults: { currency: "USD", campaignFeeCents: 0, campaignFeePercent: 0, planName: null, planAmountCents: 0, planIntervalDays: 30, taxPercent: 0 },
    }),
    paymentCustomer: table("paymentCustomer", {
      unique: ["adminId", "providerCustomerId"],
      defaults: { provider: "stripe", currency: "USD", autoPay: false, defaultPaymentMethodId: null, email: null },
    }),
    paymentMethod: table("paymentMethod", {
      unique: ["providerMethodId"],
      defaults: { brand: null, last4: null, expMonth: null, expYear: null, removedAt: null },
    }),
    payment: table("payment", {
      unique: ["idempotencyKey", "providerPaymentIntentId", "providerCheckoutSessionId"],
      defaults: {
        status: "PENDING",
        attempts: 0,
        providerPaymentIntentId: null,
        providerCheckoutSessionId: null,
        providerChargeId: null,
        receiptUrl: null,
        failureCode: null,
        failureMessage: null,
        campaignId: null,
        scheduleId: null,
        dueAt: null,
        paidAt: null,
        failedAt: null,
        refundedAt: null,
        canceledAt: null,
        nextRetryAt: null,
      },
      onFindUnique: () => store.onPaymentFindUnique,
    }),
    invoice: table("invoice", { unique: ["number", "paymentId"], defaults: { receiptUrl: null } }),
    billingSchedule: table("billingSchedule", {
      defaults: { intervalDays: 30, status: "ACTIVE", campaignId: null, lastBilledAt: null, canceledAt: null },
    }),
    billingEvent: table("billingEvent", {
      unique: ["providerEventId"],
      defaults: { status: "RECEIVED", error: null, processedAt: null, receivedAt: new Date(BASE_TIME) },
    }),
    campaign: table("campaign", {
      defaults: {
        status: "DRAFT",
        currency: "USD",
        dailyBudgetCents: null,
        lifetimeBudgetCents: null,
        startTime: null,
        endTime: null,
        targeting: null,
        ctaType: null,
        destinationType: null,
        destinationUrl: null,
        contentId: null,
        ctaConfigId: null,
        creativeSpec: null,
        metaCampaignId: null,
        metaAdSetId: null,
        metaCreativeId: null,
        metaAdId: null,
        metaFormId: null,
        platformFeeCents: null,
        stoppedAt: null,
      },
    }),
    ctaConfig: table("ctaConfig"),
    contentItem: table("contentItem"),
    auditLog: table("auditLog"),
  };

  const graphMock = vi.fn(async (opts: { host: string; method?: string; path: string; body?: Row; params?: Row }) => {
    store.graphCalls.push({ host: opts.host, method: opts.method ?? "GET", path: opts.path, body: opts.body, params: opts.params });
    return store.graph(opts);
  });

  const resolveAdsAccessMock = vi.fn(async () => ({
    accessToken: "ads-token",
    host: "graph.facebook.com" as const,
    tokenRow: { id: "tok1" } as never,
  }));

  const makeSummary = (input: StripeChargeInput, status: string): IntentSummary => {
    const n = ++store.seq;
    const failed = status === "requires_payment_method";
    return {
      id: `pi_${n}`,
      status,
      chargeId: status === "succeeded" ? `ch_${n}` : null,
      receiptUrl: status === "succeeded" ? `https://pay.stripe.test/receipts/${n}` : null,
      failureCode: failed ? "insufficient_funds" : null,
      failureMessage: failed ? "Your card has insufficient funds." : null,
      amount: input.amountCents,
      currency: input.currency.toUpperCase(),
    };
  };

  class FakeStripeProvider {
    readonly name = "stripe" as const;
    constructor(readonly secretKey: string) {}

    async createCustomer(input: { email?: string | null; name?: string | null; adminId: string }): Promise<string> {
      store.stripe.calls.push({ method: "createCustomer", args: input });
      return `cus_${++store.seq}`;
    }

    async createSetupSession(input: unknown) {
      store.stripe.calls.push({ method: "createSetupSession", args: input });
      const n = ++store.seq;
      return { id: `cs_setup_${n}`, url: `https://checkout.stripe.test/cs_setup_${n}` };
    }

    async createPaymentSession(input: { amountCents: number; currency: string; idempotencyKey: string }) {
      store.stripe.calls.push({ method: "createPaymentSession", args: input });
      const n = ++store.seq;
      const id = `cs_${n}`;
      store.stripe.sessions.set(id, { id, mode: "payment", status: "open", payment_status: "unpaid", payment_intent: null, customer: null });
      return { id, url: `https://checkout.stripe.test/${id}`, paymentIntentId: null };
    }

    /**
     * Stripe's real contract: a request repeated under an idempotency key it has
     * already seen returns the ORIGINAL result and takes no second payment.
     */
    async chargeOffSession(input: StripeChargeInput): Promise<IntentSummary> {
      store.stripe.calls.push({ method: "chargeOffSession", args: input });
      const seen = store.stripe.charges.get(input.idempotencyKey);
      if (seen) {
        store.stripe.replays.push(input.idempotencyKey);
        return seen.summary;
      }
      const summary = makeSummary(input, store.stripe.outcome);
      store.stripe.charges.set(input.idempotencyKey, { input, summary });
      store.stripe.intents.set(summary.id, summary);
      if (store.stripe.loseNextResponse) {
        store.stripe.loseNextResponse = false;
        // The charge happened; we simply never saw the answer.
        throw new Error("socket hang up");
      }
      return summary;
    }

    async retrieveIntent(id: string): Promise<IntentSummary> {
      store.stripe.calls.push({ method: "retrieveIntent", args: id });
      if (store.stripe.failNextRetrieveIntent) {
        store.stripe.failNextRetrieveIntent = false;
        throw new Error("stripe is down");
      }
      const known = store.stripe.intents.get(id);
      if (known) return known;
      return { id, status: "processing", chargeId: null, receiptUrl: null, failureCode: null, failureMessage: null, amount: 0, currency: "USD" };
    }

    async retrieveCheckoutSession(id: string) {
      store.stripe.calls.push({ method: "retrieveCheckoutSession", args: id });
      const s = store.stripe.sessions.get(id) ?? {};
      return {
        id,
        mode: String(s.mode ?? "payment"),
        status: (s.status as string | null) ?? null,
        paymentStatus: (s.payment_status as string | null) ?? null,
        paymentIntentId: typeof s.payment_intent === "string" ? s.payment_intent : null,
        setupIntentId: null,
        customerId: typeof s.customer === "string" ? s.customer : null,
      };
    }

    async listCards(customerId: string) {
      store.stripe.calls.push({ method: "listCards", args: customerId });
      return store.stripe.cards.map((c) => ({ ...c }));
    }

    async detachCard(paymentMethodId: string) {
      store.stripe.calls.push({ method: "detachCard", args: paymentMethodId });
      store.stripe.cards = store.stripe.cards.filter((c) => c.id !== paymentMethodId);
    }

    async setDefaultCard(customerId: string, paymentMethodId: string) {
      store.stripe.calls.push({ method: "setDefaultCard", args: { customerId, paymentMethodId } });
    }

    async portalUrl() {
      return "https://billing.stripe.test/portal";
    }

    async refund(paymentIntentId: string, idempotencyKey: string) {
      store.stripe.calls.push({ method: "refund", args: { paymentIntentId, idempotencyKey } });
      return { id: `re_${++store.seq}`, status: "succeeded" };
    }
  }

  const alertMock = vi.fn(async (_subject: string, _text: string) => undefined);

  return { BASE_TIME, store, prismaMock, graphMock, resolveAdsAccessMock, FakeStripeProvider, alertMock };
});

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));
vi.mock("@/lib/email", () => ({ queueAdminAlert: alertMock }));

vi.mock("@/lib/meta/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/meta/client")>()),
  graphCall: graphMock,
}));

vi.mock("@/lib/meta/tokens", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/meta/tokens")>()),
  resolveAdsAccess: resolveAdsAccessMock,
}));

vi.mock("@/lib/billing/stripe", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/billing/stripe")>()),
  StripeProvider: FakeStripeProvider,
}));

import { campaignFieldsProblem, campaignFieldsSchema, targetingSchema } from "@/lib/validation/campaign";
import {
  activateCampaignInMeta,
  buildCallToAction,
  buildTargeting,
  createCampaignInMeta,
  OBJECTIVE_CONFIG,
  pauseCampaignInMeta,
  stopCampaignInMeta,
  parseCampaignInsights,
  parseReachEstimate,
  targetingProblem,
} from "@/lib/meta/marketing";
import {
  campaignFeeCurrencyProblem,
  campaignQuoteOrProblem,
  computeCampaignQuote,
  computePlanQuote,
  chargeIdempotencyKey,
  DEFAULT_PRICING,
  nextBillingDate,
  type Pricing,
} from "@/lib/billing/pricing";
import { verifyStripeSignature, summarizeRefund } from "@/lib/billing/stripe";
import { hmacSha256 } from "@/lib/crypto";
import {
  applyIntent,
  assertCampaignFeePaid,
  campaignFeeStatus,
  cancelPayment,
  collectPayment,
  createCampaignFeePayment,
  createPayment,
  ensurePlanSchedule,
  recordAndProcessEvent,
  reconcileStuckPayments,
  refreshPaymentMethods,
  replayFailedBillingEvents,
  retryFailedPayments,
  runDueSchedules,
  setAutoPay,
} from "@/lib/billing/service";

// ---------------------------------------------------------------- helpers

function seed(tableName: string, row: Row): Row {
  const rows = (store.tables[tableName] ??= []);
  const n = ++store.seq;
  const full: Row = { id: `${tableName}_seed_${n}`, createdAt: new Date(BASE_TIME + n), updatedAt: new Date(BASE_TIME + n), ...row };
  rows.push(full);
  return full;
}

function rowsIn(tableName: string): Row[] {
  return store.tables[tableName] ?? [];
}

function setPricing(p: Partial<{ currency: string; campaignFeeCents: number; campaignFeePercent: number; planName: string | null; planAmountCents: number; planIntervalDays: number; taxPercent: number }>): void {
  const rows = (store.tables.pricingConfig ??= []);
  rows.length = 0;
  rows.push({
    id: 1,
    currency: "USD",
    campaignFeeCents: 0,
    campaignFeePercent: 0,
    planName: null,
    planAmountCents: 0,
    planIntervalDays: 30,
    taxPercent: 0,
    updatedAt: new Date(BASE_TIME),
    ...p,
  });
}

function seedCustomer(over: Row = {}): Row {
  return seed("paymentCustomer", {
    id: "cust1",
    adminId: "admin1",
    provider: "stripe",
    providerCustomerId: "cus_seed_1",
    email: "owner@test.local",
    currency: "USD",
    autoPay: false,
    defaultPaymentMethodId: null,
    ...over,
  });
}

function seedCardFor(customerId: string, over: Row = {}): Row {
  return seed("paymentMethod", {
    id: "pm_local_1",
    customerId,
    providerMethodId: "pm_stripe_1",
    brand: "visa",
    last4: "4242",
    expMonth: 12,
    expYear: 2030,
    removedAt: null,
    ...over,
  });
}

function seedPayment(over: Row = {}): Row {
  return seed("payment", {
    id: "pay1",
    customerId: "cust1",
    kind: "CAMPAIGN_FEE",
    description: "Platform service fee",
    amountCents: 1500,
    currency: "USD",
    status: "PENDING",
    idempotencyKey: "idem-1",
    providerPaymentIntentId: null,
    providerCheckoutSessionId: null,
    providerChargeId: null,
    receiptUrl: null,
    failureCode: null,
    failureMessage: null,
    attempts: 0,
    campaignId: null,
    scheduleId: null,
    dueAt: new Date(BASE_TIME),
    paidAt: null,
    failedAt: null,
    refundedAt: null,
    canceledAt: null,
    nextRetryAt: null,
    ...over,
  });
}

const ACCOUNT = {
  id: "acc1",
  adAccountId: "act_123456",
  fbPageId: "page_777",
  igUserId: "ig_999",
  connectionMode: "FACEBOOK_LOGIN",
} as unknown as InstagramAccount;

function campaignRow(over: Row = {}): Campaign {
  return {
    id: "camp1",
    accountId: "acc1",
    name: "Autumn promo",
    objective: "OUTCOME_TRAFFIC",
    status: "READY",
    dailyBudgetCents: 500,
    lifetimeBudgetCents: null,
    currency: "USD",
    startTime: null,
    endTime: null,
    targeting: { countries: ["UZ"], ageMin: 25, ageMax: 45 },
    ctaType: "LEARN_MORE",
    destinationType: "WEBSITE",
    destinationUrl: "https://example.test/landing",
    leadFlowId: null,
    contentId: null,
    ctaConfigId: null,
    creativeSpec: null,
    metaCampaignId: null,
    metaAdSetId: null,
    metaCreativeId: null,
    metaAdId: null,
    metaFormId: null,
    ...over,
  } as unknown as Campaign;
}

function bodyOfCall(pathSuffix: string): Row | undefined {
  return store.graphCalls.find((c) => c.path.endsWith(pathSuffix))?.body;
}

beforeEach(() => {
  // truncate in place — the table closures captured these arrays
  for (const rows of Object.values(store.tables)) rows.length = 0;
  store.seq = 0;
  store.graphCalls = [];
  store.onPaymentFindUnique = null;
  store.graph = async ({ path }) => {
    if (path.endsWith("/campaigns")) return { id: "120_camp" };
    if (path.endsWith("/adsets")) return { id: "120_adset" };
    if (path.endsWith("/adcreatives")) return { id: "120_creative" };
    if (path.endsWith("/ads")) return { id: "120_ad" };
    return {};
  };
  store.stripe.charges = new Map();
  store.stripe.replays = [];
  store.stripe.calls = [];
  store.stripe.outcome = "succeeded";
  store.stripe.loseNextResponse = false;
  store.stripe.intents = new Map();
  store.stripe.sessions = new Map();
  store.stripe.cards = [];
  store.stripe.failNextRetrieveIntent = false;
  graphMock.mockClear();
  alertMock.mockClear();
  setPricing({});
});

// ================================================================
// 1. CAMPAIGN TARGETING + FIELD VALIDATION
// ================================================================

describe("campaign targeting validation", () => {
  it("accepts a complete, valid targeting spec and normalises country codes", () => {
    const parsed = targetingSchema.parse({
      countries: ["uz", "kz"],
      cities: [{ key: "2420605", name: "Tashkent", radius: 25, distanceUnit: "kilometer" }],
      ageMin: 18,
      ageMax: 65,
      genders: [2],
      interests: [{ id: "6003139266461", name: "Driving" }],
      instagramPositions: ["reels", "story"],
    });
    expect(parsed.countries).toEqual(["UZ", "KZ"]);
    expect(parsed.ageMin).toBe(18);
    expect(parsed.ageMax).toBe(65);
    expect(targetingProblem(parsed)).toBeNull();
  });

  /** Meta's floor is 18 and this platform must never send an under-18 audience. */
  it("refuses an age below 18 at BOTH layers — schema and builder", () => {
    expect(targetingSchema.safeParse({ countries: ["UZ"], ageMin: 17 }).success).toBe(false);
    expect(targetingSchema.safeParse({ countries: ["UZ"], ageMin: 13 }).success).toBe(false);
    expect(targetingSchema.safeParse({ countries: ["UZ"], ageMin: 18 }).success).toBe(true);
    // even if an unvalidated value reached the builder, what is SENT is clamped
    expect(buildTargeting({ countries: ["UZ"], ageMin: 13, ageMax: 99 }).age_min).toBe(18);
    expect(buildTargeting({ countries: ["UZ"], ageMin: 13, ageMax: 99 }).age_max).toBe(65);
  });

  it("refuses ages above 65 and non-integer ages", () => {
    expect(targetingSchema.safeParse({ countries: ["UZ"], ageMax: 66 }).success).toBe(false);
    expect(targetingSchema.safeParse({ countries: ["UZ"], ageMin: 25.5 }).success).toBe(false);
  });

  /**
   * An inverted range is only visible across two fields. It has to be caught when
   * the campaign is SAVED, not at "Create in Meta" — that step runs only after the
   * platform fee has been paid, so a late refusal charges first and explains after.
   */
  it("refuses an inverted age range at save time AND at build time", () => {
    expect(targetingSchema.safeParse({ countries: ["UZ"], ageMin: 45, ageMax: 30 }).success).toBe(false);
    expect(targetingSchema.safeParse({ countries: ["UZ"], ageMin: 30, ageMax: 45 }).success).toBe(true);
    expect(targetingSchema.safeParse({ countries: ["UZ"], ageMin: 30, ageMax: 30 }).success).toBe(true);
    // the builder keeps its own backstop
    expect(targetingProblem({ countries: ["UZ"], ageMin: 45, ageMax: 30 })).toMatch(/Minimum age is above maximum/);
    expect(targetingProblem({ countries: ["UZ"], ageMin: 30, ageMax: 30 })).toBeNull();
  });

  it("accepts only Meta's gender codes (1 = men, 2 = women) and at most two", () => {
    expect(targetingSchema.safeParse({ countries: ["UZ"], genders: [1] }).success).toBe(true);
    expect(targetingSchema.safeParse({ countries: ["UZ"], genders: [2] }).success).toBe(true);
    expect(targetingSchema.safeParse({ countries: ["UZ"], genders: [1, 2] }).success).toBe(true);
    expect(targetingSchema.safeParse({ countries: ["UZ"], genders: [0] }).success).toBe(false);
    expect(targetingSchema.safeParse({ countries: ["UZ"], genders: [3] }).success).toBe(false);
    expect(targetingSchema.safeParse({ countries: ["UZ"], genders: [1, 2, 1] }).success).toBe(false);
    // "both" is the absence of a filter, not genders:[1,2] — sending both narrows
    // nothing but excludes Meta's unspecified-gender users.
    expect(buildTargeting({ countries: ["UZ"], genders: [1, 2] }).genders).toBeUndefined();
    expect(buildTargeting({ countries: ["UZ"], genders: [2] }).genders).toEqual([2]);
  });

  it("rejects malformed country codes and oversized lists", () => {
    expect(targetingSchema.safeParse({ countries: ["USA"] }).success).toBe(false);
    expect(targetingSchema.safeParse({ countries: ["U"] }).success).toBe(false);
    expect(targetingSchema.safeParse({ countries: Array.from({ length: 26 }, () => "UZ") }).success).toBe(false);
    expect(targetingSchema.safeParse({ interests: Array.from({ length: 26 }, (_, i) => ({ id: String(i) })) }).success).toBe(false);
  });

  it("requires at least one location and never invents a default one", () => {
    expect(targetingProblem(null)).toMatch(/country or city/);
    expect(targetingProblem({})).toMatch(/country or city/);
    expect(targetingProblem({ countries: [] })).toMatch(/country or city/);
    expect(buildTargeting(null).geo_locations).toEqual({});
  });

  /**
   * Meta documents the city radius as 10–50 MILES or 17–80 KM — the two are not
   * the same window, so the bound has to be applied in the unit the admin chose.
   */
  it("applies the city-radius limit in the unit it was given (Meta: 10–50 mi / 17–80 km)", () => {
    expect(targetingProblem({ countries: ["UZ"], cities: [{ key: "1", radius: 17 }] })).toBeNull();
    expect(targetingProblem({ countries: ["UZ"], cities: [{ key: "1", radius: 80 }] })).toBeNull();
    expect(targetingProblem({ countries: ["UZ"], cities: [{ key: "1", radius: 16 }] })).toMatch(/radius/);
    expect(targetingProblem({ countries: ["UZ"], cities: [{ key: "1", radius: 81 }] })).toMatch(/radius/);
    // Meta's own documented mile bounds must both be accepted
    expect(targetingProblem({ countries: ["UZ"], cities: [{ key: "1", radius: 10, distanceUnit: "mile" }] })).toBeNull();
    expect(targetingProblem({ countries: ["UZ"], cities: [{ key: "1", radius: 50, distanceUnit: "mile" }] })).toBeNull();
    expect(targetingProblem({ countries: ["UZ"], cities: [{ key: "1", radius: 9, distanceUnit: "mile" }] })).toMatch(/radius/);
    expect(targetingProblem({ countries: ["UZ"], cities: [{ key: "1", radius: 51, distanceUnit: "mile" }] })).toMatch(/radius/);
  });

  /** Two layers, one rule — a campaign the schema accepts must not be refused later. */
  it("agrees between the input schema and the pre-flight check on every radius", () => {
    const cases: Array<{ radius: number; distanceUnit?: "kilometer" | "mile" }> = [
      { radius: 9, distanceUnit: "mile" },
      { radius: 10, distanceUnit: "mile" },
      { radius: 50, distanceUnit: "mile" },
      { radius: 51, distanceUnit: "mile" },
      { radius: 16 },
      { radius: 17 },
      { radius: 80 },
    ];
    for (const c of cases) {
      const schemaOk = targetingSchema.safeParse({ countries: ["UZ"], cities: [{ key: "1", ...c }] }).success;
      const buildOk = targetingProblem({ countries: ["UZ"], cities: [{ key: "1", ...c }] }) === null;
      expect({ ...c, schemaOk }).toEqual({ ...c, schemaOk: buildOk });
    }
  });

  it("passes the city radius through to Meta with its unit, and omits it when unset", () => {
    const t = buildTargeting({ cities: [{ key: "1", radius: 20, distanceUnit: "mile" }, { key: "2" }] });
    expect(t.geo_locations).toEqual({ cities: [{ key: "1", radius: 20, distance_unit: "mile" }, { key: "2" }] });
  });
});

describe("campaign budget and schedule validation", () => {
  const base = { name: "C", objective: "OUTCOME_TRAFFIC" as const };

  it("accepts a valid daily-budget campaign and defaults the currency to USD", () => {
    const parsed = campaignFieldsSchema.parse({ ...base, dailyBudgetCents: 500 });
    expect(parsed.currency).toBe("USD");
    expect(campaignFieldsProblem(parsed)).toBeNull();
  });

  it("rejects budgets below Meta's floor, non-integers and absurd amounts", () => {
    expect(campaignFieldsSchema.safeParse({ ...base, dailyBudgetCents: 99 }).success).toBe(false);
    expect(campaignFieldsSchema.safeParse({ ...base, dailyBudgetCents: 100 }).success).toBe(true);
    expect(campaignFieldsSchema.safeParse({ ...base, dailyBudgetCents: 500.5 }).success).toBe(false);
    expect(campaignFieldsSchema.safeParse({ ...base, dailyBudgetCents: 100_000_001 }).success).toBe(false);
    expect(campaignFieldsSchema.safeParse({ ...base, lifetimeBudgetCents: 1_000_000_001 }).success).toBe(false);
  });

  it("insists on exactly one budget kind", () => {
    expect(campaignFieldsProblem({ dailyBudgetCents: 500, lifetimeBudgetCents: 50000 })).toMatch(/either a daily or a lifetime/);
    expect(campaignFieldsProblem({})).toMatch(/budget is required/);
    expect(campaignFieldsProblem({ dailyBudgetCents: null, lifetimeBudgetCents: null })).toMatch(/budget is required/);
    expect(campaignFieldsProblem({ lifetimeBudgetCents: 50000, endTime: "2026-10-01T00:00:00Z" })).toBeNull();
  });

  it("requires an end date for a lifetime budget, and end strictly after start", () => {
    expect(campaignFieldsProblem({ lifetimeBudgetCents: 50000 })).toMatch(/end date/);
    expect(campaignFieldsProblem({ dailyBudgetCents: 500, startTime: "2026-10-05T00:00:00Z", endTime: "2026-10-01T00:00:00Z" })).toMatch(/after the start/);
    // equal instants are not a window
    expect(campaignFieldsProblem({ dailyBudgetCents: 500, startTime: "2026-10-05T00:00:00Z", endTime: "2026-10-05T00:00:00Z" })).toMatch(/after the start/);
    expect(campaignFieldsProblem({ dailyBudgetCents: 500, startTime: "2026-10-05T00:00:00Z", endTime: "2026-10-05T00:00:01Z" })).toBeNull();
    // an end with no start is legitimate (starts immediately)
    expect(campaignFieldsProblem({ dailyBudgetCents: 500, endTime: "2026-10-05T00:00:00Z" })).toBeNull();
  });

  it("rejects non-ISO datetimes, bad URLs and unknown objectives/destinations", () => {
    expect(campaignFieldsSchema.safeParse({ ...base, dailyBudgetCents: 500, startTime: "next tuesday" }).success).toBe(false);
    expect(campaignFieldsSchema.safeParse({ ...base, dailyBudgetCents: 500, destinationUrl: "not a url" }).success).toBe(false);
    expect(campaignFieldsSchema.safeParse({ ...base, objective: "OUTCOME_SALES", dailyBudgetCents: 500 }).success).toBe(false);
    expect(campaignFieldsSchema.safeParse({ ...base, dailyBudgetCents: 500, destinationType: "TELEPATHY" }).success).toBe(false);
    expect(campaignFieldsSchema.safeParse({ ...base, dailyBudgetCents: 500, currency: "DOLLARS" }).success).toBe(false);
    expect(campaignFieldsSchema.safeParse({ ...base, name: "", dailyBudgetCents: 500 }).success).toBe(false);
  });
});

// ================================================================
// 2. MARKETING API REQUEST BUILDERS (nothing reaches Meta)
// ================================================================

describe("createCampaignInMeta — the request bodies actually sent to Meta", () => {
  it("builds campaign → ad set → creative → ad, and every object is created PAUSED", async () => {
    seed("campaign", { ...(campaignRow() as unknown as Row), id: "camp1" });
    const campaign = campaignRow({
      startTime: new Date("2026-10-01T00:00:00Z"),
      endTime: new Date("2026-10-31T00:00:00Z"),
      targeting: { countries: ["UZ"], ageMin: 25, ageMax: 45, genders: [2] },
    });

    const ids = await createCampaignInMeta(ACCOUNT, campaign);
    expect(ids).toEqual({ metaCampaignId: "120_camp", metaAdSetId: "120_adset", metaCreativeId: "120_creative", metaAdId: "120_ad" });

    // the four creation calls, in order, all POST to the ad account's edges
    expect(store.graphCalls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST act_123456/campaigns",
      "POST act_123456/adsets",
      "POST act_123456/adcreatives",
      "POST act_123456/ads",
    ]);
    expect(store.graphCalls.every((c) => c.host === "graph.facebook.com")).toBe(true);

    // ---- THE PAUSED-FIRST INVARIANT: nothing may be born spending money.
    const statuses = store.graphCalls.map((c) => c.body?.status).filter((s) => s !== undefined);
    expect(statuses).toEqual(["PAUSED", "PAUSED", "PAUSED"]);
    expect(statuses).not.toContain("ACTIVE");

    expect(bodyOfCall("/campaigns")).toEqual({
      name: "Autumn promo",
      objective: "OUTCOME_TRAFFIC",
      status: "PAUSED",
      special_ad_categories: [],
    });

    expect(bodyOfCall("/adsets")).toEqual({
      name: "Autumn promo — ad set",
      campaign_id: "120_camp",
      status: "PAUSED",
      billing_event: OBJECTIVE_CONFIG.OUTCOME_TRAFFIC.billingEvent,
      optimization_goal: OBJECTIVE_CONFIG.OUTCOME_TRAFFIC.optimizationGoal,
      targeting: {
        geo_locations: { countries: ["UZ"] },
        publisher_platforms: ["instagram"],
        instagram_positions: ["stream", "reels"],
        targeting_automation: { advantage_audience: 0 },
        age_min: 25,
        age_max: 45,
        genders: [2],
      },
      daily_budget: 500,
      end_time: "2026-10-31T00:00:00.000Z",
      start_time: "2026-10-01T00:00:00.000Z",
    });

    expect(bodyOfCall("/adcreatives")).toEqual({
      name: "Autumn promo — creative",
      object_story_spec: {
        page_id: "page_777",
        link_data: {
          link: "https://example.test/landing",
          message: "Autumn promo",
          call_to_action: { type: "LEARN_MORE", value: { link: "https://example.test/landing" } },
        },
      },
    });

    expect(bodyOfCall("/ads")).toEqual({
      name: "Autumn promo — ad",
      adset_id: "120_adset",
      creative: { creative_id: "120_creative" },
      status: "PAUSED",
    });
  });

  it("sends a lifetime budget with its end time, and a promoted page for objectives that need one", async () => {
    seed("campaign", { id: "camp1" });
    await createCampaignInMeta(
      ACCOUNT,
      campaignRow({
        objective: "OUTCOME_LEADS",
        ctaType: "SIGN_UP",
        metaFormId: "form_42",
        dailyBudgetCents: null,
        lifetimeBudgetCents: 250_000,
        endTime: new Date("2026-11-30T00:00:00Z"),
      }),
    );
    const adset = bodyOfCall("/adsets")!;
    expect(adset.lifetime_budget).toBe(250_000);
    expect(adset.daily_budget).toBeUndefined();
    expect(adset.end_time).toBe("2026-11-30T00:00:00.000Z");
    expect(adset.destination_type).toBe("ON_AD");
    expect(adset.promoted_object).toEqual({ page_id: "page_777" });
    expect(adset.optimization_goal).toBe("LEAD_GENERATION");

    // a Leads creative opens Meta's Instant Form, never a URL
    expect(bodyOfCall("/adcreatives")).toEqual({
      name: "Autumn promo — creative",
      object_story_spec: {
        page_id: "page_777",
        link_data: {
          link: "https://fb.me/",
          message: "Autumn promo",
          call_to_action: { type: "SIGN_UP", value: { lead_gen_form_id: "form_42" } },
        },
      },
    });
  });

  it("boosts an existing Instagram post through instagram_user_id + source_instagram_media_id", async () => {
    seed("campaign", { id: "camp1" });
    seed("contentItem", { id: "content1", mediaId: "17900000000000000" });
    await createCampaignInMeta(ACCOUNT, campaignRow({ contentId: "content1" }));
    expect(bodyOfCall("/adcreatives")).toEqual({
      name: "Autumn promo — creative",
      instagram_user_id: "ig_999",
      source_instagram_media_id: "17900000000000000",
      call_to_action: { type: "LEARN_MORE", value: { link: "https://example.test/landing" } },
    });
    // the organic post itself is never modified
    expect(store.graphCalls.some((c) => c.path.includes("17900000000000000") && c.method === "POST")).toBe(false);
  });

  it("lets a linked Lead Button override the campaign's own button and destination", async () => {
    seed("campaign", { id: "camp1" });
    seed("ctaConfig", { id: "cta1", ctaType: "BOOK_NOW", url: null, landingSlug: "autumn" });
    await createCampaignInMeta(ACCOUNT, campaignRow({ ctaConfigId: "cta1" }));
    const creative = bodyOfCall("/adcreatives")!;
    const linkData = (creative.object_story_spec as { link_data: Row }).link_data;
    expect(linkData.call_to_action).toEqual({ type: "BOOK_NOW", value: { link: "http://localhost:3000/f/autumn" } });
    expect(linkData.link).toBe("http://localhost:3000/f/autumn");
  });

  it("persists each Meta id the moment Meta returns it, so a mid-chain failure loses nothing", async () => {
    seed("campaign", { id: "camp1", metaCampaignId: null, metaAdSetId: null, metaCreativeId: null, metaAdId: null });
    store.graph = async ({ path }) => {
      if (path.endsWith("/campaigns")) return { id: "120_camp" };
      throw new Error("Meta rejected the ad set");
    };
    await expect(createCampaignInMeta(ACCOUNT, campaignRow())).rejects.toThrow(/rejected the ad set/);

    const row = rowsIn("campaign")[0]!;
    expect(row.metaCampaignId).toBe("120_camp");
    expect(row.metaAdSetId).toBeNull();
  });

  it("resumes from the first missing object instead of stacking up orphans in Ads Manager", async () => {
    seed("campaign", { id: "camp1", metaCampaignId: "existing_camp", metaAdSetId: "existing_adset" });
    const ids = await createCampaignInMeta(
      ACCOUNT,
      campaignRow({ metaCampaignId: "existing_camp", metaAdSetId: "existing_adset" }),
    );
    expect(store.graphCalls.map((c) => c.path)).toEqual(["act_123456/adcreatives", "act_123456/ads"]);
    expect(ids.metaCampaignId).toBe("existing_camp");
    expect(ids.metaAdSetId).toBe("existing_adset");
    // the ad is attached to the ad set that already exists, not a new one
    expect(bodyOfCall("/ads")!.adset_id).toBe("existing_adset");
  });

  it("does nothing at all for a complete chain", async () => {
    seed("campaign", { id: "camp1" });
    const ids = await createCampaignInMeta(
      ACCOUNT,
      campaignRow({ metaCampaignId: "c", metaAdSetId: "s", metaCreativeId: "cr", metaAdId: "a" }),
    );
    expect(store.graphCalls).toHaveLength(0);
    expect(ids).toEqual({ metaCampaignId: "c", metaAdSetId: "s", metaCreativeId: "cr", metaAdId: "a" });
  });

  it("refuses — before touching Meta — a campaign that cannot produce a valid object", async () => {
    seed("campaign", { id: "camp1" });
    const attempts: Array<[Campaign, RegExp]> = [
      [campaignRow({ dailyBudgetCents: null, lifetimeBudgetCents: null }), /budget/i],
      [campaignRow({ dailyBudgetCents: null, lifetimeBudgetCents: 10000, endTime: null }), /end date/i],
      [campaignRow({ targeting: null }), /country or city/i],
      [campaignRow({ targeting: { countries: ["UZ"], ageMin: 50, ageMax: 20 } }), /age/i],
      [campaignRow({ objective: "OUTCOME_SALES" }), /not supported/i],
    ];
    for (const [c, pattern] of attempts) {
      await expect(createCampaignInMeta(ACCOUNT, c)).rejects.toThrow(pattern);
    }
    expect(store.graphCalls).toHaveLength(0);
  });

  it("refuses when no ad account is linked, and when a Page-backed objective has no Page", async () => {
    seed("campaign", { id: "camp1" });
    await expect(createCampaignInMeta({ ...ACCOUNT, adAccountId: null } as InstagramAccount, campaignRow())).rejects.toMatchObject({
      code: "META_UNSUPPORTED",
      reason: expect.stringMatching(/ad account/i),
    });
    await expect(
      createCampaignInMeta({ ...ACCOUNT, fbPageId: null } as InstagramAccount, campaignRow({ objective: "OUTCOME_LEADS", metaFormId: "f1" })),
    ).rejects.toMatchObject({ code: "META_UNSUPPORTED", reason: expect.stringMatching(/Facebook Page/i) });
    expect(store.graphCalls).toHaveLength(0);
  });

  /**
   * A link/lead creative is published BY a Facebook Page (object_story_spec),
   * so without a Page there is nothing to publish it as. Catching that before
   * the first Graph call is what stops a campaign and an ad set being left
   * behind in Ads Manager with nothing pointing at them.
   */
  it("refuses a Page-less link creative up front instead of orphaning a campaign in Meta", async () => {
    seed("campaign", { id: "camp1" });
    const pageless = { ...ACCOUNT, fbPageId: null } as InstagramAccount;
    await expect(createCampaignInMeta(pageless, campaignRow({ objective: "OUTCOME_TRAFFIC" }))).rejects.toMatchObject({
      code: "META_UNSUPPORTED",
      reason: expect.stringMatching(/Page/i),
    });
    // nothing was created in Meta, so there is nothing orphaned to clean up
    expect(store.graphCalls).toHaveLength(0);
    expect(rowsIn("campaign")[0]!.metaCampaignId).toBeUndefined();

    // …but boosting an existing Instagram post needs no Page at all
    seed("contentItem", { id: "content1", mediaId: "17901" });
    await expect(createCampaignInMeta(pageless, campaignRow({ contentId: "content1" }))).resolves.toBeTruthy();
    expect(store.graphCalls).toHaveLength(4);
  });

  it("refuses a Leads button with no Instant Form, and a Traffic button with no URL", () => {
    expect(() => buildCallToAction({ ctaType: "SIGN_UP", objective: "OUTCOME_LEADS", metaFormId: null, destinationUrl: null })).toThrow(/Instant Form/);
    expect(() => buildCallToAction({ ctaType: "LEARN_MORE", objective: "OUTCOME_TRAFFIC", metaFormId: null, destinationUrl: null })).toThrow(/destination URL/);
    // Engagement routes through the ad set's destination_type, so it carries no value
    expect(buildCallToAction({ ctaType: "MESSAGE_PAGE", objective: "OUTCOME_ENGAGEMENT", metaFormId: null, destinationUrl: null })).toEqual({ type: "MESSAGE_PAGE" });
    // Awareness with nowhere to send people renders no button rather than a dead one
    expect(buildCallToAction({ ctaType: "LEARN_MORE", objective: "OUTCOME_AWARENESS", metaFormId: null, destinationUrl: null })).toBeNull();
  });
});

/**
 * Creation is always PAUSED, so activation is the ONLY thing in this module that
 * can start spending the ad account's money — and it is reachable only from the
 * admin-confirmed publish route.
 */
describe("campaign lifecycle in Meta", () => {
  const live = campaignRow({ metaCampaignId: "c_1", metaAdSetId: "s_1", metaCreativeId: "cr_1", metaAdId: "a_1" });

  it("refuses to activate a campaign that was never built in Meta", async () => {
    await expect(activateCampaignInMeta(ACCOUNT, campaignRow())).rejects.toThrow(/not been created in Meta/);
    await expect(activateCampaignInMeta(ACCOUNT, campaignRow({ metaCampaignId: "c_1", metaAdSetId: "s_1" }))).rejects.toThrow(/not been created in Meta/);
    expect(store.graphCalls).toHaveLength(0);
  });

  it("activates the campaign, the ad set and the ad — nothing else", async () => {
    await activateCampaignInMeta(ACCOUNT, live);
    expect(store.graphCalls.map((c) => [c.method, c.path, c.body?.status])).toEqual([
      ["POST", "c_1", "ACTIVE"],
      ["POST", "s_1", "ACTIVE"],
      ["POST", "a_1", "ACTIVE"],
    ]);
  });

  it("pauses by campaign object, and stopping archives it for good", async () => {
    await pauseCampaignInMeta(ACCOUNT, live);
    expect(store.graphCalls).toHaveLength(1);
    expect(store.graphCalls[0]).toMatchObject({ method: "POST", path: "c_1", body: { status: "PAUSED" } });

    store.graphCalls = [];
    await stopCampaignInMeta(ACCOUNT, live);
    expect(store.graphCalls).toHaveLength(1);
    expect(store.graphCalls[0]).toMatchObject({ method: "POST", path: "c_1", body: { status: "ARCHIVED" } });
  });

  it("has nothing to pause or stop for a campaign that only exists locally", async () => {
    await pauseCampaignInMeta(ACCOUNT, campaignRow());
    await stopCampaignInMeta(ACCOUNT, campaignRow());
    expect(store.graphCalls).toHaveLength(0);
  });

  it("will not touch a live object on an account with no ad account linked", async () => {
    const noAds = { ...ACCOUNT, adAccountId: null } as InstagramAccount;
    await expect(activateCampaignInMeta(noAds, live)).rejects.toMatchObject({ code: "META_UNSUPPORTED" });
    await expect(pauseCampaignInMeta(noAds, live)).rejects.toMatchObject({ code: "META_UNSUPPORTED" });
    await expect(stopCampaignInMeta(noAds, live)).rejects.toMatchObject({ code: "META_UNSUPPORTED" });
    expect(store.graphCalls).toHaveLength(0);
  });
});

// ================================================================
// 3. READING META BACK: reach estimate + insights
// ================================================================

describe("reach estimate parsing", () => {
  it("reads Meta's bounds in both the object and the array shape", () => {
    const obj = parseReachEstimate({ data: { users_lower_bound: 120000, users_upper_bound: 141000, estimate_ready: true } });
    expect(obj).toMatchObject({ available: true, usersLowerBound: 120000, usersUpperBound: 141000 });
    const arr = parseReachEstimate({ data: [{ users_lower_bound: 5, users_upper_bound: 9 }] });
    expect(arr).toMatchObject({ available: true, usersLowerBound: 5, usersUpperBound: 9 });
  });

  /**
   * Meta answers -1 for "I cannot tell you". Rendering that is a minus-one-person
   * audience on the screen, so it must come back as unavailable — with no number
   * anywhere in the result for a caller to pick up by accident.
   */
  it("treats Meta's -1 sentinel as UNAVAILABLE and exposes no number at all", () => {
    for (const data of [
      { users_lower_bound: -1, users_upper_bound: -1 },
      { users_lower_bound: -1, users_upper_bound: 50000 },
      { users_lower_bound: 1000, users_upper_bound: -1 },
    ]) {
      const r = parseReachEstimate({ data });
      expect(r.available).toBe(false);
      expect(r).toEqual({ available: false, reason: expect.stringContaining("unavailable") });
      expect(JSON.stringify(r)).not.toContain("-1");
      expect(Object.keys(r)).toEqual(["available", "reason"]);
    }
  });

  it("is unavailable for a not-ready estimate, a missing payload and unparseable numbers", () => {
    expect(parseReachEstimate({ data: { users_lower_bound: 10, users_upper_bound: 20, estimate_ready: false } }).available).toBe(false);
    expect(parseReachEstimate({}).available).toBe(false);
    expect(parseReachEstimate({ data: [] }).available).toBe(false);
    expect(parseReachEstimate({ data: { users_lower_bound: "many", users_upper_bound: "lots" } }).available).toBe(false);
    expect(parseReachEstimate({ data: { users_upper_bound: 20 } }).available).toBe(false);
  });

  it("accepts a genuine zero-reach answer (0 is a number Meta means)", () => {
    expect(parseReachEstimate({ data: { users_lower_bound: 0, users_upper_bound: 0 } })).toMatchObject({ available: true, usersLowerBound: 0 });
  });
});

describe("insights parsing", () => {
  const full = {
    spend: "12.34",
    impressions: "5400",
    reach: "4100",
    clicks: "87",
    cpc: "0.14",
    ctr: "1.61",
    actions: [
      { action_type: "link_click", value: "80" },
      { action_type: "lead", value: "6" },
    ],
    date_start: "2026-09-01",
    date_stop: "2026-09-12",
  };

  it("converts Meta's strings and picks the result action that matches the objective", () => {
    expect(parseCampaignInsights({ data: [full] }, "OUTCOME_LEADS", "USD")!.results).toBe(6);
    expect(parseCampaignInsights({ data: [full] }, "OUTCOME_TRAFFIC", "USD")!.results).toBe(80);
    expect(parseCampaignInsights({ data: [full] }, "OUTCOME_AWARENESS", "USD")!.results).toBe(4100);
    const i = parseCampaignInsights({ data: [full] }, "OUTCOME_TRAFFIC", "UZS")!;
    expect(i.spend).toBeCloseTo(12.34);
    expect(i.impressions).toBe(5400);
    expect(i.currency).toBe("UZS");
    expect(i.resultAction).toBe("link_click");
  });

  it("survives a row where Meta reported almost nothing", () => {
    const i = parseCampaignInsights({ data: [{}] }, "OUTCOME_TRAFFIC", "USD")!;
    expect(i).toMatchObject({ spend: 0, impressions: 0, reach: 0, clicks: 0, results: 0, dateStart: null, dateStop: null });
    // a rate Meta did not report is null — never a fabricated 0.00 cost-per-click
    expect(i.cpc).toBeNull();
    expect(i.ctr).toBeNull();
  });

  it("keeps an empty-string metric null and a garbage metric null rather than 0", () => {
    const i = parseCampaignInsights({ data: [{ cpc: "", ctr: "n/a" }] }, "OUTCOME_TRAFFIC", "USD")!;
    expect(i.cpc).toBeNull();
    expect(i.ctr).toBeNull();
  });

  it("returns null when Meta has no rows at all", () => {
    expect(parseCampaignInsights({ data: [] }, "OUTCOME_TRAFFIC", "USD")).toBeNull();
    expect(parseCampaignInsights({}, "OUTCOME_TRAFFIC", "USD")).toBeNull();
    expect(parseCampaignInsights({ data: { spend: "1" } }, "OUTCOME_TRAFFIC", "USD")).toBeNull();
  });

  it("reports 0 results — not a guess — for an objective whose action Meta did not return", () => {
    const i = parseCampaignInsights({ data: [{ ...full, actions: [] }] }, "OUTCOME_LEADS", "USD")!;
    expect(i.results).toBe(0);
    expect(i.resultAction).toBe("lead");
  });
});

// ================================================================
// 4. PRICING MATHS
// ================================================================

describe("pricing maths", () => {
  it("charges nothing when nothing is priced", () => {
    const q = computeCampaignQuote({ dailyBudgetCents: 500 }, DEFAULT_PRICING);
    expect(q).toMatchObject({ free: true, totalCents: 0, subtotalCents: 0, taxCents: 0, lines: [] });
  });

  it("adds a flat fee, a percentage of the first budget period, then tax", () => {
    const pricing: Pricing = { ...DEFAULT_PRICING, campaignFeeCents: 1000, campaignFeePercent: 10, taxPercent: 12 };
    const q = computeCampaignQuote({ dailyBudgetCents: 500, currency: "USD" }, pricing);
    expect(q.lines.map((l) => l.amountCents)).toEqual([1000, 350]); // 5.00 × 7 days = 35.00 → 10% = 3.50
    expect(q.subtotalCents).toBe(1350);
    expect(q.taxCents).toBe(162); // 13.50 × 12% = 1.62
    expect(q.totalCents).toBe(1512);
  });

  it("takes a lifetime percentage from the lifetime budget, ignoring any daily value", () => {
    const pricing: Pricing = { ...DEFAULT_PRICING, campaignFeePercent: 5 };
    const q = computeCampaignQuote({ lifetimeBudgetCents: 20000, dailyBudgetCents: 999 }, pricing);
    expect(q.totalCents).toBe(1000);
    expect(q.lines[0]!.description).toMatch(/lifetime budget/);
    expect(computeCampaignQuote({ dailyBudgetCents: 999 }, pricing).lines[0]!.description).toMatch(/7-day budget/);
  });

  /** Half a cent must round the same way every time, or the invoice will not add up. */
  it("rounds at the cent boundary deterministically (half up), and never emits a zero line", () => {
    // base 1000, 0.05% → 0.5 cents exactly
    expect(computeCampaignQuote({ lifetimeBudgetCents: 1000 }, { ...DEFAULT_PRICING, campaignFeePercent: 0.05 }).totalCents).toBe(1);
    // base 1000, 0.04% → 0.4 cents
    expect(computeCampaignQuote({ lifetimeBudgetCents: 1000 }, { ...DEFAULT_PRICING, campaignFeePercent: 0.04 }).totalCents).toBe(0);
    // base 333, 10% → 33.3 → 33
    expect(computeCampaignQuote({ lifetimeBudgetCents: 333 }, { ...DEFAULT_PRICING, campaignFeePercent: 10 }).totalCents).toBe(33);
    // base 335, 10% → 33.5 → 34 (floating point must not turn this into 33)
    expect(computeCampaignQuote({ lifetimeBudgetCents: 335 }, { ...DEFAULT_PRICING, campaignFeePercent: 10 }).totalCents).toBe(34);
    // a percentage too small to reach one cent adds no line at all
    const tiny = computeCampaignQuote({ lifetimeBudgetCents: 1 }, { ...DEFAULT_PRICING, campaignFeePercent: 10 });
    expect(tiny.lines).toEqual([]);
    expect(tiny.free).toBe(true);
    // tax rounds the same way: 1005 × 5% = 50.25 → 50
    expect(computeCampaignQuote({ lifetimeBudgetCents: 0 }, { ...DEFAULT_PRICING, campaignFeeCents: 1005, taxPercent: 5 }).taxCents).toBe(50);
  });

  it("prices the recurring plan separately from campaign fees", () => {
    expect(computePlanQuote(DEFAULT_PRICING).free).toBe(true);
    const q = computePlanQuote({ ...DEFAULT_PRICING, planName: "Pro", planAmountCents: 2900, taxPercent: 10 });
    expect(q.lines).toEqual([{ description: "Pro", amountCents: 2900 }]);
    expect(q.totalCents).toBe(3190);
  });
});

/**
 * THE CURRENCY GUARD. A percentage fee is a percentage OF the ad budget but is
 * charged in the platform's own currency. With no exchange rate anywhere in this
 * system, a mismatch can only be refused — never quietly converted at a made-up
 * rate, and never silently reduced to the flat half of the fee.
 */
describe("the currency guard on percentage fees", () => {
  const pricing: Pricing = { ...DEFAULT_PRICING, currency: "USD", campaignFeeCents: 1000, campaignFeePercent: 10 };

  it("refuses to price a percentage of a budget held in another currency", () => {
    expect(() => computeCampaignQuote({ dailyBudgetCents: 500, currency: "UZS" }, pricing)).toThrow(/cannot be calculated/);
    try {
      computeCampaignQuote({ lifetimeBudgetCents: 20000, currency: "EUR" }, pricing);
      expect.unreachable("a cross-currency percentage fee must be refused");
    } catch (err) {
      const e = err as { code?: string; reason?: string; fix?: string; details?: Record<string, unknown> };
      expect(e.code).toBe("VALIDATION");
      expect(e.reason).toMatch(/EUR/);
      expect(e.reason).toMatch(/USD/);
      expect(e.reason).toMatch(/converts no currencies/);
      expect(e.fix).toMatch(/flat campaign fee|Billing/);
      expect(e.details).toMatchObject({ campaignCurrency: "EUR", pricingCurrency: "USD", campaignFeePercent: 10 });
    }
  });

  it("prices normally when the currencies agree, whatever the casing", () => {
    expect(computeCampaignQuote({ dailyBudgetCents: 500, currency: "usd" }, pricing).totalCents).toBe(1350);
    expect(campaignFeeCurrencyProblem("USD", pricing)).toBeNull();
    expect(campaignFeeCurrencyProblem("usd", pricing)).toBeNull();
    // unknown campaign currency (the wizard previewing before an account is picked)
    expect(campaignFeeCurrencyProblem(null, pricing)).toBeNull();
    expect(campaignFeeCurrencyProblem("GBP", pricing)).toMatch(/GBP/);
  });

  it("only refuses when a percentage would really be charged", () => {
    expect(computeCampaignQuote({ dailyBudgetCents: 500, currency: "UZS" }, { ...pricing, campaignFeePercent: 0 }).totalCents).toBe(1000);
    expect(computeCampaignQuote({ dailyBudgetCents: 0, currency: "UZS" }, pricing).totalCents).toBe(1000);
    expect(computeCampaignQuote({ lifetimeBudgetCents: 0, dailyBudgetCents: null, currency: "UZS" }, pricing).totalCents).toBe(1000);
  });

  /** The campaigns list prices every row; one unpriceable row must not take the page down. */
  it("hands the list view a refusal instead of throwing it — the page cannot crash", () => {
    const list = [
      { id: "a", dailyBudgetCents: 500, currency: "USD" },
      { id: "b", dailyBudgetCents: 500, currency: "UZS" },
      { id: "c", lifetimeBudgetCents: 100_000, currency: "EUR" },
      { id: "d", lifetimeBudgetCents: 100_000, currency: "USD" },
    ];
    let rendered: Array<{ id: string; total: number | null; problem: string | null }> = [];
    expect(() => {
      rendered = list.map((c) => {
        const r = campaignQuoteOrProblem(c, pricing);
        return { id: c.id, total: r.quote?.totalCents ?? null, problem: r.problem };
      });
    }).not.toThrow();

    expect(rendered).toEqual([
      { id: "a", total: 1350, problem: null },
      { id: "b", total: null, problem: expect.stringContaining("UZS") },
      { id: "c", total: null, problem: expect.stringContaining("EUR") },
      { id: "d", total: 11000, problem: null },
    ]);
    // a refused row shows no price at all — not the flat half the server would not honour
    expect(rendered[1]!.total).toBeNull();
  });
});

// ================================================================
// 5. STRIPE WEBHOOK SIGNATURE
// ================================================================

describe("Stripe webhook signature verification", () => {
  const secret = "whsec_test_secret";
  const body = JSON.stringify({ id: "evt_1", type: "payment_intent.succeeded", data: { object: { id: "pi_1" } } });
  const t = 1_800_000_000;
  const sig = hmacSha256(secret, `${t}.${body}`);

  it("accepts a correctly signed, fresh payload", () => {
    expect(verifyStripeSignature(body, `t=${t},v1=${sig}`, secret, 300, t * 1000 + 10_000)).toEqual({ ok: true, timestamp: t });
  });

  it("rejects a WRONG signature — tampered body, wrong secret, garbage hex, truncated hex", () => {
    expect(verifyStripeSignature(`${body} `, `t=${t},v1=${sig}`, secret, 300, t * 1000).ok).toBe(false);
    expect(verifyStripeSignature(body, `t=${t},v1=${sig}`, "whsec_other", 300, t * 1000)).toEqual({ ok: false, reason: "signature mismatch" });
    expect(verifyStripeSignature(body, `t=${t},v1=${"0".repeat(64)}`, secret, 300, t * 1000).ok).toBe(false);
    expect(verifyStripeSignature(body, `t=${t},v1=${sig.slice(0, 32)}`, secret, 300, t * 1000).ok).toBe(false);
    // an empty v1 must never pass a constant-time compare
    expect(verifyStripeSignature(body, `t=${t},v1=`, secret, 300, t * 1000).ok).toBe(false);
  });

  it("rejects a timestamp outside the tolerance in EITHER direction", () => {
    expect(verifyStripeSignature(body, `t=${t},v1=${sig}`, secret, 300, (t + 301) * 1000)).toEqual({ ok: false, reason: "timestamp outside tolerance" });
    expect(verifyStripeSignature(body, `t=${t},v1=${sig}`, secret, 300, (t - 301) * 1000)).toEqual({ ok: false, reason: "timestamp outside tolerance" });
    // exactly at the edge is still inside
    expect(verifyStripeSignature(body, `t=${t},v1=${sig}`, secret, 300, (t + 300) * 1000).ok).toBe(true);
    // replay a day later
    expect(verifyStripeSignature(body, `t=${t},v1=${sig}`, secret, 300, (t + 86_400) * 1000).ok).toBe(false);
  });

  it("rejects malformed headers and accepts one of several v1s (key rotation)", () => {
    expect(verifyStripeSignature(body, null, secret).ok).toBe(false);
    expect(verifyStripeSignature(body, "", secret).ok).toBe(false);
    expect(verifyStripeSignature(body, `v1=${sig}`, secret).ok).toBe(false);
    expect(verifyStripeSignature(body, `t=${t}`, secret, 300, t * 1000)).toEqual({ ok: false, reason: "missing v1 signature" });
    expect(verifyStripeSignature(body, `t=abc,v1=${sig}`, secret, 300, t * 1000)).toEqual({ ok: false, reason: "missing timestamp" });
    expect(verifyStripeSignature(body, `t=${t},v1=deadbeef,v1=${sig}`, secret, 300, t * 1000).ok).toBe(true);
  });
});

// ================================================================
// 6. BILLING SERVICE — payments, idempotency, refunds, schedules
// ================================================================

describe("payment creation is idempotent", () => {
  it("returns the existing payment for a key it has already minted", async () => {
    const customer = seedCustomer();
    const quote = { currency: "USD", lines: [], subtotalCents: 1500, taxCents: 0, totalCents: 1500, free: false };
    const first = await createPayment({ customer: customer as never, kind: "MANUAL", description: "Fee", quote, idempotencyKey: "k1" });
    const second = await createPayment({ customer: customer as never, kind: "MANUAL", description: "Fee", quote, idempotencyKey: "k1" });
    expect(second.id).toBe(first.id);
    expect(rowsIn("payment")).toHaveLength(1);
  });

  /** Two requests racing between the lookup and the insert: the loser adopts the winner's row. */
  it("survives the create/find race and never mints two payments for one key", async () => {
    const customer = seedCustomer();
    const quote = { currency: "USD", lines: [], subtotalCents: 1500, taxCents: 0, totalCents: 1500, free: false };
    store.onPaymentFindUnique = (where) => {
      if (where.idempotencyKey !== "race") return;
      store.onPaymentFindUnique = null;
      // the other request commits its row in the gap
      seed("payment", { id: "winner", customerId: "cust1", kind: "MANUAL", description: "Fee", amountCents: 1500, currency: "USD", status: "PENDING", idempotencyKey: "race", attempts: 0 });
    };
    const p = await createPayment({ customer: customer as never, kind: "MANUAL", description: "Fee", quote, idempotencyKey: "race" });
    expect(p.id).toBe("winner");
    expect(rowsIn("payment").filter((r) => r.idempotencyKey === "race")).toHaveLength(1);
  });
});

describe("campaign fee payments", () => {
  it("charges nothing and records a zero fee when the campaign is free", async () => {
    const customer = seedCustomer();
    seed("campaign", { id: "c1", name: "Free one", dailyBudgetCents: 500, currency: "USD" });
    const { payment, quote } = await createCampaignFeePayment(customer as never, "c1");
    expect(payment).toBeNull();
    expect(quote.free).toBe(true);
    expect(rowsIn("campaign")[0]!.platformFeeCents).toBe(0);
    expect(rowsIn("payment")).toHaveLength(0);
  });

  it("mints one payment for the quoted amount and stamps the fee on the campaign", async () => {
    setPricing({ campaignFeeCents: 1000, campaignFeePercent: 10, taxPercent: 12 });
    const customer = seedCustomer();
    seed("campaign", { id: "c1", name: "Autumn", dailyBudgetCents: 500, currency: "USD" });
    const { payment, quote } = await createCampaignFeePayment(customer as never, "c1");
    expect(quote.totalCents).toBe(1512);
    expect(payment!.amountCents).toBe(1512);
    expect(payment!.idempotencyKey).toBe("campaign-fee:c1:1512USD");
    expect(rowsIn("campaign")[0]!.platformFeeCents).toBe(1512);

    // asking twice does not create a second invoice-able payment
    const again = await createCampaignFeePayment(customer as never, "c1");
    expect(again.payment!.id).toBe(payment!.id);
    expect(rowsIn("payment")).toHaveLength(1);
  });

  /** A price change must never leave two live quotes for one campaign. */
  it("cancels the unpaid payment at the old price when pricing changes", async () => {
    setPricing({ campaignFeeCents: 1000 });
    const customer = seedCustomer();
    seed("campaign", { id: "c1", name: "Autumn", dailyBudgetCents: 500, currency: "USD" });
    const old = (await createCampaignFeePayment(customer as never, "c1")).payment!;
    expect(old.amountCents).toBe(1000);

    setPricing({ campaignFeeCents: 2500 });
    const fresh = (await createCampaignFeePayment(customer as never, "c1")).payment!;
    expect(fresh.amountCents).toBe(2500);
    expect(fresh.id).not.toBe(old.id);

    const rows = rowsIn("payment");
    expect(rows.find((r) => r.id === old.id)!.status).toBe("CANCELED");
    expect(rows.filter((r) => r.status === "PENDING")).toHaveLength(1);
  });

  it("refuses to quote a campaign whose currency the percentage cannot cross — and writes no payment", async () => {
    setPricing({ currency: "USD", campaignFeePercent: 10 });
    const customer = seedCustomer();
    seed("campaign", { id: "c1", name: "Tashkent", dailyBudgetCents: 500, currency: "UZS" });
    await expect(createCampaignFeePayment(customer as never, "c1")).rejects.toThrow(/cannot be calculated/);
    expect(rowsIn("payment")).toHaveLength(0);
  });

  it("gates creating the campaign in Meta on the fee actually being paid", async () => {
    setPricing({ campaignFeeCents: 2000 });
    const customer = seedCustomer();
    seed("campaign", { id: "c1", name: "Autumn", dailyBudgetCents: 500, currency: "USD" });
    await createCampaignFeePayment(customer as never, "c1");

    const unpaid = await campaignFeeStatus("c1");
    expect(unpaid).toMatchObject({ required: true, paid: false });
    expect(() => assertCampaignFeePaid(unpaid)).toThrow(/has not been paid/);
    try {
      assertCampaignFeePaid(unpaid);
    } catch (err) {
      expect((err as { code?: string }).code).toBe("REQUIRES_PAYMENT");
      expect((err as { reason?: string }).reason).toMatch(/Meta's advertising spend is separate/);
    }

    rowsIn("payment")[0]!.status = "SUCCEEDED";
    const paid = await campaignFeeStatus("c1");
    expect(paid).toMatchObject({ required: true, paid: true });
    expect(() => assertCampaignFeePaid(paid)).not.toThrow();
  });
});

describe("collecting a payment", () => {
  function autoPayCustomer(): Row {
    const customer = seedCustomer({ autoPay: true, defaultPaymentMethodId: "pm_local_1" });
    seedCardFor("cust1");
    return customer;
  }

  it("charges a saved card off-session and settles the payment, with an invoice and an audit entry", async () => {
    const customer = autoPayCustomer();
    const payment = seedPayment();
    const out = await collectPayment(payment as never, customer as never, { allowOffSession: true });
    expect(out.checkoutUrl).toBeNull();
    expect(out.payment.status).toBe("SUCCEEDED");
    expect(out.payment.attempts).toBe(1);
    expect(out.payment.paidAt).toBeInstanceOf(Date);
    expect(out.payment.receiptUrl).toMatch(/pay\.stripe\.test/);

    const charge = [...store.stripe.charges.values()][0]!;
    expect(charge.input.idempotencyKey).toBe(chargeIdempotencyKey("idem-1", 1));
    expect(charge.input.amountCents).toBe(1500);
    expect(rowsIn("invoice")).toHaveLength(1);
    expect(rowsIn("invoice")[0]!.number).toBe(`INV-${new Date().getUTCFullYear()}-00001`);
    expect(rowsIn("auditLog").map((a) => a.action)).toContain("PAYMENT_SUCCEEDED");
  });

  it("opens hosted Checkout when there is no off-session card, and leaves the row PENDING", async () => {
    const customer = seedCustomer();
    const payment = seedPayment();
    const out = await collectPayment(payment as never, customer as never, { allowOffSession: true, returnPath: "/campaigns" });
    expect(out.checkoutUrl).toMatch(/^https:\/\/checkout\.stripe\.test\//);
    expect(out.payment.status).toBe("PENDING");
    expect(out.payment.attempts).toBe(1);
    expect(out.payment.providerCheckoutSessionId).toMatch(/^cs_/);
    expect(store.stripe.charges.size).toBe(0);
  });

  it("does nothing for an already settled payment, and refuses a cancelled or refunded one", async () => {
    const customer = autoPayCustomer();
    const done = seedPayment({ id: "p_ok", idempotencyKey: "k-ok", status: "SUCCEEDED" });
    expect((await collectPayment(done as never, customer as never, { allowOffSession: true })).payment.status).toBe("SUCCEEDED");
    expect(store.stripe.charges.size).toBe(0);

    for (const status of ["CANCELED", "REFUNDED"]) {
      const dead = seedPayment({ id: `p_${status}`, idempotencyKey: `k-${status}`, status });
      await expect(collectPayment(dead as never, customer as never, { allowOffSession: true })).rejects.toThrow(new RegExp(status.toLowerCase()));
    }
    expect(store.stripe.charges.size).toBe(0);
  });

  /**
   * Two triggers on one payment (a manual retry and the hourly job) must not each
   * mint their own attempt number — two different idempotency keys would be two
   * real charges.
   */
  it("lets only one of two concurrent collectors claim the attempt", async () => {
    const customer = autoPayCustomer();
    const payment = seedPayment();
    // the other trigger got there first and already moved the row on
    const stale = { ...payment };
    rowsIn("payment")[0]!.status = "PROCESSING";
    rowsIn("payment")[0]!.attempts = 1;

    const out = await collectPayment(stale as never, customer as never, { allowOffSession: true });
    // it is handed the current state rather than racing to charge as well
    expect(out.payment.attempts).toBe(1);
    expect(store.stripe.calls.filter((c) => c.method === "chargeOffSession")).toHaveLength(0);
  });

  it("reads — never re-charges — a PROCESSING payment the provider gave a reference for", async () => {
    const customer = autoPayCustomer();
    store.stripe.intents.set("pi_known", { id: "pi_known", status: "succeeded", chargeId: "ch_known", receiptUrl: "https://r", failureCode: null, failureMessage: null, amount: 1500, currency: "USD" });
    const payment = seedPayment({ status: "PROCESSING", attempts: 1, providerPaymentIntentId: "pi_known" });
    const out = await collectPayment(payment as never, customer as never, { allowOffSession: true });
    expect(out.payment.status).toBe("SUCCEEDED");
    expect(store.stripe.charges.size).toBe(0);
    expect(store.stripe.calls.some((c) => c.method === "retrieveIntent")).toBe(true);
  });

  it("records a decline as a failed payment with a retry date, and alerts the admin", async () => {
    const customer = autoPayCustomer();
    store.stripe.outcome = "requires_payment_method";
    const payment = seedPayment();
    const out = await collectPayment(payment as never, customer as never, { allowOffSession: true });
    expect(out.payment.status).toBe("FAILED");
    expect(out.payment.failureCode).toBe("insufficient_funds");
    expect(out.payment.nextRetryAt).toBeInstanceOf(Date);
    expect(rowsIn("auditLog").map((a) => a.action)).toContain("PAYMENT_FAILED");
    expect(alertMock.mock.calls.some(([subject]) => /FAILED/.test(String(subject)))).toBe(true);
    expect(rowsIn("invoice")).toHaveLength(0);
  });

  it("schedules no automatic retry for a customer who is not on automatic payments", async () => {
    const customer = seedCustomer({ autoPay: false, defaultPaymentMethodId: "pm_local_1" });
    seedCardFor("cust1");
    const payment = seedPayment({ status: "PROCESSING", attempts: 1, providerPaymentIntentId: "pi_declined" });
    store.stripe.intents.set("pi_declined", { id: "pi_declined", status: "requires_payment_method", chargeId: null, receiptUrl: null, failureCode: "card_declined", failureMessage: "Declined.", amount: 1500, currency: "USD" });
    const out = await collectPayment(payment as never, customer as never, { allowOffSession: true });
    expect(out.payment.status).toBe("FAILED");
    expect(out.payment.nextRetryAt).toBeNull();
  });
});

/**
 * THE ONE THAT MATTERS: a charge whose HTTP response was lost. Stripe took the
 * money; we never heard. Re-sending that same attempt under its own key is a
 * replay, and the customer must end up charged exactly once.
 */
describe("a charge whose answer never came back", () => {
  it("replays the same attempt and settles on the original charge — exactly one payment taken", async () => {
    const customer = seedCustomer({ autoPay: true, defaultPaymentMethodId: "pm_local_1" });
    seedCardFor("cust1");
    const payment = seedPayment();

    store.stripe.loseNextResponse = true;
    await expect(collectPayment(payment as never, customer as never, { allowOffSession: true })).rejects.toThrow(/socket hang up/);

    const stranded = rowsIn("payment")[0]!;
    expect(stranded.status).toBe("PROCESSING");
    expect(stranded.attempts).toBe(1);
    expect(stranded.providerPaymentIntentId).toBeNull(); // untraced: nothing to read

    // twenty minutes later — still inside Stripe's 24h window — the reconciler picks it up
    const later = new Date((stranded.updatedAt as Date).getTime() + 20 * 60_000);
    const settled = await reconcileStuckPayments(later);
    expect(settled).toBe(1);

    const final = rowsIn("payment")[0]!;
    expect(final.status).toBe("SUCCEEDED");
    expect(final.attempts).toBe(1); // the counter never advanced past an unaccounted charge
    // Stripe saw one distinct charge and one replay of it
    expect(store.stripe.charges.size).toBe(1);
    expect(store.stripe.replays).toEqual([chargeIdempotencyKey("idem-1", 1)]);
    expect(rowsIn("invoice")).toHaveLength(1);
  });

  it("stops replaying once Stripe has forgotten the key, and says so instead of charging again", async () => {
    seedCustomer({ autoPay: true, defaultPaymentMethodId: "pm_local_1" });
    seedCardFor("cust1");
    const payment = seedPayment({ status: "PROCESSING", attempts: 1 });
    // the row has sat untraced for two days
    (payment as Row).updatedAt = new Date(Date.now() - 48 * 3600_000);

    const settled = await reconcileStuckPayments(new Date());
    expect(settled).toBe(0);
    expect(store.stripe.charges.size).toBe(0);
    expect(rowsIn("payment")[0]!.status).toBe("PROCESSING");
  });
});

describe("applyIntent never regresses a settled payment", () => {
  it("keeps a SUCCEEDED payment succeeded when a late failure arrives, and issues no second invoice", async () => {
    seedCustomer();
    const payment = seedPayment({ status: "SUCCEEDED", paidAt: new Date(BASE_TIME), providerPaymentIntentId: "pi_x" });
    const after = await applyIntent(payment.id as string, { id: "pi_x", status: "requires_payment_method", chargeId: null, receiptUrl: null, failureCode: "x", failureMessage: "late", amount: 1500, currency: "USD" }, { source: "test" });
    expect(after.status).toBe("SUCCEEDED");
    expect(rowsIn("invoice")).toHaveLength(0);

    // applying the same success twice creates one invoice, not two
    const p2 = seedPayment({ id: "p2", idempotencyKey: "k2", status: "PROCESSING" });
    const summary = { id: "pi_y", status: "succeeded", chargeId: "ch_y", receiptUrl: null, failureCode: null, failureMessage: null, amount: 1500, currency: "USD" };
    await applyIntent(p2.id as string, summary, { source: "webhook" });
    await applyIntent(p2.id as string, summary, { source: "webhook-redelivery" });
    expect(rowsIn("invoice")).toHaveLength(1);
    expect(rowsIn("auditLog").filter((a) => a.action === "PAYMENT_SUCCEEDED")).toHaveLength(1);
  });
});

describe("provider webhook events", () => {
  const event = (over: Row = {}): { id: string; type: string; data: { object: Record<string, unknown> } } => ({
    id: "evt_1",
    type: "payment_intent.succeeded",
    data: { object: { id: "pi_1", metadata: {} } },
    ...over,
  }) as never;

  it("processes an event once and acknowledges a redelivery without re-running it", async () => {
    seedCustomer();
    seedPayment({ providerPaymentIntentId: "pi_1", status: "PROCESSING" });
    store.stripe.intents.set("pi_1", { id: "pi_1", status: "succeeded", chargeId: "ch_1", receiptUrl: null, failureCode: null, failureMessage: null, amount: 1500, currency: "USD" });

    expect(await recordAndProcessEvent(event())).toBe("processed");
    const reads = store.stripe.calls.filter((c) => c.method === "retrieveIntent").length;
    expect(await recordAndProcessEvent(event())).toBe("duplicate");
    expect(store.stripe.calls.filter((c) => c.method === "retrieveIntent")).toHaveLength(reads);
    expect(rowsIn("billingEvent")).toHaveLength(1);
    expect(rowsIn("billingEvent")[0]!.status).toBe("PROCESSED");
  });

  it("ignores an event type it does not handle, and one whose payment it cannot find", async () => {
    expect(await recordAndProcessEvent(event({ id: "evt_unknown", type: "invoice.finalized" }))).toBe("ignored");
    expect(await recordAndProcessEvent(event({ id: "evt_orphan" }))).toBe("ignored");
    expect(rowsIn("billingEvent").every((r) => r.status === "IGNORED")).toBe(true);
  });

  it("marks a handler failure FAILED and recovers it on the replay pass", async () => {
    seedCustomer();
    seedPayment({ providerPaymentIntentId: "pi_1", status: "PROCESSING" });
    store.stripe.intents.set("pi_1", { id: "pi_1", status: "succeeded", chargeId: "ch_1", receiptUrl: null, failureCode: null, failureMessage: null, amount: 1500, currency: "USD" });
    store.stripe.failNextRetrieveIntent = true;

    expect(await recordAndProcessEvent(event())).toBe("failed");
    const row = rowsIn("billingEvent")[0]!;
    expect(row.status).toBe("FAILED");
    expect(String(row.error)).toMatch(/stripe is down/);
    expect(rowsIn("payment")[0]!.status).toBe("PROCESSING");

    const out = await replayFailedBillingEvents(new Date(Date.now() + 6 * 60_000));
    expect(out).toMatchObject({ replayed: 1, recovered: 1, failed: 0 });
    expect(rowsIn("billingEvent")[0]!.status).toBe("PROCESSED");
    expect(rowsIn("payment")[0]!.status).toBe("SUCCEEDED");
  });

  it("settles a hosted-Checkout payment from checkout.session.completed", async () => {
    const customer = seedCustomer({ providerCustomerId: "cus_A" });
    const payment = seedPayment({ status: "PENDING" });
    store.stripe.intents.set("pi_cs", { id: "pi_cs", status: "succeeded", chargeId: "ch_cs", receiptUrl: "https://r", failureCode: null, failureMessage: null, amount: 1500, currency: "USD" });
    const res = await recordAndProcessEvent({
      id: "evt_cs",
      type: "checkout.session.completed",
      data: { object: { id: "cs_1", mode: "payment", payment_intent: "pi_cs", customer: "cus_A", metadata: { paymentId: String(payment.id) } } },
    });
    expect(res).toBe("processed");
    const row = rowsIn("payment")[0]!;
    expect(row.status).toBe("SUCCEEDED");
    expect(row.providerPaymentIntentId).toBe("pi_cs");
    expect(row.providerCheckoutSessionId).toBe("cs_1");
    expect(customer.id).toBe("cust1");
  });
});

describe("refunds", () => {
  it("tells a partial refund from a full one straight off Stripe's amounts", () => {
    expect(summarizeRefund({ amount: 1512, amount_refunded: 1512, refunded: true })).toEqual({ chargeCents: 1512, refundedCents: 1512, full: true });
    expect(summarizeRefund({ amount: 1512, amount_refunded: 500, refunded: false })).toEqual({ chargeCents: 1512, refundedCents: 500, full: false });
    expect(summarizeRefund({ amount: 1512, amount_refunded: 1600, refunded: false }).full).toBe(true);
    // an unreadable payload stays partial rather than writing the payment off
    expect(summarizeRefund({}).full).toBe(false);
    expect(summarizeRefund({ refunded: true }).full).toBe(true);
  });

  it("leaves a partially refunded payment SETTLED, recording the amounts in the audit log", async () => {
    seedCustomer();
    seedPayment({ status: "SUCCEEDED", providerPaymentIntentId: "pi_r", paidAt: new Date(BASE_TIME) });
    const res = await recordAndProcessEvent({
      id: "evt_partial",
      type: "charge.refunded",
      data: { object: { id: "ch_r", payment_intent: "pi_r", amount: 1500, amount_refunded: 500, refunded: false } },
    });
    expect(res).toBe("processed");
    const row = rowsIn("payment")[0]!;
    expect(row.status).toBe("SUCCEEDED");
    expect(row.refundedAt).toBeInstanceOf(Date);
    const entry = rowsIn("auditLog").find((a) => a.action === "PAYMENT_PARTIALLY_REFUNDED")!;
    expect(entry).toBeTruthy();
    expect(entry.after).toMatchObject({ full: false, refundedCents: 500, chargeCents: 1500 });
  });

  it("marks a fully refunded payment REFUNDED", async () => {
    seedCustomer();
    seedPayment({ status: "SUCCEEDED", providerPaymentIntentId: "pi_r", paidAt: new Date(BASE_TIME) });
    await recordAndProcessEvent({
      id: "evt_full",
      type: "charge.refunded",
      data: { object: { id: "ch_r", payment_intent: "pi_r", amount: 1500, amount_refunded: 1500, refunded: true } },
    });
    expect(rowsIn("payment")[0]!.status).toBe("REFUNDED");
    expect(rowsIn("auditLog").map((a) => a.action)).toContain("PAYMENT_REFUNDED");
  });

  it("ignores a refund for a charge that belongs to no payment here", async () => {
    expect(
      await recordAndProcessEvent({ id: "evt_alien", type: "charge.refunded", data: { object: { id: "ch_z", payment_intent: "pi_unknown", amount: 100, amount_refunded: 100, refunded: true } } }),
    ).toBe("ignored");
  });
});

describe("recurring schedules", () => {
  function seedSchedule(over: Row = {}): Row {
    return seed("billingSchedule", {
      id: "sch1",
      customerId: "cust1",
      name: "Platform plan",
      amountCents: 2900,
      currency: "USD",
      intervalDays: 30,
      nextBillingAt: new Date(BASE_TIME),
      lastBilledAt: null,
      status: "ACTIVE",
      campaignId: null,
      canceledAt: null,
      ...over,
    });
  }

  it("charges a due schedule automatically and moves it to the next period", async () => {
    seedCustomer({ autoPay: true, defaultPaymentMethodId: "pm_local_1" });
    seedCardFor("cust1");
    const schedule = seedSchedule();
    const out = await runDueSchedules(new Date(BASE_TIME + 1000));
    expect(out).toMatchObject({ charged: 1, pendingCreated: 0, skipped: 0 });
    expect(rowsIn("payment")[0]!.status).toBe("SUCCEEDED");
    expect((schedule.nextBillingAt as Date).getTime()).toBe(BASE_TIME + 30 * 86400_000);
    expect(schedule.lastBilledAt).toBeInstanceOf(Date);
  });

  it("creates a pending payment and notifies the admin when automatic payments are off", async () => {
    seedCustomer({ autoPay: false });
    const schedule = seedSchedule();
    const out = await runDueSchedules(new Date(BASE_TIME + 1000));
    expect(out).toMatchObject({ charged: 0, pendingCreated: 1 });
    expect(rowsIn("payment")[0]!.status).toBe("PENDING");
    expect(alertMock.mock.calls.some(([s]) => /Payment due/.test(String(s)))).toBe(true);
    // the period must not be re-created on the next run
    expect((schedule.nextBillingAt as Date).getTime()).toBeGreaterThan(BASE_TIME);
  });

  it("does not stall for ever on a period whose payment was cancelled", async () => {
    seedCustomer({ autoPay: false });
    const schedule = seedSchedule();
    seed("payment", {
      id: "dead", customerId: "cust1", kind: "PLAN", description: "Platform plan", amountCents: 2900, currency: "USD",
      status: "CANCELED", idempotencyKey: `schedule:sch1:${BASE_TIME}`, attempts: 0, scheduleId: "sch1", dueAt: new Date(BASE_TIME),
    });
    const out = await runDueSchedules(new Date(BASE_TIME + 1000));
    expect(out.skipped).toBe(1);
    expect((schedule.nextBillingAt as Date).getTime()).toBeGreaterThan(BASE_TIME);
    // and the following run mints the NEXT period rather than re-finding the dead row
    const out2 = await runDueSchedules(new Date(BASE_TIME + 40 * 86400_000));
    expect(out2.pendingCreated).toBe(1);
  });

  it("cancelling one occurrence steps the schedule on rather than ending the series", async () => {
    seedCustomer();
    const schedule = seedSchedule();
    const payment = seedPayment({ scheduleId: "sch1", dueAt: new Date(BASE_TIME), status: "PENDING" });
    const canceled = await cancelPayment(payment as never, "admin1");
    expect(canceled.status).toBe("CANCELED");
    expect((schedule.nextBillingAt as Date).getTime()).toBe(BASE_TIME + 30 * 86400_000);
    expect(rowsIn("auditLog").map((a) => a.action)).toContain("PAYMENT_CANCELED");
  });

  it("does not step a schedule that has already moved past the cancelled occurrence", async () => {
    seedCustomer();
    const moved = new Date(BASE_TIME + 30 * 86400_000);
    const schedule = seedSchedule({ nextBillingAt: moved });
    const payment = seedPayment({ scheduleId: "sch1", dueAt: new Date(BASE_TIME), status: "PENDING" });
    await cancelPayment(payment as never, "admin1");
    expect((schedule.nextBillingAt as Date).getTime()).toBe(moved.getTime());
  });

  it("refuses to cancel a payment that is not still outstanding", async () => {
    seedCustomer();
    const paid = seedPayment({ status: "SUCCEEDED" });
    await expect(cancelPayment(paid as never, "admin1")).rejects.toThrow(/cannot be cancelled/);
  });

  it("creates, repoints and cancels the plan schedule as the plan price changes", async () => {
    const customer = seedCustomer();
    setPricing({ planName: "Pro", planAmountCents: 2900 });
    await ensurePlanSchedule(customer as never);
    expect(rowsIn("billingSchedule")).toHaveLength(1);
    expect(rowsIn("billingSchedule")[0]!).toMatchObject({ amountCents: 2900, name: "Pro", status: "ACTIVE" });

    setPricing({ planName: "Pro", planAmountCents: 4900, planIntervalDays: 7 });
    await ensurePlanSchedule(customer as never);
    expect(rowsIn("billingSchedule")).toHaveLength(1);
    expect(rowsIn("billingSchedule")[0]!).toMatchObject({ amountCents: 4900, intervalDays: 7 });

    setPricing({ planName: null, planAmountCents: 0 });
    await ensurePlanSchedule(customer as never);
    expect(rowsIn("billingSchedule")[0]!.status).toBe("CANCELED");
  });

  it("advances billing dates without drift when the scheduler was down", () => {
    const prev = new Date("2026-08-01T00:00:00Z");
    expect(nextBillingDate(prev, 30, new Date("2026-08-15T00:00:00Z")).toISOString()).toBe("2026-08-31T00:00:00.000Z");
    expect(nextBillingDate(prev, 30, new Date("2026-10-15T00:00:00Z")).toISOString()).toBe("2026-10-30T00:00:00.000Z");
  });
});

describe("failed-payment retries", () => {
  it("retries only what is due, on an auto-pay customer with a card", async () => {
    seedCustomer({ autoPay: true, defaultPaymentMethodId: "pm_local_1" });
    seedCardFor("cust1");
    const now = new Date(BASE_TIME + 10 * 86400_000);
    seedPayment({ id: "due", idempotencyKey: "k-due", status: "FAILED", attempts: 1, nextRetryAt: new Date(BASE_TIME) });
    seedPayment({ id: "not-yet", idempotencyKey: "k-later", status: "FAILED", attempts: 1, nextRetryAt: new Date(BASE_TIME + 60 * 86400_000) });

    const out = await retryFailedPayments(now);
    expect(out).toMatchObject({ retried: 1, succeeded: 1 });
    expect(rowsIn("payment").find((p) => p.id === "due")!.status).toBe("SUCCEEDED");
    expect(rowsIn("payment").find((p) => p.id === "not-yet")!.status).toBe("FAILED");
    // the retry is a NEW attempt with its own key — not a replay of the failed one
    expect([...store.stripe.charges.keys()]).toEqual([chargeIdempotencyKey("k-due", 2)]);
  });

  it("does not retry a customer who turned automatic payments off", async () => {
    seedCustomer({ autoPay: false, defaultPaymentMethodId: "pm_local_1" });
    seedCardFor("cust1");
    seedPayment({ status: "FAILED", attempts: 1, nextRetryAt: new Date(BASE_TIME) });
    const out = await retryFailedPayments(new Date(BASE_TIME + 86400_000));
    expect(out.retried).toBe(0);
    expect(store.stripe.charges.size).toBe(0);
  });
});

describe("payment methods", () => {
  it("mirrors Stripe's cards, picks a default and retires ones that disappeared", async () => {
    const customer = seedCustomer();
    store.stripe.cards = [
      { id: "pm_a", brand: "visa", last4: "4242", expMonth: 1, expYear: 2031 },
      { id: "pm_b", brand: "mastercard", last4: "4444", expMonth: 2, expYear: 2032 },
    ];
    const methods = await refreshPaymentMethods(customer as never);
    expect(methods).toHaveLength(2);
    expect(rowsIn("paymentCustomer")[0]!.defaultPaymentMethodId).toBe(methods[0]!.id);

    // the first card is removed at Stripe
    store.stripe.cards = [{ id: "pm_b", brand: "mastercard", last4: "4444", expMonth: 2, expYear: 2032 }];
    const after = await refreshPaymentMethods(rowsIn("paymentCustomer")[0]! as never);
    expect(after).toHaveLength(1);
    expect(after[0]!.providerMethodId).toBe("pm_b");
    expect(rowsIn("paymentMethod").find((m) => m.providerMethodId === "pm_a")!.removedAt).toBeInstanceOf(Date);
    expect(rowsIn("paymentCustomer")[0]!.defaultPaymentMethodId).toBe(after[0]!.id);
  });

  it("turns automatic payments off when the last card goes", async () => {
    const customer = seedCustomer({ autoPay: true, defaultPaymentMethodId: "pm_local_1" });
    seedCardFor("cust1");
    store.stripe.cards = [];
    await refreshPaymentMethods(customer as never);
    const row = rowsIn("paymentCustomer")[0]!;
    expect(row.defaultPaymentMethodId).toBeNull();
    expect(row.autoPay).toBe(false);
  });

  it("refuses to switch automatic payments on with no card on file", async () => {
    const customer = seedCustomer();
    store.stripe.cards = [];
    await expect(setAutoPay(customer as never, true, "admin1")).rejects.toThrow(/payment method/i);
    expect(rowsIn("paymentCustomer")[0]!.autoPay).toBe(false);
  });

  it("switches automatic payments on once a card exists, and audits it", async () => {
    const customer = seedCustomer();
    store.stripe.cards = [{ id: "pm_a", brand: "visa", last4: "4242", expMonth: 1, expYear: 2031 }];
    const updated = await setAutoPay(customer as never, true, "admin1");
    expect(updated.autoPay).toBe(true);
    expect(rowsIn("auditLog").map((a) => a.action)).toContain("ENABLED_AUTOMATIC_PAYMENTS");
  });
});
