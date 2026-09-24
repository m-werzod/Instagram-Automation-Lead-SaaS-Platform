/**
 * HTTP Range parsing for the media routes.
 *
 * Shared rather than inlined per route because the interesting forms are the
 * ones that are easy to get subtly wrong: `bytes=-500` asks for the LAST 500
 * bytes, not the first 500, and a player that uses it (Meta's fetcher and
 * Safari both do) receives corrupt media if the server answers with the head of
 * the file while labelling it as the tail.
 */

export interface ByteRange {
  start: number;
  /** Inclusive, as in the Range/Content-Range headers themselves. */
  end: number;
}

export type RangeParse =
  /** Serve 206 with this range. */
  | { kind: "ok"; range: ByteRange }
  /** Serve 416 with `Content-Range: bytes * /total`. */
  | { kind: "unsatisfiable" }
  /** No usable range asked for — serve the whole object with 200. */
  | { kind: "ignore" };

const SINGLE_SPEC = /^(\d*)-(\d*)$/;

/**
 * Parse a Range header against a known object size.
 *
 * Malformed and unsupported forms resolve to "ignore" rather than an error:
 * RFC 9110 says a recipient that cannot satisfy a range specification may
 * simply respond with the whole representation, and that is far friendlier to a
 * publishing fetch than a 4xx.
 */
export function parseByteRange(header: string | null | undefined, totalBytes: number): RangeParse {
  if (!header) return { kind: "ignore" };

  const unit = /^\s*bytes\s*=\s*(.+)$/i.exec(header);
  if (!unit) return { kind: "ignore" };

  const specs = unit[1]!.split(",");
  // Several ranges at once would need a multipart/byteranges body; answering
  // with the whole object is the allowed alternative, and never wrong.
  if (specs.length !== 1) return { kind: "ignore" };

  const parts = SINGLE_SPEC.exec(specs[0]!.trim());
  if (!parts) return { kind: "ignore" };

  const firstRaw = parts[1]!;
  const lastRaw = parts[2]!;
  if (!firstRaw && !lastRaw) return { kind: "ignore" };

  if (!Number.isFinite(totalBytes) || totalBytes <= 0) return { kind: "unsatisfiable" };

  if (!firstRaw) {
    // Suffix form: the last N bytes.
    const suffix = Number(lastRaw);
    if (!Number.isFinite(suffix)) return { kind: "ignore" };
    if (suffix <= 0) return { kind: "unsatisfiable" };
    return { kind: "ok", range: { start: Math.max(0, totalBytes - suffix), end: totalBytes - 1 } };
  }

  const start = Number(firstRaw);
  if (!Number.isFinite(start)) return { kind: "ignore" };
  if (start >= totalBytes) return { kind: "unsatisfiable" };

  // Open-ended form: from `start` to the end of the object.
  if (!lastRaw) return { kind: "ok", range: { start, end: totalBytes - 1 } };

  const end = Number(lastRaw);
  if (!Number.isFinite(end)) return { kind: "ignore" };
  if (end < start) return { kind: "ignore" };
  return { kind: "ok", range: { start, end: Math.min(end, totalBytes - 1) } };
}
