import { mkdtemp, rm, writeFile, stat } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { getStorage, type StorageDriver } from "@/lib/storage";
import { createLogger, errorFields } from "@/lib/logger";

const log = createLogger("video.workspace");

/**
 * Scratch space for one render.
 *
 * FFmpeg works on files, so every job gets a private temporary directory that
 * is removed when the job ends — including when it fails or is cancelled. A
 * render that leaks its working files fills the worker's disk and takes the
 * next render down with it, so cleanup is unconditional rather than best-effort.
 *
 * With the local storage driver, inputs are read straight from their stored
 * path (no copy). With Blob they are downloaded here first, because FFmpeg
 * cannot seek an HTTP body reliably enough for editing.
 */
export class Workspace {
  private dir: string | null = null;
  private storage: StorageDriver | null = null;

  async open(): Promise<string> {
    if (this.dir) return this.dir;
    this.dir = await mkdtemp(join(tmpdir(), "igvideo-"));
    return this.dir;
  }

  private async driver(): Promise<StorageDriver> {
    if (!this.storage) this.storage = await getStorage();
    return this.storage;
  }

  /**
   * The scratch directory itself. Used as FFmpeg's working directory so a
   * generated file can be named inside a filtergraph by its bare filename —
   * see RunOptions.cwd for why an absolute path is not always expressible.
   */
  directory(): string {
    if (!this.dir) throw new Error("Workspace is not open");
    return this.dir;
  }

  path(name: string): string {
    if (!this.dir) throw new Error("Workspace is not open");
    // Names are produced by this module, never by a user; the sanitiser is a
    // belt-and-braces guard for future callers.
    return join(this.dir, name.replace(/[^A-Za-z0-9._-]/g, "_"));
  }

  /**
   * Make a stored object available as a local file. Returns the path FFmpeg
   * should read.
   */
  async materialize(storageKey: string, localName: string, signal?: AbortSignal): Promise<string> {
    const driver = await this.driver();
    const direct = driver.localPath(storageKey);
    if (direct) {
      const exists = await stat(direct).then(() => true).catch(() => false);
      if (!exists) throw new Error(`Stored file is missing: ${storageKey}`);
      return direct;
    }

    await this.open();
    const target = this.path(localName);
    const stream = await driver.read(storageKey);
    await pipeline(Readable.fromWeb(stream as never), createWriteStream(target), { signal });
    return target;
  }

  /** Write a small generated file (subtitles, a plan) into the workspace. */
  async writeFile(name: string, content: string | Buffer): Promise<string> {
    await this.open();
    const target = this.path(name);
    await writeFile(target, content);
    return target;
  }

  /** Remove everything. Never throws — cleanup failure must not fail a job. */
  async dispose(): Promise<void> {
    if (!this.dir) return;
    try {
      await rm(this.dir, { recursive: true, force: true });
    } catch (err) {
      log.warn("workspace cleanup failed", { dir: this.dir, ...errorFields(err) });
    } finally {
      this.dir = null;
    }
  }
}

/** Run `fn` with a workspace that is always cleaned up afterwards. */
export async function withWorkspace<T>(fn: (ws: Workspace) => Promise<T>): Promise<T> {
  const ws = new Workspace();
  try {
    await ws.open();
    return await fn(ws);
  } finally {
    await ws.dispose();
  }
}
