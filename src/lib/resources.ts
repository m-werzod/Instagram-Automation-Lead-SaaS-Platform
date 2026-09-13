import { coreEnv } from "@/lib/env";

/**
 * Comment resources — files an admin hands to people who comment on a post
 * (a price list, a catalogue, a lookbook). Deliberately separate from
 * src/lib/meta/publishing.ts's MediaAsset pipeline: these files are never fed
 * into Instagram's publish endpoint, only attached to or linked from a
 * private reply, so they accept types (PDF, docs) publishing rightly rejects.
 */

export type ResourceKind = "IMAGE" | "VIDEO" | "FILE";

/** Instagram's Send API documents image/video/audio attachment types only —
 * there is no generic "file" attachment (unlike Messenger). Anything that
 * isn't an image or video sends as a link in a text message instead. */
export function resourceKindFromMime(mime: string): ResourceKind {
  if (mime.startsWith("image/")) return "IMAGE";
  if (mime.startsWith("video/")) return "VIDEO";
  return "FILE";
}

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/zip": "zip",
};

export function resourceExtensionFor(mimeType: string): string {
  return EXT_BY_MIME[mimeType] ?? "bin";
}

/** Public URL the platform serves this resource from — Meta fetches attachment
 * URLs the same way it fetches publish media; humans open link-fallback URLs directly. */
export function resourceUrlFor(id: string, mimeType: string): string {
  return `${coreEnv().APP_URL}/r/${id}.${resourceExtensionFor(mimeType)}`;
}

/** Broader than MediaAsset's publish-only allowlist on purpose — these files
 * never enter Instagram's publish pipeline, so PDFs/docs are fine. */
export const ALLOWED_RESOURCE_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "video/mp4",
  "video/quicktime",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/zip",
]);

/** Same serverless request-body ceiling as MediaAsset (src/lib/meta/publishing.ts). */
export const MAX_RESOURCE_BYTES = 4 * 1024 * 1024;
