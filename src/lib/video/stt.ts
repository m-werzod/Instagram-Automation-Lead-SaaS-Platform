import { readFile } from "node:fs/promises";
import { aiKeyFor, openAiBaseUrl } from "@/lib/env";
import { createLogger, errorFields } from "@/lib/logger";
import type { SubtitleCue } from "./subtitles";

const log = createLogger("video.stt");

/**
 * Speech-to-text for automatic subtitles.
 *
 * The platform's existing AI abstraction is text-only (chat plus tool calls),
 * so transcription is its own provider layer rather than a forced fit:
 *
 *   openai-compatible — POST {base}/audio/transcriptions. Returns word-level
 *                       timings with `verbose_json`, which is what per-word
 *                       highlight presets need.
 *   google            — Gemini `generateContent` with inline audio. Returns
 *                       cue-level timings only; word highlighting stays
 *                       unavailable rather than being faked from guesses.
 *
 * Neither is assumed to work. A provider that is unconfigured, unpaid, or
 * failing is reported as unavailable with the provider's own reason, and the
 * editor offers manual subtitles instead of pretending to transcribe.
 */

export type SttProviderName = "openai-compatible" | "google";

export interface TranscriptionResult {
  cues: SubtitleCue[];
  language: string | null;
  provider: SttProviderName;
  model: string;
  /** True when the provider returned real word timings. */
  hasWordTimings: boolean;
}

export class SttUnavailableError extends Error {
  readonly provider: SttProviderName | null;
  /** What the operator must do about it. */
  readonly fix: string;
  constructor(provider: SttProviderName | null, message: string, fix: string) {
    super(message);
    this.name = "SttUnavailableError";
    this.provider = provider;
    this.fix = fix;
  }
}

export interface SttStatus {
  available: boolean;
  provider: SttProviderName | null;
  model: string | null;
  reason: string | null;
  fix: string | null;
}

function configuredProvider(): SttProviderName | null {
  const explicit = process.env.STT_PROVIDER?.trim().toLowerCase();
  if (explicit === "google") return aiKeyFor("google") ? "google" : null;
  if (explicit === "openai" || explicit === "openai-compatible") {
    return aiKeyFor("openai") ? "openai-compatible" : null;
  }
  if (explicit === "none") return null;
  // Auto: prefer the OpenAI-compatible route because it gives word timings.
  if (aiKeyFor("openai")) return "openai-compatible";
  if (aiKeyFor("google")) return "google";
  return null;
}

export function sttModel(provider: SttProviderName): string {
  const configured = process.env.STT_MODEL?.trim();
  if (configured) return configured;
  return provider === "google" ? (process.env.GEMINI_VIDEO_MODEL?.trim() || "gemini-2.5-flash") : "whisper-1";
}

/** Non-throwing capability report for status endpoints and the UI. */
export function sttStatus(): SttStatus {
  const provider = configuredProvider();
  if (!provider) {
    return {
      available: false,
      provider: null,
      model: null,
      reason: "No speech-to-text provider is configured.",
      fix: "Set AI_API_KEY (an OpenAI-compatible gateway with transcription) or GOOGLE_AI_API_KEY, then set STT_PROVIDER if you want to pin one.",
    };
  }
  return { available: true, provider, model: sttModel(provider), reason: null, fix: null };
}

// ---- OpenAI-compatible ----

interface VerboseJson {
  text?: string;
  language?: string;
  segments?: Array<{ start: number; end: number; text: string }>;
  words?: Array<{ start: number; end: number; word: string }>;
}

