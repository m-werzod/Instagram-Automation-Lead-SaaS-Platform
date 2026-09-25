import { assertSafeKey, StorageError, UploadTooLargeError, type PutOptions, type PutResult, type PutStreamOptions, type StorageDriver } from "./index";

/**
 * Vercel Blob storage, for deployments whose web tier is serverless.
 *
 * Talks to the Blob REST API directly rather than depending on @vercel/blob, to
 * match how the rest of this codebase integrates external services (raw REST,
 * no SDK) and to keep the dependency list small. The browser uploads straight
 * to Blob using a short-lived client token, which is what makes files larger
 * than the 4.5 MB request limit possible at all.
 */

const API = "https://blob.vercel-storage.com";

/**
 * Recover the error a streamed request body actually threw.
 *
 * Only unwraps the errors this module raises deliberately — a genuine network
 * failure must stay the TypeError it is, rather than being re-labelled as
 * something a caller might treat as the client's fault.
 */
function unwrapCause(err: unknown): unknown {
  const cause = (err as { cause?: unknown } | null)?.cause;
  if (cause instanceof UploadTooLargeError || cause instanceof StorageError) return cause;
  return err;
}

function token(): string {
  const t = process.env.BLOB_READ_WRITE_TOKEN?.trim();
  if (!t) {
    throw new StorageError(
      "BLOB_READ_WRITE_TOKEN is not set. Create a Blob store in the Vercel dashboard (Storage → Blob → Create) and add its read-write token to the project environment.",
    );
  }
  return t;
}

interface BlobPutResponse {
  url: string;
  downloadUrl?: string;
  pathname: string;
  contentType?: string;
}

export class VercelBlobDriver implements StorageDriver {
  readonly name = "vercel-blob" as const;
  readonly hasNativePublicUrls = true;

  /** Blob URLs are stable per key; cached so repeated lookups cost nothing. */
  private urlCache = new Map<string, string>();

