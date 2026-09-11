import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { route, ok, parseBody, assertSameOrigin, clientIp } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/guard";
import { audit, AuditActions } from "@/lib/audit";
import { getGlobalSettings } from "@/lib/settings";

export const GET = route(async () => {
  await requireAdmin();
  // Never ship the (encrypted) bot token to the browser — /api/settings/telegram
  // reports connection status without the secret.
  const { telegramBotToken: _telegramBotToken, ...settings } = await getGlobalSettings();
  return ok({ settings: { ...settings, telegramConfigured: Boolean(_telegramBotToken) } });
});

const updateSchema = z.object({
  masterAutomationEnabled: z.boolean().optional(),
  autoCampaignLaunchEnabled: z.boolean().optional(),
  leadAutomationWhenOff: z.boolean().optional(),
});

export const PATCH = route(async (req: NextRequest) => {
  assertSameOrigin(req);
  const auth = await requireAdmin();
  const body = await parseBody(req, updateSchema);
  const before = await getGlobalSettings();

  const settings = await prisma.globalSettings.update({ where: { id: 1 }, data: body });

  const masterChanged =
    body.masterAutomationEnabled !== undefined && body.masterAutomationEnabled !== before.masterAutomationEnabled;
  await audit({
    adminId: auth.admin.id,
    action: masterChanged
      ? settings.masterAutomationEnabled
        ? AuditActions.MASTER_SWITCH_ON
        : AuditActions.MASTER_SWITCH_OFF
      : AuditActions.CHANGED_GLOBAL_SETTINGS,
    resourceType: "global_settings",
    before: {
      masterAutomationEnabled: before.masterAutomationEnabled,
      autoCampaignLaunchEnabled: before.autoCampaignLaunchEnabled,
      leadAutomationWhenOff: before.leadAutomationWhenOff,
    },
    after: {
      masterAutomationEnabled: settings.masterAutomationEnabled,
      autoCampaignLaunchEnabled: settings.autoCampaignLaunchEnabled,
      leadAutomationWhenOff: settings.leadAutomationWhenOff,
    },
    ip: clientIp(req),
  });
  return ok({ settings });
});
