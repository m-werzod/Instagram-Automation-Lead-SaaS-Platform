import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
      if (args?.include?.account) {
        const acc = rowsOf("instagramAccount").find((a) => a.id === row.accountId);
        out.account = acc ? { ...acc } : null;
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
    instagramAccount: table("instagramAccount", { defaults: { isDemo: false } }),
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
  syncCampaignFromMeta,
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
  canReplayCharge,
  IDEMPOTENCY_WINDOW_MS,
  inFlightPaymentAction,
  invoiceNumber,
  nextRetryAt as computeNextRetryAt,
  paymentStatusFromIntent,
  RETRY_DELAYS_DAYS,
  type Pricing,
} from "@/lib/billing/pricing";
import {
  verifyStripeSignature,
  summarizeRefund,
  cardFromPaymentMethod,
  formEncode,
  PaymentProviderError,
  StripeClient,
  summarizeIntent,
} from "@/lib/billing/stripe";
import { hmacSha256 } from "@/lib/crypto";
import {
  applyIntent,
  assertCampaignFeePaid,
  campaignFeeStatus,
  cancelPayment,
  collectPayment,
  createCampaignFeePayment,
  createPayment,
  ensureCustomer,
  ensurePlanSchedule,
  findCustomer,
  getPricing,
  recordAndProcessEvent,
  reconcileStuckPayments,
  refreshPaymentMethods,
  removeMethod,
  replayFailedBillingEvents,
  retryFailedPayments,
  runDueSchedules,
  setAutoPay,
  setDefaultMethod,
  syncPaymentFromProvider,
  toPricing,
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
      expect(e.fix).toMatch(/flat campaign fee/);
      expect(e.details).toMatchObject({ campaignCurrency: "EUR", pricingCurrency: "USD", campaignFeePercent: 10 });
    }
  });

  /**
   * The "fix" is an instruction the owner will follow. Every amount in this
   * system is an integer of 1/100th of a unit, which is only true for a
   * 2-decimal currency — telling them to set the pricing currency to UZS (or
   * any zero-decimal one) would turn every later charge into a 100x overcharge.
   */
  it("only ever advises switching to a currency this platform can actually bill in", () => {
    const fixFor = (currency: string): string => {
      try {
        computeCampaignQuote({ lifetimeBudgetCents: 20000, currency }, pricing);
        return expect.unreachable(`${currency} must be refused`) as never;
      } catch (err) {
        return String((err as { fix?: string }).fix);
      }
    };
    // EUR is billable here, so naming it is safe advice
    expect(fixFor("EUR")).toMatch(/Set the pricing currency to EUR/);
    // UZS is not — the advice must NOT be "set the pricing currency to UZS"
    expect(fixFor("UZS")).not.toMatch(/pricing currency to UZS/);
    expect(fixFor("UZS")).toMatch(/USD, EUR, GBP/);
    expect(fixFor("JPY")).not.toMatch(/pricing currency to JPY/);
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
    expect(row.receiptUrl).toBe("https://r");
    // the session's customer is ours, so the card it saved is mirrored too
    expect(store.stripe.calls.some((c) => c.method === "listCards" && c.args === customer.providerCustomerId)).toBe(true);
    expect(rowsIn("invoice")).toHaveLength(1);
  });

  /**
   * Checkout puts our paymentId in the session metadata, but a PaymentIntent
   * webhook can arrive for an intent this row has not been stamped with yet
   * (the two race). The metadata fallback is what stops that becoming an
   * "unknown payment, ignored" and a paid customer left PENDING for ever.
   */
  it("finds the payment by metadata when the intent id is not on the row yet", async () => {
    seedCustomer();
    const payment = seedPayment({ status: "PENDING", providerPaymentIntentId: null });
    store.stripe.intents.set("pi_meta", { id: "pi_meta", status: "succeeded", chargeId: "ch_meta", receiptUrl: null, failureCode: null, failureMessage: null, amount: 1500, currency: "USD" });

    const res = await recordAndProcessEvent({
      id: "evt_meta",
      type: "payment_intent.succeeded",
      data: { object: { id: "pi_meta", metadata: { paymentId: String(payment.id) } } },
    });
    expect(res).toBe("processed");
    expect(rowsIn("payment")[0]!.status).toBe("SUCCEEDED");
    expect(rowsIn("payment")[0]!.providerPaymentIntentId).toBe("pi_meta");
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
    // the period must not be re-created on the next run — it steps exactly one interval
    expect((schedule.nextBillingAt as Date).getTime()).toBe(BASE_TIME + 30 * 86400_000);
    // …and a second run of the scheduler finds nothing due, so no second payment is minted
    expect(await runDueSchedules(new Date(BASE_TIME + 2000))).toMatchObject({ charged: 0, pendingCreated: 0, skipped: 0 });
    expect(rowsIn("payment")).toHaveLength(1);
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

// ================================================================
// 12. REACH ESTIMATE — READING META'S NUMBERS STRICTLY
// ================================================================

/**
 * The -1 sentinel is not the only way Meta can decline to give a number, and
 * `Number()` is a lossy way to ask: Number(null), Number(""), Number(" ") and
 * Number([]) are all 0. A bound that arrives as any of those is "Meta told us
 * nothing", but a 0 reach estimate is a real, meaningful answer this product
 * deliberately renders (see the zero-reach test above) — so coercing one into
 * the other invents an audience size and shows it with full confidence.
 * parseCampaignInsights' own `opt()` already draws exactly this line.
 */
describe("reach estimate — a bound Meta did not actually give is never read as a number", () => {
  const blankBounds: Array<[string, unknown]> = [
    ["null", null],
    ["empty string", ""],
    ["whitespace", "   "],
    ["empty array", []],
    ["boolean", true],
    ["object", {}],
  ];

  it.each(blankBounds)("treats a %s bound as unavailable rather than as zero people", (_label, value) => {
    const both = parseReachEstimate({ data: { users_lower_bound: value, users_upper_bound: value } });
    expect(both.available).toBe(false);
    expect(Object.keys(both)).toEqual(["available", "reason"]);

    // and the same when only ONE bound is junk — a half-known range is not a range
    const lowerOnly = parseReachEstimate({ data: { users_lower_bound: value, users_upper_bound: 50_000 } });
    expect(lowerOnly.available).toBe(false);
    const upperOnly = parseReachEstimate({ data: { users_lower_bound: 1_000, users_upper_bound: value } });
    expect(upperOnly.available).toBe(false);
  });

  it("still accepts the numeric strings Meta legitimately sends", () => {
    expect(parseReachEstimate({ data: { users_lower_bound: "1200", users_upper_bound: "3400" } })).toMatchObject({
      available: true,
      usersLowerBound: 1200,
      usersUpperBound: 3400,
    });
    // and a genuine zero is still a genuine zero, not collateral damage from the fix
    expect(parseReachEstimate({ data: { users_lower_bound: 0, users_upper_bound: 0 } })).toMatchObject({ available: true, usersLowerBound: 0 });
    expect(parseReachEstimate({ data: { users_lower_bound: "0", users_upper_bound: "0" } })).toMatchObject({ available: true, usersLowerBound: 0 });
  });

  it("never lets a non-number reach the caller as usersLowerBound/usersUpperBound", () => {
    for (const v of [null, "", "   ", [], {}, true, "abc", NaN, Infinity, undefined]) {
      const r = parseReachEstimate({ data: { users_lower_bound: v, users_upper_bound: v } });
      if (r.available) {
        expect.unreachable(`a ${JSON.stringify(v)} bound must not be reported as available`);
      }
    }
  });
});

// ================================================================
// 13. THE REAL STRIPE WIRE FORMAT
// ================================================================

/**
 * Everything above this point drives billing through FakeStripeProvider, which
 * is right for testing what the SERVICE decides. It leaves the code that
 * actually talks to Stripe — the form encoder, the auth/idempotency headers,
 * the HTTP error mapping and the response parsers — completely unexercised.
 * These tests drive the REAL StripeClient/StripeProvider against a stubbed
 * global fetch: nothing leaves the process, but the bytes that would have gone
 * to Stripe are asserted exactly.
 */

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
  hasAbortSignal: boolean;
}
type StripeReply = { status?: number; json?: unknown; text?: string; throws?: unknown };

function stubStripeFetch(reply: StripeReply | ((call: FetchCall) => StripeReply)): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: Record<string, unknown>) => {
      const call: FetchCall = {
        url: String(input),
        method: String(init?.method ?? "GET"),
        headers: { ...((init?.headers ?? {}) as Record<string, string>) },
        body: init?.body as string | undefined,
        hasAbortSignal: (init?.signal as unknown) instanceof AbortSignal,
      };
      calls.push(call);
      const r = typeof reply === "function" ? reply(call) : reply;
      if (r.throws !== undefined) throw r.throws;
      return new Response(r.text ?? JSON.stringify(r.json ?? {}), {
        status: r.status ?? 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  return calls;
}

/** The form body Stripe would have received, as key/value pairs. */
function sentParams(call: FetchCall): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(call.body ?? ""));
}

