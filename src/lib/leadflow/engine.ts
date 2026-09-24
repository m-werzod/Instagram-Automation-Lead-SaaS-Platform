import type { LeadFlowQuestion, LeadFlowSession, Prisma, QuestionType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { createLogger } from "@/lib/logger";
import { testAnswerPattern } from "@/lib/validation/leadbutton";

const log = createLogger("leadflow");

/**
 * Lead-flow engine (spec §17–20): a deterministic state machine that sends
 * exactly ONE question per step over Instagram DM, validates each answer,
 * stores it, then advances. No LLM involvement — behavior is predictable and
 * unit-tested. Sessions expire after 24h of inactivity.
 */

export const SESSION_EXPIRY_MS = 24 * 60 * 60 * 1000;
/** Reserved quick-reply payload prefix for select options. */
export const OPTION_PAYLOAD_PREFIX = "lf_opt:";
export const CANCEL_KEYWORDS = ["cancel", "stop", "exit", "bekor"];

/**
 * Questions from this order upwards are ARCHIVED — an admin removed or rewrote
 * them, but completed sessions still hold LeadAnswer rows that cascade from
 * them, so the row stays with the flow instead of taking that history with it.
 * A flow holds at most 25 live questions, so the band is never reached
 * organically. Every read of the live question list filters it out.
 */
export const ARCHIVED_QUESTION_ORDER = 1000;
export const ACTIVE_QUESTION_FILTER = { order: { lt: ARCHIVED_QUESTION_ORDER } } as const;

export interface ValidationResult {
  ok: boolean;
  /** normalized value to store */
  value?: string;
  /** re-prompt text on failure */
  error?: string;
}

export function validateAnswer(question: LeadFlowQuestion, rawInput: string, quickReplyPayload?: string | null): ValidationResult {
  let input = rawInput.trim();

  // Quick-reply payload wins for selects
  if (quickReplyPayload?.startsWith(OPTION_PAYLOAD_PREFIX)) {
    const idx = Number.parseInt(quickReplyPayload.slice(OPTION_PAYLOAD_PREFIX.length), 10);
    const opt = question.options[idx];
    if (opt !== undefined) input = opt;
  }

  if (!input) {
    return question.required
      ? { ok: false, error: "Please send an answer to continue." }
      : { ok: true, value: "" };
  }

  switch (question.type) {
    case "TEXT": {
      if (question.validationRegex) {
        // null = the stored pattern is unusable (invalid, or unsafe to run) → accept, as before
        if (testAnswerPattern(question.validationRegex, input) === false) {
          return { ok: false, error: "That doesn't look right — please try again." };
        }
      }
      return { ok: true, value: input.slice(0, 1000) };
    }
    case "PHONE": {
      const digits = input.replace(/[\s\-().]/g, "");
      if (!/^\+?\d{7,15}$/.test(digits)) {
        return { ok: false, error: "Please send a valid phone number (digits only, e.g. +998901234567)." };
      }
      return { ok: true, value: digits };
    }
    case "EMAIL": {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(input)) {
        return { ok: false, error: "Please send a valid email address (e.g. name@example.com)." };
      }
      return { ok: true, value: input.toLowerCase() };
    }
    case "NUMBER": {
      const n = Number(input.replace(",", "."));
      if (!Number.isFinite(n)) return { ok: false, error: "Please send a number." };
      return { ok: true, value: String(n) };
    }
    case "DATE": {
      const d = parseDateish(input);
      if (!d) return { ok: false, error: "Please send a date like 2026-09-15 or 15.09.2026." };
      return { ok: true, value: d };
    }
    case "TIME": {
      const m = input.match(/^([01]?\d|2[0-3])[:.\s]?([0-5]\d)$/);
      if (!m) return { ok: false, error: "Please send a time like 14:30." };
      return { ok: true, value: `${m[1]!.padStart(2, "0")}:${m[2]}` };
    }
    case "BOOLEAN": {
      const yes = ["yes", "y", "ha", "да", "true", "1", "ok", "yep"].includes(input.toLowerCase());
      const no = ["no", "n", "yo'q", "yoq", "нет", "false", "0", "nope"].includes(input.toLowerCase());
      if (!yes && !no) return { ok: false, error: 'Please answer "Yes" or "No".' };
      return { ok: true, value: yes ? "Yes" : "No" };
    }
    case "SINGLE_SELECT": {
      const match = matchOption(question.options, input);
      if (match === null) {
        return { ok: false, error: `Please choose one of the options:\n${numberedOptions(question.options)}` };
      }
      return { ok: true, value: match };
    }
    case "MULTI_SELECT": {
      const parts = input.split(/[,;]+/).map((p) => p.trim()).filter(Boolean);
      const matched: string[] = [];
      for (const part of parts) {
        const m = matchOption(question.options, part);
        if (m !== null && !matched.includes(m)) matched.push(m);
      }
      if (matched.length === 0) {
        return {
          ok: false,
          error: `Please choose one or more options (numbers separated by commas):\n${numberedOptions(question.options)}`,
        };
      }
      return { ok: true, value: matched.join(", ") };
    }
  }
}

