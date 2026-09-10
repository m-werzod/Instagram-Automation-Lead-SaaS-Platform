"use client";

import { toast } from "sonner";

/**
 * Client-side API helper. Every response follows the {ok, data|error}
 * envelope from src/lib/api.ts. Errors surface the what/why/fix triple.
 */

export interface ApiErrorShape {
  code: string;
  message: string;
  reason?: string;
  fix?: string;
  details?: unknown;
}

export class ApiError extends Error {
  readonly shape: ApiErrorShape;
  constructor(shape: ApiErrorShape) {
    super(shape.message);
    this.shape = shape;
  }
}

export async function api<T = unknown>(
  path: string,
  init: RequestInit & { json?: unknown; silent?: boolean } = {},
): Promise<T> {
  const { json, silent, ...rest } = init;
  const res = await fetch(path, {
    ...rest,
    headers: {
      ...(json !== undefined ? { "Content-Type": "application/json" } : {}),
      ...rest.headers,
    },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
    credentials: "same-origin",
  });

  let body: { ok?: boolean; data?: T; error?: ApiErrorShape } = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    /* non-JSON */
  }

  if (!res.ok || body.ok === false) {
    const shape: ApiErrorShape = body.error ?? { code: "HTTP_" + res.status, message: `Request failed (${res.status})` };
    if (res.status === 401 && typeof window !== "undefined" && !path.startsWith("/api/auth")) {
      window.location.href = "/login";
    }
    if (!silent) {
      toast.error(shape.message, {
        description: [shape.reason, shape.fix].filter(Boolean).join(" — ") || undefined,
        duration: 6000,
      });
    }
    throw new ApiError(shape);
  }
  return body.data as T;
}
