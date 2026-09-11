import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { parseButtonSpec } from "@/lib/validation/leadbutton";
import { LandingWizard } from "./landing-wizard";

/**
 * PUBLIC hosted lead-capture page (the Lead Button's landing surface).
 * Renders the admin-designed button + step-by-step questions; posts to
 * /api/leads/public (rate-limited, honeypot, same validation as the DM flow).
 * Chrome strings come from the visitor's locale cookie (default: Uzbek).
 */

export const dynamic = "force-dynamic";

export default async function LandingPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const cta = await prisma.ctaConfig.findUnique({
    where: { landingSlug: slug },
    include: { account: { select: { username: true, name: true } } },
  });
  if (!cta || !cta.enabled || !cta.leadFlowId) notFound();

  const flow = await prisma.leadFlow.findUnique({
    where: { id: cta.leadFlowId },
    include: { questions: { orderBy: { order: "asc" } } },
  });
  if (!flow || !flow.enabled || flow.questions.length === 0) notFound();

  return (
    <LandingWizard
      slug={slug}
      username={cta.account.username}
      displayName={cta.account.name}
      headline={flow.name}
      description={flow.description}
      completionMessage={flow.completionMessage}
      spec={parseButtonSpec(cta.buttonSpec)}
      questions={flow.questions.map((q) => ({
        id: q.id,
        title: q.title,
        prompt: q.prompt,
        type: q.type,
        required: q.required,
        options: q.options,
      }))}
    />
  );
}