/** Never leave a stubbed global fetch behind for whatever runs next. */
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Stripe form encoding — the shape Stripe actually requires", () => {
  const entries = (o: Record<string, unknown>) => Array.from(formEncode(o).entries());

  it("flattens nested objects into a[b] and arrays into a[0]", () => {
    expect(entries({ amount: 1500, currency: "usd" })).toEqual([
      ["amount", "1500"],
      ["currency", "usd"],
    ]);
    expect(entries({ metadata: { adminId: "a1", campaignId: "c1" } })).toEqual([
      ["metadata[adminId]", "a1"],
      ["metadata[campaignId]", "c1"],
    ]);
    expect(entries({ payment_method_types: ["card"] })).toEqual([["payment_method_types[0]", "card"]]);
  });

  it("encodes an array of objects the way line_items needs", () => {
    expect(entries({ line_items: [{ quantity: 1, price_data: { currency: "usd", unit_amount: 1350 } }] })).toEqual([
      ["line_items[0][quantity]", "1"],
      ["line_items[0][price_data][currency]", "usd"],
      ["line_items[0][price_data][unit_amount]", "1350"],
    ]);
  });

  it("sends booleans as Stripe's literal true/false", () => {
    expect(entries({ off_session: true, confirm: false })).toEqual([
      ["off_session", "true"],
      ["confirm", "false"],
    ]);
  });

  /** A dropped key is absent; a stringified "null" would be a value Stripe stores. */
  it("omits null and undefined entirely instead of sending the word 'null'", () => {
    const out = formEncode({ a: 1, b: null, c: undefined, nested: { keep: "y", drop: null } });
    expect(Array.from(out.entries())).toEqual([
      ["a", "1"],
      ["nested[keep]", "y"],
    ]);
    expect(out.toString()).not.toContain("null");
    expect(out.toString()).not.toContain("undefined");
  });
});

describe("StripeClient — headers, transport and error mapping", () => {
  const client = new StripeClient("sk_test_wire");

  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs a form-encoded body with auth, pinned API version and an idempotency key", async () => {
    const calls = stubStripeFetch({ json: { id: "pi_1" } });
    await client.request("POST", "/payment_intents", { amount: 500, currency: "usd" }, { idempotencyKey: "key-1" });

    expect(calls).toHaveLength(1);
    const c = calls[0]!;
    expect(c.url).toBe("https://api.stripe.com/v1/payment_intents");
    expect(c.method).toBe("POST");
    expect(c.headers.Authorization).toBe("Bearer sk_test_wire");
    expect(c.headers["Stripe-Version"]).toBe("2024-06-20");
    expect(c.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(c.headers["Idempotency-Key"]).toBe("key-1");
    expect(sentParams(c)).toEqual({ amount: "500", currency: "usd" });
    // the timeout can only fire if a signal was actually wired to the request
    expect(c.hasAbortSignal).toBe(true);
  });

  it("omits the Idempotency-Key header when none was asked for", async () => {
    const calls = stubStripeFetch({ json: {} });
    await client.request("POST", "/customers", { email: "a@b.c" });
    expect(calls[0]!.headers["Idempotency-Key"]).toBeUndefined();
  });

  it("puts GET params in the query string and sends no body", async () => {
    const calls = stubStripeFetch({ json: { data: [] } });
    await client.request("GET", "/payment_methods", { customer: "cus_1", type: "card", limit: 20 });
    const c = calls[0]!;
    expect(c.method).toBe("GET");
    expect(c.body).toBeUndefined();
    const q = new URL(c.url).searchParams;
    expect(q.get("customer")).toBe("cus_1");
    expect(q.get("type")).toBe("card");
    expect(q.get("limit")).toBe("20");
  });

  it("maps a card decline onto PaymentProviderError with its codes intact", async () => {
    stubStripeFetch({
      status: 402,
      json: { error: { type: "card_error", code: "card_declined", decline_code: "insufficient_funds", message: "Your card has insufficient funds." } },
    });
    const err = await client.request("POST", "/payment_intents", { amount: 1 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PaymentProviderError);
    const e = err as PaymentProviderError;
    expect(e.code).toBe("PAYMENT_PROVIDER_ERROR");
    expect(e.status).toBe(402);
    expect(e.isCardDeclined).toBe(true);
    expect(e.providerCode).toBe("card_declined");
    expect(e.declineCode).toBe("insufficient_funds");
    expect(e.message).toBe("Your card has insufficient funds.");
    expect(e.fix).toMatch(/declined/i);
  });

  it("points a 401 at the secret key rather than telling the admin to retry", async () => {
    stubStripeFetch({ status: 401, json: { error: { type: "invalid_request_error", message: "Invalid API Key provided" } } });
    const e = (await client.request("GET", "/customers").catch((x: unknown) => x)) as PaymentProviderError;
    expect(e.status).toBe(401);
    expect(e.isCardDeclined).toBe(false);
    expect(e.fix).toMatch(/PAYMENT_SECRET_KEY/);
  });

  /** An HTML 502 from a proxy must not surface as a raw SyntaxError from JSON.parse. */
  it("turns a non-JSON response into a payment error, not a parser crash", async () => {
    stubStripeFetch({ status: 502, text: "<html><body>Bad Gateway</body></html>" });
    const e = (await client.request("GET", "/customers").catch((x: unknown) => x)) as PaymentProviderError;
    expect(e).toBeInstanceOf(PaymentProviderError);
    expect(e).not.toBeInstanceOf(SyntaxError);
    expect(e.message).toMatch(/non-JSON/);
    expect(e.status).toBe(502);
  });

  it("treats an empty 200 body as an empty object", async () => {
    stubStripeFetch({ status: 200, text: "" });
    await expect(client.request("POST", "/payment_methods/pm_1/detach")).resolves.toEqual({});
  });

  it("reports a network failure and an abort as 'could not reach', never as a success", async () => {
    stubStripeFetch({ throws: new TypeError("fetch failed") });
    const net = (await client.request("GET", "/customers").catch((x: unknown) => x)) as PaymentProviderError;
    expect(net).toBeInstanceOf(PaymentProviderError);
    expect(net.status).toBe(503);
    expect(net.message).toMatch(/Could not reach/);

    const abort = Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
    stubStripeFetch({ throws: abort });
    const timedOut = (await client.request("POST", "/payment_intents", { amount: 1 }).catch((x: unknown) => x)) as PaymentProviderError;
    expect(timedOut).toBeInstanceOf(PaymentProviderError);
    expect(timedOut.status).toBe(503);
  });

  /** A transport-level status outside 4xx/5xx must not become an HTTP status we return. */
  it("clamps an implausible provider status to 502", () => {
    expect(new PaymentProviderError("x", { status: 600 }).status).toBe(502);
    expect(new PaymentProviderError("x", { status: 0 }).status).toBe(502);
    expect(new PaymentProviderError("x").status).toBe(502);
    expect(new PaymentProviderError("x", { status: 429 }).status).toBe(429);
  });
});

/** The real provider, not the fake: what would have gone over the wire to Stripe. */
const realStripe = await vi.importActual<typeof import("@/lib/billing/stripe")>("@/lib/billing/stripe");

