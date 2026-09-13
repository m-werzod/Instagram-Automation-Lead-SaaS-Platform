/**
 * Agent guardrails — pure functions, unit-tested, no I/O.
 *
 * They decide when the assistant may speak (working hours), how long it may
 * speak (response length), and whether what the model produced is allowed to
 * leave the building (prohibited topics, prompt leakage, empty output). The
 * runtime applies them on every turn; nothing here is advisory.
 */

export interface WorkingHours {
  /** IANA zone, e.g. "Asia/Tashkent" */
  timezone: string;
  /** 0 = Sunday … 6 = Saturday */
  days: number[];
  /** "HH:MM" 24h, inclusive */
  start: string;
  /** "HH:MM" 24h, exclusive; may be earlier than start for overnight shifts */
  end: string;
}

/** "HH:MM" 24h. Exported so every place that validates working-hours input (the API schema included) shares one pattern instead of risking a second, drifting copy. */
export const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function parseWorkingHours(json: unknown): WorkingHours | null {
  if (!json || typeof json !== "object") return null;
  const o = json as Record<string, unknown>;
  if (typeof o.timezone !== "string" || !o.timezone) return null;
  if (!Array.isArray(o.days) || o.days.length === 0) return null;
  if (typeof o.start !== "string" || !HHMM.test(o.start)) return null;
  if (typeof o.end !== "string" || !HHMM.test(o.end)) return null;
  try {
    // throws RangeError on an unknown zone
    new Intl.DateTimeFormat("en-US", { timeZone: o.timezone });
  } catch {
    return null;
  }
  const days = [...new Set(o.days.map((d) => Number(d)).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))];
  if (days.length === 0) return null;
  return { timezone: o.timezone, days, start: o.start, end: o.end };
}

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** Local weekday (0–6) and minutes since midnight in the given zone. */
export function localClock(now: Date, timezone: string): { day: number; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const dayIndex = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
  const hour = Number(get("hour")) % 24; // "24" appears in some engines for midnight
  const minute = Number(get("minute"));
  return { day: dayIndex, minutes: hour * 60 + minute };
}

/** No schedule = always available. Overnight windows (22:00 → 06:00) count the previous day's slot. */
export function isWithinWorkingHours(spec: WorkingHours | null | undefined, now: Date = new Date()): boolean {
  if (!spec) return true;
  const { day, minutes } = localClock(now, spec.timezone);
  const start = minutesOf(spec.start);
  const end = minutesOf(spec.end);
  if (start === end) return spec.days.includes(day); // whole day
  if (start < end) return spec.days.includes(day) && minutes >= start && minutes < end;
  // overnight: today's evening OR the tail of yesterday's shift
  if (minutes >= start) return spec.days.includes(day);
  if (minutes < end) return spec.days.includes((day + 6) % 7);
  return false;
}

/** "price, refunds\ncompetitors" → ["price", "refunds", "competitors"] */
export function splitTopics(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return [...new Set(raw.split(/[,\n;]+/).map((t) => t.trim().toLowerCase()).filter((t) => t.length >= 2))];
}

/** First prohibited topic mentioned in the text, or null. Word-boundary aware for single words, substring for phrases. */
export function findProhibitedTopic(text: string, topics: string[]): string | null {
  const lower = text.toLowerCase();
  for (const topic of topics) {
    if (topic.includes(" ")) {
      if (lower.includes(topic)) return topic;
    } else {
      const re = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegex(topic)}([^\\p{L}\\p{N}]|$)`, "iu");
      if (re.test(lower)) return topic;
    }
  }
  return null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A reply that quotes a long stretch of its own system prompt is leaking
 * configuration. 80 consecutive characters is far longer than any legitimate
 * overlap (a price, an address) and far shorter than a real leak.
 */
export function looksLikePromptLeak(reply: string, systemPrompt: string, window = 80): boolean {
  if (/\b(system prompt|my instructions are|you are configured|i was instructed to)\b/i.test(reply)) return true;
  const hay = normalize(reply);
  const src = normalize(systemPrompt);
  if (hay.length < window || src.length < window) return false;
  for (let i = 0; i + window <= src.length; i += 20) {
    if (hay.includes(src.slice(i, i + window))) return true;
  }
  return false;
}

function normalize(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

export type ResponseLength = "SHORT" | "MEDIUM" | "LONG";

export function normalizeResponseLength(v: unknown): ResponseLength {
  return v === "MEDIUM" || v === "LONG" ? v : "SHORT";
}

/** Token ceiling per length preset, never above the agent's own maximum. */
export function maxTokensFor(length: ResponseLength, agentMax: number): number {
  const cap = length === "SHORT" ? 300 : length === "MEDIUM" ? 700 : agentMax;
  return Math.max(64, Math.min(cap, agentMax));
}

export function lengthInstruction(length: ResponseLength): string {
  switch (length) {
    case "SHORT":
      return "Reply in 1–3 short sentences. No lists unless the customer asks for options.";
    case "MEDIUM":
      return "Reply in one short paragraph (up to ~80 words).";
    case "LONG":
      return "Reply as fully as the question needs, but stay under 900 characters — Instagram cuts longer messages.";
  }
}

export interface ReplyValidationInput {
  systemPrompt: string;
  prohibitedTopics?: string | null;
  fallbackReply?: string | null;
}

export type ReplyValidation =
  | { ok: true; text: string }
  | { ok: false; reason: "empty" | "prohibited_topic" | "prompt_leak"; detail?: string; text: string | null };

/** Output gate: the text that may be sent, or the fallback (if configured) plus the reason it replaced the model's words. */
export function validateReply(reply: string | null | undefined, agent: ReplyValidationInput): ReplyValidation {
  const text = (reply ?? "").trim();
  const fallback = agent.fallbackReply?.trim() || null;
  if (!text) return { ok: false, reason: "empty", text: fallback };
  const hit = findProhibitedTopic(text, splitTopics(agent.prohibitedTopics));
  if (hit) return { ok: false, reason: "prohibited_topic", detail: hit, text: fallback };
  if (looksLikePromptLeak(text, agent.systemPrompt)) return { ok: false, reason: "prompt_leak", text: fallback };
  return { ok: true, text };
}
