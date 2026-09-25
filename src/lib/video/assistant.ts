import { z } from "zod";
import { getProvider, providerNameOf, recordUsage } from "@/lib/ai";
import type { ChatTurn, ToolDef } from "@/lib/ai";
import type { AIProviderType } from "@prisma/client";
import { createLogger, errorFields } from "@/lib/logger";
import { applyEditPatch, diffEditParams, editParamsSchema, type EditParams } from "./params";

const log = createLogger("video.assistant");

/**
 * The editor's chat assistant.
 *
 * The model has exactly three moves — propose a parameter patch, ask a
 * question, or explain that something is not supported — and none of them
 * executes anything. A proposal is validated against the edit schema, shown to
 * the operator as a plain-language diff, and applied only when they accept it.
 *
 * This is the whole safety story for natural-language editing: the model never
 * emits a command, a filter string, or a path. It emits data that must survive
 * zod validation before it can influence a render.
 */

export type AssistantLanguage = "uz" | "ru" | "en";

export interface AssistantProposal {
  /** Validated patch, ready for applyEditPatch. */
  patch: Record<string, unknown>;
  /** The resulting parameters, for previewing the outcome. */
  next: EditParams;
  /** Field-by-field changes, for the confirmation UI. */
  changes: Array<{ path: string; from: string; to: string }>;
  summary: string;
}

export interface AssistantTurn {
  reply: string;
  proposal: AssistantProposal | null;
  unsupported: string[];
  language: AssistantLanguage;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  model: string;
  provider: string;
}

/**
 * Language detection good enough to answer in the operator's language.
 * Cyrillic implies Russian; the Uzbek Latin markers (oʻ, gʻ, sh/ch digraphs and
 * common function words) separate Uzbek from English.
 */
/**
 * Uzbek stems that no English word begins with, so a prefix match is safe on
 * an agglutinative language ("ovoz" must also catch "ovozni", "ovozini").
 *
 * The bare fragments this list used to carry — `bo`, `qo`, and `video` — made
 * the detector answer an English operator in Uzbek: `bo\w*` matches "bold",
 * "bottom", "box" and "boost", and "video" is the same word in all three
 * languages, so "make the video 2x faster" was read as Uzbek. A marker earns a
 * place here only if it cannot begin an English word.
 */
