"use client";

import * as React from "react";
import { toast } from "sonner";
import { CalendarClock, Film, Image as ImageIcon, Images, Link2, Plus, Send, Trash2, Upload, CircleDashed, Heart, MessageCircle, Bookmark } from "lucide-react";
import { api } from "@/lib/client/api";
import { useI18n } from "@/lib/i18n/provider";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Field, Input, Segmented, Textarea } from "@/components/ui/input";
import { ToggleRow } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

/**
 * Create a publication through the official content-publishing API.
 * Left: what will appear on Instagram (live). Right: type, media, caption,
 * timing. Media is either uploaded (JPEG ≤ 4 MB, hosted by the platform) or a
 * public URL. Scheduling is platform-side — Instagram has no scheduling API.
 */

type MediaType = "IMAGE" | "REELS" | "STORIES" | "CAROUSEL";
type Kind = "IMAGE" | "VIDEO";

interface Item {
  key: string;
  assetId?: string;
  url?: string;
  kind: Kind;
  preview: string | null;
  name?: string;
  uploading?: boolean;
}

export interface LimitInfo {
  available: boolean;
  reason: string | null;
  requiredScope: string;
  limit: { used: number; quota: number } | null;
}

function newItem(): Item {
  return { key: Math.random().toString(36).slice(2), kind: "IMAGE", preview: null };
}

function toLocalInputValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function PublishDialog({
  open,
  onOpenChange,
  accountId,
  username,
  limitInfo,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  accountId: string;
  username: string;
  limitInfo: LimitInfo | null;
  onCreated: () => Promise<void>;
}) {
  const { d } = useI18n();
  const t = d.content.publish;
  const [mediaType, setMediaType] = React.useState<MediaType>("IMAGE");
  const [items, setItems] = React.useState<Item[]>([newItem()]);
  const [caption, setCaption] = React.useState("");
  const [shareToFeed, setShareToFeed] = React.useState(true);
  const [coverUrl, setCoverUrl] = React.useState("");
  const [when, setWhen] = React.useState<"now" | "schedule">("now");
  const [scheduledLocal, setScheduledLocal] = React.useState(() => toLocalInputValue(new Date(Date.now() + 3600_000)));
  const [busy, setBusy] = React.useState(false);

  function reset() {
    setMediaType("IMAGE");
    setItems([newItem()]);
    setCaption("");
    setShareToFeed(true);
    setCoverUrl("");
    setWhen("now");
  }

  function changeType(next: MediaType) {
    setMediaType(next);
    setItems((prev) => (next === "CAROUSEL" ? (prev.length >= 2 ? prev : [...prev, newItem()]) : [prev[0] ?? newItem()]));
  }

  function patchItem(key: string, patch: Partial<Item>) {
    setItems((prev) => prev.map((i) => (i.key === key ? { ...i, ...patch } : i)));
  }

  async function upload(key: string, file: File) {
    patchItem(key, { uploading: true, name: file.name });
    const form = new FormData();
    form.append("file", file);
    form.append("accountId", accountId);
    try {
      const res = await api<{ asset: { id: string; kind: Kind; url: string } }>("/api/media", { method: "POST", body: form });
      patchItem(key, {
        assetId: res.asset.id,
        url: undefined,
        kind: res.asset.kind,
        preview: URL.createObjectURL(file),
        uploading: false,
      });
    } catch {
      patchItem(key, { uploading: false, name: undefined });
    }
  }

  function setUrl(key: string, url: string) {
    const kind: Kind = /\.(mp4|mov|m4v)(\?|#|$)/i.test(url) ? "VIDEO" : "IMAGE";
    patchItem(key, { url, assetId: undefined, kind, preview: url || null, name: undefined });
  }

  const ready = items.every((i) => (i.assetId || i.url) && !i.uploading) && (mediaType !== "CAROUSEL" || items.length >= 2);
  const captionAllowed = mediaType !== "STORIES";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    try {
      await api("/api/publish", {
        method: "POST",
        json: {
          accountId,
          mediaType,
          caption: captionAllowed && caption.trim() ? caption.trim() : undefined,
          items: items.map((i) => (i.assetId ? { assetId: i.assetId } : { url: i.url, kind: i.kind })),
          ...(mediaType === "REELS" ? { shareToFeed, ...(coverUrl ? { coverUrl } : {}) } : {}),
          ...(when === "schedule" ? { scheduledAt: new Date(scheduledLocal).toISOString() } : {}),
        },
      });
      toast.success(when === "schedule" ? t.scheduledOk : t.submittedOk);
      onOpenChange(false);
      reset();
      await onCreated();
    } catch {
      /* toast from api() */
    } finally {
      setBusy(false);
    }
  }

  const first = items[0];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent wide title={t.title} description={t.subtitle}>
        <form onSubmit={submit} className="grid gap-5 md:grid-cols-[280px_1fr]">
          {/* live preview */}
          <div className="flex flex-col items-center gap-2">
            <div className="phone-frame w-full max-w-[280px]">
              <div className="phone-notch" />
              <PostPreview mediaType={mediaType} items={items} caption={captionAllowed ? caption : ""} username={username} />
            </div>
            <p className="text-center text-[11px] leading-4 text-(--color-fg-faint)">{t.previewHint}</p>
          </div>

          {/* controls */}
          <div className="space-y-4">
            <Segmented
              value={mediaType}
              onChange={changeType}
              options={[
                { value: "IMAGE", label: <span className="inline-flex items-center gap-1"><ImageIcon size={12} /> {t.types.IMAGE}</span> },
                { value: "REELS", label: <span className="inline-flex items-center gap-1"><Film size={12} /> {t.types.REELS}</span> },
                { value: "STORIES", label: <span className="inline-flex items-center gap-1"><CircleDashed size={12} /> {t.types.STORIES}</span> },
                { value: "CAROUSEL", label: <span className="inline-flex items-center gap-1"><Images size={12} /> {t.types.CAROUSEL}</span> },
              ]}
            />

            <Field label={t.media} hint={mediaType === "REELS" ? t.videoHint : t.jpegOnly}>
              <div className="space-y-2">
                {items.map((item, idx) => (
                  <MediaItemRow
                    key={item.key}
                    item={item}
                    index={idx}
                    removable={mediaType === "CAROUSEL" && items.length > 2}
                    onFile={(f) => void upload(item.key, f)}
                    onUrl={(u) => setUrl(item.key, u)}
                    onRemove={() => setItems((prev) => prev.filter((i) => i.key !== item.key))}
                    video={mediaType === "REELS"}
                  />
                ))}
                {mediaType === "CAROUSEL" && items.length < 10 && (
                  <Button type="button" size="sm" variant="secondary" onClick={() => setItems((prev) => [...prev, newItem()])}>
                    <Plus size={13} /> {t.addItem}
                  </Button>
                )}
              </div>
            </Field>

            {captionAllowed && (
              <Field label={`${t.caption} · ${caption.length}/2200`}>
                <Textarea rows={4} maxLength={2200} value={caption} onChange={(e) => setCaption(e.target.value)} placeholder={t.captionPh} />
              </Field>
            )}

            {mediaType === "REELS" && (
              <div className="rounded-lg border border-(--color-border) px-3">
                <ToggleRow label={t.shareToFeed} checked={shareToFeed} onCheckedChange={setShareToFeed} onLabel={d.common.on} offLabel={d.common.off} />
                <div className="pb-3">
                  <Field label={t.cover}>
                    <Input value={coverUrl} onChange={(e) => setCoverUrl(e.target.value)} placeholder="https://…/cover.jpg" />
                  </Field>
                </div>
              </div>
            )}

            <Field label={t.when} hint={t.platformScheduling}>
              <div className="space-y-2">
                <Segmented
                  value={when}
                  onChange={setWhen}
                  options={[
                    { value: "now", label: <span className="inline-flex items-center gap-1"><Send size={12} /> {t.now}</span> },
                    { value: "schedule", label: <span className="inline-flex items-center gap-1"><CalendarClock size={12} /> {t.schedule}</span> },
                  ]}
                />
                {when === "schedule" && (
                  <Input type="datetime-local" value={scheduledLocal} min={toLocalInputValue(new Date())} onChange={(e) => setScheduledLocal(e.target.value)} />
                )}
              </div>
            </Field>

            {limitInfo?.limit && (
              <p className="text-[11px] text-(--color-fg-faint)">{t.limit(limitInfo.limit.used, limitInfo.limit.quota)}</p>
            )}

            <div className="flex justify-end gap-2 border-t border-(--color-border) pt-3">
              <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
                {d.common.cancel}
              </Button>
              <Button type="submit" disabled={busy || !ready || !first}>
                {busy ? t.submitting : when === "schedule" ? t.submitScheduled : t.submit}
              </Button>
            </div>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function MediaItemRow({
  item,
  index,
  removable,
  video,
  onFile,
  onUrl,
  onRemove,
}: {
  item: Item;
  index: number;
  removable: boolean;
  video: boolean;
  onFile: (f: File) => void;
  onUrl: (u: string) => void;
  onRemove: () => void;
}) {
  const { d } = useI18n();
  const t = d.content.publish;
  const inputRef = React.useRef<HTMLInputElement>(null);
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-(--color-border) p-2">
      <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-(--color-panel-2) text-[10px] font-bold">{index + 1}</span>
      <input
        ref={inputRef}
        type="file"
        accept={video ? "video/mp4,video/quicktime" : "image/jpeg,video/mp4,video/quicktime"}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
          e.target.value = "";
        }}
      />
      <Button type="button" size="sm" variant="secondary" disabled={item.uploading} onClick={() => inputRef.current?.click()}>
        <Upload size={13} /> {item.uploading ? t.uploading : item.assetId ? t.replace : t.upload}
      </Button>
      <span className="text-[11px] text-(--color-fg-faint)">{t.orUrl}</span>
      <div className="relative min-w-40 flex-1">
        <Link2 size={12} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-(--color-fg-faint)" />
        <Input className="h-8 pl-7 text-xs" value={item.url ?? ""} onChange={(e) => onUrl(e.target.value)} placeholder={t.urlPh} />
      </div>
      {item.name && <span className="max-w-32 truncate text-[11px] text-(--color-ok)">{item.name}</span>}
      {removable && (
        <Button type="button" size="icon" variant="ghost" onClick={onRemove} aria-label={t.remove}>
          <Trash2 size={13} />
        </Button>
      )}
    </div>
  );
}

