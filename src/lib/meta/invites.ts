import type { ConnectInvite } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { coreEnv } from "@/lib/env";
import { hashSessionToken, randomToken } from "@/lib/crypto";
import { AppError } from "@/lib/errors";

/**
 * Connect invitations — how an Instagram account that belongs to SOMEONE ELSE
 * gets attached to this platform.
 *
 * Instagram has no "request access to @handle" API, and never will: the only
 * party that can grant access is the person holding the account, typing their
 * password on instagram.com. There is no server-to-server way to ask. So the
 * platform does the one thing that is possible — it mints a link for the admin
 * to send, and the account owner completes the standard Instagram
 * authorization on their own device.
 *
 * The link is a bearer credential, so it is deliberately the weakest one the
 * flow allows:
 *   · single use — consumed the moment it produces an account
 *   · expiring — hours, not forever
 *   · revocable — the admin can kill it before it is used
 *   · scoped to one capability — attaching an Instagram account. It is not a
 *     session: it cannot read leads, messages, settings or anything else
 *   · stored hashed — the raw token exists only in the link that was handed
 *     out, so a database leak cannot be replayed
 */

/** Long enough for a client to get round to it, short enough to not linger. */
export const INVITE_TTL_HOURS_DEFAULT = 72;
export const INVITE_TTL_HOURS_MAX = 24 * 14;

export interface InviteView {
  id: string;
  label: string | null;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  revokedAt: string | null;
  status: "PENDING" | "USED" | "EXPIRED" | "REVOKED";
  createdBy: string | null;
  account: { id: string; username: string } | null;
}

export function inviteStatus(invite: ConnectInvite): InviteView["status"] {
  if (invite.revokedAt) return "REVOKED";
  if (invite.usedAt) return "USED";
  if (invite.expiresAt.getTime() <= Date.now()) return "EXPIRED";
  return "PENDING";
}

export function inviteUrl(token: string): string {
  return `${coreEnv().APP_URL}/connect/${token}`;
}

/**
 * Mint an invite. The raw token is returned ONCE — it is never recoverable
 * afterwards, by design, so the UI has to show the link immediately.
 */
export async function createInvite(opts: {
  adminId: string;
  label?: string | null;
  ttlHours?: number;
}): Promise<{ invite: ConnectInvite; token: string; url: string }> {
  const ttl = Math.min(Math.max(opts.ttlHours ?? INVITE_TTL_HOURS_DEFAULT, 1), INVITE_TTL_HOURS_MAX);
  const token = randomToken(32);

  const invite = await prisma.connectInvite.create({
    data: {
      tokenHash: hashSessionToken(token),
      label: opts.label?.trim() ? opts.label.trim().slice(0, 120) : null,
      createdById: opts.adminId,
      expiresAt: new Date(Date.now() + ttl * 3600 * 1000),
    },
  });

  return { invite, token, url: inviteUrl(token) };
}

/** Why an invite cannot be used — a code the UI can translate, not a message. */
export type InviteRejection = "unknown" | "revoked" | "used" | "expired";

export type InviteCheck =
  | { ok: true; invite: ConnectInvite }
  | { ok: false; reason: InviteRejection };

/**
 * Look up an invite by its raw token and report whether it is still usable.
 *
 * Non-throwing, and the rejection is a CODE rather than a sentence, because the
 * person hitting this is usually not the admin — it is a client who was sent a
 * link, reading it in their own language, and "invalid link" tells them nothing
 * about whether to ask for a new one.
 */
export async function checkInviteToken(token: string): Promise<InviteCheck> {
  if (!token || token.length < 20) return { ok: false, reason: "unknown" };
  const invite = await prisma.connectInvite.findUnique({ where: { tokenHash: hashSessionToken(token) } });
  if (!invite) return { ok: false, reason: "unknown" };
  return checkInvite(invite);
}

/** Same checks, for a row already in hand (the OAuth callback holds the id). */
export function checkInvite(invite: ConnectInvite): InviteCheck {
  switch (inviteStatus(invite)) {
    case "REVOKED":
      return { ok: false, reason: "revoked" };
    case "USED":
      return { ok: false, reason: "used" };
    case "EXPIRED":
      return { ok: false, reason: "expired" };
    default:
      return { ok: true, invite };
  }
}

const REJECTION_ERRORS: Record<InviteRejection, AppError> = {
  unknown: new AppError("NOT_FOUND", "This connection link is not valid", {
    reason: "No invitation matches this link.",
    fix: "Ask for a new link.",
  }),
  revoked: new AppError("FORBIDDEN", "This connection link was cancelled", {
    reason: "An administrator revoked the invitation.",
    fix: "Ask for a new link.",
  }),
  used: new AppError("FORBIDDEN", "This connection link has already been used", {
    reason: "Each invitation connects exactly one Instagram account, once.",
    fix: "Ask for a new link if another account needs connecting.",
  }),
  expired: new AppError("FORBIDDEN", "This connection link has expired", {
    reason: "Invitations are short-lived on purpose.",
    fix: "Ask for a new link.",
  }),
};

/** Throwing wrapper, for callers that want the standard API error shape. */
export async function requireUsableInvite(token: string): Promise<ConnectInvite> {
  const check = await checkInviteToken(token);
  if (!check.ok) throw REJECTION_ERRORS[check.reason];
  return check.invite;
}

/**
 * Consume the invite. Conditional on it still being unused so two authorizations
 * racing the same link cannot both win — the second finds 0 rows updated.
 */
export async function markInviteUsed(inviteId: string, accountId: string): Promise<boolean> {
  const res = await prisma.connectInvite.updateMany({
    where: { id: inviteId, usedAt: null, revokedAt: null },
    data: { usedAt: new Date(), accountId },
  });
  return res.count === 1;
}

export async function revokeInvite(inviteId: string): Promise<void> {
  await prisma.connectInvite.updateMany({
    where: { id: inviteId, usedAt: null, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export async function listInvites(limit = 25): Promise<InviteView[]> {
  const rows = await prisma.connectInvite.findMany({
    orderBy: { createdAt: "desc" },
    take: limit,
    include: {
      createdBy: { select: { name: true } },
      account: { select: { id: true, username: true } },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    label: r.label,
    createdAt: r.createdAt.toISOString(),
    expiresAt: r.expiresAt.toISOString(),
    usedAt: r.usedAt?.toISOString() ?? null,
    revokedAt: r.revokedAt?.toISOString() ?? null,
    status: inviteStatus(r),
    createdBy: r.createdBy?.name ?? null,
    account: r.account ? { id: r.account.id, username: r.account.username } : null,
    // the token is intentionally absent — it is unrecoverable after creation
  }));
}
