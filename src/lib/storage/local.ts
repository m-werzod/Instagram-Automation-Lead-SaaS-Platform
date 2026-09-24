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
    await mkdir(dirname(full), { recursive: true });
    const partial = `${full}.part`;
    const out = createWriteStream(partial);

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
        if (!out.write(value)) {
          await new Promise<void>((resolve, reject) => {
            out.once("drain", resolve);
            out.once("error", reject);
          });
        }
      }
      await new Promise<void>((resolve, reject) => {
        out.end(() => resolve());
        out.once("error", reject);
      });
      await rename(partial, full);
      return { key, publicUrl: null, sizeBytes: written };
    } catch (err) {
      out.destroy();
      await reader.cancel().catch(() => {});
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