/** What the customer sees — a feed post, a Reel or a Story frame. */
function PostPreview({ mediaType, items, caption, username }: { mediaType: MediaType; items: Item[]; caption: string; username: string }) {
  const first = items[0];
  const media = (item: Item | undefined, className: string) => {
    if (!item?.preview) {
      return (
        <div className={cn("grid place-items-center bg-gradient-to-br from-slate-200 to-slate-300 text-slate-500", className)}>
          <ImageIcon size={28} />
        </div>
      );
    }
    return item.kind === "VIDEO" ? (
      <video src={item.preview} className={cn("object-cover", className)} muted playsInline />
    ) : (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={item.preview} alt="" className={cn("object-cover", className)} />
    );
  };

  if (mediaType === "STORIES" || mediaType === "REELS") {
    return (
      <div className="relative h-full w-full bg-black text-white">
        {media(first, "absolute inset-0 h-full w-full opacity-90")}
        <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-black/30" />
        <div className="absolute left-3 top-8 text-sm font-semibold drop-shadow">{mediaType === "REELS" ? "Reels" : ""}</div>
        <div className="absolute inset-x-0 bottom-0 space-y-2 p-3">
          <div className="flex items-center gap-2">
            <span className="ig-gradient grid h-7 w-7 place-items-center rounded-full text-[10px] font-bold">{username.charAt(0).toUpperCase()}</span>
            <span className="text-xs font-semibold">{username}</span>
          </div>
          {caption && <p className="line-clamp-3 text-[11px] leading-4 opacity-90">{caption}</p>}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full w-full flex-col bg-white text-slate-900">
      <div className="flex items-center gap-2 px-3 pb-2 pt-9">
        <span className="ig-gradient grid h-7 w-7 place-items-center rounded-full text-[10px] font-bold text-white">{username.charAt(0).toUpperCase()}</span>
        <span className="text-xs font-semibold">{username}</span>
      </div>
      <div className="relative aspect-square w-full overflow-hidden bg-slate-100">
        {media(first, "h-full w-full")}
        {mediaType === "CAROUSEL" && (
          <span className="absolute right-2 top-2 rounded-full bg-black/60 px-1.5 py-0.5 text-[10px] font-semibold text-white">1/{items.length}</span>
        )}
      </div>
      <div className="flex items-center gap-3 px-3 py-2 text-slate-800">
        <Heart size={18} />
        <MessageCircle size={18} />
        <Send size={18} />
        <Bookmark size={18} className="ml-auto" />
      </div>
      <p className="px-3 text-[11px] leading-4">
        <span className="font-semibold">{username}</span> {caption ? <span className="line-clamp-4 whitespace-pre-wrap">{caption}</span> : <span className="text-slate-400">…</span>}
      </p>
    </div>
  );
}