describe("StripeProvider — the requests that move money", () => {
  const provider = new realStripe.StripeProvider("sk_test_wire");

  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("charges a saved card off-session under a key derived from the attempt", async () => {
    const calls = stubStripeFetch({ json: { id: "pi_9", status: "succeeded", amount: 1350, currency: "usd", latest_charge: { id: "ch_9", receipt_url: "https://receipt" } } });
    const out = await provider.chargeOffSession({
      customerId: "cus_1",
      paymentMethodId: "pm_1",
      amountCents: 1350,
      currency: "USD",
      description: "Campaign fee",
      metadata: { paymentId: "pay1" },
      idempotencyKey: chargeIdempotencyKey("k-1", 1),
    });

    const c = calls[0]!;
    expect(c.url).toBe("https://api.stripe.com/v1/payment_intents");
    // the same attempt replays rather than double-charging only because the key is stable
    expect(c.headers["Idempotency-Key"]).toBe("pi:k-1:1");
    expect(sentParams(c)).toMatchObject({
      amount: "1350",
      currency: "usd", // Stripe rejects an uppercase currency
      customer: "cus_1",
      payment_method: "pm_1",
      off_session: "true",
      confirm: "true",
      description: "Campaign fee",
      "metadata[paymentId]": "pay1",
      "expand[]": "latest_charge",
    });
    expect(out).toMatchObject({ id: "pi_9", status: "succeeded", chargeId: "ch_9", receiptUrl: "https://receipt", amount: 1350, currency: "USD" });
  });

  /** A decline is an outcome to record, not a transport failure to blow up on. */
  it("returns a declined card as a failed summary instead of throwing", async () => {
    stubStripeFetch({
      status: 402,
      json: { error: { type: "card_error", code: "card_declined", decline_code: "do_not_honor", message: "Your card was declined." } },
    });
    const out = await provider.chargeOffSession({
      customerId: "cus_1",
      paymentMethodId: "pm_1",
      amountCents: 900,
      currency: "EUR",
      description: "d",
      metadata: {},
      idempotencyKey: "k:1",
    });
    expect(out.status).toBe("requires_payment_method");
    expect(paymentStatusFromIntent(out.status)).toBe("FAILED");
    expect(out.failureCode).toBe("do_not_honor");
    expect(out.failureMessage).toMatch(/declined/i);
    expect(out.amount).toBe(900);
    expect(out.currency).toBe("EUR");
    expect(out.chargeId).toBeNull();
  });

  /** An API outage is NOT a decline: swallowing it would mark a payment failed and start the retry clock. */
  it("still throws when the failure is not a card error", async () => {
    stubStripeFetch({ status: 500, json: { error: { type: "api_error", message: "Stripe is down" } } });
    await expect(
      provider.chargeOffSession({ customerId: "c", paymentMethodId: "p", amountCents: 1, currency: "USD", description: "d", metadata: {}, idempotencyKey: "k:1" }),
    ).rejects.toBeInstanceOf(PaymentProviderError);
  });

  it("builds a hosted Checkout that charges once and saves the card for later", async () => {
    const calls = stubStripeFetch({ json: { id: "cs_1", url: "https://checkout", payment_intent: "pi_1" } });
    const out = await provider.createPaymentSession({
      customerId: "cus_1",
      amountCents: 1512,
      currency: "USD",
      description: "Platform plan",
      successUrl: "https://app/ok",
      cancelUrl: "https://app/no",
      metadata: { paymentId: "pay1" },
      idempotencyKey: "k-1:1",
    });
    const p = sentParams(calls[0]!);
    expect(calls[0]!.url).toBe("https://api.stripe.com/v1/checkout/sessions");
    expect(calls[0]!.headers["Idempotency-Key"]).toBe("cs:k-1:1");
    expect(p).toMatchObject({
      mode: "payment",
      customer: "cus_1",
      "line_items[0][quantity]": "1",
      "line_items[0][price_data][currency]": "usd",
      "line_items[0][price_data][unit_amount]": "1512",
      "line_items[0][price_data][product_data][name]": "Platform plan",
      "payment_intent_data[setup_future_usage]": "off_session",
      success_url: "https://app/ok",
      cancel_url: "https://app/no",
    });
    expect(out).toEqual({ id: "cs_1", url: "https://checkout", paymentIntentId: "pi_1" });
  });

  /** Saving a card must not be able to take money: no amount may appear anywhere in the body. */
  it("creates a setup session that charges nothing", async () => {
    const calls = stubStripeFetch({ json: { id: "cs_2", url: "https://setup" } });
    await provider.createSetupSession({ customerId: "cus_1", successUrl: "https://ok", cancelUrl: "https://no", metadata: { adminId: "a1" } });
    const p = sentParams(calls[0]!);
    expect(p.mode).toBe("setup");
    expect(Object.keys(p).join(",")).not.toMatch(/amount|line_items|price_data/);
  });

  it("refunds against the payment intent under its own idempotency key", async () => {
    const calls = stubStripeFetch({ json: { id: "re_1", status: "succeeded" } });
    const out = await provider.refund("pi_1", "k-1");
    expect(calls[0]!.url).toBe("https://api.stripe.com/v1/refunds");
    expect(calls[0]!.headers["Idempotency-Key"]).toBe("re:k-1");
    expect(sentParams(calls[0]!)).toEqual({ payment_intent: "pi_1" });
    expect(out).toEqual({ id: "re_1", status: "succeeded" });
  });

  it("lists cards and URL-encodes ids on the detach and default-card paths", async () => {
    const listCalls = stubStripeFetch({ json: { data: [{ id: "pm_1", card: { brand: "visa", last4: "4242", exp_month: 4, exp_year: 2030 } }] } });
    expect(await provider.listCards("cus_1")).toEqual([{ id: "pm_1", brand: "visa", last4: "4242", expMonth: 4, expYear: 2030 }]);
    expect(new URL(listCalls[0]!.url).searchParams.get("type")).toBe("card");

    const detachCalls = stubStripeFetch({ json: {} });
    await provider.detachCard("pm/../evil");
    expect(detachCalls[0]!.url).toBe("https://api.stripe.com/v1/payment_methods/pm%2F..%2Fevil/detach");

    const defaultCalls = stubStripeFetch({ json: {} });
    await provider.setDefaultCard("cus_1", "pm_1");
    expect(sentParams(defaultCalls[0]!)).toEqual({ "invoice_settings[default_payment_method]": "pm_1" });
  });

  /** The portal is optional (it must be switched on in the dashboard); its absence must not break Billing. */
  it("returns null rather than throwing when the billing portal is not enabled", async () => {
    stubStripeFetch({ status: 400, json: { error: { type: "invalid_request_error", message: "No configuration provided" } } });
    await expect(provider.portalUrl("cus_1", "https://back")).resolves.toBeNull();
  });
});

describe("Stripe response parsing", () => {
  it("reads an expanded charge and a bare charge id the same way", () => {
    expect(summarizeIntent({ id: "pi_1", status: "succeeded", amount: 100, currency: "eur", latest_charge: { id: "ch_1", receipt_url: "https://r" } })).toEqual({
      id: "pi_1",
      status: "succeeded",
      chargeId: "ch_1",
      receiptUrl: "https://r",
      failureCode: null,
      failureMessage: null,
      amount: 100,
      currency: "EUR",
    });
    const bare = summarizeIntent({ id: "pi_2", status: "processing", latest_charge: "ch_2" });
    expect(bare.chargeId).toBe("ch_2");
    expect(bare.receiptUrl).toBeNull();
    expect(bare.amount).toBe(0);
    expect(bare.currency).toBe("USD");
  });

  it("prefers the decline code over the generic error code", () => {
    const s = summarizeIntent({ id: "pi_3", status: "requires_payment_method", last_payment_error: { code: "card_declined", decline_code: "lost_card", message: "Declined" } });
    expect(s.failureCode).toBe("lost_card");
    expect(summarizeIntent({ id: "pi_4", status: "x", last_payment_error: { code: "expired_card", message: "m" } }).failureCode).toBe("expired_card");
    expect(summarizeIntent({ id: "pi_5" }).status).toBe("unknown");
  });

  it("reads a payment method with no card block without inventing details", () => {
    expect(cardFromPaymentMethod({ id: "pm_1" })).toEqual({ id: "pm_1", brand: null, last4: null, expMonth: null, expYear: null });
    expect(cardFromPaymentMethod({ id: "pm_2", card: { brand: "amex", last4: "0005" } })).toMatchObject({ brand: "amex", last4: "0005", expMonth: null });
  });
});

// ================================================================
// 14. THE SMALL PURE RULES THE MONEY PATH RESTS ON
// ================================================================