function parseDateish(input: string): string | null {
  const iso = input.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  const eur = input.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})$/);
  let y: number, mo: number, d: number;
  if (iso) [y, mo, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  else if (eur) [y, mo, d] = [Number(eur[3]), Number(eur[2]), Number(eur[1])];
  else return null;
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function matchOption(options: string[], input: string): string | null {
  const trimmed = input.trim();
  // numeric choice ("2" → second option)
  const asNum = Number.parseInt(trimmed, 10);
  if (!Number.isNaN(asNum) && asNum >= 1 && asNum <= options.length && String(asNum) === trimmed) {
    return options[asNum - 1] ?? null;
  }
  const lower = trimmed.toLowerCase();
  const exact = options.find((o) => o.toLowerCase() === lower);
  if (exact) return exact;
  const prefix = options.filter((o) => o.toLowerCase().startsWith(lower));
  if (prefix.length === 1) return prefix[0]!;
  return null;
}

export function numberedOptions(options: string[]): string {
  return options.map((o, i) => `${i + 1}. ${o}`).join("\n");
}

/** Render the outbound message for a question (text + optional quick replies). */
export function renderQuestion(question: LeadFlowQuestion): {
  text: string;
  quickReplies: Array<{ title: string; payload: string }> | undefined;
} {
  if (question.type === "SINGLE_SELECT" && question.options.length > 0) {
    if (question.options.length <= 13 && question.options.every((o) => o.length <= 20)) {
      return {
        text: question.prompt,
        quickReplies: question.options.map((o, i) => ({ title: o, payload: `${OPTION_PAYLOAD_PREFIX}${i}` })),
      };
    }
    return { text: `${question.prompt}\n${numberedOptions(question.options)}\n(Reply with a number)`, quickReplies: undefined };
  }
  if (question.type === "MULTI_SELECT" && question.options.length > 0) {
    return {
      text: `${question.prompt}\n${numberedOptions(question.options)}\n(Reply with numbers separated by commas)`,
      quickReplies: undefined,
    };
  }
  if (question.type === "BOOLEAN") {
    return {
      text: question.prompt,
      quickReplies: [
        { title: "Yes", payload: `${OPTION_PAYLOAD_PREFIX}yes` },
        { title: "No", payload: `${OPTION_PAYLOAD_PREFIX}no` },
      ],
    };
  }
  return { text: question.prompt, quickReplies: undefined };
}

// ---- question list maintenance ----

export interface FlowQuestionInput {
  title: string;
  prompt: string;
  type: QuestionType;
  required: boolean;
  options: string[];
  mapTo?: string | null;
  validationRegex?: string | null;
}

type StoredQuestion = Pick<LeadFlowQuestion, "title" | "prompt" | "type" | "required" | "options" | "mapTo" | "validationRegex">;

function sameQuestion(stored: StoredQuestion, input: FlowQuestionInput): boolean {
  return (
    stored.title === input.title &&
    stored.prompt === input.prompt &&
    stored.type === input.type &&
    stored.required === input.required &&
    stored.mapTo === (input.mapTo ?? null) &&
    stored.validationRegex === (input.validationRegex ?? null) &&
    stored.options.length === input.options.length &&
    stored.options.every((o, i) => o === input.options[i])
  );
}

function questionData(input: FlowQuestionInput) {
  return {
    title: input.title,
    prompt: input.prompt,
    type: input.type,
    required: input.required,
    options: input.options,
    mapTo: input.mapTo ?? null,
    validationRegex: input.validationRegex ?? null,
  };
}

/**
 * Replace a flow's live question list without destroying history.
 *
 * LeadAnswer cascades from LeadFlowQuestion, so deleting a question deletes
 * every answer completed sessions gave to it. Rows that carry answers are
 * therefore never deleted here: unchanged ones are reused in place, and the
 * ones an admin dropped or rewrote move into the archive order band. Only
 * answer-free rows are actually removed.
 *
 * Returns whether the live list really changed, so callers only cancel
 * in-flight sessions when a save touched the questions at all.
 */
export async function syncFlowQuestions(
  tx: Prisma.TransactionClient,
  flowId: string,
  incoming: FlowQuestionInput[],
): Promise<{ changed: boolean; archived: number; deleted: number }> {
  const existing = await tx.leadFlowQuestion.findMany({
    where: { flowId, ...ACTIVE_QUESTION_FILTER },
    orderBy: { order: "asc" },
    include: { _count: { select: { answers: true } } },
  });

  const reuseIds: Array<string | null> = incoming.map(() => null);
  const claimed = new Set<string>();

  // identical rows first: a save that only moved a question must not orphan its answers
  incoming.forEach((question, i) => {
    const hit = existing.find((row) => !claimed.has(row.id) && sameQuestion(row, question));
    if (hit) {
      reuseIds[i] = hit.id;
      claimed.add(hit.id);
    }
  });

  const spare = existing.filter((row) => !claimed.has(row.id) && row._count.answers === 0);
  let spareIdx = 0;
  incoming.forEach((_, i) => {
    if (reuseIds[i]) return;
    const row = spare[spareIdx++];
    if (!row) return;
    reuseIds[i] = row.id;
    claimed.add(row.id);
  });

  const leftovers = existing.filter((row) => !claimed.has(row.id));
  const toDelete = leftovers.filter((row) => row._count.answers === 0);
  const toArchive = leftovers.filter((row) => row._count.answers > 0);

  const byId = new Map(existing.map((row) => [row.id, row]));
  const changed =
    leftovers.length > 0 ||
    incoming.some((question, i) => {
      const id = reuseIds[i];
      if (!id) return true;
      const row = byId.get(id)!;
      return row.order !== i + 1 || !sameQuestion(row, question);
    });

  if (!changed) return { changed: false, archived: 0, deleted: 0 };

  const finalOrder = new Map<string, number>();
  reuseIds.forEach((id, i) => {
    if (id) finalOrder.set(id, i + 1);
  });

  // Park rows whose order moves on a temporary negative order first: [flowId,
  // order] is unique, so renumbering in place would collide mid-flight. A row
  // that keeps its order holds that slot throughout, so nothing can want it.
  const removedIds = new Set(toDelete.map((row) => row.id));
  const parked = new Set<string>();
  let parking = -1;
  for (const row of existing) {
    if (removedIds.has(row.id) || finalOrder.get(row.id) === row.order) continue;
    await tx.leadFlowQuestion.update({ where: { id: row.id }, data: { order: parking-- } });
    parked.add(row.id);
  }
  if (removedIds.size) {
    await tx.leadFlowQuestion.deleteMany({ where: { id: { in: [...removedIds] } } });
  }

  for (const [i, question] of incoming.entries()) {
    const id = reuseIds[i];
    if (!id) {
      await tx.leadFlowQuestion.create({ data: { flowId, order: i + 1, ...questionData(question) } });
      continue;
    }
    if (!parked.has(id) && sameQuestion(byId.get(id)!, question)) continue;
    await tx.leadFlowQuestion.update({ where: { id }, data: { order: i + 1, ...questionData(question) } });
  }

  if (toArchive.length) {
    const highest = await tx.leadFlowQuestion.aggregate({
      where: { flowId, order: { gte: ARCHIVED_QUESTION_ORDER } },
      _max: { order: true },
    });
    let next = Math.max(highest._max.order ?? 0, ARCHIVED_QUESTION_ORDER - 1) + 1;
    for (const row of toArchive) {
      await tx.leadFlowQuestion.update({ where: { id: row.id }, data: { order: next++ } });
    }
    log.info("archived answered questions instead of deleting them", { flowId, count: toArchive.length });
  }

  return { changed: true, archived: toArchive.length, deleted: toDelete.length };
}

// ---- session state machine ----

export interface StepOutcome {
  /** messages to send to the user, in order */
  messages: Array<{ text: string; quickReplies?: Array<{ title: string; payload: string }> }>;
  sessionStatus: "ACTIVE" | "COMPLETED" | "CANCELLED";
  completedSessionId?: string;
}

export async function startFlowSession(opts: {
  flowId: string;
  accountId: string;
  conversationId: string;
}): Promise<StepOutcome> {
  const flow = await prisma.leadFlow.findUnique({
    where: { id: opts.flowId },
    include: { questions: { where: ACTIVE_QUESTION_FILTER, orderBy: { order: "asc" } } },
  });
  if (!flow || !flow.enabled || flow.questions.length === 0) {
    return { messages: [], sessionStatus: "CANCELLED" };
  }

  // cancel any previous active session in this conversation
  await prisma.leadFlowSession.updateMany({
    where: { conversationId: opts.conversationId, status: "ACTIVE" },
    data: { status: "CANCELLED" },
  });

  const first = flow.questions[0]!;
  await prisma.leadFlowSession.create({
    data: {
      flowId: flow.id,
      accountId: opts.accountId,
      conversationId: opts.conversationId,
      currentQuestionId: first.id,
      askedAt: new Date(),
    },
  });

  const rendered = renderQuestion(first);
  log.info("flow session started", { flowId: flow.id, conversationId: opts.conversationId });
  return { messages: [rendered], sessionStatus: "ACTIVE" };
}

export async function getActiveSession(conversationId: string): Promise<(LeadFlowSession & { flow: { name: string } }) | null> {
  const session = await prisma.leadFlowSession.findFirst({
    where: { conversationId, status: "ACTIVE" },
    orderBy: { startedAt: "desc" },
    include: { flow: { select: { name: true } } },
  });
  if (!session) return null;
  const anchor = session.askedAt ?? session.startedAt;
  if (Date.now() - anchor.getTime() > SESSION_EXPIRY_MS) {
    await prisma.leadFlowSession.update({ where: { id: session.id }, data: { status: "EXPIRED" } });
    return null;
  }
  return session;
}

/**
 * Feed one inbound user message into an active session.
 * Returns the reply message(s) and whether the flow completed.
 */
export async function handleFlowAnswer(
  session: LeadFlowSession,
  rawInput: string,
  quickReplyPayload?: string | null,
): Promise<StepOutcome> {
  if (CANCEL_KEYWORDS.includes(rawInput.trim().toLowerCase())) {
    await prisma.leadFlowSession.update({ where: { id: session.id }, data: { status: "CANCELLED" } });
    return {
      messages: [{ text: "No problem — the form was cancelled. Message us anytime to start again." }],
      sessionStatus: "CANCELLED",
    };
  }

  const questions = await prisma.leadFlowQuestion.findMany({
    where: { flowId: session.flowId, ...ACTIVE_QUESTION_FILTER },
    orderBy: { order: "asc" },
  });
  const currentIdx = questions.findIndex((q) => q.id === session.currentQuestionId);
  const current = currentIdx >= 0 ? questions[currentIdx]! : null;
  if (!current) {
    await prisma.leadFlowSession.update({ where: { id: session.id }, data: { status: "CANCELLED" } });
    return { messages: [], sessionStatus: "CANCELLED" };
  }

  // boolean quick replies use payload yes/no
  let effectiveInput = rawInput;
  if (current.type === "BOOLEAN" && quickReplyPayload === `${OPTION_PAYLOAD_PREFIX}yes`) effectiveInput = "Yes";
  if (current.type === "BOOLEAN" && quickReplyPayload === `${OPTION_PAYLOAD_PREFIX}no`) effectiveInput = "No";

  const result = validateAnswer(current, effectiveInput, quickReplyPayload);
  if (!result.ok) {
    return { messages: [{ text: result.error ?? "Please try again." }], sessionStatus: "ACTIVE" };
  }

  await prisma.leadAnswer.upsert({
    where: { sessionId_questionId: { sessionId: session.id, questionId: current.id } },
    create: { sessionId: session.id, questionId: current.id, value: result.value ?? "" },
    update: { value: result.value ?? "" },
  });

  const next = questions[currentIdx + 1];
  if (next) {
    await prisma.leadFlowSession.update({
      where: { id: session.id },
      data: { currentQuestionId: next.id, askedAt: new Date() },
    });
    return { messages: [renderQuestion(next)], sessionStatus: "ACTIVE" };
  }

  // flow complete → build the lead
  const completed = await completeSession(session.id);
  return completed;
}

async function completeSession(sessionId: string): Promise<StepOutcome> {
  const session = await prisma.leadFlowSession.findUniqueOrThrow({
    where: { id: sessionId },
    include: {
      flow: true,
      answers: { include: { question: true } },
      conversation: true,
    },
  });

  const byOrder = [...session.answers].sort((a, b) => a.question.order - b.question.order);
  const mapped: Record<string, string> = {};
  for (const a of byOrder) {
    if (a.question.mapTo && ["name", "phone", "email"].includes(a.question.mapTo)) {
      mapped[a.question.mapTo] = a.value;
    }
  }
  const answersJson = byOrder.map((a) => ({ question: a.question.title, answer: a.value }));

  // Attribute the lead to the Lead Button config built on this flow (if any).
  const ctaConfig = await prisma.ctaConfig.findFirst({
    where: { accountId: session.accountId, leadFlowId: session.flowId },
    select: { id: true },
  });

  const lead = await prisma.lead.create({
    data: {
      accountId: session.accountId,
      igsid: session.conversation.igsid,
      conversationId: session.conversationId,
      name: mapped.name ?? session.conversation.username ?? null,
      phone: mapped.phone ?? null,
      email: mapped.email ?? null,
      answers: answersJson as unknown as Prisma.InputJsonValue,
      source: "instagram_dm",
      flowId: session.flowId,
      ctaConfigId: ctaConfig?.id ?? null,
      status: "NEW",
    },
  });
  await prisma.leadEvent.create({ data: { leadId: lead.id, type: "CREATED", data: { flow: session.flow.name } } });

  await prisma.$transaction([
    prisma.leadFlowSession.update({
      where: { id: session.id },
      data: { status: "COMPLETED", completedAt: new Date(), leadId: lead.id },
    }),
    prisma.conversation.update({ where: { id: session.conversationId }, data: { leadId: lead.id } }),
  ]);

  log.info("flow completed, lead created", { sessionId, leadId: lead.id });

  const thanks =
    session.flow.completionMessage?.trim() ||
    "Thank you! We received your details and will contact you shortly. ✅";
  return {
    messages: [{ text: thanks }],
    sessionStatus: "COMPLETED",
    completedSessionId: session.id,
  };
}

/** Find a flow whose trigger keywords match an inbound message. */
export async function findFlowByKeyword(accountId: string, text: string): Promise<string | null> {
  const flows = await prisma.leadFlow.findMany({
    where: { accountId, enabled: true },
    select: { id: true, triggerKeywords: true },
  });
  const lower = text.toLowerCase();
  for (const flow of flows) {
    if (flow.triggerKeywords.some((k) => k && lower.includes(k.toLowerCase()))) return flow.id;
  }
  return null;
}