const UZ_STEMS =
  /\b(qil|qoʻsh|qo'sh|qosh|ovoz|tovush|musiqa|matn|saqla|kerak|uchun|bilan|lekin|faqat|tezroq|sekinroq|sekin|katta|kichik|pastki|yuqori|subtitr|baland|qisqartir|boshla|tayyorla|oʻzgartir|ozgartir)\w*/g;

/**
 * Markers whose suffixed forms collide with English ("asl" + `\w*` catches
 * "also"), so these must match as whole words.
 */
const UZ_EXACT = /\b(asl|asli|qism|qismi|pastga|tepaga)\b/g;

export function detectLanguage(text: string): AssistantLanguage {
  if (/[Ѐ-ӿ]/.test(text)) return "ru";
  const t = text.toLowerCase();
  if (/(o|g)[ʻʼ‘’]/i.test(text)) return "uz";
  const hits = (t.match(UZ_STEMS)?.length ?? 0) + (t.match(UZ_EXACT)?.length ?? 0);
  return hits >= 1 ? "uz" : "en";
}

const SYSTEM_BY_LANG: Record<AssistantLanguage, string> = {
  uz: "Javoblaringizni tabiiy o‘zbek tilida yozing. Qisqa va aniq gapiring.",
  ru: "Отвечайте на естественном русском языке. Говорите кратко и конкретно.",
  en: "Reply in natural English. Be brief and concrete.",
};

/**
 * The patch schema handed to the model. Deliberately a *description* of the
 * edit model rather than the full zod schema: every field is optional, so the
 * model can express "only change the music volume" without restating the rest.
 */
/**
 * EVERY level is `.strict()`, not just the outermost one.
 *
 * zod strips unknown keys by default, and `.strict()` applies only to the
 * object it is called on. With the nested sections left permissive, a proposal
 * like `{ video: { greenScreen: true }, audio: { originalVolume: 20 } }` had
 * `greenScreen` quietly deleted and the REST applied — so the operator was
 * shown "Remove the background and drop the voice to 20%", accepted it, and
 * got only the volume change. A parameter this editor does not have must be
 * refused out loud (the model is told to call `explain_unsupported` instead),
 * never silently dropped out of a proposal the operator is about to confirm.
 */
const patchSchema = z
  .object({
    video: z
      .object({
        trim: z.object({ startSec: z.number().min(0), endSec: z.number().min(0).optional() }).strict().optional(),
        speed: z.number().min(0.25).max(4).optional(),
        aspect: z.enum(["original", "9:16", "1:1", "4:5", "16:9"]).optional(),
        fit: z.enum(["cover", "contain"]).optional(),
        maxHeight: z.number().int().min(240).max(2160).optional(),
      })
      .strict()
      .optional(),
    audio: z
      .object({
        originalVolume: z.number().int().min(0).max(200).optional(),
        muteOriginal: z.boolean().optional(),
        tracks: z
          .array(
            z
              .object({
                assetId: z.string().min(1),
                volume: z.number().int().min(0).max(200).optional(),
                startSec: z.number().min(0).optional(),
                trimStartSec: z.number().min(0).optional(),
                trimEndSec: z.number().min(0).optional(),
                fadeInSec: z.number().min(0).max(60).optional(),
                fadeOutSec: z.number().min(0).max(60).optional(),
                loop: z.boolean().optional(),
                duckUnderSpeech: z.boolean().optional(),
              })
              .strict(),
          )
          .optional(),
      })
      .strict()
      .optional(),
    look: z
      .object({
        preset: z.enum(["none", "vivid", "warm", "cool", "soft", "contrast", "bw"]).optional(),
        brightness: z.number().min(-0.5).max(0.5).optional(),
        contrast: z.number().min(0.5).max(2).optional(),
        saturation: z.number().min(0).max(3).optional(),
      })
      .strict()
      .optional(),
    subtitles: z
      .object({
        burnIn: z.boolean().optional(),
        style: z
          .object({
            preset: z
              .enum(["clean-white", "bold-social", "minimal", "high-contrast", "creator", "highlighted-words", "professional"])
              .optional(),
            fontSizePct: z.number().min(2).max(14).optional(),
            bold: z.boolean().optional(),
            textColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
            backgroundColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
            backgroundOpacity: z.number().min(0).max(1).optional(),
            outlineWidth: z.number().min(0).max(8).optional(),
            position: z.enum(["top", "middle", "lower-center", "bottom"]).optional(),
            alignment: z.enum(["left", "center", "right"]).optional(),
            uppercase: z.boolean().optional(),
            wordHighlight: z.boolean().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const PATCH_TOOL: ToolDef = {
  name: "propose_edit",
  description:
    "Propose a change to the current editing parameters. Include ONLY the fields that should change. This does not apply anything — the operator sees your proposal and confirms it.",
  parameters: {
    type: "object",
    properties: {
      patch: {
        type: "object",
        description:
          "Partial edit parameters. Sections: video{trim{startSec,endSec},speed,aspect,fit,maxHeight}, audio{originalVolume,muteOriginal,tracks[{assetId,volume,startSec,trimStartSec,trimEndSec,fadeInSec,fadeOutSec,loop,duckUnderSpeech}]}, look{preset,brightness,contrast,saturation}, subtitles{burnIn,style{preset,fontSizePct,bold,textColor,backgroundColor,backgroundOpacity,outlineWidth,position,alignment,uppercase,wordHighlight}}. Volumes are percentages 0-200 where 100 means unchanged.",
      },
      summary: { type: "string", description: "One sentence, in the operator's language, describing what this changes." },
    },
    required: ["patch", "summary"],
  },
};

const UNSUPPORTED_TOOL: ToolDef = {
  name: "explain_unsupported",
  description: "State that a requested effect cannot be done by this editor. Use it instead of inventing a parameter that does not exist.",
  parameters: {
    type: "object",
    properties: {
      requests: { type: "array", items: { type: "string" }, description: "Each unsupported thing the operator asked for." },
      explanation: { type: "string", description: "Short explanation in the operator's language, and the nearest thing that IS possible." },
    },
    required: ["requests", "explanation"],
  },
};

function buildSystemPrompt(params: EditParams, ctx: ProjectContext, lang: AssistantLanguage): string {
  const tracks = ctx.audioAssets.length
    ? ctx.audioAssets.map((a) => `- id "${a.id}": ${a.name}${a.durationSec ? ` (${Math.round(a.durationSec)}s)` : ""}`).join("\n")
    : "(none uploaded yet)";

  return [
    "You are the editing assistant inside an Instagram video editor. You help the operator change ONE video project by proposing parameter changes.",
    "",
    "HOW YOU WORK:",
    "- To change the edit, call propose_edit with only the fields that change. You never apply anything yourself; the operator confirms every proposal.",
    "- If a request cannot be expressed in the parameters below, call explain_unsupported. Never invent a parameter, a filter, or an effect that is not listed.",
    "- If a request is ambiguous in a way that changes the result (which audio track, how much, which part of the video), ask a short question instead of guessing.",
    "- Volumes are percentages of the original amplitude. 100 leaves a track unchanged, 30 makes it much quieter. This is NOT perceived loudness; do not promise a precise loudness result.",
    "",
    "WHAT THIS EDITOR CAN DO:",
    "- Trim (start/end), change speed 0.25x-4x (voices stay natural), change aspect ratio (9:16, 1:1, 4:5, 16:9) by cropping or padding, cap resolution.",
    "- Mix audio: the video's own audio volume and each uploaded track's volume are INDEPENDENT. Uploaded tracks can start at an offset, be trimmed, fade in/out, loop, and duck under the original audio.",
    "- Colour presets: none, vivid, warm, cool, soft, contrast, bw; plus brightness/contrast/saturation.",
    "- Subtitles: burn in captions with a preset look, size, colours, background box, outline, position, alignment, uppercase, and per-word highlighting when word timings exist.",
    "",
    "WHAT IT CANNOT DO (say so plainly): motion graphics, animated stickers or logos, object/face tracking, green-screen removal, beat-synced automatic cutting, transitions other than hard cuts, zoom/pan keyframes, generating new footage, or changing what is said.",
    "",
    `SOURCE VIDEO: ${ctx.sourceLabel}`,
    `UPLOADED AUDIO TRACKS (use these ids in audio.tracks):\n${tracks}`,
    ctx.subtitleInfo,
    "",
    "CURRENT PARAMETERS (JSON):",
    JSON.stringify(params),
    "",
    SYSTEM_BY_LANG[lang],
  ].join("\n");
}

export interface ProjectContext {
  sourceLabel: string;
  audioAssets: Array<{ id: string; name: string; durationSec: number | null }>;
  /** One line about whether subtitles exist and whether word timings exist. */
  subtitleInfo: string;
  accountId: string;
  projectId: string;
}

export interface AssistantInput {
  message: string;
  history: Array<{ role: "user" | "assistant"; text: string }>;
  params: EditParams;
  context: ProjectContext;
  model: string;
  /** Provider enum as stored on the agent row; defaults to the platform default. */
  provider: AIProviderType;
  adminId?: string | null;
}

/**
 * One assistant turn. Returns a reply and, when the model proposed one, a
 * validated patch with a diff the operator can read before accepting.
 */
export async function runAssistantTurn(input: AssistantInput): Promise<AssistantTurn> {
  const lang = detectLanguage(input.message);
  const provider = getProvider(input.provider);
  const providerName = providerNameOf(input.provider);
  const system = buildSystemPrompt(input.params, input.context, lang);

  const messages: ChatTurn[] = [
    ...input.history.slice(-12).map((h) =>
      h.role === "user" ? ({ role: "user", text: h.text } as ChatTurn) : ({ role: "assistant", text: h.text } as ChatTurn),
    ),
    { role: "user", text: input.message },
  ];

  const started = Date.now();
  const res = await provider.chat({
    model: input.model,
    system,
    messages,
    tools: [PATCH_TOOL, UNSUPPORTED_TOOL],
    temperature: 0.2,
    maxTokens: 1200,
  });

  let proposal: AssistantProposal | null = null;
  const unsupported: string[] = [];
  const replyParts: string[] = [];
  if (res.text?.trim()) replyParts.push(res.text.trim());

  for (const call of res.toolCalls) {
    if (call.name === "propose_edit") {
      const parsed = patchSchema.safeParse(call.arguments.patch ?? {});
      if (!parsed.success) {
        // A malformed proposal is reported, never silently applied.
        log.warn("assistant proposed an invalid patch", { issues: parsed.error.issues.slice(0, 3) });
        replyParts.push(
          lang === "uz"
            ? "Taklif qilingan o‘zgarish noto‘g‘ri formatda edi — iltimos, aniqroq ayting."
            : lang === "ru"
              ? "Предложенное изменение было в неверном формате — уточните, пожалуйста."
              : "The proposed change was not in a valid form — please rephrase.",
        );
        continue;
      }
      try {
        const next = applyEditPatch(input.params, parsed.data);
        const changes = diffEditParams(input.params, next);
        if (changes.length > 0) {
          proposal = {
            patch: parsed.data as Record<string, unknown>,
            next,
            changes,
            summary: String(call.arguments.summary ?? "").slice(0, 400),
          };
        }
      } catch (err) {
        log.warn("assistant patch failed validation on merge", errorFields(err));
      }
    } else if (call.name === "explain_unsupported") {
      const reqs = Array.isArray(call.arguments.requests) ? (call.arguments.requests as unknown[]).map(String) : [];
      unsupported.push(...reqs.slice(0, 10));
      const explanation = String(call.arguments.explanation ?? "").slice(0, 800);
      if (explanation) replyParts.push(explanation);
    }
  }

  if (replyParts.length === 0 && proposal) replyParts.push(proposal.summary);

  /**
   * Never hand the chat an empty bubble.
   *
   * A model that answers with a tool call and no prose is normal, and so is a
   * proposal that turns out to change nothing — combine the two (or an
   * `explain_unsupported` whose explanation came back blank) and `reply` was
   * the empty string. The operator saw their message land and absolutely
   * nothing come back, with no way to tell a silent success from a crash.
   */
  if (replyParts.length === 0 && unsupported.length > 0) {
    replyParts.push(
      lang === "uz"
        ? `Bu muharrir buni qila olmaydi: ${unsupported.join(", ")}.`
        : lang === "ru"
          ? `Этот редактор не умеет: ${unsupported.join(", ")}.`
          : `This editor cannot do: ${unsupported.join(", ")}.`,
    );
  }
  if (replyParts.length === 0) {
    replyParts.push(
      lang === "uz"
        ? "Hech narsani oʻzgartirish kerak boʻlmadi — parametrlar avvalgidek qoldi."
        : lang === "ru"
          ? "Менять ничего не потребовалось — параметры остались прежними."
          : "No change was needed — the parameters are already as you describe.",
    );
  }

  await recordUsage({
    accountId: input.context.accountId,
    purpose: "video_assistant",
    provider: providerName,
    model: input.model,
    inputTokens: res.inputTokens,
    outputTokens: res.outputTokens,
    costUsd: res.costUsd ?? null,
    latencyMs: Date.now() - started,
    success: true,
  }).catch((err) => log.warn("usage accounting failed", errorFields(err)));

  return {
    reply: replyParts.join("\n\n").trim(),
    proposal,
    unsupported,
    language: lang,
    inputTokens: res.inputTokens,
    outputTokens: res.outputTokens,
    costUsd: res.costUsd ?? null,
    model: input.model,
    provider: providerName,
  };
}

export { editParamsSchema };
