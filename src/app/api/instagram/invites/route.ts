import { NextRequest } from "next/server";
import { z } from "zod";
import { route, ok, parseBody, assertSameOrigin, clientIp } from "@/lib/api";
import { requireStaff } from "@/lib/auth/guard";
import { createInvite, listInvites, INVITE_TTL_HOURS_DEFAULT, INVITE_TTL_HOURS_MAX } from "@/lib/meta/invites";
import { isInstagramLoginConfigured, isMetaConfigured } from "@/lib/env";
import { AppError } from "@/lib/errors";
import { audit } from "@/lib/audit";

export const GET = route(async () => {
  await requireStaff();
  return ok({ invites: await listInvites() });
});

const createSchema = z.object({
  label: z.string().max(120).optional(),
  ttlHours: z.number().int().min(1).max(INVITE_TTL_HOURS_MAX).optional(),
});

/**
 * Mint a connect link for the owner of an Instagram account to follow.
 *
 * The raw token is returned exactly once, here — it is stored hashed, so there
 * is deliberately no way to read it back later. The UI has to show it
 * immediately, and a lost link is replaced by issuing a new one.
 */
export const POST = route(async (req: NextRequest) => {
  assertSameOrigin(req);
  const auth = await requireStaff();

  // Refuse to hand out a link that is guaranteed to dead-end on the owner's
  // phone — that wastes their time and looks broken from outside.
  if (!isMetaConfigured() || !isInstagramLoginConfigured()) {
    throw new AppError("VALIDATION", "Finish the Meta app setup before inviting an account owner", {
      reason: "Without the Instagram app credentials the link cannot reach Instagram's authorization screen.",
      fix: "Complete the setup steps on the Instagram page, then create the link.",
    });
  }

  const body = await parseBody(req, createSchema);
  const { invite, url } = await createInvite({
    adminId: auth.admin.id,
    label: body.label ?? null,
    ttlHours: body.ttlHours ?? INVITE_TTL_HOURS_DEFAULT,
  });

  await audit({
    adminId: auth.admin.id,
    action: "CREATED_CONNECT_INVITE",
    resourceType: "connect_invite",
    resourceId: invite.id,
    // the token itself is never audited — the log would become a credential store
    after: { label: invite.label, expiresAt: invite.expiresAt.toISOString() },
    ip: clientIp(req),
  });

  return ok({ url, invite: { id: invite.id, label: invite.label, expiresAt: invite.expiresAt.toISOString() } });
});
