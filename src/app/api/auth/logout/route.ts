import { NextRequest, NextResponse } from "next/server";
import { route, assertSameOrigin, clientIp } from "@/lib/api";
import { getAuth, revokeSession, SESSION_COOKIE } from "@/lib/auth/session";
import { audit, AuditActions } from "@/lib/audit";

export const POST = route(async (req: NextRequest) => {
  assertSameOrigin(req);
  const auth = await getAuth();
  if (auth) {
    await revokeSession(auth.session.id);
    await audit({ adminId: auth.admin.id, action: AuditActions.LOGOUT, ip: clientIp(req) });
  }
  const res = NextResponse.json({ ok: true, data: null });
  res.cookies.set(SESSION_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
  return res;
});
