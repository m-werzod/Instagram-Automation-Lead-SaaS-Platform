/**
 * Memory guards for routes that accept a large request body.
 *
 * `req.arrayBuffer()` reads a body to completion before anything can inspect
 * it, so a size check taken afterwards cannot prevent the allocation it is
 * checking for — and a sender that omits Content-Length (or contradicts it with
 * Transfer-Encoding: chunked) makes the pre-flight check meaningless too. The
 * reader below pulls the body chunk by chunk and abandons it the instant the
 * running total passes the limit, and the slot counter bounds how many such
 * reads may run at once, because the real ceiling is the limit times the number
 * of concurrent uploads rather than the limit alone. A slot is only a bound if
 * it is given back, so the reader also gives up on a body that stops arriving.
 */

export class UploadTooLargeError extends Error {
  constructor(readonly limitBytes: number) {
    super(`Upload exceeded the ${limitBytes} byte limit`);
    this.name = "UploadTooLargeError";
  }
}

export class UploadStalledError extends Error {
  constructor(readonly idleMs: number) {
    super(`Upload sent nothing for ${idleMs}ms`);
    this.name = "UploadStalledError";
  }
}

/**
 * A connection that goes quiet mid-body — a dropped mobile link, a half-open
 * socket, a sender holding the request open on purpose — would otherwise keep
 * its slot for as long as the process lives, and a few of those would turn the
 * concurrency guard below into the outage it exists to prevent. Sixty seconds
 * of silence is far beyond any real network hiccup within a single upload.
 */
const STALL_MS = 60_000;

/**
 * Read a request body into memory, refusing to keep more than `limitBytes`.
 *
 * Throws UploadTooLargeError as soon as the limit is passed, so the bytes still
 * in flight are never allocated: the stream is cancelled, which closes the
 * request rather than draining it. A body that stops arriving altogether throws
 * UploadStalledError instead of waiting forever.
 */
export async function readBoundedBody(
  body: ReadableStream<Uint8Array> | null,
  limitBytes: number,
  opts: { stallMs?: number } = {},
): Promise<Buffer> {
  if (!body) return Buffer.alloc(0);

  const stallMs = opts.stallMs ?? STALL_MS;
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await within(reader.read(), stallMs);
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      total += value.byteLength;
      if (total > limitBytes) throw new UploadTooLargeError(limitBytes);
      // Copy: the chunk's backing ArrayBuffer belongs to the stream and may be
      // reused once read() is called again.
      chunks.push(Buffer.from(value));
    }
  } finally {
    // Not awaited: a socket that has already stopped responding must not be
    // able to hold the handler here too, which would undo the stall timeout.
    void reader.cancel().catch(() => {});
  }

  return chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks, total);
}

/**
 * Race a pending read against the stall timer. Promise.race attaches its own
 * handlers to `read`, so a rejection arriving after the timer won is already
 * accounted for and never surfaces as an unhandled rejection.
 */
async function within<T>(read: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stalled = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new UploadStalledError(ms)), ms);
  });
  try {
    return await Promise.race([read, stalled]);
  } finally {
    clearTimeout(timer);
  }
}

export interface UploadSlot {
  release(): void;
}

export interface UploadConcurrency {
  /** Simultaneous uploads one admin may have in flight. */
  perOwner: number;
  /** Simultaneous uploads across the whole process. */
  total: number;
}

/**
 * The editor shows three upload zones — source, audio, sample — and each one
 * only disables itself, so an operator can legitimately have three in flight;
 * a lower per-owner cap would refuse the app's own UI. The process total is
 * what actually bounds the heap (that many bodies times VIDEO_MAX_UPLOAD_MB),
 * and it stays below three times the per-owner cap deliberately: one operator
 * filling every slot on a box that also runs FFmpeg is the case being avoided.
 */
export const UPLOAD_CONCURRENCY: UploadConcurrency = { perOwner: 3, total: 4 };

const inFlightByOwner = new Map<string, number>();
let inFlightTotal = 0;

/**
 * Take an upload slot, or null when the caller (or the process) is already at
 * capacity. The caller MUST release it in a `finally`.
 */
export function acquireUploadSlot(ownerKey: string, limits: UploadConcurrency = UPLOAD_CONCURRENCY): UploadSlot | null {
  const mine = inFlightByOwner.get(ownerKey) ?? 0;
  if (mine >= limits.perOwner || inFlightTotal >= limits.total) return null;

  inFlightByOwner.set(ownerKey, mine + 1);
  inFlightTotal += 1;

  let released = false;
  return {
    release() {
      // Releasing twice would hand out a slot that was never taken back.
      if (released) return;
      released = true;
      const left = (inFlightByOwner.get(ownerKey) ?? 1) - 1;
      if (left <= 0) inFlightByOwner.delete(ownerKey);
      else inFlightByOwner.set(ownerKey, left);
      inFlightTotal = Math.max(0, inFlightTotal - 1);
    },
  };
}

/** How many uploads are being received right now (diagnostics and tests). */
export function uploadsInFlight(): number {
  return inFlightTotal;
}

/** Test hook — drop every slot so one test's leak cannot fail the next. */
export function _resetUploadSlots(): void {
  inFlightByOwner.clear();
  inFlightTotal = 0;
}