describe("payment status mapping and helpers", () => {
  it("maps every Stripe intent status this product acts on", () => {
    expect(
      Object.fromEntries(
        ["succeeded", "processing", "requires_action", "requires_confirmation", "canceled", "requires_payment_method"].map((s) => [s, paymentStatusFromIntent(s)]),
      ),
    ).toEqual({
      succeeded: "SUCCEEDED",
      processing: "PROCESSING",
      requires_action: "REQUIRES_ACTION",
      requires_confirmation: "REQUIRES_ACTION",
      canceled: "CANCELED",
      requires_payment_method: "FAILED",
    });
  });

  /** An unrecognised status must never be optimistically read as SUCCEEDED. */
  it("falls back to PENDING for a status it does not know", () => {
    for (const s of ["requires_capture", "", "totally_new_status"]) {
      expect(paymentStatusFromIntent(s)).toBe("PENDING");
    }
  });

  it("numbers invoices per year, zero-padded, without truncating a big sequence", () => {
    expect(invoiceNumber(2026, 1)).toBe("INV-2026-00001");
    expect(invoiceNumber(2026, 99999)).toBe("INV-2026-99999");
    expect(invoiceNumber(2026, 100000)).toBe("INV-2026-100000");
  });

  /**
   * Past Stripe's 24h idempotency window a "replay" is a second charge. The
   * boundary has to be exclusive, or a payment exactly 24h old is re-sent under
   * a key Stripe has already forgotten.
   */
  it("allows a replay only inside Stripe's 24-hour idempotency window", () => {
    const sent = new Date(BASE_TIME);
    expect(canReplayCharge(sent, new Date(BASE_TIME + 1000))).toBe(true);
    expect(canReplayCharge(sent, new Date(BASE_TIME + IDEMPOTENCY_WINDOW_MS - 1))).toBe(true);
    expect(canReplayCharge(sent, new Date(BASE_TIME + IDEMPOTENCY_WINDOW_MS))).toBe(false);
    expect(canReplayCharge(sent, new Date(BASE_TIME + IDEMPOTENCY_WINDOW_MS + 1))).toBe(false);
  });

  /**
   * "Replay" re-sends the charge. It is only safe when the provider never gave
   * us a reference for this attempt AND we can charge off-session — anything
   * else must be READ, or a Checkout payment gets charged a second time under a
   * different key.
   */
  it("only re-sends a charge that the provider left no trace of", () => {
    const none = { providerPaymentIntentId: null, providerCheckoutSessionId: null };
    expect(inFlightPaymentAction(none, true)).toBe("replay");
    expect(inFlightPaymentAction(none, false)).toBe("read");
    expect(inFlightPaymentAction({ providerPaymentIntentId: "pi_1", providerCheckoutSessionId: null }, true)).toBe("read");
    expect(inFlightPaymentAction({ providerPaymentIntentId: null, providerCheckoutSessionId: "cs_1" }, true)).toBe("read");
    expect(inFlightPaymentAction({ providerPaymentIntentId: "pi_1", providerCheckoutSessionId: "cs_1" }, true)).toBe("read");
  });

  it("backs off 1, 3 then 7 days and then gives up for good", () => {
    const failedAt = new Date(BASE_TIME);
    const days = (d: Date | null) => (d === null ? null : Math.round((d.getTime() - BASE_TIME) / 86400_000));
    expect([1, 2, 3].map((a) => days(computeNextRetryAt(a, failedAt)))).toEqual([...RETRY_DELAYS_DAYS]);
    expect(computeNextRetryAt(4, failedAt)).toBeNull();
    expect(computeNextRetryAt(99, failedAt)).toBeNull();
    // attempt 0 has not happened yet — there is nothing to schedule
    expect(computeNextRetryAt(0, failedAt)).toBeNull();
  });
});

// ================================================================
// 15. AUDIT PASS — paths a user reaches that nothing above exercised
// ================================================================

/**
 * The campaign fee's idempotency key contains the quoted amount, and a quote at
 * a price that is no longer current is CANCELED. Change a price and change it
 * back — which is exactly what an owner trying out pricing does — and the key
 * for the original price points at a row that was cancelled on the way past.
 * `POST /api/billing/payments` hands whatever comes back straight to
 * collectPayment, and a cancelled payment cannot be collected.
 */
