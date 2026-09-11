"use client";

import * as React from "react";
import { Heart, MessageCircle, Send, MoreHorizontal, Music2, ChevronRight, Check, ChevronLeft } from "lucide-react";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n/provider";
import { leadButtonStyle } from "@/lib/leadbutton-style";
import type { ButtonSpec } from "@/lib/validation/leadbutton";
import { Segmented } from "@/components/ui/input";

/**
 * Instagram-style phone mockup. The admin can tap through the exact journey
 * their customer will take: Reel → button → questions → done.
 *
 * Two honest surfaces:
 *  - "ad": a promoted Reel — Instagram draws the CTA bar itself (fixed look,
 *    only the text comes from ctaType).
 *  - "landing": our hosted page — fully styled by ButtonSpec.
 */

export interface PreviewQuestion {
  title: string;
  prompt: string;
  type: string;
  required: boolean;
  options: string[];
}

export function PhonePreview({
  spec,
  headline,
  description,
  completionMessage,
  questions,
  ctaLabel,
  reelThumb,
  reelCaption,
  username,
}: {
  spec: ButtonSpec;
  headline: string;
  description: string;
  completionMessage: string;
  questions: PreviewQuestion[];
  /** Native ad CTA label (e.g. “Sign up”) — Instagram renders this surface. */
  ctaLabel: string;
  reelThumb: string | null;
  reelCaption: string | null;
  username: string;
}) {
  const { d } = useI18n();
  const [surface, setSurface] = React.useState<"ad" | "landing">("ad");
  // step: -1 = reel, 0 = landing intro, 1..N = questions, N+1 = done
  const [step, setStep] = React.useState(-1);
  const total = questions.length;

  React.useEffect(() => {
    // if questions shrink below current step, clamp
    if (step > total + 1) setStep(total + 1);
  }, [total, step]);

  const goNext = () => setStep((s) => Math.min(s + 1, total + 1));
  const restart = () => setStep(-1);

  return (
    <div className="flex flex-col items-center gap-3">
      <Segmented
        className="max-w-xs"
        value={surface}
        onChange={(v) => {
          setSurface(v);
          setStep(-1);
        }}
        options={[
          { value: "ad", label: d.leadButton.preview.stepReel + " + " + d.leadButton.preview.igSponsored },
          { value: "landing", label: d.leadButton.delivery.linkTitle },
        ]}
      />

      <div className="phone-frame w-full max-w-[280px]">
        <div className="phone-notch" />
        {step === -1 && surface === "ad" && (
          <ReelScreen
            thumb={reelThumb}
            caption={reelCaption ?? d.leadButton.preview.igCaption}
            username={username}
            ctaLabel={ctaLabel}
            sponsored={d.leadButton.preview.igSponsored}
            onCta={goNext === undefined ? undefined : () => setStep(0)}
          />
        )}
        {step === -1 && surface === "landing" && (
          <IntroScreen
            spec={spec}
            headline={headline}
            description={description}
            username={username}
            onStart={() => setStep(1)}
            startLabel={spec.label}
          />
        )}
        {step === 0 && (
          <IntroScreen
            spec={spec}
            headline={headline}
            description={description}
            username={username}
            onStart={() => setStep(1)}
            startLabel={spec.label}
          />
        )}
        {step >= 1 && step <= total && total > 0 && (
          <QuestionScreen
            q={questions[step - 1]!}
            index={step}
            total={total}
            spec={spec}
            onNext={goNext}
            onBack={() => setStep((s) => Math.max(s - 1, 0))}
          />
        )}
        {(step === total + 1 || (step >= 1 && total === 0)) && (
          <DoneScreen message={completionMessage || d.landing.thanksDefault} onRestart={restart} />
        )}
      </div>

      <p className="max-w-[280px] text-center text-[11px] leading-4 text-(--color-fg-faint)">
        {surface === "ad" ? d.leadButton.preview.surfaceAd : d.leadButton.preview.surfaceLanding}
        {" · "}
        {d.leadButton.preview.tapToDemo}
      </p>
    </div>
  );
}

