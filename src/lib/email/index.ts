import nodemailer from "nodemailer";
import type { Lead, InstagramAccount } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { emailEnv, isEmailConfigured } from "@/lib/env";
import { createLogger, errorFields } from "@/lib/logger";
import { enqueue } from "@/lib/queue";

const log = createLogger("email");

/**
 * EmailService (spec §22–23). All sends flow through the queue with retry +
 * exponential backoff; every attempt is recorded in email_events. Leads are
 * ALWAYS persisted before any email attempt — delivery failure never loses a
 * lead.
 */

export interface LeadNotificationPayload {
  leadId: string;
  accountUsername: string;
  leadName: string | null;
  phone: string | null;
  email: string | null;
  campaignName: string | null;
  contentCaption: string | null;
  answers: Array<{ question: string; answer: string }>;
  source: string;
  submittedAt: string;
}

/** Queue a lead notification (returns the email event id). */
export async function queueLeadNotification(payload: LeadNotificationPayload): Promise<string> {
  const to = emailEnvSafe()?.LEAD_NOTIFICATION_EMAIL ?? process.env.LEAD_NOTIFICATION_EMAIL ?? "";
  const event = await prisma.emailEvent.create({
    data: {
      to: to || "unconfigured",
      subject: `New Instagram Lead — ${payload.leadName ?? "Unknown"} (@${payload.accountUsername})`,
      template: "lead_notification",
      payload: payload as unknown as object,
      leadId: payload.leadId,
      status: "PENDING",
    },
  });
  await enqueue("email.send", { emailEventId: event.id }, { maxAttempts: 4 });
  return event.id;
}

function emailEnvSafe() {
  try {
    return emailEnv();
  } catch {
    return null;
  }
}

export function renderLeadNotification(p: LeadNotificationPayload): { text: string; html: string } {
  const lines = [
    "New Instagram Lead",
    "",
    `Instagram account: @${p.accountUsername}`,
    `Lead name: ${p.leadName ?? "—"}`,
    `Phone: ${p.phone ?? "—"}`,
    `Email: ${p.email ?? "—"}`,
    `Campaign: ${p.campaignName ?? "—"}`,
    `Content: ${p.contentCaption ?? "—"}`,
    "",
    "Answers:",
    ...p.answers.map((a) => `  ${a.question} → ${a.answer}`),
    "",
    `Source: ${p.source}`,
    `Timestamp: ${p.submittedAt}`,
  ];
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const rows = (label: string, value: string | null) =>
    `<tr><td style="padding:4px 12px 4px 0;color:#666">${esc(label)}</td><td style="padding:4px 0"><b>${esc(value ?? "—")}</b></td></tr>`;
  const html = `
  <div style="font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:560px">
    <h2 style="margin:0 0 12px">New Instagram Lead</h2>
    <table style="border-collapse:collapse;font-size:14px">
      ${rows("Instagram account", "@" + p.accountUsername)}
      ${rows("Lead name", p.leadName)}
      ${rows("Phone", p.phone)}
      ${rows("Email", p.email)}
      ${rows("Campaign", p.campaignName)}
      ${rows("Content", p.contentCaption)}
      ${rows("Source", p.source)}
      ${rows("Timestamp", p.submittedAt)}
    </table>
    ${
      p.answers.length > 0
        ? `<h3 style="margin:16px 0 8px">Answers</h3>
    <table style="border-collapse:collapse;font-size:14px">
      ${p.answers.map((a) => rows(a.question, a.answer)).join("\n")}
    </table>`
        : ""
    }
  </div>`;
  return { text: lines.join("\n"), html };
}