describe("a campaign fee after a price change is reverted", () => {
  async function priceTrip(): Promise<{ customer: Row; first: Row; back: Row }> {
    setPricing({ campaignFeeCents: 1000 });
    const customer = seedCustomer();
    seed("campaign", { id: "c1", name: "Autumn", dailyBudgetCents: 500, currency: "USD" });

    const first = (await createCampaignFeePayment(customer as never, "c1")).payment! as unknown as Row;
    setPricing({ campaignFeeCents: 2500 });
    await createCampaignFeePayment(customer as never, "c1");
    setPricing({ campaignFeeCents: 1000 }); // the owner changes their mind back
    const back = (await createCampaignFeePayment(customer as never, "c1")).payment! as unknown as Row;
    return { customer, first, back };
  }

  it("hands back a payment the admin can actually pay, not a cancelled one", async () => {
    const { customer, first, back } = await priceTrip();
    // same key -> necessarily the same row; it must have been re-opened, not left dead
    expect(back.id).toBe(first.id);
    expect(back.amountCents).toBe(1000);
    expect(back.status).toBe("PENDING");
    expect(back.canceledAt).toBeNull();

    // this is precisely what the pay route does next with it
    const out = await collectPayment(back as never, customer as never, { allowOffSession: true, returnPath: "/campaigns" });
    expect(out.checkoutUrl).toMatch(/^https:\/\/checkout\.stripe\.test\//);
  });

  it("opens the Create-in-Meta gate once that revived fee is paid", async () => {
    const { back } = await priceTrip();
    const payer = rowsIn("paymentCustomer")[0]!;
    payer.autoPay = true;
    payer.defaultPaymentMethodId = "pm_local_1";
    seedCardFor("cust1");

    const paid = await collectPayment(back as never, payer as never, { allowOffSession: true });
    expect(paid.payment.status).toBe("SUCCEEDED");
    expect(paid.payment.amountCents).toBe(1000);

    // the gate must see the fee that was paid, not the stale cancelled quote
    const status = await campaignFeeStatus("c1");
    expect(status).toMatchObject({ required: true, paid: true });
    expect(() => assertCampaignFeePaid(status)).not.toThrow();
  });

  it("still refuses when the price moved on and the new quote is unpaid", async () => {
    setPricing({ campaignFeeCents: 1000 });
    const customer = seedCustomer({ autoPay: true, defaultPaymentMethodId: "pm_local_1" });
    seedCardFor("cust1");
    seed("campaign", { id: "c1", name: "Autumn", dailyBudgetCents: 500, currency: "USD" });

    const cheap = (await createCampaignFeePayment(customer as never, "c1")).payment!;
    await collectPayment(cheap as never, customer as never, { allowOffSession: true });
    expect((await campaignFeeStatus("c1")).paid).toBe(true);

    setPricing({ campaignFeeCents: 2500 });
    await createCampaignFeePayment(customer as never, "c1");
    const status = await campaignFeeStatus("c1");
    expect(status).toMatchObject({ required: true, paid: false });
    expect(status.quote.totalCents).toBe(2500);
    expect(() => assertCampaignFeePaid(status)).toThrow(/has not been paid/);
  });
});

/**
 * The staged race earlier proves the LOSER backs off. This runs both collectors
 * for real, concurrently, on one payment — the manual "Pay now" button and the
 * hourly retry job landing together — and counts the charges Stripe saw.
 */
describe("two collectors racing for real", () => {
  it("takes exactly one charge, mints one attempt and one invoice", async () => {
    const customer = seedCustomer({ autoPay: true, defaultPaymentMethodId: "pm_local_1" });
    seedCardFor("cust1");
    const payment = seedPayment();

    const [a, b] = await Promise.all([
      collectPayment({ ...payment } as never, customer as never, { allowOffSession: true }),
      collectPayment({ ...payment } as never, customer as never, { allowOffSession: true }),
    ]);

    expect(store.stripe.calls.filter((c) => c.method === "chargeOffSession")).toHaveLength(1);
    expect(store.stripe.charges.size).toBe(1);
    expect([...store.stripe.charges.keys()]).toEqual([chargeIdempotencyKey("idem-1", 1)]);
    expect(rowsIn("payment")[0]!.attempts).toBe(1);
    expect(rowsIn("payment")[0]!.status).toBe("SUCCEEDED");
    expect(rowsIn("invoice")).toHaveLength(1);
    // both callers are told the truth; neither is handed a half-finished row
    expect([a.payment.status, b.payment.status]).toContain("SUCCEEDED");
    expect(a.payment.attempts).toBe(1);
    expect(b.payment.attempts).toBe(1);
  });
});

/**
 * Stripe answers `requires_action` for a saved card that wants 3-D Secure —
 * routine for European cards on an off-session charge. The money is NOT taken,
 * and the intent stays open and confirmable.
 */
describe("an off-session charge the cardholder has to authenticate", () => {
  function authCustomer(): Row {
    const customer = seedCustomer({ autoPay: true, defaultPaymentMethodId: "pm_local_1" });
    seedCardFor("cust1");
    return customer;
  }

  it("records it as REQUIRES_ACTION, takes no money and writes no invoice", async () => {
    const customer = authCustomer();
    store.stripe.outcome = "requires_action";
    const out = await collectPayment(seedPayment() as never, customer as never, { allowOffSession: true });
    expect(out.payment.status).toBe("REQUIRES_ACTION");
    expect(out.payment.paidAt).toBeNull();
    expect(rowsIn("invoice")).toHaveLength(0);
  });

  /** Neither recovery job looks at REQUIRES_ACTION, so the admin has to be told. */
  it("tells the admin, because nothing automatic will ever pick it up again", async () => {
    const customer = authCustomer();
    store.stripe.outcome = "requires_action";
    await collectPayment(seedPayment() as never, customer as never, { allowOffSession: true });

    const day = new Date(Date.now() + 86400_000);
    expect(await reconcileStuckPayments(day)).toBe(0);
    expect(await retryFailedPayments(day)).toMatchObject({ retried: 0, succeeded: 0 });
    expect(rowsIn("payment")[0]!.status).toBe("REQUIRES_ACTION");

    const alerted = alertMock.mock.calls.map(([subject, text]) => `${String(subject)} ${String(text)}`).join("\n");
    expect(alerted).toMatch(/authenticat/i);
    expect(rowsIn("auditLog").map((a) => a.action)).toContain("PAYMENT_REQUIRES_ACTION");
  });

  /**
   * Charging it off-session again cannot satisfy 3-D Secure — it just opens a
   * SECOND intent for the same money, and if the customer then authenticates
   * the first one they are charged twice. Paying again must read the existing
   * intent and otherwise hand them hosted Checkout, where authentication can
   * actually happen.
   */
  it("never answers 'pay again' with a second off-session charge", async () => {
    const customer = authCustomer();
    store.stripe.outcome = "requires_action";
    const first = await collectPayment(seedPayment() as never, customer as never, { allowOffSession: true });
    expect(store.stripe.charges.size).toBe(1);
    expect(first.payment.providerPaymentIntentId).toBeTruthy();

    const row = rowsIn("payment")[0]!;
    const again = await collectPayment(row as never, customer as never, { allowOffSession: true, returnPath: "/billing" });

    // no new PaymentIntent was created behind the cardholder's back
    expect(store.stripe.charges.size).toBe(1);
    expect(again.checkoutUrl).toMatch(/^https:\/\/checkout\.stripe\.test\//);
  });

  it("settles instead of re-charging when the customer authenticated it elsewhere", async () => {
    const customer = authCustomer();
    store.stripe.outcome = "requires_action";
    await collectPayment(seedPayment() as never, customer as never, { allowOffSession: true });
    const row = rowsIn("payment")[0]!;
    const intentId = String(row.providerPaymentIntentId);

    // the customer completed 3-D Secure in Stripe's own flow
    store.stripe.intents.set(intentId, { id: intentId, status: "succeeded", chargeId: "ch_3ds", receiptUrl: "https://r/3ds", failureCode: null, failureMessage: null, amount: 1500, currency: "USD" });

    const out = await collectPayment(row as never, customer as never, { allowOffSession: true });
    expect(out.payment.status).toBe("SUCCEEDED");
    expect(out.checkoutUrl).toBeNull();
    expect(store.stripe.charges.size).toBe(1);
    expect(rowsIn("invoice")).toHaveLength(1);
  });
});

describe("settling a stuck payment the provider DID answer once", () => {
  it("reads it rather than re-sending the charge", async () => {
    seedCustomer({ autoPay: true, defaultPaymentMethodId: "pm_local_1" });
    seedCardFor("cust1");
    store.stripe.intents.set("pi_ref", { id: "pi_ref", status: "succeeded", chargeId: "ch_ref", receiptUrl: "https://r", failureCode: null, failureMessage: null, amount: 1500, currency: "USD" });
    const p = seedPayment({ status: "PROCESSING", attempts: 1, providerPaymentIntentId: "pi_ref" });
    p.updatedAt = new Date(Date.now() - 20 * 60_000);

    expect(await reconcileStuckPayments(new Date())).toBe(1);
    expect(rowsIn("payment")[0]!.status).toBe("SUCCEEDED");
    expect(store.stripe.charges.size).toBe(0);
    expect(store.stripe.calls.filter((c) => c.method === "chargeOffSession")).toHaveLength(0);
  });

  it("learns the intent id from the Checkout session before reading it", async () => {
    seedCustomer();
    store.stripe.sessions.set("cs_open", { id: "cs_open", mode: "payment", status: "complete", payment_status: "paid", payment_intent: "pi_from_cs", customer: "cus_seed_1" });
    store.stripe.intents.set("pi_from_cs", { id: "pi_from_cs", status: "succeeded", chargeId: "ch_cs2", receiptUrl: null, failureCode: null, failureMessage: null, amount: 1500, currency: "USD" });
    const p = seedPayment({ status: "PROCESSING", attempts: 1, providerCheckoutSessionId: "cs_open" });

    const out = await syncPaymentFromProvider(p as never);
    expect(out.status).toBe("SUCCEEDED");
    expect(rowsIn("payment")[0]!.providerPaymentIntentId).toBe("pi_from_cs");
  });

  it("leaves a payment with nothing to ask about exactly as it was", async () => {
    seedCustomer();
    const p = seedPayment({ status: "PROCESSING", attempts: 1 });
    expect((await syncPaymentFromProvider(p as never)).status).toBe("PROCESSING");
    expect(store.stripe.calls).toHaveLength(0);
  });
});

/** Saving a card is a hosted-Checkout round trip that comes back as a webhook. */
describe("saving a card", () => {
  it("mirrors the new card in when setup-mode Checkout completes", async () => {
    seedCustomer({ providerCustomerId: "cus_A" });
    store.stripe.cards = [{ id: "pm_new", brand: "visa", last4: "1111", expMonth: 6, expYear: 2031 }];

    const res = await recordAndProcessEvent({
      id: "evt_setup",
      type: "checkout.session.completed",
      data: { object: { id: "cs_setup_1", mode: "setup", customer: "cus_A" } },
    });
    expect(res).toBe("processed");
    const cards = rowsIn("paymentMethod");
    expect(cards.map((m) => m.providerMethodId)).toEqual(["pm_new"]);
    expect(cards[0]!.last4).toBe("1111");
    // the first card becomes the default, so automatic payments can be switched on
    expect(rowsIn("paymentCustomer")[0]!.defaultPaymentMethodId).toBe(cards[0]!.id);
    // a setup session must never have settled a payment
    expect(rowsIn("payment")).toHaveLength(0);
  });

  it("re-reads the cards when Stripe reports one attached, updated or detached", async () => {
    seedCustomer({ providerCustomerId: "cus_A" });
    store.stripe.cards = [{ id: "pm_x", brand: "amex", last4: "0005", expMonth: 3, expYear: 2029 }];
    expect(await recordAndProcessEvent({ id: "evt_att", type: "payment_method.attached", data: { object: { id: "pm_x", customer: "cus_A" } } })).toBe("processed");
    expect(rowsIn("paymentMethod")).toHaveLength(1);

    store.stripe.cards = [];
    expect(await recordAndProcessEvent({ id: "evt_det", type: "payment_method.detached", data: { object: { id: "pm_x", customer: "cus_A" } } })).toBe("processed");
    expect(rowsIn("paymentMethod")[0]!.removedAt).toBeInstanceOf(Date);
  });

  it("ignores a card event for a Stripe customer that is not ours", async () => {
    seedCustomer({ providerCustomerId: "cus_A" });
    expect(await recordAndProcessEvent({ id: "evt_alien", type: "payment_method.attached", data: { object: { id: "pm_y", customer: "cus_SOMEONE_ELSE" } } })).toBe("ignored");
    expect(store.stripe.calls.filter((c) => c.method === "listCards")).toHaveLength(0);
  });
});

describe("the billing customer and their cards", () => {
  it("creates the Stripe customer once and reuses it afterwards", async () => {
    const admin = { id: "admin1", email: "owner@test.local", name: "Owner" };
    const first = await ensureCustomer(admin);
    const second = await ensureCustomer(admin);
    expect(second.id).toBe(first.id);
    expect(rowsIn("paymentCustomer")).toHaveLength(1);
    expect(store.stripe.calls.filter((c) => c.method === "createCustomer")).toHaveLength(1);
    expect(first.providerCustomerId).toMatch(/^cus_/);
    // the customer is billed in the platform's pricing currency
    expect(first.currency).toBe("USD");
    expect((await findCustomer("admin1"))!.id).toBe(first.id);
    expect(await findCustomer("nobody")).toBeNull();
  });

  it("switches the default card at Stripe as well as here, and refuses an unknown one", async () => {
    const customer = seedCustomer();
    store.stripe.cards = [
      { id: "pm_a", brand: "visa", last4: "4242", expMonth: 1, expYear: 2031 },
      { id: "pm_b", brand: "mastercard", last4: "4444", expMonth: 2, expYear: 2032 },
    ];
    const methods = await refreshPaymentMethods(customer as never);
    const fresh = rowsIn("paymentCustomer")[0]!;

    await setDefaultMethod(fresh as never, String(methods[1]!.id));
    expect(rowsIn("paymentCustomer")[0]!.defaultPaymentMethodId).toBe(methods[1]!.id);
    expect(store.stripe.calls.some((c) => c.method === "setDefaultCard" && (c.args as Row).paymentMethodId === "pm_b")).toBe(true);

    await expect(setDefaultMethod(fresh as never, "pm_not_mine")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("detaches a removed card at Stripe and turns automatic payments off with the last one", async () => {
    const customer = seedCustomer({ autoPay: true, defaultPaymentMethodId: "pm_local_1" });
    seedCardFor("cust1");
    store.stripe.cards = [{ id: "pm_stripe_1", brand: "visa", last4: "4242", expMonth: 12, expYear: 2030 }];

    await removeMethod(customer as never, "pm_local_1");
    expect(store.stripe.calls.some((c) => c.method === "detachCard" && c.args === "pm_stripe_1")).toBe(true);
    expect(rowsIn("paymentMethod")[0]!.removedAt).toBeInstanceOf(Date);
    const row = rowsIn("paymentCustomer")[0]!;
    expect(row.defaultPaymentMethodId).toBeNull();
    expect(row.autoPay).toBe(false);
    // and a card that is no longer on file is never detached at Stripe twice
    await expect(removeMethod(row as never, "pm_local_1")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("reads pricing from the stored row and falls back to the defaults", async () => {
    setPricing({ currency: "EUR", campaignFeeCents: 1500, campaignFeePercent: 7.5, planName: "Pro", planAmountCents: 4900, planIntervalDays: 7, taxPercent: 20 });
    expect(await getPricing()).toEqual({
      currency: "EUR",
      campaignFeeCents: 1500,
      campaignFeePercent: 7.5,
      planName: "Pro",
      planAmountCents: 4900,
      planIntervalDays: 7,
      taxPercent: 20,
    });
    expect(toPricing(null)).toEqual(DEFAULT_PRICING);

    // an installation that has never saved pricing charges nothing rather than guessing
    (store.tables.pricingConfig ??= []).length = 0;
    expect(await getPricing()).toEqual(DEFAULT_PRICING);
  });
});

// ================================================================
// 16. SYNCING A LIVE CAMPAIGN BACK FROM META
// ================================================================

describe("syncCampaignFromMeta", () => {
  const liveRow = (over: Row = {}): Row => ({
    id: "camp1",
    accountId: "acc1",
    name: "Autumn promo",
    objective: "OUTCOME_TRAFFIC",
    status: "ACTIVE",
    currency: "USD",
    metaCampaignId: "c_1",
    metaAdSetId: "s_1",
    metaCreativeId: "cr_1",
    metaAdId: "a_1",
    stoppedAt: null,
    ...over,
  });

  function metaAnswers(over: { effective_status?: string; insights?: unknown; review?: Row; failInsights?: boolean } = {}): void {
    store.graph = async ({ path }) => {
      if (path === "c_1/insights") {
        if (over.failInsights) throw new Error("(#100) insights not available");
        return over.insights ?? { data: [{ spend: "9.50", impressions: "1000", reach: "800", clicks: "40", cpc: "0.24", ctr: "4", actions: [{ action_type: "link_click", value: "37" }] }] };
      }
      if (path === "c_1") return { status: "ACTIVE", effective_status: over.effective_status ?? "ACTIVE" };
      if (path === "a_1") return over.review ?? { effective_status: "DISAPPROVED", issues_info: [{ level: "AD", error_code: 1815869, error_summary: "Ad not approved", error_message: "Policy" }] };
      return {};
    };
  }

  it("stores Meta's numbers, Meta's review verdict and Meta's status", async () => {
    const row = seed("campaign", liveRow());
    metaAnswers({ effective_status: "PAUSED" });
    const out = await syncCampaignFromMeta(ACCOUNT, row as never);

    expect(out.status).toEqual({ status: "ACTIVE", effectiveStatus: "PAUSED" });
    expect(out.insights!.spend).toBeCloseTo(9.5);
    expect(out.insights!.results).toBe(37);
    expect(out.review).toEqual({ status: "DISAPPROVED", issues: [{ level: "AD", code: 1815869, summary: "Ad not approved", message: "Policy" }] });

    const saved = rowsIn("campaign")[0]!;
    expect(saved.status).toBe("PAUSED"); // Meta's own answer wins over the stale local one
    expect(saved.reviewStatus).toBe("DISAPPROVED");
    expect((saved.insightsSnapshot as Row).impressions).toBe(1000);
    expect(saved.insightsSyncedAt).toBeInstanceOf(Date);
  });

  /** Archiving is the admin's decision; Meta reporting ACTIVE must not undo it. */
  it("never resurrects a campaign that was archived here", async () => {
    const row = seed("campaign", liveRow({ status: "ARCHIVED" }));
    metaAnswers({ effective_status: "ACTIVE" });
    await syncCampaignFromMeta(ACCOUNT, row as never);
    expect(rowsIn("campaign")[0]!.status).toBe("ARCHIVED");
  });

  it("leaves a local draft alone even if some Meta object answers", async () => {
    for (const status of ["DRAFT", "READY", "ERROR"]) {
      (store.tables.campaign ??= []).length = 0;
      const row = seed("campaign", liveRow({ status }));
      metaAnswers({ effective_status: "ACTIVE" });
      await syncCampaignFromMeta(ACCOUNT, row as never);
      expect(rowsIn("campaign")[0]!.status).toBe(status);
    }
  });

  it("stamps stoppedAt the first time Meta says the campaign is archived", async () => {
    const row = seed("campaign", liveRow({ status: "ACTIVE", stoppedAt: null }));
    metaAnswers({ effective_status: "ARCHIVED" });
    await syncCampaignFromMeta(ACCOUNT, row as never);
    const saved = rowsIn("campaign")[0]!;
    expect(saved.status).toBe("ARCHIVED");
    expect(saved.stoppedAt).toBeInstanceOf(Date);
  });

  /** A spend figure Meta would not give must not wipe the last one it did. */
  it("keeps going — and keeps the old snapshot — when insights fail", async () => {
    const row = seed("campaign", liveRow({ insightsSnapshot: { spend: 4.2 } }));
    metaAnswers({ failInsights: true, effective_status: "ACTIVE" });
    const out = await syncCampaignFromMeta(ACCOUNT, row as never);
    expect(out.insights).toBeNull();
    expect(out.review!.status).toBe("DISAPPROVED"); // the rest of the sync still ran
    expect((rowsIn("campaign")[0]!.insightsSnapshot as Row).spend).toBe(4.2);
  });

  it("does not ask Meta about a campaign that was never built there", async () => {
    const row = seed("campaign", liveRow({ metaCampaignId: null, metaAdId: null }));
    metaAnswers();
    const out = await syncCampaignFromMeta(ACCOUNT, row as never);
    expect(out).toMatchObject({ status: { status: null, effectiveStatus: null }, insights: null, review: null });
    expect(store.graphCalls).toHaveLength(0);
    expect(rowsIn("campaign")[0]!.status).toBe("ACTIVE"); // unchanged
  });
});

// ================================================================
// 17. THE WEBHOOK ENDPOINT ITSELF — the one unauthenticated door
// ================================================================

/**
 * Everything above tests recordAndProcessEvent, which trusts its caller. The
 * only caller is an endpoint the whole internet can POST to, and the single
 * thing standing between a stranger and "this payment SUCCEEDED" is the
 * signature check inside the route. So the route is driven here as HTTP:
 * a real Request in, a real Response out.
 */
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<object>()), after: vi.fn() }));

const { NextRequest: RealNextRequest } = await vi.importActual<typeof import("next/server")>("next/server");
const { POST: stripeWebhookRoute } = await import("@/app/api/webhooks/stripe/route");

const WEBHOOK_SECRET = "whsec_qa_campaigns_billing";

function webhookRequest(body: string, header: string | null): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (header !== null) headers["stripe-signature"] = header;
  return new RealNextRequest("http://localhost:3000/api/webhooks/stripe", { method: "POST", headers, body }) as unknown as Request;
}

function signedHeader(body: string, opts: { secret?: string; atMs?: number } = {}): string {
  const t = Math.floor((opts.atMs ?? Date.now()) / 1000);
  return `t=${t},v1=${hmacSha256(opts.secret ?? WEBHOOK_SECRET, `${t}.${body}`)}`;
}

describe("POST /api/webhooks/stripe", () => {
  const succeeded = JSON.stringify({ id: "evt_http_1", type: "payment_intent.succeeded", data: { object: { id: "pi_http", metadata: {} } } });

  function seedUnpaid(): void {
    seedCustomer();
    seedPayment({ providerPaymentIntentId: "pi_http", status: "PROCESSING" });
    store.stripe.intents.set("pi_http", { id: "pi_http", status: "succeeded", chargeId: "ch_http", receiptUrl: null, failureCode: null, failureMessage: null, amount: 1500, currency: "USD" });
  }

  it("settles the payment for a correctly signed event", async () => {
    seedUnpaid();
    const res = await stripeWebhookRoute(webhookRequest(succeeded, signedHeader(succeeded)) as never);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, outcome: "processed" });
    expect(rowsIn("payment")[0]!.status).toBe("SUCCEEDED");
  });

  /** The whole point of the endpoint's security: a forged "you were paid". */
  it("refuses an UNSIGNED event and changes nothing", async () => {
    seedUnpaid();
    const res = await stripeWebhookRoute(webhookRequest(succeeded, null) as never);
    expect(res.status).toBe(400);
    expect(rowsIn("payment")[0]!.status).toBe("PROCESSING");
    expect(rowsIn("billingEvent")).toHaveLength(0);
    expect(rowsIn("invoice")).toHaveLength(0);
  });

  it("refuses an event signed with the wrong secret", async () => {
    seedUnpaid();
    const res = await stripeWebhookRoute(webhookRequest(succeeded, signedHeader(succeeded, { secret: "whsec_attacker" })) as never);
    expect(res.status).toBe(400);
    expect(rowsIn("payment")[0]!.status).toBe("PROCESSING");
    expect(rowsIn("billingEvent")).toHaveLength(0);
  });

  /** A signature is for one exact body — swapping the payload under it must fail. */
  it("refuses a body that was edited after it was signed", async () => {
    seedUnpaid();
    const header = signedHeader(succeeded);
    const tampered = succeeded.replace("evt_http_1", "evt_http_2");
    const res = await stripeWebhookRoute(webhookRequest(tampered, header) as never);
    expect(res.status).toBe(400);
    expect(rowsIn("payment")[0]!.status).toBe("PROCESSING");
  });

  /** A signed event captured off the wire must not still work an hour later. */
  it("refuses a replay from outside the timestamp tolerance", async () => {
    seedUnpaid();
    const stale = signedHeader(succeeded, { atMs: Date.now() - 3600_000 });
    const res = await stripeWebhookRoute(webhookRequest(succeeded, stale) as never);
    expect(res.status).toBe(400);
    expect(rowsIn("payment")[0]!.status).toBe("PROCESSING");
  });

  it("refuses a correctly signed body that is not an event", async () => {
    seedUnpaid();
    for (const body of ["not json at all", JSON.stringify({ id: "evt_x" }), JSON.stringify({ id: "evt_x", type: "payment_intent.succeeded" })]) {
      const res = await stripeWebhookRoute(webhookRequest(body, signedHeader(body)) as never);
      expect(res.status).toBe(400);
    }
    expect(rowsIn("billingEvent")).toHaveLength(0);
    expect(rowsIn("payment")[0]!.status).toBe("PROCESSING");
  });

  /**
   * Stripe retries a non-2xx, and eventually disables an endpoint that keeps
   * failing. A handler bug must therefore still ACK — the event is stored and
   * replayed on this side instead.
   */
  it("still answers 200 when the handler itself fails, so Stripe does not disable the endpoint", async () => {
    seedUnpaid();
    store.stripe.failNextRetrieveIntent = true;
    const res = await stripeWebhookRoute(webhookRequest(succeeded, signedHeader(succeeded)) as never);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, outcome: "failed" });
    // the ACK is only honest because the event is kept for our own replay pass
    expect(rowsIn("billingEvent")[0]!.status).toBe("FAILED");
    expect(await replayFailedBillingEvents(new Date(Date.now() + 6 * 60_000))).toMatchObject({ recovered: 1 });
    expect(rowsIn("payment")[0]!.status).toBe("SUCCEEDED");
  });

  it("acknowledges a Stripe redelivery without settling anything twice", async () => {
    seedUnpaid();
    await stripeWebhookRoute(webhookRequest(succeeded, signedHeader(succeeded)) as never);
    const res = await stripeWebhookRoute(webhookRequest(succeeded, signedHeader(succeeded)) as never);
    expect(await res.json()).toEqual({ received: true, outcome: "duplicate" });
    expect(rowsIn("invoice")).toHaveLength(1);
    expect(rowsIn("billingEvent")).toHaveLength(1);
  });

  /** With no webhook secret configured the endpoint must refuse, not accept blindly. */
  it("refuses every event when PAYMENT_WEBHOOK_SECRET is not configured", async () => {
    seedUnpaid();
    const saved = process.env.PAYMENT_WEBHOOK_SECRET;
    process.env.PAYMENT_WEBHOOK_SECRET = "";
    try {
      const res = await stripeWebhookRoute(webhookRequest(succeeded, signedHeader(succeeded)) as never);
      expect(res.status).toBe(503);
      expect(rowsIn("payment")[0]!.status).toBe("PROCESSING");
    } finally {
      process.env.PAYMENT_WEBHOOK_SECRET = saved;
    }
  });
});

