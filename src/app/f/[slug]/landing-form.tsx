"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/input";

interface Question {
  id: string;
  title: string;
  prompt: string;
  type: string;
  required: boolean;
  options: string[];
}

export function LandingForm({
  slug,
  questions,
  completionMessage,
}: {
  slug: string;
  questions: Question[];
  completionMessage: string;
}) {
  const [values, setValues] = React.useState<Record<string, string>>({});
  const [busy, setBusy] = React.useState(false);
  const [done, setDone] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  function set(id: string, v: string) {
    setValues((prev) => ({ ...prev, [id]: v }));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/leads/public", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, answers: values, website: "" }),
      });
      const body = (await res.json()) as { ok: boolean; error?: { message: string } };
      if (!res.ok || !body.ok) {
        setError(body.error?.message ?? "Submission failed — please check your answers.");
        return;
      }
      setDone(true);
    } catch {
      setError("Network error — please try again.");
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return <div className="rounded-md border border-[--color-ok]/40 bg-[--color-ok]/10 p-4 text-sm">{completionMessage}</div>;
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      {/* honeypot — hidden from humans */}
      <input type="text" name="website" tabIndex={-1} autoComplete="off" className="hidden" aria-hidden onChange={() => undefined} />
      {questions.map((q) => (
        <Field key={q.id} label={q.required ? q.prompt : `${q.prompt} (optional)`}>
          {q.type === "SINGLE_SELECT" || q.type === "BOOLEAN" ? (
            <Select required={q.required} value={values[q.id] ?? ""} onChange={(e) => set(q.id, e.target.value)}>
              <option value="" disabled>
                — select —
              </option>
              {(q.type === "BOOLEAN" ? ["Yes", "No"] : q.options).map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </Select>
          ) : q.type === "MULTI_SELECT" ? (
            <MultiSelect options={q.options} value={values[q.id] ?? ""} onChange={(v) => set(q.id, v)} />
          ) : q.type === "TEXT" && q.prompt.length > 60 ? (
            <Textarea required={q.required} value={values[q.id] ?? ""} onChange={(e) => set(q.id, e.target.value)} />
          ) : (
            <Input
              required={q.required}
              type={q.type === "EMAIL" ? "email" : q.type === "NUMBER" ? "number" : q.type === "DATE" ? "date" : q.type === "TIME" ? "time" : q.type === "PHONE" ? "tel" : "text"}
              value={values[q.id] ?? ""}
              onChange={(e) => set(q.id, e.target.value)}
              placeholder={q.type === "PHONE" ? "+998 90 123 45 67" : undefined}
            />
          )}
        </Field>
      ))}
      {error && <p className="text-xs text-[--color-danger]">{error}</p>}
      <Button type="submit" className="w-full" disabled={busy}>
        {busy ? "Submitting…" : "Submit"}
      </Button>
    </form>
  );
}

function MultiSelect({ options, value, onChange }: { options: string[]; value: string; onChange: (v: string) => void }) {
  const selected = new Set(value.split(",").map((s) => s.trim()).filter(Boolean));
  function toggle(opt: string) {
    const next = new Set(selected);
    if (next.has(opt)) next.delete(opt);
    else next.add(opt);
    onChange([...next].join(", "));
  }
  return (
    <div className="space-y-1.5">
      {options.map((o) => (
        <label key={o} className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={selected.has(o)} onChange={() => toggle(o)} />
          {o}
        </label>
      ))}
    </div>
  );
}
