import { metaEnv } from "@/lib/env";
import { hmacSha256 } from "@/lib/crypto";
import { AppError } from "@/lib/errors";
import { createLogger } from "@/lib/logger";

const log = createLogger("meta.client");

/**
 * Single low-level Graph API client. EVERY Meta call in this codebase goes
 * through graphCall() — endpoints are never fetch()ed ad hoc, so version,
 * error mapping and rate-limit handling stay in one place.
 *
 * Hosts:
 *  - graph.instagram.com  → Instagram API with Instagram Login (mode A)
 *  - graph.facebook.com   → Facebook Login mode (pages, marketing API)
 */

export type GraphHost = "graph.instagram.com" | "graph.facebook.com";

export interface MetaErrorBody {
  message: string;
  type?: string;
  code?: number;
  error_subcode?: number;
  fbtrace_id?: string;
  error_user_title?: string;
  error_user_msg?: string;
}

export class MetaApiError extends AppError {
  readonly metaCode?: number;
  readonly metaSubcode?: number;
  readonly fbtraceId?: string;

  constructor(meta: MetaErrorBody, httpStatus: number) {
    const mapped = mapMetaError(meta, httpStatus);
    super(mapped.code, mapped.message, { status: mapped.status, reason: mapped.reason, fix: mapped.fix });
    this.name = "MetaApiError";
    this.metaCode = meta.code;
    this.metaSubcode = meta.error_subcode;
    this.fbtraceId = meta.fbtrace_id;
  }

  /** Outside the 24h messaging window (subcode 2018278) or similar policy block. */
  get isMessagingWindowClosed(): boolean {
    return this.metaSubcode === 2018278 || this.metaSubcode === 2534022;
  }
  get isTokenError(): boolean {
    return this.metaCode === 190;
  }
  get isRateLimit(): boolean {
    return this.metaCode !== undefined && [4, 17, 32, 613, 80001, 80002, 80004, 80005, 80006].includes(this.metaCode);
  }
}

function mapMetaError(meta: MetaErrorBody, httpStatus: number) {
  const base = meta.error_user_msg || meta.message || "Meta API error";
  if (meta.code === 190) {
    return {
      code: "META_TOKEN_EXPIRED" as const,
      status: 401,
      message: "Instagram access token expired or invalid",
      reason: base,
      fix: "Reconnect the account in Settings → Integrations → Instagram.",
    };
  }
  if (meta.code !== undefined && [4, 17, 32, 613, 80001, 80002, 80004, 80005, 80006].includes(meta.code)) {
    return {
      code: "META_RATE_LIMITED" as const,
      status: 429,
      message: "Meta API rate limit reached",
      reason: base,
      fix: "The system backs off automatically; retry in a few minutes.",
    };
  }
  if (meta.code === 10 || (meta.code !== undefined && meta.code >= 200 && meta.code <= 299)) {
    return {
      code: "META_PERMISSION_MISSING" as const,
      status: 403,
      message: "Missing Meta permission for this operation",
      reason: base,
      fix: "Reconnect the account approving all permissions, or check app review status for this permission.",
    };
  }
  return {
    code: "META_API_ERROR" as const,
    status: httpStatus >= 400 && httpStatus < 600 ? httpStatus : 502,
    message: base,
    reason: meta.type ? `${meta.type} (code ${meta.code ?? "?"}${meta.error_subcode ? `/${meta.error_subcode}` : ""})` : undefined,
    fix: "See docs/META_API.md §12; the fbtrace_id can be used with Meta support.",
  };
}

export interface GraphCallOptions {
  host: GraphHost;
  method?: "GET" | "POST" | "DELETE";
  /** path WITHOUT version prefix, e.g. "me/messages" or "act_123/campaigns" */
  path: string;
  accessToken: string;
  /** query params (GET) — values are stringified; objects JSON-stringified */
  params?: Record<string, unknown>;
  /** form body (POST) — same stringification rules */
  body?: Record<string, unknown>;
  /** omit version prefix (oauth endpoints on api.instagram.com style hosts) */
  noVersion?: boolean;
}

function stringifyParams(input: Record<string, unknown>): URLSearchParams {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined || v === null) continue;
    sp.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
  }
  return sp;
}

/** Structured result of X-App-Usage style headers (observability). */
export interface GraphUsage {
  appUsage?: string;
  bucUsage?: string;
}

export async function graphCall<T = Record<string, unknown>>(opts: GraphCallOptions): Promise<T> {
  const { host, method = "GET", path, accessToken, params, body, noVersion } = opts;
  const version = metaEnv().META_GRAPH_VERSION;
  const url = new URL(`https://${host}/${noVersion ? "" : version + "/"}${path.replace(/^\//, "")}`);

  const query = stringifyParams(params ?? {});
  query.set("access_token", accessToken);
  // appsecret_proof is supported/required on graph.facebook.com server calls only.
  if (host === "graph.facebook.com") {
    query.set("appsecret_proof", hmacSha256(metaEnv().META_APP_SECRET, accessToken));
  }
  url.search = query.toString();

  const init: RequestInit = { method };
  if (method === "POST" && body) {
    init.headers = { "Content-Type": "application/x-www-form-urlencoded" };
    init.body = stringifyParams(body).toString();
  }

  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    log.error("network error calling Meta", { host, path, error: String(err) });
    throw new AppError("META_API_ERROR", "Could not reach the Meta API", {
      reason: "Network error between this server and Meta.",
      fix: "Check server internet connectivity / firewall and retry.",
    });
  }

  const text = await res.text();
  let json: Record<string, unknown>;
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    throw new AppError("META_API_ERROR", `Meta returned a non-JSON response (HTTP ${res.status})`, {
      reason: text.slice(0, 200),
    });
  }

  log.debug("graph call", {
    host,
    path,
    method,
    status: res.status,
    ms: Date.now() - started,
    appUsage: res.headers.get("x-app-usage") ?? undefined,
  });

  if (!res.ok || json.error) {
    const errBody = (json.error ?? { message: `HTTP ${res.status}` }) as MetaErrorBody;
    throw new MetaApiError(errBody, res.status);
  }
  return json as T;
}

/** Paginate a Graph edge (data/paging.next) up to maxItems. */
export async function graphCallPaged<TItem>(
  opts: GraphCallOptions,
  maxItems: number,
): Promise<TItem[]> {
  const items: TItem[] = [];
  let page = await graphCall<{ data?: TItem[]; paging?: { next?: string } }>(opts);
  while (true) {
    if (Array.isArray(page.data)) items.push(...page.data);
    if (items.length >= maxItems || !page.paging?.next) break;
    const nextUrl = page.paging.next;
    const res = await fetch(nextUrl);
    const json = (await res.json()) as { data?: TItem[]; paging?: { next?: string }; error?: MetaErrorBody };
    if (!res.ok || json.error) {
      throw new MetaApiError(json.error ?? { message: `HTTP ${res.status}` }, res.status);
    }
    page = json;
  }
  return items.slice(0, maxItems);
}
