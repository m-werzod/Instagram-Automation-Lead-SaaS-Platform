"use client";

import * as React from "react";
import { Check, ChevronLeft } from "lucide-react";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n/provider";
import { leadButtonStyle } from "@/lib/leadbutton-style";
import type { ButtonSpec } from "@/lib/validation/leadbutton";

/**
 * The customer-facing question wizard — one question per screen, exactly like
 * the builder preview. Styled entirely by the admin's ButtonSpec.
 */

interface Q {
  id: string;
  title: string;
  prompt: string;
  type: string;
  required: boolean;
  options: string[];
}

export function LandingWizard({
  slug,
  username,
  displayName,
  headline,
  description,
  completionMessage,
  spec,
  questions,
}: {
  slug: string;
  username: string;
  displayName: string | null;
  headline: string;
  description: string | null;
  completionMessage: string | null;
  spec: ButtonSpec;
  questions: Q[];
}) {
  const { d } = useI18n();
  // step: 0 = intro, 1..N = questions, N+1 = done
  const [step, setStep] = React.useState(0);
  const [answers, setAnswers] = React.useState<Record<string, string>>({});
  const [multi, setMulti] = React.useState<Record<string, string[]>>({});
  const [error, setError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);
  const total = questions.length;
  const done = step > total;

  function valueOf(q: Q): string {
    if (q.type === "MULTI_SELECT") return (multi[q.id] ?? []).join(", ");
    return answers[q.id] ?? "";
  }

  function localCheck(q: Q): string | null {
    const v = valueOf(q).trim();
    if (q.required && !v) return d.landing.requiredField;
    return null;
  }

  async function next() {
    setError(null);
    const q = questions[step - 1]!;
    const problem = localCheck(q);
    if (problem) {
      setError(problem);
      return;
    }
    if (step < total) {
      setStep(step + 1);
      return;
    }
    // last question → submit everything
    setSubmitting(true);
    try {
      const payload: Record<string, string> = {};
      for (const question of questions) {
        const v = valueOf(question).trim();
        if (v) payload[question.id] = v;
      }
      const res = await fetch("/api/leads/public", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, answers: payload, website: "" }),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: { message?: string; details?: { questionId?: string } } };
      if (!res.ok || body.ok === false) {
        const qid = body.error?.details?.questionId;
        if (qid) {
          const idx = questions.findIndex((x) => x.id === qid);
          if (idx >= 0) setStep(idx + 1);
        }
        setError(body.error?.message ?? d.landing.invalidValue);
        return;
      }
      setStep(total + 1);
    } catch {
      setError(d.errors.network);
    } finally {
      setSubmitting(false);
    }
  }

  const q = step >= 1 && step <= total ? questions[step - 1]! : null;

  return (
    <div className="flex min-h-dvh justify-center bg-(--color-bg) sm:items-center sm:py-8">
      <div className="flex w-full max-w-md flex-col overflow-hidden bg-white sm:min-h-[600px] sm:rounded-3xl sm:border sm:border-(--color-border) sm:shadow-xl">
        <div className="ig-gradient h-1.5 w-full shrink-0" />

        {/* intro */}
        {step === 0 && (
          <div className={cn("flex flex-1 flex-col px-6 pb-8 pt-10", spec.position === "center" && "justify-center")}>
            <div className="mb-4 flex items-center gap-2.5">
              <span className="ig-gradient grid h-10 w-10 place-items-center rounded-full text-sm font-bold text-white">
                {username.charAt(0).toUpperCase()}
              </span>
              <div>
                <div className="text-sm font-semibold leading-tight">{displayName ?? `@${username}`}</div>
                <div className="text-xs text-slate-400">@{username}</div>
              </div>
            </div>
            <h1 className="text-2xl font-bold leading-snug">{headline}</h1>
            {description && <p className="mt-2 text-sm leading-6 text-slate-500">{description}</p>}
            {spec.helper && <p className="mt-4 text-xs font-medium text-slate-400">{spec.helper}</p>}
            <div className={cn(spec.position === "center" ? "mt-6" : "mt-auto pt-6")}>
              <button type="button" style={leadButtonStyle(spec)} onClick={() => setStep(1)} className="active:scale-[0.98]">
                {spec.label}
              </button>
            </div>
          </div>
        )}

        {/* question steps */}
        {q && (
          <div className="flex flex-1 flex-col px-6 pb-8 pt-6">
            <div className="mb-1.5 flex items-center justify-between text-xs font-medium text-slate-400">
              <button
                type="button"
                onClick={() => { setError(null); setStep(step - 1); }}
                className="flex items-center gap-0.5 hover:text-slate-600"
              >
                <ChevronLeft size={14} /> {d.landing.back}
              </button>
              {d.landing.progress(step, total)}
            </div>
            <div className="mb-6 h-2 w-full overflow-hidden rounded-full bg-slate-100">
              <div className="h-full rounded-full transition-all duration-300" style={{ width: `${(step / total) * 100}%`, background: spec.bg }} />
            </div>

            <label className="text-lg font-semibold leading-snug" htmlFor={`q-${q.id}`}>
              {q.prompt}
              {!q.required && <span className="ml-1.5 align-middle text-xs font-normal text-slate-400">({d.common.optional})</span>}
            </label>

            <div className="mt-4 flex-1 space-y-2">
              <AnswerInput
                q={q}
                value={answers[q.id] ?? ""}
                multiValue={multi[q.id] ?? []}
                spec={spec}
                yes={d.landing.yes}
                no={d.landing.no}
                onChange={(v) => { setError(null); setAnswers((a) => ({ ...a, [q.id]: v })); }}
                onMultiChange={(v) => { setError(null); setMulti((m) => ({ ...m, [q.id]: v })); }}
                onEnter={next}
              />
              {error && <p className="text-sm font-medium text-red-600">{error}</p>}
            </div>

            <button
              type="button"
              style={leadButtonStyle({ ...spec, size: "md" })}
              onClick={next}
              disabled={submitting}
              className="mt-4 disabled:opacity-60 active:scale-[0.98]"
            >
              {submitting ? d.landing.sending : step === total ? d.landing.send : d.landing.next}
            </button>
          </div>
        )}

        {/* done */}
        {done && (
          <div className="flex flex-1 flex-col items-center justify-center gap-4 px-8 py-16 text-center">
            <span className="grid h-20 w-20 place-items-center rounded-full bg-emerald-100 text-emerald-600">
              <Check size={38} strokeWidth={3} />
            </span>
            <p className="text-xl font-bold">{completionMessage?.trim() || d.landing.thanksDefault}</p>
            <p className="text-sm text-slate-400">@{username}</p>
          </div>
        )}

        <p className="pb-4 text-center text-[10px] text-slate-300">{d.landing.poweredBy}</p>
      </div>
    </div>
  );
}

