import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { route, ok, assertSameOrigin, clientIp } from "@/lib/api";
import { requireStaff } from "@/lib/auth/guard";
import { audit, AuditActions } from "@/lib/audit";
import { deliverEmailEvent } from "@/lib/email";
import { emailEnv } from "@/lib/env";

/** Send a real test email synchronously so the admin gets immediate feedback. */
export const POST = route(async (req: NextRequest) => {
  assertSameOrigin(req);
  const auth = await requireStaff();
  const env = emailEnv(); // throws CONFIG_MISSING with fix instructions if unset

  const event = await prisma.emailEvent.create({
    data: {
      to: env.LEAD_NOTIFICATION_EMAIL,
      subject: "Test email — Instagram Automation Platform",
      template: "admin_alert",
      payload: { text: `Test message sent by ${auth.admin.email} at ${new Date().toISOString()}.\nSMTP configuration is working.` },
      status: "PENDING",
    },
  });

  await deliverEmailEvent(event.id); // throws with details on SMTP failure
  await audit({ adminId: auth.admin.id, action: AuditActions.SENT_TEST_EMAIL, ip: clientIp(req) });
  return ok({ sent: true, to: env.LEAD_NOTIFICATION_EMAIL });
});