// ================================================================
// 18. CAVEATS IN THE SCHEDULER, PINNED AS TESTS
// ================================================================

describe("what the scheduler does when the card keeps failing", () => {
  function dueSchedule(): Row {
    seedCustomer({ autoPay: true, defaultPaymentMethodId: "pm_local_1" });
    seedCardFor("cust1");
    return seed("billingSchedule", {
      id: "sch1", customerId: "cust1", name: "Platform plan", amountCents: 2900, currency: "USD",
      intervalDays: 30, nextBillingAt: new Date(BASE_TIME), lastBilledAt: null, status: "ACTIVE", campaignId: null, canceledAt: null,
    });
  }

  /** "charged" is read as income in the ops log, so a decline must not land in it. */
  it("reports a DECLINED charge as declined, not as charged", async () => {
    const schedule = dueSchedule();
    store.stripe.outcome = "requires_payment_method";
    const out = await runDueSchedules(new Date(BASE_TIME + 1000));
    expect(out).toEqual({ charged: 0, declined: 1, pendingCreated: 0, skipped: 0 });
    // the payment itself is honest about what happened
    expect(rowsIn("payment")[0]!.status).toBe("FAILED");
    expect(rowsIn("payment")[0]!.nextRetryAt).toBeInstanceOf(Date);
    // and the period has NOT moved on — only a successful charge steps it
    expect((schedule.nextBillingAt as Date).getTime()).toBe(BASE_TIME);
  });

  /**
   * CAVEAT: once the 1/3/7-day ladder is exhausted the failed occurrence keeps
   * the schedule standing on its own period for ever — every later run finds
   * the same FAILED row under the same key and skips. The subscription stops
   * billing silently; recovering it needs the admin to cancel that payment
   * (which steps the series) or pay it.
   */
  it("stalls the whole series on one exhausted occurrence until a human acts", async () => {
    const schedule = dueSchedule();
    store.stripe.outcome = "requires_payment_method";
    await runDueSchedules(new Date(BASE_TIME + 1000));

    // the ladder runs out
    rowsIn("payment")[0]!.attempts = 4;
    rowsIn("payment")[0]!.nextRetryAt = null;
    expect(await retryFailedPayments(new Date(BASE_TIME + 400 * 86400_000))).toMatchObject({ retried: 0 });

    // a year of scheduler runs mints nothing and moves nothing
    const later = await runDueSchedules(new Date(BASE_TIME + 400 * 86400_000));
    expect(later).toMatchObject({ charged: 0, pendingCreated: 0, skipped: 1 });
    expect(rowsIn("payment")).toHaveLength(1);
    expect((schedule.nextBillingAt as Date).getTime()).toBe(BASE_TIME);

    // cancelling the dead occurrence is what hands the series back to the scheduler
    await cancelPayment(rowsIn("payment")[0]! as never, "admin1");
    expect((schedule.nextBillingAt as Date).getTime()).toBe(BASE_TIME + 30 * 86400_000);
    store.stripe.outcome = "succeeded";
    expect(await runDueSchedules(new Date(BASE_TIME + 400 * 86400_000))).toMatchObject({ charged: 1 });
  });

  it("charges nothing at all while payments are not configured", async () => {
    dueSchedule();
    const saved = process.env.PAYMENT_SECRET_KEY;
    process.env.PAYMENT_SECRET_KEY = "";
    try {
      expect(await runDueSchedules(new Date(BASE_TIME + 1000))).toEqual({ charged: 0, declined: 0, pendingCreated: 0, skipped: 0 });
      expect(await retryFailedPayments(new Date(BASE_TIME + 1000))).toEqual({ retried: 0, succeeded: 0, reconciled: 0 });
      expect(await reconcileStuckPayments(new Date(BASE_TIME + 1000))).toBe(0);
      expect(rowsIn("payment")).toHaveLength(0);
      expect(store.stripe.calls).toHaveLength(0);
    } finally {
      process.env.PAYMENT_SECRET_KEY = saved;
    }
  });
});

