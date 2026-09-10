import { prisma } from "@/lib/prisma";
import type { GlobalSettings } from "@prisma/client";

/**
 * Global switches (single row, id=1).
 * masterAutomationEnabled — spec §37 emergency switch: when OFF the worker
 * sends no automated outbound messages, runs no outgoing automations, and
 * campaign automation halts. Lead capture may continue if
 * leadAutomationWhenOff is true.
 */

export async function getGlobalSettings(): Promise<GlobalSettings> {
  const existing = await prisma.globalSettings.findUnique({ where: { id: 1 } });
  if (existing) return existing;
  return prisma.globalSettings.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });
}

export async function isMasterAutomationOn(): Promise<boolean> {
  return (await getGlobalSettings()).masterAutomationEnabled;
}