function AnswerInput({
  q,
  value,
  multiValue,
  spec,
  yes,
  no,
  onChange,
  onMultiChange,
  onEnter,
}: {
  q: Q;
  value: string;
  multiValue: string[];
  spec: ButtonSpec;
  yes: string;
  no: string;
  onChange: (v: string) => void;
  onMultiChange: (v: string[]) => void;
  onEnter: () => void;
}) {
  const base =
    "w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-[15px] outline-none transition-colors focus:border-slate-400 focus:bg-white";

  if (q.type === "SINGLE_SELECT") {
    return (
      <div className="space-y-2">
        {q.options.map((o) => (
          <button
            key={o}
            type="button"
            onClick={() => onChange(o)}
            className={cn(
              "w-full rounded-xl border px-4 py-3 text-left text-[15px] font-medium transition-all",
              value === o ? "border-transparent text-white" : "border-slate-200 bg-slate-50 text-slate-700 hover:border-slate-300",
            )}
            style={value === o ? { background: spec.bg } : undefined}
          >
            {o}
          </button>
        ))}
      </div>
    );
  }
  if (q.type === "MULTI_SELECT") {
    return (
      <div className="space-y-2">
        {q.options.map((o) => {
          const on = multiValue.includes(o);
          return (
            <button
              key={o}
              type="button"
              onClick={() => onMultiChange(on ? multiValue.filter((x) => x !== o) : [...multiValue, o])}
              className={cn(
                "flex w-full items-center justify-between rounded-xl border px-4 py-3 text-left text-[15px] font-medium transition-all",
                on ? "border-transparent text-white" : "border-slate-200 bg-slate-50 text-slate-700 hover:border-slate-300",
              )}
              style={on ? { background: spec.bg } : undefined}
            >
              {o}
              {on && <Check size={16} />}
            </button>
          );
        })}
      </div>
    );
  }
  if (q.type === "BOOLEAN") {
    return (
      <div className="flex gap-2">
        {[
          { label: yes, send: "Yes" },
          { label: no, send: "No" },
        ].map((o) => (
          <button
            key={o.send}
            type="button"
            onClick={() => onChange(o.send)}
            className={cn(
              "flex-1 rounded-xl border px-4 py-3 text-[15px] font-medium transition-all",
              value === o.send ? "border-transparent text-white" : "border-slate-200 bg-slate-50 text-slate-700 hover:border-slate-300",
            )}
            style={value === o.send ? { background: spec.bg } : undefined}
          >
            {o.label}
          </button>
        ))}
      </div>
    );
  }

  const inputType =
    q.type === "PHONE" ? "tel" : q.type === "EMAIL" ? "email" : q.type === "NUMBER" ? "number" : q.type === "DATE" ? "date" : q.type === "TIME" ? "time" : "text";

  if (q.type === "TEXT" && q.prompt.length > 60) {
    return (
      <textarea
        id={`q-${q.id}`}
        className={cn(base, "min-h-28 resize-none")}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        maxLength={1000}
      />
    );
  }
  return (
    <input
      id={`q-${q.id}`}
      type={inputType}
      inputMode={q.type === "PHONE" ? "tel" : q.type === "NUMBER" ? "decimal" : undefined}
      placeholder={q.type === "PHONE" ? "+998 90 123 45 67" : undefined}
      className={base}
      value={value}
      autoFocus
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onEnter();
        }
      }}
      maxLength={1000}
    />
  );
}
