"use client";

import * as React from "react";
import { Wand2, Plus, Trash2, Download, AlertTriangle, Loader2 } from "lucide-react";
import { api } from "@/lib/client/api";
import { useI18n } from "@/lib/i18n/provider";
import { Card, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import { type TabProps, type SubtitleCueRow, type SubtitleTrackRow } from "./types";
import { defaultEditParams } from "@/lib/video/params";

const PRESETS = ["clean-white", "bold-social", "minimal", "high-contrast", "creator", "highlighted-words", "professional"] as const;
const POSITIONS = ["top", "middle", "lower-center", "bottom"] as const;

/**
 * Subtitle editing.
 *
 * Per-word highlighting is offered only when the track actually carries word
 * timings. A transcription provider that returns sentence-level timings cannot
 * support it, and faking the timings would drift visibly from the speech, so
 * the control is disabled with the reason shown instead.
 */
export function SubtitlesTab({ state, onPatch, onReload }: TabProps) {
  const { d } = useI18n();
  const t = d.videoEditor.subtitlesPanel;
  const params = state.project.params ?? defaultEditParams();
  const tracks = state.project.subtitle;
  const active: SubtitleTrackRow | undefined =
    tracks.find((tr) => tr.id === params.subtitles.trackId) ?? tracks[0];

  const [busy, setBusy] = React.useState(false);
  const [language, setLanguage] = React.useState<"uz" | "ru" | "en">("uz");
  const [cues, setCues] = React.useState<SubtitleCueRow[]>(active?.cues ?? []);

  React.useEffect(() => setCues(active?.cues ?? []), [active?.id, active?.cues]);

  const hasWordTimings = (active?.cues ?? []).some((c) => Array.isArray(c.words) && c.words.length > 0);
  const style = params.subtitles.style;

  async function generate() {
    setBusy(true);
    try {
      await api("/api/video/jobs", { method: "POST", json: { projectId: state.project.id, kind: "TRANSCRIBE", languageHint: language } });
      toast.success(t.generating);
      await onReload();
    } catch {
      /* reported */
    } finally {
      setBusy(false);
    }
  }

  async function createEmpty() {
    setBusy(true);
    try {
      await api("/api/video/subtitles", {
        method: "POST",
        json: { projectId: state.project.id, language, cues: [{ start: 0, end: 2, text: "" }], preset: style.preset, makeDefault: true },
      });
      await onReload();
    } catch {
      /* reported */
    } finally {
      setBusy(false);
    }
  }

  async function saveCues() {
    if (!active) return;
    setBusy(true);
    try {
      await api("/api/video/subtitles", { method: "PATCH", json: { trackId: active.id, cues } });
      toast.success(d.common.saved);
      await onReload();
    } catch {
      /* reported */
    } finally {
      setBusy(false);
    }
  }

  async function importFile(file: File) {
    const text = await file.text();
    setBusy(true);
    try {
      await api("/api/video/subtitles", {
        method: "POST",
        json: { projectId: state.project.id, language, importText: text, preset: style.preset, makeDefault: true },
      });
      await onReload();
    } catch {
      /* reported */
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title={t.generate} />
        <div className="space-y-3 p-4 pt-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium text-(--color-fg-muted)">{t.language}</span>
            {(["uz", "ru", "en"] as const).map((lang) => (
              <Button key={lang} size="sm" variant={language === lang ? "default" : "secondary"} onClick={() => setLanguage(lang)}>
                {lang.toUpperCase()}
              </Button>
            ))}
          </div>

          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={busy || !state.capabilities.subtitlesAuto.available} onClick={() => void generate()}>
              {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Wand2 className="mr-1.5 h-4 w-4" />}
              {t.generate}
            </Button>
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => void createEmpty()}>
              {t.manual}
            </Button>
            <label className="inline-flex">
              <input
                type="file"
                accept=".srt,.vtt,text/vtt,application/x-subrip"
                className="sr-only"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void importFile(f);
                  e.target.value = "";
                }}
              />
              <span className="inline-flex cursor-pointer items-center rounded-md border border-(--color-border) px-3 py-1.5 text-sm">
                {t.importFile}
              </span>
            </label>
            {active && (
              <Button asChild size="sm" variant="ghost">
                <a href={`/api/video/subtitles?trackId=${active.id}&format=srt`} download>
                  <Download className="mr-1.5 h-4 w-4" />
                  {t.exportSrt}
                </a>
              </Button>
            )}
          </div>

          {!state.capabilities.subtitlesAuto.available && (
            <p className="flex items-start gap-1.5 text-xs text-(--color-fg-muted)">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-(--color-warn)" />
              {state.capabilities.subtitlesAuto.reason} {state.capabilities.subtitlesAuto.fix}
            </p>
          )}
        </div>
      </Card>

      {!active ? (
        <Card className="p-6 text-sm text-(--color-fg-muted)">{t.noTrack}</Card>
      ) : (
        <>
          <Card>
            <CardHeader title={t.preset} />
            <div className="space-y-4 p-4 pt-0">
              <div className="flex flex-wrap gap-2">
                {PRESETS.map((preset) => (
                  <Button
                    key={preset}
                    size="sm"
                    variant={style.preset === preset ? "default" : "secondary"}
                    onClick={() => void onPatch({ subtitles: { style: { preset } } })}
                  >
                    {t.presets[preset]}
                  </Button>
                ))}
              </div>

              <label className="flex items-center justify-between gap-3 text-sm">
                <span>{t.burnIn}</span>
                <Switch checked={params.subtitles.burnIn} onCheckedChange={(burnIn) => void onPatch({ subtitles: { burnIn } })} />
              </label>

              <div className="grid gap-3 sm:grid-cols-2">
                <ColorField label={t.textColor} value={style.textColor} onChange={(textColor) => void onPatch({ subtitles: { style: { textColor } } })} />
                <ColorField
                  label={t.background}
                  value={style.backgroundColor}
                  onChange={(backgroundColor) => void onPatch({ subtitles: { style: { backgroundColor } } })}
                />
              </div>

              <RangeField
                label={t.fontSize}
                value={style.fontSizePct}
                min={2}
                max={14}
                step={0.2}
                suffix="%"
                onCommit={(fontSizePct) => void onPatch({ subtitles: { style: { fontSizePct } } })}
              />
              <RangeField
                label={t.backgroundOpacity}
                value={style.backgroundOpacity}
                min={0}
                max={1}
                step={0.05}
                onCommit={(backgroundOpacity) => void onPatch({ subtitles: { style: { backgroundOpacity } } })}
              />
              <RangeField
                label={t.outline}
                value={style.outlineWidth}
                min={0}
                max={8}
                step={0.5}
                onCommit={(outlineWidth) => void onPatch({ subtitles: { style: { outlineWidth } } })}
              />

              <div className="flex flex-wrap gap-2">
                <span className="w-full text-xs font-medium text-(--color-fg-muted)">{t.position}</span>
                {POSITIONS.map((position) => (
                  <Button
                    key={position}
                    size="sm"
                    variant={style.position === position ? "default" : "secondary"}
                    onClick={() => void onPatch({ subtitles: { style: { position } } })}
                  >
                    {position}
                  </Button>
                ))}
              </div>

              <label className="flex items-center justify-between gap-3 text-sm">
                <span>{t.uppercase}</span>
                <Switch checked={style.uppercase} onCheckedChange={(uppercase) => void onPatch({ subtitles: { style: { uppercase } } })} />
              </label>

              <div>
                <label className={`flex items-center justify-between gap-3 text-sm ${hasWordTimings ? "" : "opacity-60"}`}>
                  <span>{t.wordHighlight}</span>
                  <Switch
                    checked={style.wordHighlight && hasWordTimings}
                    disabled={!hasWordTimings}
                    onCheckedChange={(wordHighlight) => void onPatch({ subtitles: { style: { wordHighlight } } })}
                  />
                </label>
                {!hasWordTimings && <p className="mt-1 text-xs text-(--color-fg-muted)">{t.wordHighlightUnavailable}</p>}
              </div>
            </div>
          </Card>

          <Card>
            <CardHeader title={`${t.cues} (${cues.length})`} />
            <div className="space-y-2 p-4 pt-0">
              <div className="max-h-[420px] space-y-2 overflow-y-auto pr-1">
                {cues.map((cue, i) => (
                  <div key={i} className="grid gap-2 rounded-md border border-(--color-border) p-2 sm:grid-cols-[80px_80px_1fr_auto]">
                    <input
                      type="number"
                      step={0.1}
                      className="rounded border border-(--color-border) bg-(--color-panel-2) px-2 py-1 text-xs"
                      value={cue.start}
                      onChange={(e) => setCues((c) => c.map((x, j) => (j === i ? { ...x, start: Number(e.target.value) } : x)))}
                    />
                    <input
                      type="number"
                      step={0.1}
                      className="rounded border border-(--color-border) bg-(--color-panel-2) px-2 py-1 text-xs"
                      value={cue.end}
                      onChange={(e) => setCues((c) => c.map((x, j) => (j === i ? { ...x, end: Number(e.target.value) } : x)))}
                    />
                    <input
                      className="rounded border border-(--color-border) bg-(--color-panel-2) px-2 py-1 text-sm"
                      value={cue.text}
                      onChange={(e) => setCues((c) => c.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))}
                    />
                    <Button size="sm" variant="ghost" aria-label={t.deleteLine} onClick={() => setCues((c) => c.filter((_, j) => j !== i))}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
              </div>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    const last = cues[cues.length - 1];
                    const start = last ? last.end + 0.1 : 0;
                    setCues((c) => [...c, { start, end: start + 2, text: "" }]);
                  }}
                >
                  <Plus className="mr-1.5 h-4 w-4" />
                  {t.addLine}
                </Button>
                <Button size="sm" disabled={busy} onClick={() => void saveCues()}>
                  {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
                  {d.common.save}
                </Button>
              </div>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="block text-xs">
      <span className="mb-1.5 block font-medium text-(--color-fg-muted)">{label}</span>
      <input type="color" className="h-9 w-full cursor-pointer rounded-md border border-(--color-border)" value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

function RangeField({
  label,
  value,
  min,
  max,
  step,
  suffix,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix?: string;
  onCommit: (v: number) => void;
}) {
  const [local, setLocal] = React.useState(value);
  React.useEffect(() => setLocal(value), [value]);
  return (
    <label className="block text-xs">
      <span className="mb-1.5 flex items-center justify-between font-medium text-(--color-fg-muted)">
        <span>{label}</span>
        <span className="tabular-nums text-(--color-fg)">
          {local}
          {suffix ?? ""}
        </span>
      </span>
      <input
        type="range"
        className="w-full accent-(--color-accent)"
        value={local}
        min={min}
        max={max}
        step={step}
        onChange={(e) => setLocal(Number(e.target.value))}
        onMouseUp={() => onCommit(local)}
        onTouchEnd={() => onCommit(local)}
        onKeyUp={() => onCommit(local)}
      />
    </label>
  );
}