  async put(key: string, data: Buffer | Uint8Array, opts: PutOptions): Promise<PutResult> {
    assertSafeKey(key);
    const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const res = await fetch(`${API}/${encodeURI(key)}`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${token()}`,
        "x-api-version": "7",
        "x-content-type": opts.contentType,
        // Keys already carry 16 random bytes, so Blob's own suffix would only
        // make them harder to correlate with our rows.
        "x-add-random-suffix": "0",
        "cache-control": "public, max-age=31536000, immutable",
      },
      body: new Uint8Array(body),
    });
    if (!res.ok) {
      throw new StorageError(`Vercel Blob rejected the upload (${res.status}): ${(await res.text()).slice(0, 300)}`);
    }
    const json = (await res.json()) as BlobPutResponse;
    this.urlCache.set(key, json.url);
    return { key, publicUrl: json.url, sizeBytes: body.byteLength };
  }

  /**
   * Hand the body straight to fetch, counting bytes as they pass so an
   * over-long upload is cut off rather than relayed in full. `duplex: "half"`
   * is required by undici whenever a request body is a stream.
   */
  async putStream(key: string, body: ReadableStream<Uint8Array>, opts: PutStreamOptions): Promise<PutResult> {
    assertSafeKey(key);
    let written = 0;
    const counted = body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          written += chunk.byteLength;
          if (written > opts.maxBytes) throw new UploadTooLargeError(opts.maxBytes);
          controller.enqueue(chunk);
        },
      }),
    );

    const res = await fetch(`${API}/${encodeURI(key)}`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${token()}`,
        "x-api-version": "7",
        "x-content-type": opts.contentType,
        "x-add-random-suffix": "0",
        "cache-control": "public, max-age=31536000, immutable",
      },
      body: counted,
      signal: opts.signal,
      // @ts-expect-error — duplex is required for a streaming body and is not
      // in the DOM lib types Next.js ships.
      duplex: "half",
    }).catch(async (err) => {
      // A rejected count aborts the fetch; make sure no partial object survives.
      await this.delete(key).catch(() => {});
      // fetch does NOT propagate the body stream's own error: undici reports a
      // failed request body as `TypeError: fetch failed` and hides the real
      // reason on `.cause`. The upload route decides between 413 and 500 with
      // `err instanceof UploadTooLargeError`, so without this unwrapping an
      // over-long upload to Blob answered 500 while the identical upload to the
      // local driver answered 413.
      throw unwrapCause(err);
    });

    if (!res.ok) {
      await this.delete(key).catch(() => {});
      throw new StorageError(`Vercel Blob rejected the upload (${res.status}): ${(await res.text()).slice(0, 300)}`);
    }
    const json = (await res.json()) as BlobPutResponse;
    this.urlCache.set(key, json.url);
    return { key, publicUrl: json.url, sizeBytes: written };
  }

  private async resolveUrl(key: string): Promise<string> {
    assertSafeKey(key);
    const cached = this.urlCache.get(key);
    if (cached) return cached;
    const res = await fetch(`${API}/?prefix=${encodeURIComponent(key)}&limit=1`, {
      headers: { authorization: `Bearer ${token()}`, "x-api-version": "7" },
    });
    if (!res.ok) throw new StorageError(`Vercel Blob lookup failed (${res.status})`);
    const json = (await res.json()) as { blobs?: Array<{ url: string; pathname: string }> };
    const hit = json.blobs?.find((b) => b.pathname === key) ?? json.blobs?.[0];
    if (!hit) throw new StorageError("Object not found in Blob storage");
    this.urlCache.set(key, hit.url);
    return hit.url;
  }

  async read(key: string, range?: { start: number; end?: number }): Promise<ReadableStream<Uint8Array>> {
    const url = await this.resolveUrl(key);
    const headers: Record<string, string> = {};
    if (range) headers.range = `bytes=${range.start}-${range.end ?? ""}`;
    const res = await fetch(url, { headers });
    if (!res.ok || !res.body) throw new StorageError(`Blob read failed (${res.status})`);
    return res.body;
  }

  async readAll(key: string): Promise<Buffer> {
    const url = await this.resolveUrl(key);
    const res = await fetch(url);
    if (!res.ok) throw new StorageError(`Blob read failed (${res.status})`);
    return Buffer.from(await res.arrayBuffer());
  }

  /**
   * Blob has no filesystem path. FFmpeg jobs therefore download to the worker's
   * scratch directory first (see src/lib/video/workspace.ts).
   */
  localPath(): string | null {
    return null;
  }

  async stat(key: string): Promise<{ sizeBytes: number } | null> {
    try {
      const url = await this.resolveUrl(key);
      const res = await fetch(url, { method: "HEAD" });
      if (!res.ok) return null;
      const len = Number(res.headers.get("content-length"));
      return { sizeBytes: Number.isFinite(len) ? len : 0 };
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    const url = await this.resolveUrl(key).catch(() => null);
    if (!url) return;
    await fetch(`${API}/delete`, {
      method: "POST",
      headers: { authorization: `Bearer ${token()}`, "content-type": "application/json", "x-api-version": "7" },
      body: JSON.stringify({ urls: [url] }),
    });
    this.urlCache.delete(key);
  }

  publicUrl(key: string): string | null {
    return this.urlCache.get(key) ?? null;
  }

  /**
   * Mint a short-lived token the browser uses to upload one object directly.
   * This is the only way past the serverless body limit, and it means the file
   * bytes never transit our function at all.
   */
  async createClientUploadToken(key: string, contentType: string, maxBytes: number): Promise<{ token: string; url: string }> {
    assertSafeKey(key);
    const res = await fetch(`${API}/token`, {
      method: "POST",
      headers: { authorization: `Bearer ${token()}`, "content-type": "application/json", "x-api-version": "7" },
      body: JSON.stringify({
        pathname: key,
        onUploadCompleted: null,
        allowedContentTypes: [contentType],
        maximumSizeInBytes: maxBytes,
        addRandomSuffix: false,
        validUntil: Date.now() + 60 * 60_000,
      }),
    });
    if (!res.ok) {
      throw new StorageError(`Could not create a Blob upload token (${res.status}): ${(await res.text()).slice(0, 200)}`);
    }
    const json = (await res.json()) as { clientToken?: string; token?: string };
    const clientToken = json.clientToken ?? json.token;
    if (!clientToken) throw new StorageError("Blob did not return an upload token");
    return { token: clientToken, url: `${API}/${encodeURI(key)}` };
  }
}
