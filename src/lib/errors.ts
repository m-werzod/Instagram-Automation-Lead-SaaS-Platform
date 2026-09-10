/**
 * Central error taxonomy. Every admin-facing error carries:
 *   what happened / why / how to fix it  (spec §39)
 * Raw exceptions never reach the UI — src/lib/api.ts maps them.
 */

export type ErrorCode =
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "VALIDATION"
  | "RATE_LIMITED"
  | "CONFLICT"
  | "CONFIG_MISSING"
  | "META_AUTH_FAILED"
  | "META_PERMISSION_MISSING"
  | "META_TOKEN_EXPIRED"
  | "META_RATE_LIMITED"
  | "META_UNSUPPORTED"
  | "META_API_ERROR"
  | "WEBHOOK_INVALID"
  | "AI_PROVIDER_ERROR"
  | "EMAIL_DELIVERY_FAILED"
  | "AUTOMATION_DISABLED"
  | "INTERNAL";

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  /** why it happened */
  readonly reason?: string;
  /** how the admin can fix it */
  readonly fix?: string;
  readonly details?: unknown;

  constructor(
    code: ErrorCode,
    message: string,
    opts: { status?: number; reason?: string; fix?: string; details?: unknown } = {},
  ) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = opts.status ?? defaultStatus(code);
    this.reason = opts.reason;
    this.fix = opts.fix;
    this.details = opts.details;
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      reason: this.reason,
      fix: this.fix,
      ...(this.details !== undefined ? { details: this.details } : {}),
    };
  }
}

function defaultStatus(code: ErrorCode): number {
  switch (code) {
    case "UNAUTHORIZED":
      return 401;
    case "FORBIDDEN":
      return 403;
    case "NOT_FOUND":
      return 404;
    case "VALIDATION":
      return 400;
    case "RATE_LIMITED":
    case "META_RATE_LIMITED":
      return 429;
    case "CONFLICT":
      return 409;
    case "CONFIG_MISSING":
      return 503;
    case "META_TOKEN_EXPIRED":
    case "META_AUTH_FAILED":
      return 401;
    case "META_PERMISSION_MISSING":
      return 403;
    case "META_UNSUPPORTED":
      return 422;
    case "WEBHOOK_INVALID":
      return 401;
    default:
      return 500;
  }
}

// Common constructors ------------------------------------------------------

export const unauthorized = (msg = "Authentication required") =>
  new AppError("UNAUTHORIZED", msg, { fix: "Log in again." });

export const forbidden = (msg = "You do not have permission to do this") =>
  new AppError("FORBIDDEN", msg, { reason: "Your admin role does not allow this action." });

export const notFound = (what = "Resource") => new AppError("NOT_FOUND", `${what} not found`);

export const validationError = (message: string, details?: unknown) =>
  new AppError("VALIDATION", message, { details });

export const tokenExpired = () =>
  new AppError("META_TOKEN_EXPIRED", "Instagram access token expired or was revoked", {
    reason: "Long-lived Meta tokens last ~60 days and can be invalidated by password changes or permission removal.",
    fix: "Open Settings → Integrations → Instagram and click Reconnect.",
  });

export const metaPermissionMissing = (permission: string) =>
  new AppError("META_PERMISSION_MISSING", `Missing Meta permission: ${permission}`, {
    reason: "The permission was not granted during authorization or was revoked.",
    fix: "Reconnect the Instagram account and approve all requested permissions.",
  });

export const metaUnsupported = (feature: string, reason: string, fix?: string) =>
  new AppError("META_UNSUPPORTED", `${feature} is not available for this account`, {
    reason,
    fix: fix ?? "See docs/META_API.md for what this account type / connection mode supports.",
  });
