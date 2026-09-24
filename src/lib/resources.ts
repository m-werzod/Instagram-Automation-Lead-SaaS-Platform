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

/**
 * Content-Disposition value for a stored file name.
 *
 * HTTP header values are Latin-1: a Cyrillic or Uzbek file name put in raw threw
 * inside the response constructor, so /r/{id} answered 500 — which broke the
 * public link AND Meta's fetch of the attachment. RFC 5987 carries the real name
 * in `filename*`, with a plain-ASCII `filename` for clients that ignore it.
 */
export function contentDispositionFor(rawName: string, disposition: "inline" | "attachment" = "inline"): string {
  const name = rawName.trim() || "file";
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_") || "file";
  const encoded = encodeURIComponent(name).replace(/['()*!]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
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