// ================================================================
// 19. POST /api/campaigns/[id]/create-in-meta — the fee gate in place
// ================================================================

/**
 * assertCampaignFeePaid throwing proves nothing on its own: what matters is
 * that the ROUTE calls it, and calls it BEFORE the first Graph request. This
 * drives the real handler — same origin check, same fee gate, same Meta chain —
 * and counts what reached Meta.
 */
vi.mock("@/lib/auth/guard", () => ({
  requireAdmin: async () => ({ admin: { id: "admin1", email: "owner@test.local", name: "Owner", role: "OWNER" } }),
}));
vi.mock("@/lib/auth/access", () => ({ assertAccountAccess: async () => undefined }));

const { POST: createInMetaRoute } = await import("@/app/api/campaigns/[id]/create-in-meta/route");

function routeRequest(): Request {
  return new RealNextRequest("http://localhost:3000/api/campaigns/c1/create-in-meta", {
    method: "POST",
    headers: { origin: "http://localhost:3000" },
  }) as unknown as Request;
}

async function callCreateInMeta(id = "c1"): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await createInMetaRoute(routeRequest() as never, { params: Promise.resolve({ id }) } as never);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("POST /api/campaigns/[id]/create-in-meta", () => {
  function seedReadyCampaign(over: Row = {}, accountOver: Row = {}): Row {
    seed("instagramAccount", { id: "acc1", adAccountId: "act_123456", fbPageId: "page_777", igUserId: "ig_999", isDemo: false, ...accountOver });
    return seed("campaign", {
      id: "c1",
      accountId: "acc1",
      name: "Autumn promo",
      objective: "OUTCOME_TRAFFIC",
      status: "READY",
      currency: "USD",
      dailyBudgetCents: 500,
      lifetimeBudgetCents: null,
      startTime: null,
      endTime: null,
      targeting: { countries: ["UZ"], ageMin: 25, ageMax: 45 },
      ctaType: "LEARN_MORE",
      destinationType: "WEBSITE",
      destinationUrl: "https://example.test/landing",
      contentId: null,
      ctaConfigId: null,
      metaCampaignId: null,
      metaAdSetId: null,
      metaCreativeId: null,
      metaAdId: null,
      metaFormId: null,
      platformFeeCents: null,
      lastError: null,
      ...over,
    });
  }

  it("builds the chain and marks the campaign CREATED when no fee is configured", async () => {
    seedReadyCampaign();
    const out = await callCreateInMeta();
    expect(out.status).toBe(200);
    expect(store.graphCalls.map((c) => c.path)).toEqual(["act_123456/campaigns", "act_123456/adsets", "act_123456/adcreatives", "act_123456/ads"]);
    const row = rowsIn("campaign")[0]!;
    expect(row.status).toBe("CREATED");
    expect(row.metaAdId).toBe("120_ad");
    expect(rowsIn("auditLog").map((a) => a.action)).toContain("CREATED_CAMPAIGN_IN_META");
  });

  /** The money gate: an unpaid fee must stop the request before Meta hears about it. */
  it("refuses — with NO Graph call at all — while the platform fee is unpaid", async () => {
    setPricing({ campaignFeeCents: 2000 });
    const customer = seedCustomer();
    seedReadyCampaign();
    await createCampaignFeePayment(customer as never, "c1");

    const out = await callCreateInMeta();
    expect(out.status).toBe(402);
    expect(out.body).toMatchObject({ ok: false, error: { code: "REQUIRES_PAYMENT" } });
    expect(store.graphCalls).toHaveLength(0);
    expect(rowsIn("campaign")[0]!.status).toBe("READY");
    expect(rowsIn("campaign")[0]!.metaCampaignId).toBeNull();
  });

  it("goes through the moment that fee is paid", async () => {
    setPricing({ campaignFeeCents: 2000 });
    const customer = seedCustomer({ autoPay: true, defaultPaymentMethodId: "pm_local_1" });
    seedCardFor("cust1");
    seedReadyCampaign();
    const { payment } = await createCampaignFeePayment(customer as never, "c1");
    await collectPayment(payment! as never, customer as never, { allowOffSession: true });

    const out = await callCreateInMeta();
    expect(out.status).toBe(200);
    expect(rowsIn("campaign")[0]!.status).toBe("CREATED");
    expect(store.graphCalls).toHaveLength(4);
  });

  /** A fee that cannot be collected must not be waved through as "nothing to pay". */
  it("refuses when a fee is configured but payments are not set up", async () => {
    setPricing({ campaignFeeCents: 2000 });
    seedReadyCampaign();
    const saved = process.env.PAYMENT_SECRET_KEY;
    process.env.PAYMENT_SECRET_KEY = "";
    try {
      const out = await callCreateInMeta();
      expect(out.status).toBe(400);
      expect(JSON.stringify(out.body)).toMatch(/payments are not set up/i);
      expect(store.graphCalls).toHaveLength(0);
    } finally {
      process.env.PAYMENT_SECRET_KEY = saved;
    }
  });

  it("never lets a demo account create a real Meta campaign", async () => {
    seedReadyCampaign({}, { isDemo: true });
    const out = await callCreateInMeta();
    expect(out.status).toBe(422);
    expect(JSON.stringify(out.body)).toMatch(/Demo/i);
    expect(store.graphCalls).toHaveLength(0);
  });

  it("refuses a campaign that is already in Meta rather than building a second one", async () => {
    seedReadyCampaign({ status: "CREATED", metaCampaignId: "120_camp" });
    const out = await callCreateInMeta();
    expect(out.status).toBe(400);
    expect(store.graphCalls).toHaveLength(0);
  });

  it("404s for a campaign that does not exist", async () => {
    expect((await callCreateInMeta("nope")).status).toBe(404);
  });

  /**
   * Meta has no transaction across the four calls. When it rejects the ad set,
   * the campaign it already made is real — the row has to keep that id (so the
   * retry resumes instead of orphaning it) and record why it stopped.
   */
  it("records the failure, keeps the ids Meta already gave, and resumes on the retry", async () => {
    seedReadyCampaign();
    store.graph = async ({ path }) => {
      if (path.endsWith("/campaigns")) return { id: "120_camp" };
      throw new Error("Meta rejected the ad set");
    };
    const failed = await callCreateInMeta();
    expect(failed.status).toBeGreaterThanOrEqual(400);
    const row = rowsIn("campaign")[0]!;
    expect(row.status).toBe("ERROR");
    expect(String(row.lastError)).toMatch(/rejected the ad set/);
    expect(row.metaCampaignId).toBe("120_camp");
    expect(rowsIn("auditLog").map((a) => a.action)).toContain("META_API_FAILURE");

    // ERROR is a retryable state, and the retry starts from the ad set
    store.graphCalls = [];
    store.graph = async ({ path }) => {
      if (path.endsWith("/adsets")) return { id: "120_adset" };
      if (path.endsWith("/adcreatives")) return { id: "120_creative" };
      if (path.endsWith("/ads")) return { id: "120_ad" };
      return {};
    };
    const retried = await callCreateInMeta();
    expect(retried.status).toBe(200);
    expect(store.graphCalls.map((c) => c.path)).toEqual(["act_123456/adsets", "act_123456/adcreatives", "act_123456/ads"]);
    expect(rowsIn("campaign")[0]!.status).toBe("CREATED");
    expect(rowsIn("campaign")[0]!.lastError).toBeNull();
  });

  it("rejects a cross-origin POST before doing anything", async () => {
    seedReadyCampaign();
    const res = await createInMetaRoute(
      new RealNextRequest("http://localhost:3000/api/campaigns/c1/create-in-meta", { method: "POST", headers: { origin: "https://evil.example" } }) as never,
      { params: Promise.resolve({ id: "c1" }) } as never,
    );
    expect(res.status).toBe(403);
    expect(store.graphCalls).toHaveLength(0);
    expect(rowsIn("campaign")[0]!.status).toBe("READY");
  });
});
