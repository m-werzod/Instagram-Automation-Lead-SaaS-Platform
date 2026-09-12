"use client";

import * as React from "react";
import { Bookmark, ChevronRight, Heart, MessageCircle, MoreHorizontal, Music2, Send } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Phone mock-up of a promoted post. Instagram draws the CTA bar itself — its
 * look is fixed, only the text comes from the chosen call-to-action — so this
 * preview deliberately does not offer colour or position controls. Live: every
 * prop change re-renders immediately.
 */
export function AdPhonePreview({
  thumb,
  caption,
  username,
  ctaLabel,
  placement,
  destinationHint,
  className,
}: {
  thumb: string | null;
  caption: string;
  username: string;
  /** null = no button on this ad */
  ctaLabel: string | null;
  placement: "reels" | "feed";
  /** what happens on tap — shown under the phone */
  destinationHint?: string;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center gap-2", className)}>
      <div className="phone-frame w-full max-w-[280px]">
        <div className="phone-notch" />
        {placement === "reels" ? (
          <ReelAd thumb={thumb} caption={caption} username={username} ctaLabel={ctaLabel} />
        ) : (
          <FeedAd thumb={thumb} caption={caption} username={username} ctaLabel={ctaLabel} />
        )}
      </div>
      {destinationHint && <p className="max-w-[280px] text-center text-[11px] leading-4 text-(--color-fg-faint)">{destinationHint}</p>}
    </div>
  );
}

function Media({ thumb, className }: { thumb: string | null; className: string }) {
  const [ok, setOk] = React.useState(true);
  React.useEffect(() => setOk(true), [thumb]);
  if (thumb && ok) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={thumb} alt="" className={className} onError={() => setOk(false)} />;
  }
  return <div className={cn(className, "bg-gradient-to-br from-fuchsia-600 via-purple-700 to-indigo-800")} />;
}

function ReelAd({ thumb, caption, username, ctaLabel }: { thumb: string | null; caption: string; username: string; ctaLabel: string | null }) {
  return (
    <div className="relative h-full w-full bg-black text-white">
      <Media thumb={thumb} className="absolute inset-0 h-full w-full object-cover opacity-85" />
      <div className="absolute inset-0 bg-gradient-to-t from-black/75 via-transparent to-black/30" />
      <div className="absolute left-3 top-8 text-sm font-semibold drop-shadow">Reels</div>
      <div className="absolute bottom-24 right-2 flex flex-col items-center gap-4 drop-shadow">
        <Heart size={22} />
        <MessageCircle size={22} />
        <Send size={20} />
        <MoreHorizontal size={20} />
      </div>
      <div className="absolute inset-x-0 bottom-0 space-y-2 p-3">
        <div className="flex items-center gap-2">
          <span className="ig-gradient grid h-7 w-7 place-items-center rounded-full text-[10px] font-bold">{username.charAt(0).toUpperCase()}</span>
          <span className="text-xs font-semibold">{username}</span>
          <span className="rounded border border-white/60 px-1.5 py-0.5 text-[9px]">Sponsored</span>
        </div>
        <p className="line-clamp-2 text-[11px] leading-4 opacity-90">{caption || "…"}</p>
        {ctaLabel && (
          <div className="flex w-full items-center justify-between rounded-lg bg-[#0095f6] px-3 py-2.5 text-[13px] font-semibold text-white">
            {ctaLabel}
            <ChevronRight size={16} />
          </div>
        )}
        <div className="flex items-center gap-1.5 text-[10px] opacity-75">
          <Music2 size={11} /> {username} · Original audio
        </div>
      </div>
    </div>
  );
}

function FeedAd({ thumb, caption, username, ctaLabel }: { thumb: string | null; caption: string; username: string; ctaLabel: string | null }) {
  return (
    <div className="flex h-full w-full flex-col bg-white text-slate-900">
      <div className="flex items-center gap-2 px-3 pb-2 pt-9">
        <span className="ig-gradient grid h-7 w-7 place-items-center rounded-full text-[10px] font-bold text-white">{username.charAt(0).toUpperCase()}</span>
        <div className="leading-tight">
          <div className="text-xs font-semibold">{username}</div>
          <div className="text-[10px] text-slate-500">Sponsored</div>
        </div>
        <MoreHorizontal size={16} className="ml-auto text-slate-500" />
      </div>
      <div className="relative aspect-[4/5] w-full overflow-hidden bg-slate-100">
        <Media thumb={thumb} className="h-full w-full object-cover" />
      </div>
      {ctaLabel && (
        <div className="flex items-center justify-between bg-[#0095f6] px-3 py-2 text-[12px] font-semibold text-white">
          {ctaLabel}
          <ChevronRight size={14} />
        </div>
      )}
      <div className="flex items-center gap-3 px-3 py-2 text-slate-800">
        <Heart size={18} />
        <MessageCircle size={18} />
        <Send size={18} />
        <Bookmark size={18} className="ml-auto" />
      </div>
      <p className="px-3 text-[11px] leading-4">
        <span className="font-semibold">{username}</span> <span className="line-clamp-3">{caption || "…"}</span>
      </p>
    </div>
  );
}