/* ---------- screens ---------- */

function ReelScreen({
  thumb,
  caption,
  username,
  ctaLabel,
  sponsored,
  onCta,
}: {
  thumb: string | null;
  caption: string;
  username: string;
  ctaLabel: string;
  sponsored: string;
  onCta?: () => void;
}) {
  const [imgOk, setImgOk] = React.useState(true);
  return (
    <div className="relative h-full w-full bg-black text-white">
      {thumb && imgOk ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={thumb} alt="" className="absolute inset-0 h-full w-full object-cover opacity-80" onError={() => setImgOk(false)} />
      ) : (
        <div className="absolute inset-0 bg-gradient-to-br from-fuchsia-600 via-purple-700 to-indigo-800" />
      )}
      <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-black/30" />

      <div className="absolute left-3 top-8 text-sm font-semibold drop-shadow">Reels</div>

      {/* right action rail */}
      <div className="absolute bottom-24 right-2 flex flex-col items-center gap-4 drop-shadow">
        <span className="flex flex-col items-center text-[10px]"><Heart size={22} /> 1 024</span>
        <span className="flex flex-col items-center text-[10px]"><MessageCircle size={22} /> 48</span>
        <Send size={20} />
        <MoreHorizontal size={20} />
      </div>

      {/* bottom info + CTA */}
      <div className="absolute inset-x-0 bottom-0 space-y-2 p-3">
        <div className="flex items-center gap-2">
          <span className="ig-gradient grid h-7 w-7 place-items-center rounded-full text-[10px] font-bold">
            {username.charAt(0).toUpperCase()}
          </span>
          <span className="text-xs font-semibold">{username}</span>
          <span className="rounded border border-white/60 px-1.5 py-0.5 text-[9px]">{sponsored}</span>
        </div>
        <p className="line-clamp-2 text-[11px] leading-4 opacity-90">{caption}</p>
        {/* Instagram-drawn CTA bar — fixed look, only the text is configurable */}
        <button
          type="button"
          onClick={onCta}
          className="flex w-full items-center justify-between rounded-lg bg-[#0095f6] px-3 py-2.5 text-[13px] font-semibold text-white transition-transform active:scale-[0.98]"
        >
          {ctaLabel}
          <ChevronRight size={16} />
        </button>
        <div className="flex items-center gap-1.5 text-[10px] opacity-75">
          <Music2 size={11} /> {username} · Original audio
        </div>
      </div>
    </div>
  );
}

