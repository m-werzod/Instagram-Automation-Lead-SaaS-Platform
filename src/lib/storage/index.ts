import { createHash, randomBytes } from "node:crypto";
import { createLogger } from "@/lib/logger";
import { coreEnv } from "@/lib/env";

const log = createLogger("storage");

/**
 * Object storage for media too large to live in Postgres.
 *
 * The publishing pipeline stores images as `bytea` (MediaAsset.data), which is
 * bounded by the 4.5 MB serverless request limit. Video cannot work that way —
 * a single Reel is tens or hundreds of megabytes, needs HTTP Range requests to
 * scrub, and must stay downloadable by Meta for the whole publish window. So
 * video files go through a driver instead:
 *
 *   local        — a directory on the machine running the worker. Correct for a
 *                  VPS/Railway/Render deployment, and for development.
 *   vercel-blob  — Vercel Blob. Correct when the web tier is serverless: the
 *                  browser uploads straight to Blob, bypassing the body limit.
 *
 * Which one is active is a deployment fact, never a guess: STORAGE_DRIVER picks
 * explicitly, otherwise a configured BLOB_READ_WRITE_TOKEN selects Blob and the
 * absence of one selects local.
 */

export type StorageDriverName = "local" | "vercel-blob";

export interface PutOptions {
  contentType: string;
  /** Blob only: whether the object gets a public, unguessable URL. */
  publicRead?: boolean;
}

export interface PutResult {
  key: string;
  /** Set only when the driver serves the object itself (Blob). */
  publicUrl: string | null;
  sizeBytes: number;
}

export interface StorageDriver {
  readonly name: StorageDriverName;
  /** True when the driver hands out URLs Meta can fetch without our help. */
  readonly hasNativePublicUrls: boolean;
  put(key: string, data: Buffer | Uint8Array, opts: PutOptions): Promise<PutResult>;
  /** Streams bytes; `range` is a byte range when the client asked for one. */
  read(key: string, range?: { start: number; end?: number }): Promise<ReadableStream<Uint8Array>>;
  /** Whole object in memory — only for files known to be small (subtitles, probes). */
  readAll(key: string): Promise<Buffer>;
  /** Absolute filesystem path, when the driver has one. FFmpeg prefers this. */
  localPath(key: string): string | null;
  stat(key: string): Promise<{ sizeBytes: number } | null>;
  delete(key: string): Promise<void>;
  publicUrl(key: string): string | null;
}

export class StorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageError";
  }
}

// ---- key construction ----

/**
 * Keys are `video/{accountId}/{scope}/{random}{ext}`. The account id is the
 * first segment so a misconfigured bucket policy still cannot let one tenant
 * enumerate another's files by guessing, and every key carries randomness so a
 * key is never derivable from a project or asset id.
 */
export function buildStorageKey(accountId: string, scope: string, filename: string): string {
  const ext = extensionOf(filename);
  const safeScope = scope.replace(/[^a-z0-9_-]/gi, "").slice(0, 24) || "misc";
  return `video/${accountId}/${safeScope}/${randomBytes(16).toString("hex")}${ext}`;
}

export function extensionOf(filename: string): string {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(filename.trim());
  const ext = m?.[1];
  return ext ? `.${ext.toLowerCase()}` : "";
}

/** Reject anything that could escape the storage root. */
export function assertSafeKey(key: string): void {
  if (!key || key.length > 512) throw new StorageError("Invalid storage key");
  if (key.startsWith("/") || key.includes("..") || key.includes("\\") || /[\0\r\n]/.test(key)) {
    throw new StorageError("Invalid storage key");
  }
}

// ---- signed URLs for the local driver ----

/**
 * The local driver has no public URL of its own, but Meta must be able to
 * download a finished render. These tokens make one: an HMAC over the asset id
 * and an expiry, verified by the public streaming route. They are deliberately
 * short-lived and scoped to a single asset.
 */
export function signAssetToken(assetId: string, ttlMs: number): string {
  const exp = Date.now() + ttlMs;
  const body = `${assetId}.${exp}`;
  return `${body}.${hmac(body)}`;
}

export function verifyAssetToken(token: string): { assetId: string } | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [assetId, expRaw, sig] = parts as [string, string, string];
  const body = `${assetId}.${expRaw}`;
  const expected = hmac(body);
  if (sig.length !== expected.length) return null;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
  if (diff !== 0) return null;
  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || Date.now() > exp) return null;
  return { assetId };
}

function hmac(body: string): string {
  const secret = process.env.SESSION_SECRET ?? "";
  return createHash("sha256").update(`${secret}:asset:${body}`).digest("hex").slice(0, 32);
}

// ---- driver selection ----

let cachedDriver: StorageDriver | null = null;

export function storageDriverName(): StorageDriverName {
  const explicit = process.env.STORAGE_DRIVER?.trim().toLowerCase();
  if (explicit === "local" || explicit === "vercel-blob") return explicit;
  return process.env.BLOB_READ_WRITE_TOKEN?.trim() ? "vercel-blob" : "local";
}

export async function getStorage(): Promise<StorageDriver> {
  if (cachedDriver) return cachedDriver;
  const name = storageDriverName();
  if (name === "vercel-blob") {
    const { VercelBlobDriver } = await import("./vercel-blob");
    cachedDriver = new VercelBlobDriver();
  } else {
    const { LocalDriver } = await import("./local");
    cachedDriver = new LocalDriver();
  }
  log.info("storage driver selected", { driver: cachedDriver.name });
  return cachedDriver;
}

/** Test hook — drop the memoised driver so a changed env is re-read. */
export function _resetStorageDriver(): void {
  cachedDriver = null;
}

// ---- configuration reporting ----

export interface StorageStatus {
  driver: StorageDriverName;
  configured: boolean;
  /** Why it is unusable, in words an admin can act on. */
  reason: string | null;
  maxUploadMb: number;
}

export function maxUploadBytes(): number {
  const mb = Number(process.env.VIDEO_MAX_UPLOAD_MB);
  const resolved = Number.isFinite(mb) && mb > 0 ? Math.min(mb, 2048) : 500;
  return Math.floor(resolved * 1024 * 1024);
}

export function storageStatus(): StorageStatus {
  const driver = storageDriverName();
  const maxUploadMb = Math.floor(maxUploadBytes() / (1024 * 1024));
  if (driver === "vercel-blob") {
    const token = process.env.BLOB_READ_WRITE_TOKEN?.trim();
    return {
      driver,
      configured: Boolean(token),
      reason: token
        ? null
        : "BLOB_READ_WRITE_TOKEN is not set. Create a Blob store in the Vercel dashboard (Storage → Blob) and add its token to the project environment.",
      maxUploadMb,
    };
  }
  return { driver, configured: true, reason: null, maxUploadMb };
}

/** Where the local driver keeps files. Also used by the worker for scratch space. */
export function localStorageRoot(): string {
  const configured = process.env.MEDIA_STORAGE_DIR?.trim();
  if (configured) return configured;
  return `${process.cwd()}/.media-storage`;
}

/**
 * A base URL Meta can reach. Publishing needs this to be a real public HTTPS
 * origin — localhost renders cannot be published, and saying so early is far
 * better than letting Meta fail with an opaque media error.
 */
export function publicBaseUrl(): string {
  return coreEnv().APP_URL;
}

export function isPubliclyReachable(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return false;
    const h = u.hostname.toLowerCase();
    if (h === "localhost" || h === "127.0.0.1" || h.endsWith(".local")) return false;
    if (/^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h)) return false;
    return true;
  } catch {
    return false;
  }
}
