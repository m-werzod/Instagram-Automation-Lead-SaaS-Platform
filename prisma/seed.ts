import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { randomBytes } from "crypto";

/**
 * Development seed (spec §44). Everything demo-created is marked isDemo=true
 * and username-prefixed "demo_" — it can never be mistaken for production
 * data, never calls Meta, and never sends real DMs.
 *
 * Bootstrap admin comes from ADMIN_EMAIL / ADMIN_PASSWORD; if no password is
 * set, a one-time password is generated and printed ONCE to stdout.
 */

const prisma = new PrismaClient();

async function main() {
  // ---- global settings row ----
  await prisma.globalSettings.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });

  // ---- bootstrap OWNER admin ----
  const email = (process.env.ADMIN_EMAIL ?? "admin@example.com").toLowerCase();
  let password = process.env.ADMIN_PASSWORD ?? "";
  let generated = false;
  if (!password) {
    password = randomBytes(9).toString("base64url") + "A1"; // meets policy
    generated = true;
  }
  const existingAdmin = await prisma.admin.findUnique({ where: { email } });
  if (!existingAdmin) {
    await prisma.admin.create({
      data: { email, name: "Owner", passwordHash: await bcrypt.hash(password, 12), role: "OWNER" },
    });
    console.log(`\n✔ OWNER admin created: ${email}`);
    if (generated) {
      console.log(`  One-time password (change it after login): ${password}\n`);
    } else {
      console.log("  Password: from ADMIN_PASSWORD env var\n");
    }
  } else {
    console.log(`✔ Admin ${email} already exists — skipping (password unchanged)`);
  }

  // ---- demo Instagram account (clearly marked, never contacts Meta) ----
  const demo = await prisma.instagramAccount.upsert({
    where: { igUserId: "demo-0000000001" },
    update: {},
    create: {
      igUserId: "demo-0000000001",
      username: "demo_driving_school",
      name: "DEMO — Driving School",
      accountType: "BUSINESS",
      connectionMode: "INSTAGRAM_LOGIN",
      status: "CONNECTED",
      followersCount: 12800,
      mediaCount: 4,
      isDemo: true,
      webhookSubscribed: false,
    },
  });

  const demoExists = await prisma.contentItem.findFirst({ where: { accountId: demo.id } });
  if (demoExists) {
    console.log("✔ Demo data already present — done.");
    return;
  }

  // ---- demo content ----
  const reel = await prisma.contentItem.create({
    data: {
      accountId: demo.id,
      mediaId: "demo-media-reel-1",
      mediaType: "VIDEO",
      mediaProductType: "REELS",
      caption:
        "DEMO · 🚗 Haydovchilik kursiga yozilish boshlandi! Namangan filialimizda yangi guruhlar. Narxlar va jadval uchun DM yozing — \"kurs\" deb yozing! #demo",
      permalink: "https://instagram.com/p/demo",
      timestamp: new Date(Date.now() - 3 * 86400_000),
      likeCount: 431,
      commentsCount: 57,
      isDemo: true,
    },
  });
  await prisma.contentItem.create({
    data: {
      accountId: demo.id,
      mediaId: "demo-media-post-1",
      mediaType: "IMAGE",
      mediaProductType: "FEED",
      caption: "DEMO · Our instructors. Sign up for September groups!",
      timestamp: new Date(Date.now() - 9 * 86400_000),
      likeCount: 120,
      commentsCount: 8,
      isDemo: true,
    },
  });

  // ---- demo lead flow ----
  const flow = await prisma.leadFlow.create({
    data: {
      accountId: demo.id,
      name: "Driving Course Registration (demo)",
      description: "Sequential DM registration used by the demo agent.",
      triggerKeywords: ["kurs", "sign up", "register", "ro'yxat"],
      completionMessage: "Rahmat! Ma'lumotlaringiz qabul qilindi — tez orada operatorimiz bog'lanadi. ✅ (demo)",
      isDemo: true,
      questions: {
        create: [
          { order: 1, title: "Full Name", prompt: "Ismingiz va familiyangizni yozing:", type: "TEXT", mapTo: "name" },
          { order: 2, title: "Phone", prompt: "Telefon raqamingizni yuboring (masalan +998901234567):", type: "PHONE", mapTo: "phone" },
          {
            order: 3,
            title: "Course",
            prompt: "Qaysi toifadagi kursga yozilmoqchisiz?",
            type: "SINGLE_SELECT",
            options: ["B toifa", "BC toifa", "A toifa"],
          },
          {
            order: 4,
            title: "Branch",
            prompt: "Qaysi filial qulay?",
            type: "SINGLE_SELECT",
            options: ["Namangan markaz", "Davlatobod", "Kosonsoy"],
          },
          {
            order: 5,
            title: "Schedule",
            prompt: "Qaysi vaqt qulay?",
            type: "SINGLE_SELECT",
            options: ["Ertalab", "Kunduzi", "Kechqurun"],
          },
          { order: 6, title: "Extra", prompt: "Qo'shimcha savolingiz bormi? (ixtiyoriy — \"yo'q\" deb yozsangiz ham bo'ladi)", type: "TEXT", required: false },
        ],
      },
    },
  });

  // ---- demo agent (disabled by default; needs an AI key to run anyway) ----
  await prisma.aIAgent.create({
    data: {
      accountId: demo.id,
      name: "Instagram Sales Agent (demo)",
      description: "Demo sales agent for the driving school scenario.",
      enabled: false,
      provider: "ANTHROPIC",
      model: "claude-sonnet-4-5",
      language: "Uzbek",
      tone: "Professional + conversational",
      systemPrompt:
        "You are the Instagram sales assistant of a driving school in Namangan, Uzbekistan. Help users with course questions and guide interested users to registration. Be brief, warm and concrete.",
      businessContext:
        "DEMO DATA. Courses: B category — 1,200,000 UZS (6 weeks); BC — 1,800,000 UZS (9 weeks); A — 900,000 UZS. Branches: Namangan center (Uychi street 12), Davlatobod, Kosonsoy. Groups start on the 1st and 15th of each month. Morning/day/evening schedules. Discounts: 10% for students.",
      salesStrategy: "Answer the question first, then offer registration. If the user shows intent, call start_lead_flow.",
      conversationRules: "Reply in the user's language (Uzbek/Russian). Never invent prices — only use business facts.",
      escalationRules: "Hand off to a human on complaints, refund requests, or anything about documents/legal issues.",
      allowedTools: ["get_business_knowledge", "start_lead_flow", "create_lead", "update_lead_status", "handoff_to_human", "do_not_reply"],
      defaultLeadFlowId: flow.id,
      isDemo: true,
    },
  });

  // ---- demo conversation + lead ----
  const conversation = await prisma.conversation.create({
    data: {
      accountId: demo.id,
      igsid: "demo-user-1",
      username: "demo_customer",
      lastUserMessageAt: new Date(Date.now() - 30 * 60_000),
      lastMessageAt: new Date(Date.now() - 25 * 60_000),
      lastMessagePreview: "Rahmat!",
      isDemo: true,
      messages: {
        create: [
          { direction: "IN", sender: "CUSTOMER", text: "Assalomu alaykum, kurs narxi qancha?", createdAt: new Date(Date.now() - 40 * 60_000), mid: "demo-mid-1" },
          {
            direction: "OUT",
            sender: "AI",
            text: "Assalomu alaykum! B toifa kursi 1,200,000 so'm (6 hafta). Ro'yxatdan o'tishni xohlaysizmi? (demo)",
            createdAt: new Date(Date.now() - 39 * 60_000),
            mid: "demo-mid-2",
            aiLatencyMs: 1450,
          },
          { direction: "IN", sender: "CUSTOMER", text: "Rahmat!", createdAt: new Date(Date.now() - 30 * 60_000), mid: "demo-mid-3" },
        ],
      },
    },
  });

  const lead = await prisma.lead.create({
    data: {
      accountId: demo.id,
      igsid: "demo-user-2",
      name: "Demo Lead — Aziz",
      phone: "+998901112233",
      status: "NEW",
      source: "instagram_dm",
      flowId: flow.id,
      contentId: reel.id,
      isDemo: true,
      answers: [
        { question: "Full Name", answer: "Demo Lead — Aziz" },
        { question: "Phone", answer: "+998901112233" },
        { question: "Course", answer: "B toifa" },
        { question: "Branch", answer: "Namangan markaz" },
        { question: "Schedule", answer: "Kechqurun" },
      ],
    },
  });
  await prisma.leadEvent.create({ data: { leadId: lead.id, type: "CREATED", data: { demo: true } } });
  await prisma.lead.create({
    data: {
      accountId: demo.id,
      name: "Demo Lead — Malika",
      phone: "+998907654321",
      status: "QUALIFIED",
      source: "landing_page",
      isDemo: true,
    },
  });

  // ---- demo automation (disabled) ----
  await prisma.automation.create({
    data: {
      accountId: demo.id,
      name: "Pricing keyword → start registration (demo)",
      description: "When a DM contains 'narx' (price), notify admins.",
      enabled: false,
      trigger: "MESSAGE_RECEIVED",
      conditions: [{ field: "text", op: "contains", value: "narx" }],
      actions: [{ type: "NOTIFY_ADMIN", params: { text: "Demo automation: a user asked about pricing." } }],
      isDemo: true,
    },
  });

  console.log(`✔ Demo account @${demo.username} seeded (flow, agent, conversation ${conversation.id.slice(0, 6)}…, leads, automation)`);
  console.log("  Demo data never calls the Meta API and is labeled DEMO in the UI.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