async function transcribeOpenAiCompatible(audioPath: string, model: string, languageHint?: string, signal?: AbortSignal): Promise<TranscriptionResult> {
  const key = aiKeyFor("openai");
  if (!key) throw new SttUnavailableError("openai-compatible", "No API key for the transcription gateway.", "Set AI_API_KEY or OPENAI_API_KEY.");

  const bytes = await readFile(audioPath);
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(bytes)], { type: "audio/wav" }), "audio.wav");
  form.append("model", model);
  form.append("response_format", "verbose_json");
  // Word granularity is what makes the highlighted-words preset honest.
  form.append("timestamp_granularities[]", "word");
  form.append("timestamp_granularities[]", "segment");
  if (languageHint) form.append("language", languageHint);

  const res = await fetch(`${openAiBaseUrl()}/audio/transcriptions`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}` },
    body: form,
    signal,
  });

  if (!res.ok) {
    const body = (await res.text()).slice(0, 400);
    if (res.status === 402) {
      throw new SttUnavailableError(
        "openai-compatible",
        "The transcription provider refused the request: the account has no balance for this model.",
        "Top up the AI gateway account, or set GOOGLE_AI_API_KEY and STT_PROVIDER=google to transcribe with Gemini instead.",
      );
    }
    if (res.status === 401 || res.status === 403) {
      throw new SttUnavailableError("openai-compatible", "The transcription provider rejected the API key.", "Check AI_API_KEY / OPENAI_API_KEY.");
    }
    if (res.status === 404) {
      throw new SttUnavailableError(
        "openai-compatible",
        `The provider does not offer the model "${model}".`,
        "Set STT_MODEL to a transcription model your provider actually lists.",
      );
    }
    throw new SttUnavailableError("openai-compatible", `Transcription failed (${res.status}): ${body}`, "Retry, or switch STT_PROVIDER.");
  }

  const json = (await res.json()) as VerboseJson;
  const segments = json.segments ?? [];
  const words = json.words ?? [];

  let cues: SubtitleCue[] = segments.map((s) => ({
    start: s.start,
    end: s.end,
    text: s.text.trim(),
    words: words
      .filter((w) => w.start >= s.start - 0.01 && w.end <= s.end + 0.01)
      .map((w) => ({ start: w.start, end: w.end, text: w.word.trim() })),
  }));

  // Some gateways return only the flat text; make a single cue rather than nothing.
  if (cues.length === 0 && json.text?.trim()) {
    cues = [{ start: 0, end: 0, text: json.text.trim() }];
  }

  return {
    cues,
    language: json.language ?? null,
    provider: "openai-compatible",
    model,
    hasWordTimings: words.length > 0,
  };
}

// ---- Google Gemini ----

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  error?: { message?: string; status?: string };
}

/**
 * Gemini has no dedicated transcription endpoint, so the audio is sent inline
 * and the model is asked for timed segments as JSON. It is a genuine
 * transcription path, but a cue-level one: the result carries no word timings,
 * so callers must not enable word highlighting off it.
 */
async function transcribeGoogle(audioPath: string, model: string, languageHint?: string, signal?: AbortSignal): Promise<TranscriptionResult> {
  const key = aiKeyFor("google");
  if (!key) throw new SttUnavailableError("google", "No Google AI key configured.", "Set GOOGLE_AI_API_KEY.");

  const bytes = await readFile(audioPath);
  // Inline data must stay well under the request ceiling; longer audio is
  // chunked by the caller before it reaches here.
  if (bytes.byteLength > 18 * 1024 * 1024) {
    throw new SttUnavailableError(
      "google",
      "This audio segment is too large to transcribe in one request.",
      "Shorten the clip, or configure an OpenAI-compatible transcription provider for long videos.",
    );
  }

  const prompt = [
    "Transcribe this audio exactly as spoken.",
    languageHint ? `The speech is in ${languageHint}.` : "The speech may be in Uzbek, Russian or English — transcribe in the language actually spoken, do not translate.",
    "Return ONLY a JSON array, no prose and no code fence, of objects:",
    '[{"start": <seconds as number>, "end": <seconds as number>, "text": "<what is said>"}]',
    "Split at natural sentence or clause boundaries, at most ~12 words per entry.",
    "If there is no intelligible speech, return [].",
  ].join(" ");

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal,
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              { text: prompt },
              { inlineData: { mimeType: "audio/wav", data: bytes.toString("base64") } },
            ],
          },
        ],
        generationConfig: { temperature: 0, responseMimeType: "application/json" },
      }),
    },
  );

  if (!res.ok) {
    const body = (await res.text()).slice(0, 400);
    throw new SttUnavailableError("google", `Gemini transcription failed (${res.status}): ${body}`, "Check GOOGLE_AI_API_KEY and the model name in GEMINI_VIDEO_MODEL.");
  }

  const json = (await res.json()) as GeminiResponse;
  const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  const cues = parseCueJson(text);

  return { cues, language: languageHint ?? null, provider: "google", model, hasWordTimings: false };
}

/** Models sometimes wrap JSON in prose or a fence despite instructions. */
export function parseCueJson(text: string): SubtitleCue[] {
  const trimmed = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = trimmed.indexOf("[");
  const end = trimmed.lastIndexOf("]");
  if (start === -1 || end <= start) return [];
  try {
    const parsed = JSON.parse(trimmed.slice(start, end + 1)) as Array<{ start?: unknown; end?: unknown; text?: unknown }>;
    return parsed
      .map((c) => ({ start: Number(c.start), end: Number(c.end), text: String(c.text ?? "").trim() }))
      .filter((c) => Number.isFinite(c.start) && Number.isFinite(c.end) && c.text.length > 0);
  } catch {
    return [];
  }
}

// ---- entry point ----

export async function transcribeAudio(
  audioPath: string,
  opts: { languageHint?: string; signal?: AbortSignal } = {},
): Promise<TranscriptionResult> {
  const provider = configuredProvider();
  if (!provider) {
    const s = sttStatus();
    throw new SttUnavailableError(null, s.reason ?? "Speech-to-text is not configured.", s.fix ?? "");
  }
  const model = sttModel(provider);

  try {
    return provider === "google"
      ? await transcribeGoogle(audioPath, model, opts.languageHint, opts.signal)
      : await transcribeOpenAiCompatible(audioPath, model, opts.languageHint, opts.signal);
  } catch (err) {
    // A configured-but-unusable primary should fall back to the other provider
    // when one exists, rather than failing the whole subtitle request.
    if (err instanceof SttUnavailableError && provider === "openai-compatible" && aiKeyFor("google")) {
      log.warn("primary transcription provider unavailable, falling back to Google", errorFields(err));
      return transcribeGoogle(audioPath, sttModel("google"), opts.languageHint, opts.signal);
    }
    throw err;
  }
}
