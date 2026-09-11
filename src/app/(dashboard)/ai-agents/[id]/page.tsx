import { redirect } from "next/navigation";

/** Agent settings moved under /automation. */
export default async function AgentDetailRedirect({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/automation/agents/${id}`);
}