/** Actual SMTP delivery — called ONLY by the email.send job handler. */
export async function deliverEmailEvent(emailEventId: string): Promise<void> {
  const event = await prisma.emailEvent.findUnique({ where: { id: emailEventId } });
  if (!event || event.status === "SENT") return;

  if (!isEmailConfigured()) {
    await prisma.emailEvent.update({
      where: { id: event.id },
      data: { status: "FAILED", attempts: { increment: 1 }, lastError: "SMTP is not configured (see .env.example EMAIL_* vars)" },
    });
    throw new Error("SMTP not configured — set EMAIL_HOST/EMAIL_USER/EMAIL_PASSWORD in .env");
  }

  const env = emailEnv();
  const transporter = nodemailer.createTransport({
    host: env.EMAIL_HOST,
    port: env.EMAIL_PORT,
    secure: env.EMAIL_SECURE || env.EMAIL_PORT === 465,
    auth: { user: env.EMAIL_USER, pass: env.EMAIL_PASSWORD },
  });

  let text = "";
  let html: string | undefined;
  if (event.template === "lead_notification" && event.payload) {
    const rendered = renderLeadNotification(event.payload as unknown as LeadNotificationPayload);
    text = rendered.text;
    html = rendered.html;
  } else if (event.template === "admin_alert" && event.payload) {
    text = (event.payload as { text?: string }).text ?? event.subject;
  } else {
    text = event.subject;
  }

  try {
    await transporter.sendMail({
      from: env.EMAIL_FROM,
      to: event.to === "unconfigured" ? env.LEAD_NOTIFICATION_EMAIL : event.to,
      subject: event.subject,
      text,
      html,
    });
    await prisma.emailEvent.update({
      where: { id: event.id },
      data: { status: "SENT", sentAt: new Date(), attempts: { increment: 1 }, lastError: null },
    });
    if (event.leadId) {
      await prisma.leadEvent
        .create({ data: { leadId: event.leadId, type: "EMAIL_SENT", data: { to: event.to } } })
        .catch(() => undefined);
    }
    log.info("email sent", { emailEventId: event.id, template: event.template });
  } catch (err) {
    await prisma.emailEvent.update({
      where: { id: event.id },
      data: { status: "FAILED", attempts: { increment: 1 }, lastError: err instanceof Error ? err.message : String(err) },
    });
    if (event.leadId) {
      await prisma.leadEvent
        .create({ data: { leadId: event.leadId, type: "EMAIL_FAILED", data: { error: String(err) } } })
        .catch(() => undefined);
    }
    log.error("email delivery failed", { emailEventId: event.id, ...errorFields(err) });
    throw err; // queue retries with backoff
  }
}

/** Admin alert helper (automation NOTIFY_ADMIN action, system alerts). */
export async function queueAdminAlert(subject: string, text: string): Promise<void> {
  const to = emailEnvSafe()?.LEAD_NOTIFICATION_EMAIL ?? process.env.LEAD_NOTIFICATION_EMAIL ?? "unconfigured";
  const event = await prisma.emailEvent.create({
    data: { to, subject, template: "admin_alert", payload: { text }, status: "PENDING" },
  });
  await enqueue("email.send", { emailEventId: event.id }, { maxAttempts: 3 });
}

/** Build the full notification payload for a lead and queue it. */
export async function notifyLeadSubmitted(lead: Lead, account: InstagramAccount): Promise<void> {
  const [campaign, content] = await Promise.all([
    lead.campaignId ? prisma.campaign.findUnique({ where: { id: lead.campaignId } }) : null,
    lead.contentId ? prisma.contentItem.findUnique({ where: { id: lead.contentId } }) : null,
  ]);
  const answers = Array.isArray(lead.answers) ? (lead.answers as Array<{ question: string; answer: string }>) : [];
  await queueLeadNotification({
    leadId: lead.id,
    accountUsername: account.username,
    leadName: lead.name,
    phone: lead.phone,
    email: lead.email,
    campaignName: campaign?.name ?? null,
    contentCaption: content?.caption?.slice(0, 120) ?? null,
    answers,
    source: lead.source,
    submittedAt: lead.createdAt.toISOString(),
  });
}