function IntroScreen({
  spec,
  headline,
  description,
  username,
  onStart,
  startLabel,
}: {
  spec: ButtonSpec;
  headline: string;
  description: string;
  username: string;
  onStart: () => void;
  startLabel: string;
}) {
  return (
    <div className="flex h-full w-full flex-col bg-white text-slate-900">
      <div className="ig-gradient h-1.5 w-full shrink-0" />
      <div className={cn("flex flex-1 flex-col px-4 pb-4 pt-10", spec.position === "center" && "justify-center")}>
        <div className="mb-3 flex items-center gap-2">
          <span className="ig-gradient grid h-8 w-8 place-items-center rounded-full text-[11px] font-bold text-white">
            {username.charAt(0).toUpperCase()}
          </span>
          <span className="text-xs font-semibold text-slate-500">@{username}</span>
        </div>
        <h2 className="text-lg font-bold leading-snug">{headline}</h2>
        {description && <p className="mt-1.5 text-[12px] leading-5 text-slate-500">{description}</p>}
        {spec.helper && <p className="mt-3 text-[11px] font-medium text-slate-400">{spec.helper}</p>}
        <div className={cn(spec.position === "center" ? "mt-4" : "mt-auto pt-4")}>
          <button type="button" style={leadButtonStyle(spec)} onClick={onStart} className="active:scale-[0.98]">
            {startLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function QuestionScreen({
  q,
  index,
  total,
  spec,
  onNext,
  onBack,
}: {
  q: PreviewQuestion;
  index: number;
  total: number;
  spec: ButtonSpec;
  onNext: () => void;
  onBack: () => void;
}) {
  const { d } = useI18n();
  const [choice, setChoice] = React.useState<string | null>(null);
  React.useEffect(() => setChoice(null), [q]);

  const isSelect = q.type === "SINGLE_SELECT" || q.type === "MULTI_SELECT";
  const isBool = q.type === "BOOLEAN";

  return (
    <div className="flex h-full w-full flex-col bg-white px-4 pb-4 pt-9 text-slate-900">
      {/* progress */}
      <div className="mb-1 flex items-center justify-between text-[10px] font-medium text-slate-400">
        <button type="button" onClick={onBack} className="flex items-center gap-0.5 hover:text-slate-600">
          <ChevronLeft size={12} /> {d.landing.back}
        </button>
        {d.leadButton.preview.progress(index, total)}
      </div>
      <div className="mb-4 h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
        <div
          className="h-full rounded-full transition-all"
          style={{ width: `${(index / total) * 100}%`, background: spec.bg }}
        />
      </div>

      <p className="text-[15px] font-semibold leading-snug">{q.prompt}</p>
      {!q.required && <p className="mt-0.5 text-[10px] text-slate-400">({d.common.optional})</p>}

      <div className="mt-3 flex-1 space-y-2 overflow-y-auto">
        {isSelect &&
          (q.options.length ? q.options : ["A", "B"]).slice(0, 6).map((o) => (
            <button
              key={o}
              type="button"
              onClick={() => setChoice(o)}
              className={cn(
                "w-full rounded-xl border px-3 py-2.5 text-left text-[13px] font-medium transition-colors",
                choice === o ? "border-transparent text-white" : "border-slate-200 bg-slate-50 text-slate-700",
              )}
              style={choice === o ? { background: spec.bg } : undefined}
            >
              {o}
            </button>
          ))}
        {isBool && (
          <div className="flex gap-2">
            {[d.landing.yes, d.landing.no].map((o) => (
              <button
                key={o}
                type="button"
                onClick={() => setChoice(o)}
                className={cn(
                  "flex-1 rounded-xl border px-3 py-2.5 text-[13px] font-medium",
                  choice === o ? "border-transparent text-white" : "border-slate-200 bg-slate-50 text-slate-700",
                )}
                style={choice === o ? { background: spec.bg } : undefined}
              >
                {o}
              </button>
            ))}
          </div>
        )}
        {!isSelect && !isBool && (
          <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-[13px] text-slate-400">
            {q.type === "PHONE" ? "+998 90 123 45 67" : q.type === "EMAIL" ? "you@mail.com" : q.type === "NUMBER" ? "42" : q.type === "DATE" ? "2026-01-15" : q.type === "TIME" ? "14:30" : "…"}
          </div>
        )}
      </div>

      <button type="button" style={leadButtonStyle({ ...spec, size: "md" })} onClick={onNext} className="mt-3 active:scale-[0.98]">
        {index === total ? d.leadButton.preview.sendAnswer : d.landing.next}
      </button>
    </div>
  );
}

function DoneScreen({ message, onRestart }: { message: string; onRestart: () => void }) {
  const { d } = useI18n();
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 bg-white px-6 text-center text-slate-900">
      <span className="grid h-16 w-16 place-items-center rounded-full bg-emerald-100 text-emerald-600">
        <Check size={30} strokeWidth={3} />
      </span>
      <p className="text-base font-bold">{d.leadButton.preview.thanksTitle}</p>
      <p className="text-[12px] leading-5 text-slate-500">{message}</p>
      <p className="text-[11px] text-slate-400">{d.leadButton.preview.thanksText}</p>
      <button type="button" onClick={onRestart} className="mt-2 text-[11px] font-medium text-indigo-600 underline-offset-2 hover:underline">
        ↺ {d.leadButton.preview.tapToDemo}
      </button>
    </div>
  );
}
