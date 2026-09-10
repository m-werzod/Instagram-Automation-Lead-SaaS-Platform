import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { LandingForm } from "./landing-form";

/**
 * PUBLIC hosted lead-capture landing page (EXTERNAL_LINK CTA kind).
 * Server component: loads the flow's questions; the client form posts to
 * /api/leads/public (rate-limited, honeypot, same validation as the DM flow).
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
    <div className="mx-auto flex min-h-dvh max-w-md flex-col justify-center p-4">
      <div className="rounded-lg border border-[--color-border] bg-[--color-panel] p-6">
        <h1 className="text-lg font-semibold">{flow.name}</h1>
        <p className="mt-1 text-xs text-[--color-fg-muted]">
          {cta.account.name ?? `@${cta.account.username}`} · {flow.description ?? "Fill in the form and we will contact you."}
        </p>
        <div className="mt-5">
          <LandingForm
            slug={slug}
            questions={flow.questions.map((q) => ({
              id: q.id,
              title: q.title,
              prompt: q.prompt,
              type: q.type,
              required: q.required,
              options: q.options,
            }))}
            completionMessage={flow.completionMessage ?? "Thank you! We received your details."}
          />
        </div>
      </div>
      <p className="mt-3 text-center text-[10px] text-[--color-fg-faint]">Powered by a private automation platform.</p>
    </div>
  );
}
