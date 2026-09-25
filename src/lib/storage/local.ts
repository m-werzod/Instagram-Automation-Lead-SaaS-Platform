import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import {
  assertSafeKey,
  localStorageRoot,
  StorageError,
  UploadTooLargeError,
  type PutOptions,
  type PutResult,
  type PutStreamOptions,
  type StorageDriver,
} from "./index";

/**
 * Filesystem storage for deployments with a resident worker (VPS, Railway,
 * Render, a dev machine). FFmpeg reads and writes these paths directly, which
 * is the fastest possible arrangement — no upload/download round trip per job.
 *
 * Nothing here is publicly served: the app streams objects through an
 * authenticated route, and hands Meta a short-lived signed URL when a render
 * has to be fetched for publishing.
 */
export class LocalDriver implements StorageDriver {
  readonly name = "local" as const;
  readonly hasNativePublicUrls = false;

  private root = resolve(localStorageRoot());

  /**
   * Resolve a key under the storage root and prove the result is still inside
   * it. assertSafeKey already rejects traversal, but this is the check that
   * actually cannot be reasoned around, so it is the one that guards every read
   * and write.
   */
  private pathFor(key: string): string {
    assertSafeKey(key);
    const full = resolve(join(this.root, key));
    if (full !== this.root && !full.startsWith(this.root + sep)) {
      throw new StorageError("Storage key escapes the storage root");
    }
    return full;
  }

  async put(key: string, data: Buffer | Uint8Array, _opts: PutOptions): Promise<PutResult> {
    const full = this.pathFor(key);
    await mkdir(dirname(full), { recursive: true });
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    await writeFile(full, buf);
    return { key, publicUrl: null, sizeBytes: buf.byteLength };
  }

  /**
   * Stream to a sibling `.part` file and rename only once the whole body has
   * arrived. A rename within one filesystem is atomic, so a reader can never
   * observe a half-written object, and an abort leaves nothing but the
   * discarded temporary — which this deletes.
   */
  async putStream(key: string, body: ReadableStream<Uint8Array>, opts: PutStreamOptions): Promise<PutResult> {
    const full = this.pathFor(key);
    // Checked before anything is opened: a caller that has already given up
    // should not cause a file to be created at all.
    if (opts.signal?.aborted) throw new StorageError("Upload cancelled");
    await mkdir(dirname(full), { recursive: true });
    const partial = `${full}.part`;
    const out = createWriteStream(partial);
    // The cleanup path below waits for "close" rather than reacting to errors
    // as they happen, so an error with no listener would otherwise be thrown
    // as an uncaught exception and take the process down.
    out.on("error", () => {});

    let written = 0;
    const reader = body.getReader();
    try {
      for (;;) {
        if (opts.signal?.aborted) throw new StorageError("Upload cancelled");
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        written += value.byteLength;
        // Stop the moment the limit is passed: the remaining bytes are never
        // read, so an oversized upload costs one chunk of memory, not a file.
        if (written > opts.maxBytes) throw new UploadTooLargeError(opts.maxBytes);
        if (!out.write(value)) await drained(out);
      }
      await new Promise<void>((resolve, reject) => {
        out.once("error", reject);
        out.end(() => resolve());
      });
      if (out.errored) throw out.errored;
      await rename(partial, full);
      return { key, publicUrl: null, sizeBytes: written };
    } catch (err) {
      await reader.cancel().catch(() => {});
      // Destroying is not enough to make the temporary removable. The
      // descriptor is opened ASYNCHRONOUSLY, so on an early abort the unlink
      // below can run before the open completes — the file then appears
      // afterwards and nothing ever deletes it (measured: roughly two thirds
      // of cancelled uploads left a zero-byte `.part` behind). Waiting for
      // "close" settles the open and releases the handle, which Windows also
      // requires before it will unlink at all.
      await closed(out);
      await rm(partial, { force: true }).catch(() => {});
      throw err;
    }
  }

  async read(key: string, range?: { start: number; end?: number }): Promise<ReadableStream<Uint8Array>> {
    const full = this.pathFor(key);
    const node = createReadStream(full, range ? { start: range.start, end: range.end } : undefined);
    return Readable.toWeb(node) as ReadableStream<Uint8Array>;
  }

  async readAll(key: string): Promise<Buffer> {
    return readFile(this.pathFor(key));
  }

  localPath(key: string): string {
    return this.pathFor(key);
  }

  async stat(key: string): Promise<{ sizeBytes: number } | null> {
    try {
      const s = await stat(this.pathFor(key));
      return { sizeBytes: s.size };
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }

  publicUrl(): string | null {
    return null;
  }

  /** Ensure the root exists — called once at worker startup. */
  async ensureRoot(): Promise<string> {
    await mkdir(this.root, { recursive: true });
    return this.root;
  }
}

/**
 * Wait out backpressure.
 *
 * Every listener is removed on the way out. Attaching a fresh `once("error")`
 * per backpressure pause and never taking it off leaks one listener per pause,
 * which on a large upload passes Node's ten-listener threshold and prints a
 * MaxListenersExceededWarning that looks, in production logs, exactly like a
 * real handle leak. "close" is awaited alongside the other two so a stream
 * destroyed mid-pause rejects instead of hanging until the request times out.
 */
function drained(out: NodeJS.WritableStream & { destroyed: boolean }): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const done = (fn: () => void) => () => {
      out.removeListener("drain", onDrain);
      out.removeListener("error", onError);
      out.removeListener("close", onClose);
      fn();
    };
    const onDrain = done(resolve);
    const onError = (err: Error) => done(() => reject(err))();
    const onClose = done(() => reject(new StorageError("Upload stream closed early")));
    out.on("drain", onDrain);
    out.on("error", onError);
    out.on("close", onClose);
  });
}

/** Destroy a write stream and wait until its descriptor is really released. */
function closed(out: { closed: boolean; destroy(): void; once(ev: string, fn: () => void): unknown }): Promise<void> {
  if (out.closed) return Promise.resolve();
  return new Promise<void>((resolve) => {
    out.once("close", resolve);
    out.destroy();
  });
}
